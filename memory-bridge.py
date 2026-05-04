"""
memory-bridge.py — taosmd memory integration for QwenCoder Mac Studio.

FastAPI APIRouter module imported by server.py via app.include_router().
Manages taosmd component lifecycle (KnowledgeGraph, VectorMemory, Archive)
and exposes all /memory/* endpoints.

Gracefully degrades: if taosmd is not installed or initialization fails,
the server continues operating without memory features (HTTP 503 for all
memory endpoints).
"""

import os
import re
import sys
import logging
from pathlib import Path
from typing import Optional, Any
from datetime import datetime

# ── Vendored taosmd ───────────────────────────────────────────────────────────
# Add vendor/ directory to sys.path so the bundled taosmd package is importable
# even when it's not installed via pip. Works for both dev (cwd) and packaged
# (process.resourcesPath) layouts.
_this_dir = Path(__file__).resolve().parent
_vendor_dir = _this_dir / "vendor"
if _vendor_dir.is_dir() and str(_vendor_dir) not in sys.path:
    sys.path.insert(0, str(_vendor_dir))

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("memory-bridge")

# ── FastAPI Router ────────────────────────────────────────────────────────────
router = APIRouter(prefix="/memory", tags=["memory"])

# ── Module-level state ────────────────────────────────────────────────────────
_kg = None                  # KnowledgeGraph instance
_vm = None                  # VectorMemory instance
_archive = None             # Archive instance
_extractor = None           # MemoryExtractor instance
_extract_model = None       # Secondary MLX model for extraction
_extract_processor = None   # Tokenizer/processor for extraction model
_extract_model_path = None  # Path of the loaded extraction model (for status reporting)
_extract_model_has_vision = False  # True when extraction model was loaded via mlx_vlm (has vision weights)
_initialized = False
_data_path = None           # Path to ~/.qwencoder/memory/ (set during initialize)
_last_extraction_at = None  # Timestamp of last successful extraction


# ── Pydantic Request/Response Models ─────────────────────────────────────────

# ── Knowledge Graph ──

class TripleRequest(BaseModel):
    subject: str
    predicate: str
    object: str
    valid_from: Optional[datetime] = None
    valid_until: Optional[datetime] = None


class TripleResponse(BaseModel):
    id: int
    subject: str
    predicate: str
    object: str
    valid_from: Optional[datetime]
    valid_until: Optional[datetime]
    created_at: datetime


class TemporalQueryRequest(BaseModel):
    entity: str
    at_time: datetime


# ── Archive ──

class ArchiveRecordRequest(BaseModel):
    event_type: str     # conversation, tool_call, decision, error, pre_compaction, session_start, session_end, task_completion, workflow_start
    payload: Any        # verbatim content (string or dict)
    summary: str        # short description
    agent_name: Optional[str] = None
    session_id: Optional[str] = None
    turn_number: Optional[int] = None
    project_id: Optional[str] = None  # project directory basename — scopes this record to a project


class ArchiveEvent(BaseModel):
    id: int
    event_type: str
    payload: Any
    summary: str
    agent_name: Optional[str]
    session_id: Optional[str]
    timestamp: datetime


# ── Vector Memory ──

class VectorAddRequest(BaseModel):
    text: str
    metadata: Optional[dict] = None


class VectorSearchRequest(BaseModel):
    query: str
    top_k: int = 10
    hybrid: bool = True


# ── Unified Retrieval ──

class RetrieveRequest(BaseModel):
    query: str
    agent_name: Optional[str] = None
    top_k: int = 10
    mode: str = "fast"  # "fast" or "thorough"
    project_id: Optional[str] = None  # project directory basename — scopes retrieval to this project


class RetrievalResult(BaseModel):
    source: str         # "kg", "vector", "archive"
    content: str
    score: float
    metadata: Optional[dict] = None


class RetrieveResponse(BaseModel):
    results: list[RetrievalResult]
    token_count: int
    query_expanded: Optional[str] = None


# ── Extraction ──

class ExtractRequest(BaseModel):
    message: str
    agent_name: str
    session_id: str


class ExtractorLoadRequest(BaseModel):
    model_path: str


# ── Session ──

class SessionEnrichRequest(BaseModel):
    session_id: str


class SessionCrystallizeRequest(BaseModel):
    session_id: str


# ── Status / Stats ──

class MemoryStatus(BaseModel):
    knowledge_graph: str            # "ready", "unavailable", "error"
    vector_memory: str
    archive: str
    extraction_model: Optional[str]             # model name or None
    extraction_model_memory_gb: Optional[float]
    fast_assistant_enabled: bool
    extraction_model_vision: bool = False       # True when extraction model has vision weights


class MemoryStats(BaseModel):
    kg_triples: int
    kg_db_size_bytes: int
    vector_count: int
    vector_db_size_bytes: int
    archive_events: int
    archive_size_bytes: int
    crystals_count: int
    last_extraction_at: Optional[datetime]


# ── KG Clear ──

class KGClearRequest(BaseModel):
    confirm: bool = False


# ── Archive Compress (no body needed, but define for consistency) ──
# POST /memory/archive/compress has no required body fields.


# ── Secret Filtering Pipeline ─────────────────────────────────────────────────
# taosmd's 17 regex patterns for redacting sensitive values before ingest.
# All content passes through this filter before entering any memory layer.
# Matched values are replaced with [REDACTED]. Redaction events are logged
# (pattern type + character count) but the redacted value itself is never logged.
# If the pipeline errors, we fail closed (reject ingest) rather than store unfiltered.

_SECRET_PATTERNS: list[tuple[str, re.Pattern]] = [
    # 1. OpenAI API keys (sk-...)
    ("openai_api_key", re.compile(r"sk-[A-Za-z0-9]{20,}")),
    # 2. Generic API keys (api_key=..., apikey=..., api-key: ...)
    ("generic_api_key", re.compile(
        r"(?i)(?:api[_-]?key|apikey)\s*[:=]\s*['\"]?([A-Za-z0-9_\-]{16,})['\"]?"
    )),
    # 3. Bearer tokens
    ("bearer_token", re.compile(r"(?i)Bearer\s+[A-Za-z0-9_\-\.]{20,}")),
    # 4. Basic auth (Authorization: Basic ...)
    ("basic_auth", re.compile(r"(?i)Basic\s+[A-Za-z0-9+/=]{16,}")),
    # 5. Passwords in URLs (proto://user:pass@host)
    ("password_in_url", re.compile(r"://[^:@\s]+:([^@\s]{3,})@")),
    # 6. Private keys (BEGIN ... PRIVATE KEY)
    ("private_key", re.compile(
        r"-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----"
        r"[\s\S]*?"
        r"-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----"
    )),
    # 7. AWS access keys (AKIA...)
    ("aws_access_key", re.compile(r"AKIA[0-9A-Z]{16}")),
    # 8. AWS secret keys (40-char base64 after common prefixes)
    ("aws_secret_key", re.compile(
        r"(?i)(?:aws_secret_access_key|aws_secret_key|secret_access_key)\s*[:=]\s*['\"]?"
        r"([A-Za-z0-9/+=]{40})['\"]?"
    )),
    # 9. Connection strings (postgres://, mysql://, mongodb://)
    ("connection_string", re.compile(
        r"(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)://[^\s'\"]+"
    )),
    # 10. GitHub tokens (ghp_, gho_, ghs_, ghr_)
    ("github_token", re.compile(r"(?:ghp|gho|ghs|ghr)_[A-Za-z0-9_]{36,}")),
    # 11. Slack tokens (xoxb-, xoxp-, xoxs-)
    ("slack_token", re.compile(r"xox[bps]-[A-Za-z0-9\-]{10,}")),
    # 12. JWT tokens (three base64url segments separated by dots)
    ("jwt_token", re.compile(
        r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-]{10,}"
    )),
    # 13. Stripe keys (sk_live_, pk_live_)
    ("stripe_key", re.compile(r"(?:sk|pk)_live_[A-Za-z0-9]{20,}")),
    # 14. SendGrid keys (SG.)
    ("sendgrid_key", re.compile(r"SG\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}")),
    # 15. Twilio keys (SK followed by 32 hex chars)
    ("twilio_key", re.compile(r"SK[0-9a-fA-F]{32}")),
    # 16. Generic secrets in env vars (SECRET=..., TOKEN=..., PASSWORD=...)
    ("env_secret", re.compile(
        r"(?i)(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)\s*[:=]\s*['\"]?"
        r"([^\s'\"]{8,})['\"]?"
    )),
    # 17. Base64-encoded credentials (long base64 strings after auth-related keys)
    ("base64_credentials", re.compile(
        r"(?i)(?:auth|credential|secret|password|token)\s*[:=]\s*['\"]?"
        r"([A-Za-z0-9+/]{40,}={0,2})['\"]?"
    )),
]


def filter_secrets(text: str) -> str:
    """Apply taosmd's 17 regex patterns to redact sensitive values from text.

    Replaces matched secrets with [REDACTED] and logs each redaction event
    (pattern name and character count) without ever logging the secret value.

    Raises ValueError if the filtering pipeline itself errors, so callers
    can reject the ingest rather than store unfiltered content.
    """
    try:
        for pattern_name, pattern in _SECRET_PATTERNS:
            def _redact(match, _name=pattern_name):
                matched_text = match.group(0)
                char_count = len(matched_text)
                logger.info(
                    f"Secret redacted: pattern={_name}, chars={char_count}"
                )
                return "[REDACTED]"

            text = pattern.sub(_redact, text)
        return text
    except Exception as e:
        logger.error(f"Secret filtering pipeline failed: {e}")
        raise ValueError(
            f"Secret filtering pipeline failed — ingest rejected to prevent storing unfiltered content: {e}"
        )


def _fail_closed_filter(text: str) -> str:
    """Wrapper around filter_secrets that ensures fail-closed behavior.

    For use in ingest endpoints. If filtering fails for any reason,
    raises HTTP 500 to reject the ingest rather than store unfiltered content.
    """
    try:
        return filter_secrets(text)
    except ValueError as e:
        raise HTTPException(
            status_code=500,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Unexpected error in secret filtering: {e}")
        raise HTTPException(
            status_code=500,
            detail="Secret filtering failed — ingest rejected to prevent storing unfiltered content"
        )


# ── Lifecycle Functions ───────────────────────────────────────────────────────

async def initialize(data_dir: str = "~/.qwencoder/memory/"):
    """Initialize all taosmd components. Called once at server startup.

    Creates the storage directory structure if missing, then initializes
    KnowledgeGraph, VectorMemory, and Archive. Wrapped in try/except so
    the server continues without memory if taosmd is not installed.
    """
    global _kg, _vm, _archive, _extractor, _initialized, _data_path

    data_path = Path(os.path.expanduser(data_dir))
    _data_path = data_path

    # Create directory structure: ~/.qwencoder/memory/ with subdirs
    # knowledge-graph.db, vector-memory.db, archive/, archive-index.db, crystals.db
    try:
        data_path.mkdir(parents=True, exist_ok=True)
        (data_path / "archive").mkdir(exist_ok=True)
        logger.info(f"Memory storage directory ready: {data_path}")
    except OSError as e:
        logger.error(f"Failed to create memory directory {data_path}: {e}")
        return

    try:
        from taosmd import KnowledgeGraph, VectorMemory, Archive

        # Initialize KnowledgeGraph with SQLite backend
        kg_path = str(data_path / "knowledge-graph.db")
        _kg = KnowledgeGraph(kg_path)
        await _kg.init()
        logger.info(f"KnowledgeGraph initialized: {kg_path}")

        # Initialize VectorMemory with ONNX embedding (CPU-only, no Metal conflict)
        # Uses all-MiniLM-L6-v2 ONNX model for 0.3ms/embed CPU inference.
        # This avoids the Metal race condition that crashes the server when
        # sentence-transformers (which uses MPS/Metal) runs alongside the main MLX model.
        vm_path = str(data_path / "vector-memory.db")
        onnx_model_path = str(Path(os.path.expanduser("~/.qwencoder/models/minilm-onnx")))
        _vm = VectorMemory(vm_path, embed_mode="onnx", onnx_path=onnx_model_path)
        await _vm.init()
        logger.info(f"VectorMemory initialized (embed_mode=onnx, CPU-only): {vm_path}")

        # Initialize Archive with JSONL storage + FTS5 index
        archive_dir = str(data_path / "archive")
        archive_index = str(data_path / "archive-index.db")
        _archive = Archive(archive_dir, index_path=archive_index)
        await _archive.init()
        logger.info(f"Archive initialized: {archive_dir}")

        _initialized = True
        logger.info("✅ taosmd memory components initialized — KG + VectorMemory + Archive ready")

    except ImportError:
        logger.warning(
            "taosmd is not installed — memory features disabled. "
            "Install with: pip install taosmd"
        )
        _kg = None
        _vm = None
        _archive = None
        _initialized = False

    except Exception as e:
        logger.error(f"Failed to initialize taosmd components: {e}")
        _kg = None
        _vm = None
        _archive = None
        _initialized = False


async def shutdown():
    """Flush pending Archive writes and close all SQLite connections.

    Called on SIGTERM to ensure data integrity before process exit.
    """
    global _kg, _vm, _archive, _extractor, _extract_model, _extract_processor, _initialized, _data_path, _last_extraction_at

    logger.info("Shutting down memory components...")

    # Flush pending Archive writes
    if _archive is not None:
        try:
            if hasattr(_archive, 'flush'):
                await _archive.flush()
            if hasattr(_archive, 'close'):
                await _archive.close()
            logger.info("Archive flushed and closed")
        except Exception as e:
            logger.error(f"Error flushing Archive: {e}")

    # Close KnowledgeGraph SQLite connection
    if _kg is not None:
        try:
            if hasattr(_kg, 'close'):
                await _kg.close()
            logger.info("KnowledgeGraph closed")
        except Exception as e:
            logger.error(f"Error closing KnowledgeGraph: {e}")

    # Close VectorMemory SQLite connection
    if _vm is not None:
        try:
            if hasattr(_vm, 'close'):
                await _vm.close()
            logger.info("VectorMemory closed")
        except Exception as e:
            logger.error(f"Error closing VectorMemory: {e}")

    # Release extraction model if loaded
    if _extract_model is not None:
        try:
            _extract_model = None
            _extract_processor = None
            import gc
            gc.collect()
            try:
                import mlx.core as mx
                mx.metal.clear_cache()
            except Exception:
                pass
            logger.info("Extraction model released")
        except Exception as e:
            logger.error(f"Error releasing extraction model: {e}")

    _kg = None
    _vm = None
    _archive = None
    _extractor = None
    _initialized = False
    _data_path = None
    _last_extraction_at = None
    _extract_model_path = None
    logger.info("Memory shutdown complete")


# ── Status & Stats Endpoints ──────────────────────────────────────────────────

def _get_file_size(path: Path) -> int:
    """Return file size in bytes, or 0 if the file does not exist."""
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _get_dir_size(dir_path: Path) -> int:
    """Return total size of all files in a directory (non-recursive), or 0 if missing."""
    total = 0
    try:
        if dir_path.is_dir():
            for entry in dir_path.iterdir():
                if entry.is_file():
                    total += os.path.getsize(entry)
    except OSError:
        pass
    return total


@router.get("/status", response_model=MemoryStatus)
async def get_memory_status():
    """Return initialization state of each memory component and extraction model availability."""
    # Report extraction model by stored path (mlx_lm models have no .name attribute)
    extraction_name = None
    if _extract_model is not None:
        extraction_name = (
            getattr(_extract_model, "name", None)
            or (_extract_model_path and str(_extract_model_path).split("/")[-1])
            or "extraction-model"
        )
    return MemoryStatus(
        knowledge_graph="ready" if _kg is not None else "unavailable",
        vector_memory="ready" if _vm is not None else "unavailable",
        archive="ready" if _archive is not None else "unavailable",
        extraction_model=extraction_name,
        extraction_model_memory_gb=getattr(_extract_model, "memory_gb", None) if _extract_model is not None else None,
        fast_assistant_enabled=_extract_model is not None,
        extraction_model_vision=_extract_model_has_vision,
    )


@router.get("/stats", response_model=MemoryStats)
async def get_memory_stats(project_id: Optional[str] = None):
    """Return storage sizes, record counts, and last extraction timestamp.

    When project_id is provided, archive_events count is scoped to that project.
    KG triples and vector counts remain global (not project-scoped at storage level).
    """
    if _data_path is None:
        raise HTTPException(status_code=503, detail="Memory system not initialized")

    # KG triple count
    kg_triples = 0
    if _kg is not None:
        try:
            # taosmd KnowledgeGraph.stats() returns {"entities": N, "triples": N, "active_triples": N}
            kg_stats = await _kg.stats()
            kg_triples = kg_stats.get("triples", 0) if isinstance(kg_stats, dict) else 0
        except Exception as e:
            logger.warning(f"Failed to get KG triple count: {e}")

    # Vector count
    vector_count = 0
    if _vm is not None:
        try:
            if hasattr(_vm, "count"):
                vector_count = await _vm.count()
            elif hasattr(_vm, "__len__"):
                vector_count = len(_vm)
        except Exception as e:
            logger.warning(f"Failed to get vector count: {e}")

    # Archive event count
    archive_events = 0
    if _archive is not None:
        try:
            if project_id and hasattr(_archive, "search_fts"):
                # Count events for this project by searching for the project_id tag
                project_results = await _archive.search_fts(project_id, limit=10000)
                archive_events = sum(
                    1 for r in project_results
                    if _archive_record_matches_project(r, project_id)
                )
            elif hasattr(_archive, "count"):
                archive_events = await _archive.count()
            elif hasattr(_archive, "event_count"):
                archive_events = await _archive.count()
        except Exception as e:
            logger.warning(f"Failed to get archive event count: {e}")

    # Crystal count
    crystals_count = 0
    # crystals.db is a SQLite DB; count rows if accessible via a component
    # For now, check if the file exists as a basic indicator
    crystals_db = _data_path / "crystals.db"
    if crystals_db.exists():
        try:
            import sqlite3
            conn = sqlite3.connect(str(crystals_db))
            cursor = conn.execute("SELECT COUNT(*) FROM crystals")
            crystals_count = cursor.fetchone()[0]
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to get crystals count: {e}")

    # File sizes
    kg_db_size = _get_file_size(_data_path / "knowledge-graph.db")
    vector_db_size = _get_file_size(_data_path / "vector-memory.db")
    archive_size = _get_dir_size(_data_path / "archive")

    return MemoryStats(
        kg_triples=kg_triples,
        kg_db_size_bytes=kg_db_size,
        vector_count=vector_count,
        vector_db_size_bytes=vector_db_size,
        archive_events=archive_events,
        archive_size_bytes=archive_size,
        crystals_count=crystals_count,
        last_extraction_at=_last_extraction_at,
    )


# ── Knowledge Graph Endpoints ─────────────────────────────────────────────────

@router.post("/kg/triples", response_model=TripleResponse, status_code=201)
async def add_triple(req: TripleRequest):
    """Add a triple to the Knowledge Graph with secret filtering and temporal contradiction detection.

    Applies the secret filtering pipeline to subject, predicate, and object
    before storing. The KnowledgeGraph handles temporal contradiction detection
    internally — when a new triple shares the same subject-predicate pair as an
    existing triple, the older triple's valid_until is set to the current timestamp.

    Returns HTTP 503 if the Knowledge Graph is unavailable.
    """
    if _kg is None:
        raise HTTPException(
            status_code=503,
            detail="Knowledge Graph is unavailable"
        )

    # Apply secret filtering (fail-closed: raises HTTP 500 on filter error)
    subject = _fail_closed_filter(req.subject)
    predicate = _fail_closed_filter(req.predicate)
    obj = _fail_closed_filter(req.object)

    try:
        result = await _kg.add_triple(
            subject,
            predicate,
            obj,
            valid_from=req.valid_from,
            valid_until=req.valid_until,
        )

        # add_triple returns the triple ID string; re-query to get full data
        triples = await _kg.query_entity(subject)
        triple = next((t for t in triples if t.get("predicate") == predicate and t.get("object_name") == obj), None)
        if triple:
            return _kg_triple_to_response(triple)
        # Fallback: return minimal response
        return TripleResponse(id=0, subject=subject, predicate=predicate, object=obj,
                              valid_from=None, valid_until=None, created_at=datetime.utcnow())
    except Exception as e:
        logger.error(f"Failed to add triple to KnowledgeGraph: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to add triple: {e}"
        )


@router.get("/kg/query/{entity}", response_model=list[TripleResponse])
async def query_entity(entity: str):
    """Query all triples where entity appears as subject or object.

    Returns triples including temporal validity metadata (valid_from, valid_until).
    Returns HTTP 503 if the Knowledge Graph is unavailable.
    """
    if _kg is None:
        raise HTTPException(
            status_code=503,
            detail="Knowledge Graph is unavailable"
        )

    try:
        results = await _kg.query_entity(entity)
        return [
            _kg_triple_to_response(t)
            for t in results
        ]
    except Exception as e:
        logger.error(f"Failed to query KnowledgeGraph for entity '{entity}': {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to query entity: {e}"
        )


@router.post("/kg/query-temporal", response_model=list[TripleResponse])
async def query_temporal(req: TemporalQueryRequest):
    """Query triples valid at a specific point in time.

    Returns only triples where the entity appears as subject or object AND
    valid_from <= at_time AND (valid_until is None OR valid_until >= at_time).

    Returns HTTP 503 if the Knowledge Graph is unavailable.
    """
    if _kg is None:
        raise HTTPException(
            status_code=503,
            detail="Knowledge Graph is unavailable"
        )

    try:
        # Get all triples for the entity first
        all_triples = await _kg.query_entity(req.entity)

        # Filter to only those valid at the requested point in time
        valid_triples = []
        for t in all_triples:
            # valid_from must be <= at_time (or None/unset means always valid from the start)
            if t.get("valid_from") is not None and t.get("valid_from") > req.at_time.timestamp():
                continue
            # valid_until must be >= at_time (or None means still valid)
            if t.get("valid_to") is not None and t.get("valid_to") < req.at_time.timestamp():
                continue
            valid_triples.append(t)

        return [
            _kg_triple_to_response(t)
            for t in valid_triples
        ]
    except Exception as e:
        logger.error(f"Failed temporal query for entity '{req.entity}' at {req.at_time}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed temporal query: {e}"
        )


@router.delete("/kg/clear")
async def clear_kg(req: KGClearRequest):
    """Clear all triples from the Knowledge Graph.

    Requires `confirm: true` in the request body as a safety guard.
    Returns HTTP 400 if confirmation is missing, HTTP 503 if KG is unavailable.
    """
    if not req.confirm:
        raise HTTPException(
            status_code=400,
            detail="Confirmation required: set confirm=true to clear all triples"
        )

    if _kg is None:
        raise HTTPException(
            status_code=503,
            detail="Knowledge Graph is unavailable"
        )

    try:
        await _kg.clear()
        logger.info("Knowledge Graph cleared by user request")
        return {"ok": True, "message": "Knowledge Graph cleared"}
    except Exception as e:
        logger.error(f"Failed to clear KnowledgeGraph: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to clear Knowledge Graph: {e}"
        )


# ── Archive Endpoints ─────────────────────────────────────────────────────────

@router.post("/archive/record", status_code=201)
async def archive_record(req: ArchiveRecordRequest):
    """Record an event to the Zero-Loss Archive with secret filtering.

    Accepts event_type, payload, summary, and optional agent_name/session_id/turn_number.
    Applies secret filtering to payload before storing.
    Includes UTC timestamp, agent_name, and session_id in record metadata.
    Stores in append-only JSONL format in ~/.qwencoder/memory/archive/.

    Returns HTTP 503 if Archive is unavailable.
    """
    if _archive is None:
        raise HTTPException(
            status_code=503,
            detail="Archive is unavailable"
        )

    # Apply secret filtering to payload (fail-closed)
    if isinstance(req.payload, str):
        filtered_payload = _fail_closed_filter(req.payload)
    elif isinstance(req.payload, dict):
        # Filter string values in dict
        filtered_payload = {
            k: _fail_closed_filter(v) if isinstance(v, str) else v
            for k, v in req.payload.items()
        }
    else:
        filtered_payload = req.payload

    filtered_summary = _fail_closed_filter(req.summary)

    # Ensure today's archive subdirectory exists — taosmd writes to
    # archive/YYYY/MM/DD.jsonl but only creates the top-level dir during init.
    if _data_path is not None:
        try:
            today = datetime.utcnow()
            day_dir = _data_path / "archive" / str(today.year) / f"{today.month:02d}"
            day_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass  # non-fatal — archive.record() will fail with a clear error if needed

    # Embed project_id in the data dict so it can be filtered on retrieval
    data_dict: dict
    if isinstance(filtered_payload, dict):
        data_dict = filtered_payload
    else:
        data_dict = {"content": str(filtered_payload)}
    if req.project_id:
        data_dict = {**data_dict, "_project_id": req.project_id}

    try:
        record = await _archive.record(
            event_type=req.event_type,
            data=data_dict,
            summary=filtered_summary,
            agent_name=req.agent_name,
            app_id=req.session_id,
        )
        return {
            "ok": True,
            "id": getattr(record, "id", None),
            "timestamp": getattr(record, "timestamp", datetime.utcnow()).isoformat(),
        }
    except Exception as e:
        logger.error(f"Failed to record archive event: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to record archive event: {e}"
        )


@router.get("/archive/search")
async def archive_search(query: str, limit: int = 20, project_id: Optional[str] = None):
    """FTS5 full-text search over archived records.

    Accepts a query string, optional limit, and optional project_id for scoping.
    When project_id is provided, only returns records tagged with that project
    (or untagged records, which are treated as global/cross-project facts).
    Performs full-text search via Archive.search_fts().
    Returns HTTP 503 if Archive is unavailable.
    """
    if _archive is None:
        raise HTTPException(
            status_code=503,
            detail="Archive is unavailable"
        )

    try:
        results = await _archive.search_fts(query, limit=limit * 2 if project_id else limit)
        # Filter by project_id when provided
        if project_id:
            filtered = []
            for r in results:
                payload = _parse_archive_payload(r)
                item_project = None
                if isinstance(payload, dict):
                    item_project = payload.get("_project_id")
                elif isinstance(payload, str) and "_project_id" in payload:
                    # Try to extract from stringified dict
                    import re as _re
                    m = _re.search(r'"_project_id"\s*:\s*"([^"]+)"', payload)
                    if m:
                        item_project = m.group(1)
                if item_project is None or item_project == project_id:
                    filtered.append(r)
                if len(filtered) >= limit:
                    break
            results = filtered
        return {
            "results": [
                {
                    "id": r.get("id"),
                    "event_type": r.get("event_type"),
                    "payload": _parse_archive_payload(r),
                    "summary": r.get("summary"),
                    "agent_name": r.get("agent_name"),
                    "session_id": r.get("app_id"),
                    "timestamp": _fmt_archive_ts(r.get("timestamp")),
                }
                for r in results
            ],
            "count": len(results),
        }
    except Exception as e:
        logger.error(f"Failed to search archive: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to search archive: {e}"
        )


@router.get("/archive/events")
async def archive_events(limit: int = 50, project_id: Optional[str] = None):
    """Return the most recent N archived events, ordered by timestamp descending.

    Accepts a configurable limit parameter (default 50) and optional project_id
    for scoping. When project_id is provided, only returns events tagged with
    that project (or untagged global events).
    Returns HTTP 503 if Archive is unavailable.
    """
    if _archive is None:
        raise HTTPException(
            status_code=503,
            detail="Archive is unavailable"
        )

    try:
        # Fetch extra results when filtering by project to ensure we get enough after filtering
        fetch_limit = limit * 3 if project_id else limit
        results = await _archive.query(limit=fetch_limit)

        # Filter by project_id when provided
        if project_id:
            filtered = []
            for r in results:
                if _archive_record_matches_project(r, project_id):
                    filtered.append(r)
                if len(filtered) >= limit:
                    break
            results = filtered

        return {
            "events": [
                {
                    "id": r.get("id"),
                    "event_type": r.get("event_type"),
                    "payload": _parse_archive_payload(r),
                    "summary": r.get("summary"),
                    "agent_name": r.get("agent_name"),
                    "session_id": r.get("app_id"),
                    "timestamp": _fmt_archive_ts(r.get("timestamp")),
                }
                for r in results[:limit]
            ],
            "count": len(results[:limit]),
        }
    except Exception as e:
        logger.error(f"Failed to get recent archive events: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get recent archive events: {e}"
        )


@router.post("/archive/compress")
async def archive_compress():
    """Trigger gzip compression of archive JSONL files older than 24 hours.

    Compresses uncompressed .jsonl files in the archive directory that are
    older than 24 hours. Already-compressed .jsonl.gz files are skipped.
    Returns HTTP 503 if Archive is unavailable.
    """
    if _archive is None or _data_path is None:
        raise HTTPException(
            status_code=503,
            detail="Archive is unavailable"
        )

    import gzip
    import shutil
    import time

    archive_dir = _data_path / "archive"
    if not archive_dir.is_dir():
        return {"ok": True, "compressed": 0, "message": "Archive directory not found"}

    cutoff = time.time() - (24 * 60 * 60)  # 24 hours ago
    compressed_count = 0
    errors = []

    for jsonl_file in archive_dir.glob("*.jsonl"):
        try:
            # Skip if already compressed or modified within last 24 hours
            if jsonl_file.stat().st_mtime > cutoff:
                continue

            gz_path = jsonl_file.with_suffix(".jsonl.gz")
            if gz_path.exists():
                continue  # Already compressed

            # Compress the file
            with open(jsonl_file, "rb") as f_in:
                with gzip.open(gz_path, "wb") as f_out:
                    shutil.copyfileobj(f_in, f_out)

            # Remove original after successful compression
            jsonl_file.unlink()
            compressed_count += 1
            logger.info(f"Compressed archive file: {jsonl_file.name} -> {gz_path.name}")

        except Exception as e:
            logger.error(f"Failed to compress {jsonl_file}: {e}")
            errors.append(str(e))

    return {
        "ok": True,
        "compressed": compressed_count,
        "errors": errors,
        "message": f"Compressed {compressed_count} archive file(s)",
    }

# ── Vector Memory Endpoints ──────────────────────────────────────────────────

@router.post("/vector/add", status_code=201)
async def vector_add(req: VectorAddRequest):
    """Add text to Vector Memory with ONNX MiniLM embedding and secret filtering.

    Embeds text using the ONNX MiniLM model (all-MiniLM-L6-v2) and stores
    the embedding via VectorMemory.add(). Applies secret filtering before
    embedding to ensure sensitive values are not encoded into vectors.

    Returns HTTP 503 if VectorMemory is unavailable.
    """
    if _vm is None:
        raise HTTPException(
            status_code=503,
            detail="Vector Memory is unavailable — ONNX model may not be loaded"
        )

    # Apply secret filtering before embedding (fail-closed)
    filtered_text = _fail_closed_filter(req.text)

    try:
        result = await _vm.add(filtered_text, metadata=req.metadata)
        return {
            "ok": True,
            "id": getattr(result, "id", None),
        }
    except Exception as e:
        logger.error(f"Failed to add text to VectorMemory: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to add to vector memory: {e}"
        )


@router.post("/vector/search")
async def vector_search(req: VectorSearchRequest):
    """Hybrid semantic search over Vector Memory.

    Accepts query, top_k (default 10), and hybrid flag (default true).
    When hybrid=true, combines semantic cosine similarity with keyword
    overlap boosting for result ranking.

    Returns HTTP 503 if VectorMemory is unavailable.
    """
    if _vm is None:
        raise HTTPException(
            status_code=503,
            detail="Vector Memory is unavailable — ONNX model may not be loaded"
        )

    try:
        results = await _vm.search(req.query, limit=req.top_k, hybrid=req.hybrid)
        return {
            "results": [
                {
                    "id": getattr(r, "id", None),
                    "text": getattr(r, "text", None),
                    "score": getattr(r, "score", 0.0),
                    "metadata": getattr(r, "metadata", None),
                }
                for r in results
            ],
            "count": len(results),
        }
    except Exception as e:
        logger.error(f"Failed to search VectorMemory: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to search vector memory: {e}"
        )

# ── Unified Retrieval Endpoint ───────────────────────────────────────────────

# Default token budget for retrieval context (configurable via env var)
_DEFAULT_TOKEN_BUDGET = int(os.environ.get("MEMORY_CONTEXT_BUDGET", "2048"))

def _estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token (GPT-style approximation)."""
    return max(1, len(text) // 4)


def _kg_triple_to_response(t: dict) -> "TripleResponse":
    """Convert a taosmd KG result dict to a TripleResponse Pydantic model.

    taosmd returns dicts with keys: id, subject_id, predicate, object_id,
    object_name, valid_from (float epoch), valid_to (float epoch), created_at.
    """
    def _epoch_to_dt(v):
        if v is None:
            return None
        if isinstance(v, (int, float)):
            from datetime import datetime, timezone
            return datetime.fromtimestamp(v, tz=timezone.utc)
        return v

    return TripleResponse(
        id=0,  # taosmd uses string IDs; use 0 as placeholder
        subject=t.get("subject_id", ""),
        predicate=t.get("predicate", ""),
        object=t.get("object_name") or t.get("object_id", ""),
        valid_from=_epoch_to_dt(t.get("valid_from")),
        valid_until=_epoch_to_dt(t.get("valid_to")),
        created_at=_epoch_to_dt(t.get("created_at")) or datetime.utcnow(),
    )


def _parse_archive_payload(record: dict):
    """Parse the data_json field from an archive record into a Python object."""
    import json as _json
    raw = record.get("data_json") or record.get("payload")
    if raw is None:
        return None
    if isinstance(raw, str):
        try:
            return _json.loads(raw)
        except Exception:
            return raw
    return raw


def _archive_record_matches_project(record: dict, project_id: str) -> bool:
    """Check if an archive record belongs to a project (or is untagged/global).

    Records with _project_id matching the given project_id are included.
    Records with no _project_id tag are treated as global and also included.
    """
    payload = _parse_archive_payload(record)
    item_project = None
    if isinstance(payload, dict):
        item_project = payload.get("_project_id")
    elif isinstance(payload, str) and "_project_id" in payload:
        import re as _re
        m = _re.search(r'"_project_id"\s*:\s*"([^"]+)"', payload)
        if m:
            item_project = m.group(1)
    # Include if: matches project, or is untagged (global)
    return item_project is None or item_project == project_id


def _fmt_archive_ts(ts) -> str | None:
    """Format an archive timestamp (float epoch or datetime) to ISO string."""
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        from datetime import datetime, timezone
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    if hasattr(ts, "isoformat"):
        return ts.isoformat()
    return str(ts)


def _reciprocal_rank_fusion(result_lists: list[list[dict]], k: int = 60) -> list[dict]:
    """Merge multiple ranked result lists using Reciprocal Rank Fusion.

    RRF score = sum(1 / (k + rank)) across all lists where the item appears.
    Items are identified by their content string.
    """
    scores: dict[str, float] = {}
    items: dict[str, dict] = {}

    for result_list in result_lists:
        for rank, item in enumerate(result_list, start=1):
            key = item.get("content", "")
            if key not in scores:
                scores[key] = 0.0
                items[key] = item
            scores[key] += 1.0 / (k + rank)

    # Sort by RRF score descending
    sorted_keys = sorted(scores.keys(), key=lambda k: scores[k], reverse=True)
    merged = []
    for key in sorted_keys:
        item = dict(items[key])
        item["score"] = scores[key]
        merged.append(item)
    return merged


@router.post("/retrieve", response_model=RetrieveResponse)
async def retrieve(req: RetrieveRequest):
    """Unified retrieval endpoint — queries all memory layers and returns merged results.

    Fast mode: uses IntentClassifier to route to most relevant layer(s), skips reranker.
    Thorough mode: fans out to KG, Vector, Archive in parallel, merges with RRF, reranks.

    Applies query expansion (entity extraction, temporal resolution) before dispatch.
    Enforces configurable token budget (default 2048 tokens) on assembled context.

    Returns HTTP 503 if all memory layers are unavailable.
    """
    if _kg is None and _vm is None and _archive is None:
        raise HTTPException(
            status_code=503,
            detail="All memory layers are unavailable"
        )

    token_budget = _DEFAULT_TOKEN_BUDGET
    query = req.query
    query_expanded = None

    # ── Query expansion: simple entity extraction via regex ──────────────────
    # Extract quoted phrases and capitalized words as potential entities
    entities = re.findall(r'"([^"]+)"', query)
    capitalized = re.findall(r'\b[A-Z][a-zA-Z]{2,}\b', query)
    if entities or capitalized:
        expanded_terms = list(set(entities + capitalized))
        query_expanded = f"{query} {' '.join(expanded_terms[:3])}"
    else:
        query_expanded = query

    all_results: list[dict] = []

    if req.mode == "thorough":
        # Fan out to all available layers in parallel
        import asyncio

        async def query_kg():
            if _kg is None:
                return []
            try:
                triples = await _kg.query_entity(query_expanded)
                return [
                    {
                        "source": "kg",
                        "content": f"{t.get("subject_id", "?")} {t.get("predicate", "?")} {t.get("object_name", t.get("object_id", "?"))}",
                        "score": 1.0,
                        "metadata": {
                            "valid_from": t.valid_from.isoformat() if t.valid_from else None,
                            "valid_until": t.valid_until.isoformat() if t.valid_until else None,
                        },
                    }
                    for t in triples[:req.top_k]
                ]
            except Exception as e:
                logger.warning(f"KG query failed during retrieval: {e}")
                return []

        async def query_vector():
            if _vm is None:
                return []
            try:
                results = await _vm.search(query_expanded, limit=req.top_k, hybrid=True)
                return [
                    {
                        "source": "vector",
                        "content": getattr(r, "text", ""),
                        "score": getattr(r, "score", 0.0),
                        "metadata": getattr(r, "metadata", None),
                    }
                    for r in results
                ]
            except Exception as e:
                logger.warning(f"Vector search failed during retrieval: {e}")
                return []

        async def query_archive():
            if _archive is None:
                return []
            try:
                results = await _archive.search_fts(query_expanded, limit=req.top_k)
                return [
                    {
                        "source": "archive",
                        "content": str(getattr(r, "payload", "")),
                        "score": 1.0,
                        "metadata": {
                            "event_type": getattr(r, "event_type", None),
                            "agent_name": getattr(r, "agent_name", None),
                            "session_id": getattr(r, "session_id", None),
                            "timestamp": getattr(r, "timestamp", None).isoformat() if getattr(r, "timestamp", None) else None,
                        },
                    }
                    for r in results
                ]
            except Exception as e:
                logger.warning(f"Archive search failed during retrieval: {e}")
                return []

        kg_results, vector_results, archive_results = await asyncio.gather(
            query_kg(), query_vector(), query_archive()
        )

        # Merge with Reciprocal Rank Fusion
        all_results = _reciprocal_rank_fusion([kg_results, vector_results, archive_results])

        # Attempt reranking with CrossEncoder if available
        try:
            from taosmd import CrossEncoderReranker
            reranker = CrossEncoderReranker()
            all_results = reranker.rerank(query, all_results, limit=req.top_k)
        except (ImportError, Exception) as e:
            logger.debug(f"CrossEncoder reranker not available, skipping: {e}")
            all_results = all_results[:req.top_k]

    else:
        # Fast mode: simple intent-based routing
        # Heuristic: if query contains entity-like terms, prefer KG; otherwise vector
        has_entity = bool(re.search(r'\b[A-Z][a-zA-Z]{2,}\b', query) or '"' in query)
        has_temporal = bool(re.search(r'\b(when|before|after|since|until|last|previous|ago)\b', query, re.I))

        if has_temporal and _archive is not None:
            # Route to archive for temporal queries
            try:
                results = await _archive.search_fts(query_expanded, limit=req.top_k)
                all_results = [
                    {
                        "source": "archive",
                        "content": str(getattr(r, "payload", "")),
                        "score": 1.0,
                        "metadata": {
                            "event_type": getattr(r, "event_type", None),
                            "timestamp": getattr(r, "timestamp", None).isoformat() if getattr(r, "timestamp", None) else None,
                        },
                    }
                    for r in results
                ]
            except Exception as e:
                logger.warning(f"Archive search failed in fast mode: {e}")

        if has_entity and _kg is not None and len(all_results) < req.top_k:
            # Supplement with KG results for entity queries
            try:
                # Extract first entity-like term for KG query
                entity_match = re.search(r'\b([A-Z][a-zA-Z]{2,})\b', query)
                if entity_match:
                    triples = await _kg.query_entity(entity_match.group(1))
                    kg_items = [
                        {
                            "source": "kg",
                            "content": f"{t.get("subject_id", "?")} {t.get("predicate", "?")} {t.get("object_name", t.get("object_id", "?"))}",
                            "score": 0.9,
                            "metadata": None,
                        }
                        for t in triples[:req.top_k]
                    ]
                    all_results = all_results + kg_items
            except Exception as e:
                logger.warning(f"KG query failed in fast mode: {e}")

        if _vm is not None and len(all_results) < req.top_k:
            # Fill remaining slots with vector search
            try:
                results = await _vm.search(query_expanded, limit=req.top_k - len(all_results), hybrid=True)
                vector_items = [
                    {
                        "source": "vector",
                        "content": getattr(r, "text", ""),
                        "score": getattr(r, "score", 0.0),
                        "metadata": getattr(r, "metadata", None),
                    }
                    for r in results
                ]
                all_results = all_results + vector_items
            except Exception as e:
                logger.warning(f"Vector search failed in fast mode: {e}")

        # Sort by score descending
        all_results.sort(key=lambda r: r.get("score", 0.0), reverse=True)
        all_results = all_results[:req.top_k]

    # ── Token budget enforcement ──────────────────────────────────────────────
    # Filter by project_id when provided — only return results that belong to
    # this project or have no project tag (global facts like language preferences).
    if req.project_id:
        def _matches_project(item: dict) -> bool:
            meta = item.get("metadata") or {}
            # Archive results embed _project_id in the payload string
            content = item.get("content", "")
            item_project = meta.get("project_id") or meta.get("_project_id")
            if item_project:
                return item_project == req.project_id
            # If no project tag, allow through (global/cross-project facts)
            # but deprioritise by halving the score so project-specific results rank higher
            if f"_project_id" not in content:
                item["score"] = item.get("score", 0.5) * 0.5
                return True
            return False
        all_results = [r for r in all_results if _matches_project(r)]
        # Re-sort after score adjustment
        all_results.sort(key=lambda r: r.get("score", 0.0), reverse=True)

    # Truncate lower-scored results to fit within the token budget
    budget_remaining = token_budget
    trimmed_results = []
    for item in all_results:
        content = item.get("content", "")
        tokens = _estimate_tokens(content)
        if budget_remaining <= 0:
            break
        if tokens > budget_remaining:
            # Truncate content to fit remaining budget
            max_chars = budget_remaining * 4
            item = dict(item)
            item["content"] = content[:max_chars]
            tokens = budget_remaining
        trimmed_results.append(item)
        budget_remaining -= tokens

    token_count = token_budget - budget_remaining

    return RetrieveResponse(
        results=[
            RetrievalResult(
                source=r["source"],
                content=r["content"],
                score=r.get("score", 0.0),
                metadata=r.get("metadata"),
            )
            for r in trimmed_results
        ],
        token_count=token_count,
        query_expanded=query_expanded if query_expanded != query else None,
    )


# ── Extraction Model Endpoints ────────────────────────────────────────────────

import asyncio as _asyncio

# Semaphore for extraction model inference (concurrency=1)
# IMPORTANT: We share the SAME semaphore as the main inference in server.py
# because both models hit the Metal GPU. Concurrent Metal operations crash
# the process (SIGABRT in MTLCommandBuffer). By sharing the semaphore,
# extraction waits for main inference to finish and vice versa.
_extraction_semaphore: "_asyncio.Semaphore | None" = None


def _get_extraction_semaphore() -> "_asyncio.Semaphore":
    global _extraction_semaphore
    if _extraction_semaphore is None:
        # Try to use the main inference semaphore from server.py
        # so Metal operations are fully serialized across both models
        try:
            import importlib
            server = importlib.import_module("server")
            _extraction_semaphore = server._get_inference_semaphore()
        except Exception:
            # Fallback: own semaphore if server module isn't available
            _extraction_semaphore = _asyncio.Semaphore(1)
    return _extraction_semaphore


def _get_metal_lock():
    """Get the global Metal GPU threading lock from server.py."""
    try:
        import importlib
        server = importlib.import_module("server")
        return server.get_metal_lock()
    except Exception:
        return None

# Extraction queue state
_extraction_queue_depth = 0
_extraction_processing = False
_extraction_source = None  # "extraction_model" or "primary_model"

# Regex patterns for fast entity-relationship extraction (15ms)
_EXTRACTION_PATTERNS = [
    # "X uses Y", "X is a Y", "X has Y", "X works with Y" etc.
    re.compile(
        r'\b([A-Za-z][A-Za-z0-9_]{1,40})\s+'
        r'(uses|is a|is an|has|works with|depends on|created by|located in|'
        r'part of|related to|knows|owns|manages|implements|extends|imports|'
        r'calls|returns|contains|defines|exports|inherits from|conforms to)\s+'
        r'([A-Za-z][A-Za-z0-9_]{1,40})',
        re.I
    ),
    # CamelCase/PascalCase class/type relationships: "PhotoRanker: EmbeddingService"
    re.compile(r'\b([A-Z][a-zA-Z0-9]{2,40}):\s+([A-Z][a-zA-Z0-9]{2,40})'),
    # File path → component: extract top-level dir and filename as entities
    # e.g. "PhotoRanker/Services/EmbeddingService.swift" → PhotoRanker contains EmbeddingService
    re.compile(r'["\']([A-Z][a-zA-Z0-9]+)/(?:[^"\']+/)([A-Z][a-zA-Z0-9]+)\.[a-z]+["\']'),
    # "X.swift", "X.py", "X.js" → entity name extraction for tool call context
    # Produces (filename_stem, "is_file", extension) triples
    re.compile(r'\b([A-Z][a-zA-Z0-9]{2,40})\.(swift|py|js|ts|rs|kt|java|cpp|h)\b'),
    # "import X" / "from X import" patterns
    re.compile(r'\b(?:import|from)\s+([A-Za-z][A-Za-z0-9_.]{2,40})\b'),
]


def _regex_extract_triples(text: str) -> list[tuple[str, str, str]]:
    """Fast regex-based triple extraction (~15ms). Returns list of (subject, predicate, object)."""
    triples = []
    seen = set()  # deduplicate within a single extraction call

    for i, pattern in enumerate(_EXTRACTION_PATTERNS):
        for match in pattern.finditer(text):
            groups = match.groups()
            if i == 0 and len(groups) >= 3:
                # Standard S-P-O pattern
                triple = (groups[0], groups[1], groups[2])
            elif i == 1 and len(groups) == 2:
                # CamelCase key-value → "X is Y"
                triple = (groups[0], "is", groups[1])
            elif i == 2 and len(groups) == 2:
                # File path: component contains file
                triple = (groups[0], "contains", groups[1])
            elif i == 3 and len(groups) == 2:
                # Filename.ext → "X is_file ext"
                triple = (groups[0], "is_file", groups[1])
            elif i == 4 and len(groups) == 1:
                # import X → "codebase imports X"
                triple = ("codebase", "imports", groups[0])
            else:
                continue

            key = (triple[0].lower(), triple[1].lower(), triple[2].lower())
            if key not in seen:
                seen.add(key)
                triples.append(triple)

    return triples


@router.post("/extractor/load")
async def extractor_load(req: ExtractorLoadRequest):
    """Load a secondary Qwen3-4B model via MLX for async fact extraction.

    Checks Metal memory before loading: rejects with HTTP 507 if active
    memory > 92% of system RAM. Reports extraction model status via GET /memory/status.

    Returns HTTP 507 if insufficient memory, HTTP 500 on load failure.
    """
    global _extract_model, _extract_processor, _extraction_source, _extract_model_path, _extract_model_has_vision

    # Check Metal memory usage before loading
    try:
        import psutil
        total_ram = psutil.virtual_memory().total
        available_ram = psutil.virtual_memory().available
        used_fraction = (total_ram - available_ram) / total_ram
        if used_fraction > 0.92:
            raise HTTPException(
                status_code=507,
                detail=f"Insufficient memory: {used_fraction:.1%} of system RAM in use (limit: 92%). "
                       f"Unload other models before loading the extraction model."
            )
    except ImportError:
        logger.warning("psutil not available — skipping memory check before loading extraction model")
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Memory check failed: {e} — proceeding with load")

    try:
        import mlx_lm
        import mlx_vlm
        from mlx_vlm.utils import load_config as vlm_load_config
        import json
        from pathlib import Path as _Path

        logger.info(f"Loading extraction model: {req.model_path}")

        # Detect whether the model has real vision weights.
        # Load via mlx_vlm if it does (enables image analysis),
        # fall back to mlx_lm for text-only models.
        _has_vision = False
        try:
            _cfg_path = _Path(req.model_path) / "config.json"
            _idx_path = _Path(req.model_path) / "model.safetensors.index.json"
            if _cfg_path.exists():
                _cfg = json.loads(_cfg_path.read_text())
                _has_vision_cfg = "vision_config" in _cfg or "image_token_id" in _cfg
                # Check weight map if index exists; otherwise check for vision-related files
                if _idx_path.exists():
                    _idx = json.loads(_idx_path.read_text())
                    _has_vision_weights = any("vision" in k for k in _idx.get("weight_map", {}).keys())
                else:
                    # Single-file model — check for vision-related config files as proxy
                    _has_vision_weights = (
                        (_Path(req.model_path) / "preprocessor_config.json").exists() or
                        (_Path(req.model_path) / "processor_config.json").exists()
                    )
                _has_vision = _has_vision_cfg and _has_vision_weights
        except Exception as _e:
            logger.warning(f"Could not detect vision capability: {_e}")

        # If the same model is already loaded but as the wrong type (e.g. loaded as
        # text-only before vision-detection code existed), unload it first so we
        # can reload it correctly via mlx_vlm.
        if _extract_model is not None:
            already_correct = (_extract_model_path == req.model_path and _extract_model_has_vision == _has_vision)
            if not already_correct:
                logger.info(f"Unloading existing extraction model before reload (vision={_extract_model_has_vision} → {_has_vision})")
                _extract_model = None
                _extract_processor = None
                _extract_model_path = None
                _extract_model_has_vision = False
                import gc
                gc.collect()
                try:
                    import mlx.core as mx
                    mx.metal.clear_cache()
                except Exception:
                    pass

        if _has_vision:
            logger.info(f"Loading extraction model as vision-capable (mlx_vlm): {req.model_path}")
            _extract_model, _extract_processor = mlx_vlm.load(req.model_path)
        else:
            logger.info(f"Loading extraction model as text-only (mlx_lm): {req.model_path}")
            _extract_model, _extract_processor = mlx_lm.load(req.model_path)

        _extract_model_path = req.model_path
        _extract_model_has_vision = _has_vision
        _extraction_source = "extraction_model"
        logger.info(f"Extraction model loaded ({'vision' if _has_vision else 'text-only'}): {req.model_path}")
        return {
            "ok": True,
            "model": req.model_path,
            "vision": _has_vision,
            "message": f"Extraction model loaded ({'vision' if _has_vision else 'text-only'}): {req.model_path}",
        }
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail="mlx_lm is not installed — cannot load extraction model"
        )
    except Exception as e:
        logger.error(f"Failed to load extraction model: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to load extraction model: {e}"
        )


@router.post("/extractor/unload")
async def extractor_unload():
    """Unload the extraction model and free its Metal memory allocation."""
    global _extract_model, _extract_processor, _extraction_source, _extract_model_path, _extract_model_has_vision

    if _extract_model is None:
        return {"ok": True, "message": "No extraction model loaded"}

    try:
        _extract_model = None
        _extract_processor = None
        _extraction_source = None
        _extract_model_path = None
        _extract_model_has_vision = False
        import gc
        gc.collect()
        try:
            import mlx.core as mx
            mx.metal.clear_cache()
        except Exception:
            pass
        logger.info("Extraction model unloaded")
        return {"ok": True, "message": "Extraction model unloaded"}
    except Exception as e:
        logger.error(f"Failed to unload extraction model: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to unload extraction model: {e}"
        )


@router.post("/extract")
async def extract(req: ExtractRequest):
    """Trigger fact extraction from a conversation turn.

    Runs regex-based extraction first (15ms), then queues LLM extraction
    via Extraction_Model if available, or falls back to primary model.
    Stores extracted facts as triples in KG and adds turn to VectorMemory.

    Falls back to regex-only if no LLM model is available.
    """
    global _extraction_queue_depth, _extraction_processing, _last_extraction_at, _extraction_source

    # Apply secret filtering to message before extraction
    try:
        filtered_message = filter_secrets(req.message)
    except ValueError as e:
        logger.error(f"Secret filtering failed for extraction: {e}")
        return {"ok": False, "error": "Secret filtering failed"}

    # ── Step 1: Fast regex extraction (15ms) ─────────────────────────────────
    regex_triples = _regex_extract_triples(filtered_message)
    stored_count = 0

    if _kg is not None:
        for subject, predicate, obj in regex_triples:
            try:
                await _kg.add_triple(subject, predicate, obj)
                stored_count += 1
            except Exception as e:
                logger.warning(f"Failed to store regex triple ({subject}, {predicate}, {obj}): {e}")

    # ── Step 2: Add turn to VectorMemory ─────────────────────────────────────
    if _vm is not None:
        try:
            await _vm.add(filtered_message, metadata={
                "agent_name": req.agent_name,
                "session_id": req.session_id,
                "type": "conversation_turn",
            })
        except Exception as e:
            logger.warning(f"Failed to add turn to VectorMemory: {e}")

    # ── Step 3: Queue LLM extraction ─────────────────────────────────────────
    _extraction_queue_depth += 1

    async def _llm_extract():
        global _extraction_queue_depth, _extraction_processing, _last_extraction_at, _extraction_source

        async with _get_extraction_semaphore():
            _extraction_processing = True
            try:
                llm_triples = []

                if _extract_model is not None and _extract_processor is not None:
                    # Use dedicated extraction model
                    _extraction_source = "extraction_model"
                    try:
                        import mlx_lm
                        prompt = (
                            f"Extract entity-relationship triples from this text as JSON array. "
                            f"Format: [{{\"s\": \"subject\", \"p\": \"predicate\", \"o\": \"object\"}}]\n\n"
                            f"Text: {filtered_message[:500]}\n\nTriples:"
                        )
                        response = _extract_generate(prompt, max_tokens=200)
                        import json
                        # Extract JSON array from response
                        json_match = re.search(r'\[.*?\]', response, re.DOTALL)
                        if json_match:
                            triples_data = json.loads(json_match.group(0))
                            llm_triples = [(t.get("s", ""), t.get("p", ""), t.get("o", "")) for t in triples_data if isinstance(t, dict)]
                    except Exception as e:
                        logger.warning(f"LLM extraction with extraction model failed: {e}")

                else:
                    # Fall back to primary model via /v1/chat/completions
                    _extraction_source = "primary_model"
                    try:
                        import http.client
                        import json
                        server_url = os.environ.get("MLX_SERVER_URL", "http://localhost:8090")
                        host = server_url.replace("http://", "").replace("https://", "")
                        conn = http.client.HTTPConnection(host, timeout=30)
                        payload = json.dumps({
                            "model": "current",
                            "messages": [
                                {
                                    "role": "system",
                                    "content": "Extract entity-relationship triples as JSON array: [{\"s\": \"subject\", \"p\": \"predicate\", \"o\": \"object\"}]. Output only the JSON array."
                                },
                                {
                                    "role": "user",
                                    "content": filtered_message[:500]
                                }
                            ],
                            "max_tokens": 200,
                            "stream": False,
                        })
                        conn.request("POST", "/v1/chat/completions",
                                     body=payload,
                                     headers={"Content-Type": "application/json"})
                        resp = conn.getresponse()
                        if resp.status == 200:
                            data = json.loads(resp.read().decode())
                            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                            json_match = re.search(r'\[.*?\]', content, re.DOTALL)
                            if json_match:
                                triples_data = json.loads(json_match.group(0))
                                llm_triples = [(t.get("s", ""), t.get("p", ""), t.get("o", "")) for t in triples_data if isinstance(t, dict)]
                        conn.close()
                    except Exception as e:
                        logger.warning(f"LLM extraction with primary model failed: {e}")

                # Store LLM-extracted triples in KG
                if _kg is not None:
                    for subject, predicate, obj in llm_triples:
                        if subject and predicate and obj:
                            try:
                                await _kg.add_triple(subject, predicate, obj)
                            except Exception as e:
                                logger.warning(f"Failed to store LLM triple: {e}")

                _last_extraction_at = datetime.utcnow()

            except Exception as e:
                logger.error(f"LLM extraction failed: {e}")
            finally:
                _extraction_processing = False
                _extraction_queue_depth = max(0, _extraction_queue_depth - 1)

    # Fire-and-forget LLM extraction
    _asyncio.create_task(_llm_extract())

    return {
        "ok": True,
        "regex_triples_stored": stored_count,
        "llm_extraction_queued": True,
        "queue_depth": _extraction_queue_depth,
    }


@router.get("/extract/queue")
async def extract_queue():
    """Return extraction queue depth and processing status."""
    return {
        "queue_depth": _extraction_queue_depth,
        "processing": _extraction_processing,
        "extraction_source": _extraction_source,
        "last_extraction_at": _last_extraction_at.isoformat() if _last_extraction_at else None,
    }


# ── Session Management Endpoints ──────────────────────────────────────────────

@router.post("/session/enrich")
async def session_enrich(req: SessionEnrichRequest):
    """Run Session Catalog enrichment pipeline on a completed session.

    Performs topic extraction, description generation, and category assignment.
    Uses heuristic-only enrichment when Extraction_Model is not loaded (tier 1).
    Uses LLM-based enrichment when Extraction_Model is available (tier 2).

    Returns HTTP 503 if Archive is unavailable.
    """
    if _archive is None:
        raise HTTPException(
            status_code=503,
            detail="Archive is unavailable — cannot enrich session"
        )

    try:
        # Retrieve recent events for this session from the archive
        session_events = []
        try:
            all_events = await _archive.query(limit=100)
            session_events = [
                e for e in all_events
                if e.get("app_id") == req.session_id
            ]
        except Exception as e:
            logger.warning(f"Failed to retrieve session events for enrichment: {e}")

        # Build session text for analysis
        session_text = " ".join([
            str(_parse_archive_payload(e) or "") + " " + str(e.get("summary", ""))
            for e in session_events
        ])[:2000]  # Limit to 2000 chars for analysis

        enrichment = {
            "session_id": req.session_id,
            "event_count": len(session_events),
        }

        if _extract_model is not None and _extract_processor is not None and session_text:
            # Tier 2: LLM-based enrichment using extraction model
            try:
                import mlx_lm
                prompt = (
                    f"Analyze this conversation session and provide:\n"
                    f"1. topics: list of 3-5 main topics (comma-separated)\n"
                    f"2. description: one sentence summary\n"
                    f"3. category: one of [coding, debugging, planning, research, other]\n\n"
                    f"Session: {session_text[:500]}\n\n"
                    f"Output as JSON: {{\"topics\": \"...\", \"description\": \"...\", \"category\": \"...\"}}"
                )
                response = _extract_generate(prompt, max_tokens=150)
                import json
                json_match = re.search(r'\{.*?\}', response, re.DOTALL)
                if json_match:
                    llm_data = json.loads(json_match.group(0))
                    enrichment.update({
                        "topics": llm_data.get("topics", ""),
                        "description": llm_data.get("description", ""),
                        "category": llm_data.get("category", "other"),
                        "enrichment_tier": "llm",
                    })
                else:
                    raise ValueError("No JSON found in LLM response")
            except Exception as e:
                logger.warning(f"LLM enrichment failed, falling back to heuristic: {e}")
                # Fall through to heuristic enrichment

        if "enrichment_tier" not in enrichment:
            # Tier 1: Heuristic-only enrichment
            # Extract topics from most common words in session text
            words = re.findall(r'\b[a-zA-Z]{4,}\b', session_text.lower())
            word_freq = {}
            for w in words:
                word_freq[w] = word_freq.get(w, 0) + 1
            # Filter out common stop words
            stop_words = {'this', 'that', 'with', 'from', 'have', 'will', 'been', 'they', 'were', 'what', 'when', 'where', 'which', 'your', 'their', 'there', 'then', 'than', 'also', 'into', 'some', 'more', 'about', 'would', 'could', 'should'}
            topics = [w for w, _ in sorted(word_freq.items(), key=lambda x: -x[1]) if w not in stop_words][:5]

            enrichment.update({
                "topics": ", ".join(topics),
                "description": f"Session with {len(session_events)} events",
                "category": "other",
                "enrichment_tier": "heuristic",
            })

        logger.info(f"Session enriched: {req.session_id} (tier={enrichment.get('enrichment_tier')})")
        return {"ok": True, "enrichment": enrichment}

    except Exception as e:
        logger.error(f"Failed to enrich session {req.session_id}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to enrich session: {e}"
        )


@router.post("/session/crystallize")
async def session_crystallize(req: SessionCrystallizeRequest):
    """Generate a Crystal_Store digest for a session.

    Creates a narrative summary, outcomes, and lessons learned.
    Feeds extracted lessons back into the Knowledge Graph as triples.

    Returns HTTP 503 if Archive is unavailable.
    """
    if _archive is None:
        raise HTTPException(
            status_code=503,
            detail="Archive is unavailable — cannot crystallize session"
        )

    try:
        # Retrieve session events
        session_events = []
        try:
            all_events = await _archive.query(limit=200)
            session_events = [
                e for e in all_events
                if e.get("app_id") == req.session_id
            ]
        except Exception as e:
            logger.warning(f"Failed to retrieve session events for crystallization: {e}")

        session_text = " ".join([
            str(_parse_archive_payload(e) or "")
            for e in session_events
        ])[:3000]

        crystal = {
            "session_id": req.session_id,
            "event_count": len(session_events),
        }

        if _extract_model is not None and _extract_processor is not None and session_text:
            # LLM-based crystal generation
            try:
                import mlx_lm, json
                prompt = (
                    f"Summarize this coding session:\n"
                    f"1. summary: 2-3 sentence narrative\n"
                    f"2. outcomes: list of key outcomes (comma-separated)\n"
                    f"3. lessons: list of lessons learned (comma-separated)\n\n"
                    f"Session: {session_text[:800]}\n\n"
                    f"Output as JSON: {{\"summary\": \"...\", \"outcomes\": \"...\", \"lessons\": \"...\"}}"
                )
                response = _extract_generate(prompt, max_tokens=200)
                json_match = re.search(r'\{.*?\}', response, re.DOTALL)
                if json_match:
                    llm_data = json.loads(json_match.group(0))
                    crystal.update({
                        "summary": llm_data.get("summary", ""),
                        "outcomes": llm_data.get("outcomes", ""),
                        "lessons": llm_data.get("lessons", ""),
                        "crystal_tier": "llm",
                    })

                    # Feed lessons back into KG as triples
                    lessons_text = llm_data.get("lessons", "")
                    if lessons_text and _kg is not None:
                        lesson_triples = _regex_extract_triples(lessons_text)
                        for subject, predicate, obj in lesson_triples:
                            try:
                                await _kg.add_triple(subject, predicate, obj)
                            except Exception as e:
                                logger.warning(f"Failed to store lesson triple: {e}")
                else:
                    raise ValueError("No JSON found in LLM response")
            except Exception as e:
                logger.warning(f"LLM crystallization failed, using heuristic: {e}")

        if "crystal_tier" not in crystal:
            # Heuristic crystal generation
            crystal.update({
                "summary": f"Session {req.session_id} with {len(session_events)} events",
                "outcomes": "Session completed",
                "lessons": "",
                "crystal_tier": "heuristic",
            })

        logger.info(f"Session crystallized: {req.session_id}")
        return {"ok": True, "crystal": crystal}

    except Exception as e:
        logger.error(f"Failed to crystallize session {req.session_id}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to crystallize session: {e}"
        )


# ── Assist Endpoint ───────────────────────────────────────────────────────────

class AssistRequest(BaseModel):
    task_type: str
    payload: dict
    timeout_ms: Optional[int] = 60000


class AssistResponse(BaseModel):
    result: Optional[str] = None
    result_data: Optional[Any] = None
    elapsed_ms: int
    output_tokens: int


# Valid task_type values for the assist endpoint
_VALID_ASSIST_TASK_TYPES = frozenset({
    "vision",
    "todo_bootstrap",
    "todo_watch",
    "fetch_summarize",
    "tool_validate",
    "error_diagnose",
    "git_summarize",
    "rank_search",
    "extract_section",
    "detect_repetition",
    "route_task",
    "chat_reply",
})

# Legacy route_task support (kept for backward compatibility)
VALID_AGENT_TYPES = ["debug", "tester", "explore", "context-gather", "code-search", "requirements", "design", "implementation", "general"]

ROUTE_TASK_PROMPT = (
    "Classify this task into exactly one category. Reply with only the category name.\n\n"
    "Categories: explore, context-gather, code-search, requirements, design, debug, tester, implementation, general\n\n"
    "Rules:\n"
    "- tester: test, verify, check UI, playwright, browser test, e2e, screenshot, does it work, visual test, QA\n"
    "- debug: diagnose errors, crashes, failing tests, stack traces, root cause analysis\n"
    "- implementation: write, edit, fix, build, upgrade, migrate, install, create, add, update, render, parse\n"
    "- explore: understand, analyze, audit, review existing code\n"
    "- context-gather: find relevant files, dependencies\n"
    "- code-search: search, grep, locate symbols\n"
    "- requirements: define specs, user stories\n"
    "- design: architecture, schema, API design\n"
    "- general: anything else\n\n"
    "Task: {task}\n\nCategory:"
)


async def _assist_with_semaphore(handler_coro):
    """Run a handler coroutine under the extraction semaphore (concurrency=1)."""
    async with _get_extraction_semaphore():
        return await handler_coro


# ── Assist handler implementations ───────────────────────────────────────────

VISION_MAX_CHARS = 2000  # ~500 tokens


def _extract_generate(prompt: str, max_tokens: int = 400) -> str:
    """Generate text from the extraction model, handling both mlx_lm and mlx_vlm loaded models.

    When the model was loaded via mlx_vlm (vision-capable), mlx_lm.generate fails because
    the VLM processor (e.g. Qwen3VLProcessor) lacks eos_token_id. In that case we use
    mlx_vlm.generate with no image, which works for text-only prompts too.

    Holds the Metal GPU lock to prevent concurrent Metal operations with the
    main model's stream_generate (which runs in a separate thread).
    """
    import threading as _thr, sys as _sys
    _tid = _thr.current_thread().name
    metal_lock = _get_metal_lock()
    print(f"[metal-trace] _extract_generate: metal_lock id={id(metal_lock)} (thread={_tid})", file=_sys.stderr, flush=True)

    # Check both the flag and the processor type at runtime (self-heal for models
    # loaded before the vision-detection code existed)
    _processor_type = type(_extract_processor).__name__
    _is_vlm = _extract_model_has_vision or (
        hasattr(_extract_processor, 'image_processor') or
        'VL' in _processor_type or
        'Vision' in _processor_type or
        'vlm' in _processor_type.lower()
    )
    if _is_vlm:
        # Model loaded via mlx_vlm — use vlm generate with no image
        from mlx_vlm import generate as vlm_generate
        if metal_lock:
            print(f"[metal-trace] _extract_generate(vlm): acquiring _metal_lock (thread={_tid})", file=_sys.stderr, flush=True)
            with metal_lock:
                print(f"[metal-trace] _extract_generate(vlm): _metal_lock acquired (thread={_tid})", file=_sys.stderr, flush=True)
                result = vlm_generate(
                    _extract_model, _extract_processor,
                    prompt=prompt, max_tokens=max_tokens, verbose=False,
                )
                print(f"[metal-trace] _extract_generate(vlm): generate done, releasing lock (thread={_tid})", file=_sys.stderr, flush=True)
        else:
            print(f"[metal-trace] _extract_generate(vlm): NO metal_lock! (thread={_tid})", file=_sys.stderr, flush=True)
            result = vlm_generate(
                _extract_model, _extract_processor,
                prompt=prompt, max_tokens=max_tokens, verbose=False,
            )
        # vlm_generate returns GenerationResult — extract the text string
        return result.text if hasattr(result, 'text') else str(result)
    else:
        import mlx_lm
        if metal_lock:
            print(f"[metal-trace] _extract_generate(lm): acquiring _metal_lock (thread={_tid})", file=_sys.stderr, flush=True)
            with metal_lock:
                print(f"[metal-trace] _extract_generate(lm): _metal_lock acquired (thread={_tid})", file=_sys.stderr, flush=True)
                result = mlx_lm.generate(
                    _extract_model, _extract_processor,
                    prompt=prompt, max_tokens=max_tokens, verbose=False,
                )
                print(f"[metal-trace] _extract_generate(lm): generate done, releasing lock (thread={_tid})", file=_sys.stderr, flush=True)
                return result
        else:
            print(f"[metal-trace] _extract_generate(lm): NO metal_lock! (thread={_tid})", file=_sys.stderr, flush=True)
            return mlx_lm.generate(
                _extract_model, _extract_processor,
                prompt=prompt, max_tokens=max_tokens, verbose=False,
            )


async def _handle_vision(payload: dict) -> AssistResponse:
    """Vision — decode base64 image and describe it via the fast VLM model.

    Uses the extraction model which is loaded via mlx_vlm when it has vision
    weights (e.g. Qwen3.5-0.8B). Falls back gracefully if not available.
    """
    global _extract_model_has_vision, _extract_model, _extract_processor
    import time, base64, tempfile, os as _os
    t0 = time.monotonic()

    image_b64: str = payload.get("image_b64", "")
    mime_type: str = payload.get("mime_type", "image/png")
    prompt: str = payload.get("prompt", "Describe this image in detail.")

    if _extract_model is None or _extract_processor is None:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result=None, elapsed_ms=elapsed_ms, output_tokens=0)

    # If the extraction model was loaded as text-only (no vision weights),
    # it cannot process images — return None so the caller falls back gracefully.
    # Self-heal: if the flag is False but the model path has vision weights,
    # the model was loaded before vision-detection existed — reload it via mlx_vlm.
    if not _extract_model_has_vision:
        # Check if the model path actually has vision weights (config-based check)
        _can_heal = False
        if _extract_model_path:
            try:
                import json
                from pathlib import Path as _Path
                _cfg_path = _Path(_extract_model_path) / "config.json"
                _idx_path = _Path(_extract_model_path) / "model.safetensors.index.json"
                if _cfg_path.exists():
                    _cfg = json.loads(_cfg_path.read_text())
                    _has_vision_cfg = "vision_config" in _cfg or "image_token_id" in _cfg
                    if _idx_path.exists():
                        _idx = json.loads(_idx_path.read_text())
                        _has_vision_weights = any("vision" in k for k in _idx.get("weight_map", {}).keys())
                    else:
                        _has_vision_weights = (
                            (_Path(_extract_model_path) / "preprocessor_config.json").exists() or
                            (_Path(_extract_model_path) / "processor_config.json").exists()
                        )
                    _can_heal = _has_vision_cfg and _has_vision_weights
            except Exception:
                pass

        if _can_heal:
            logger.info(f"[_handle_vision] self-healing: reloading '{_extract_model_path}' via mlx_vlm (was loaded text-only)")
            try:
                import mlx_vlm as _mlx_vlm
                import gc
                _extract_model = None
                _extract_processor = None
                gc.collect()
                _heal_lock = _get_metal_lock()
                if _heal_lock:
                    with _heal_lock:
                        try:
                            import mlx.core as mx
                            mx.metal.clear_cache()
                        except Exception:
                            pass
                        _extract_model, _extract_processor = _mlx_vlm.load(_extract_model_path)
                else:
                    try:
                        import mlx.core as mx
                        mx.metal.clear_cache()
                    except Exception:
                        pass
                    _extract_model, _extract_processor = _mlx_vlm.load(_extract_model_path)
                _extract_model_has_vision = True
                logger.info(f"[_handle_vision] self-heal reload complete — vision now enabled")
            except Exception as _heal_err:
                logger.warning(f"[_handle_vision] self-heal reload failed: {_heal_err}")
                elapsed_ms = int((time.monotonic() - t0) * 1000)
                return AssistResponse(result=None, elapsed_ms=elapsed_ms, output_tokens=0)
        else:
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            logger.debug("[_handle_vision] extraction model is text-only, cannot process images")
            return AssistResponse(result=None, elapsed_ms=elapsed_ms, output_tokens=0)

    try:
        from mlx_vlm import generate as vlm_generate
        from mlx_vlm.prompt_utils import apply_chat_template as vlm_apply_chat_template
        from mlx_vlm.utils import load_config as vlm_load_config

        # Decode the base64 image to a temp file
        image_data = base64.b64decode(image_b64)
        ext = mime_type.split("/")[-1].replace("jpeg", "jpg")
        with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False) as tmp:
            tmp.write(image_data)
            tmp_path = tmp.name

        try:
            # Build prompt with image tokens — required for Qwen3.5 VLM models.
            # apply_chat_template injects <|vision_start|><|image_pad|><|vision_end|>
            # so the model knows where to place image features in the embedding.
            _vlm_config = vlm_load_config(_extract_model_path)
            formatted_prompt = vlm_apply_chat_template(
                _extract_processor, _vlm_config, prompt, num_images=1
            )
            _vision_metal_lock = _get_metal_lock()
            if _vision_metal_lock:
                with _vision_metal_lock:
                    response = vlm_generate(
                        _extract_model,
                        _extract_processor,
                        prompt=formatted_prompt,
                        image=tmp_path,
                        max_tokens=512,
                        verbose=False,
                    )
            else:
                response = vlm_generate(
                    _extract_model,
                    _extract_processor,
                    prompt=formatted_prompt,
                    image=tmp_path,
                    max_tokens=512,
                    verbose=False,
                )
        finally:
            try:
                _os.unlink(tmp_path)
            except Exception:
                pass

        description = response.text if hasattr(response, 'text') else (response if isinstance(response, str) else str(response))
        description = description[:VISION_MAX_CHARS]
        output_tokens = len(description) // 4
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result=description, elapsed_ms=elapsed_ms, output_tokens=output_tokens)

    except Exception as e:
        logger.warning(f"[_handle_vision] failed: {e}", exc_info=True)
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result=None, elapsed_ms=elapsed_ms, output_tokens=0)


async def _handle_todo_bootstrap(payload: dict) -> AssistResponse:
    """2.2 Todo bootstrap — generate initial todo list from user prompt."""
    import time, json
    t0 = time.monotonic()

    user_prompt: str = payload.get("user_prompt", "")

    try:
        import mlx_lm
        prompt = (
            "You are a task planner. Break the user's request into 3-5 DISTINCT implementation steps.\n"
            "Each step must be a DIFFERENT action — never repeat the same task.\n"
            "Each item must have: id (integer starting at 1), content (string describing ONE specific step), status (\"pending\").\n"
            "Output ONLY the JSON array, no explanation.\n\n"
            "Example for \"build a calculator app\":\n"
            '[{"id":1,"content":"Create HTML layout with display and buttons","status":"pending"},'
            '{"id":2,"content":"Add CSS styling for calculator grid","status":"pending"},'
            '{"id":3,"content":"Implement JS calculation logic","status":"pending"},'
            '{"id":4,"content":"Add keyboard input support","status":"pending"}]\n\n'
            f"User request: {user_prompt[:800]}\n\nTodos:"
        )
        response = _extract_generate(prompt, max_tokens=400)
        json_match = re.search(r'\[.*?\]', response, re.DOTALL)
        if not json_match:
            raise ValueError("No JSON array found in response")
        todos_raw = json.loads(json_match.group(0))
        todos = []
        seen_content = set()
        for item in todos_raw:
            if not isinstance(item, dict):
                continue
            item_id = item.get("id")
            content = item.get("content")
            status = item.get("status", "pending")
            if not isinstance(item_id, int) or not isinstance(content, str) or not content.strip():
                continue
            # Deduplicate: skip items whose content matches a previous item (case-insensitive)
            content_key = content.strip().lower()
            if content_key in seen_content:
                continue
            seen_content.add(content_key)
            todos.append({"id": len(todos) + 1, "content": content, "status": "pending"})

        output_tokens = len(response) // 4
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result_data=todos if todos else None, elapsed_ms=elapsed_ms, output_tokens=output_tokens)

    except Exception as e:
        logger.warning(f"[_handle_todo_bootstrap] failed: {e}")
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result_data=None, elapsed_ms=elapsed_ms, output_tokens=0)


async def _handle_todo_watch(payload: dict) -> AssistResponse:
    """2.3 Todo watch — infer status changes from a tool result (never add items or change content)."""
    import time, json
    t0 = time.monotonic()

    tool_name: str = payload.get("tool_name", "")
    tool_result: str = payload.get("tool_result", "")
    current_todos: list = payload.get("current_todos", [])

    if not current_todos:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result_data=None, elapsed_ms=elapsed_ms, output_tokens=0)

    try:
        import mlx_lm
        todos_json = json.dumps(current_todos)
        prompt = (
            "You are a todo status tracker. A tool just ran — infer which todo items changed status.\n"
            "Rules:\n"
            "- ONLY change status: pending→in_progress or in_progress→done\n"
            "- NEVER add new items, remove items, or change content\n"
            "- If nothing changed, output the original array unchanged\n"
            "- Output ONLY the JSON array, no explanation\n\n"
            f"Tool: {tool_name}\n"
            f"Tool result (first 600 chars): {tool_result[:600]}\n\n"
            f"Current todos: {todos_json}\n\nUpdated todos:"
        )
        response = _extract_generate(prompt, max_tokens=400)
        json_match = re.search(r'\[.*?\]', response, re.DOTALL)
        if not json_match:
            raise ValueError("No JSON array found in response")
        updated_raw = json.loads(json_match.group(0))

        # Enforce invariants: same length, same ids and content, only valid status transitions
        if len(updated_raw) != len(current_todos):
            raise ValueError("Updated todos length mismatch — discarding")

        valid_transitions = {("pending", "in_progress"), ("in_progress", "done")}
        updated = []
        has_change = False
        for orig, upd in zip(current_todos, updated_raw):
            if not isinstance(upd, dict):
                raise ValueError("Non-dict item in updated todos")
            # Preserve id and content from original
            new_status = upd.get("status", orig.get("status"))
            orig_status = orig.get("status")
            if new_status != orig_status:
                if (orig_status, new_status) not in valid_transitions:
                    new_status = orig_status  # reject invalid transition
                else:
                    has_change = True
            updated.append({"id": orig["id"], "content": orig["content"], "status": new_status})

        output_tokens = len(response) // 4
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(
            result_data=updated if has_change else None,
            elapsed_ms=elapsed_ms,
            output_tokens=output_tokens,
        )

    except Exception as e:
        logger.warning(f"[_handle_todo_watch] failed: {e}")
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result_data=None, elapsed_ms=elapsed_ms, output_tokens=0)


async def _handle_fetch_summarize(payload: dict) -> AssistResponse:
    """2.4 Fetch summarize — summarize large web content, preserving key facts."""
    import time
    t0 = time.monotonic()

    url: str = payload.get("url", "")
    raw_content: str = payload.get("raw_content", "")
    max_output_tokens: int = int(payload.get("max_output_tokens", 512))

    try:
        import mlx_lm
        prompt = (
            "Summarize the following web page content. Preserve:\n"
            "- Page title\n"
            "- Key facts and main points\n"
            "- All URLs and links mentioned\n"
            "- Code snippets (verbatim)\n"
            "- Error messages (verbatim)\n"
            "- Structured data (tables, lists)\n"
            "Be concise but complete. Do not omit technical details.\n\n"
            f"URL: {url}\n\n"
            f"Content:\n{raw_content[:6000]}\n\nSummary:"
        )
        response = _extract_generate(prompt, max_tokens=max_output_tokens)
        summary = response.strip() if isinstance(response, str) else str(response).strip()
        output_tokens = len(summary) // 4
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result=summary, elapsed_ms=elapsed_ms, output_tokens=output_tokens)

    except Exception as e:
        logger.warning(f"[_handle_fetch_summarize] failed: {e}")
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result=None, elapsed_ms=elapsed_ms, output_tokens=0)


async def _handle_tool_validate(payload: dict) -> AssistResponse:
    """2.5 Tool validate — check tool-specific preconditions without calling the model for simple cases."""
    import time, shlex
    t0 = time.monotonic()

    tool_name: str = payload.get("tool_name", "")
    tool_args: dict = payload.get("tool_args", {})
    recent_context: str = payload.get("recent_context", "")

    def _ok():
        elapsed = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result_data={"valid": True, "reason": "ok"}, elapsed_ms=elapsed, output_tokens=0)

    def _fail(reason: str):
        elapsed = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result_data={"valid": False, "reason": reason}, elapsed_ms=elapsed, output_tokens=0)

    try:
        if tool_name == "edit_file":
            old_string = tool_args.get("old_string", "")
            if old_string and recent_context and old_string not in recent_context:
                return _fail(
                    f"old_string not found in recent context — the file may have changed. "
                    f"Re-read the file before retrying edit_file."
                )
            return _ok()

        elif tool_name == "bash":
            command: str = tool_args.get("command", "")
            # Check for unclosed quotes
            try:
                shlex.split(command)
            except ValueError as e:
                return _fail(f"Bash command has a syntax error: {e}")
            # Flag empty command
            if not command.strip():
                return _fail("Bash command is empty.")
            return _ok()

        elif tool_name == "write_file":
            path = tool_args.get("path", "")
            content = tool_args.get("content")
            if not path:
                return _fail("write_file requires a non-empty 'path' field.")
            if content is None:
                return _fail("write_file requires a 'content' field.")
            return _ok()

        elif tool_name == "read_file":
            path = tool_args.get("path", "")
            if not path:
                return _fail("read_file requires a non-empty 'path' field.")
            return _ok()

        else:
            # Unknown tool — pass through
            return _ok()

    except Exception as e:
        logger.warning(f"[_handle_tool_validate] failed: {e}")
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result_data={"valid": True, "reason": "validation error — proceeding"}, elapsed_ms=elapsed_ms, output_tokens=0)


async def _handle_error_diagnose(payload: dict) -> AssistResponse:
    """2.6 Error diagnose — produce a single-sentence root cause + fix suggestion (≤100 tokens)."""
    import time, re
    t0 = time.monotonic()

    tool_name: str = payload.get("tool_name", "")
    tool_args: dict = payload.get("tool_args", {})
    error_message: str = payload.get("error_message", "")
    recent_context: str = payload.get("recent_context", "")

    # Fast-path: for well-known OS-level errors, return a grounded diagnosis
    # directly without calling the model — avoids hallucination on clear errors.
    _FAST_PATTERNS = [
        (r"No such file or directory", "The path does not exist — check the directory name and ensure it has been created before running this command."),
        (r"Permission denied", "The process lacks permission to access this path — check file/directory permissions."),
        (r"command not found", "The command is not installed or not on PATH — install it or use its full path."),
        (r"Is a directory", "A directory was given where a file was expected — provide a file path instead."),
        (r"Not a directory", "A file was given where a directory was expected — provide a directory path instead."),
        (r"File exists", "The target file already exists — remove it first or use a different destination path."),
        (r"Connection refused", "The server is not running or is not listening on the expected port — start the server first."),
        (r"Broken pipe", "The receiving process closed before all data was written — check that the downstream command is running correctly."),
        (r"timed out or exceeded output limit", "The command produced too much output or ran too long — use read_file instead of cat/head/tail for source files, or narrow the command scope."),
        (r"output limit", "The command output exceeded the 2MB limit — split into smaller commands or use read_file with line ranges instead of cat."),
        (r"stderr may have been suppressed", "The command failed silently (stderr was redirected to /dev/null) — remove 2>/dev/null to see the real error, or check if the path exists first."),
    ]
    for pattern, diagnosis in _FAST_PATTERNS:
        if re.search(pattern, error_message, re.IGNORECASE):
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            return AssistResponse(result=diagnosis, elapsed_ms=elapsed_ms, output_tokens=len(diagnosis) // 4)

    try:
        import mlx_lm, json
        args_summary = json.dumps(tool_args, ensure_ascii=False)[:300]
        # Keep the prompt tightly grounded in the literal error text.
        # Instruct the model NOT to invent causes — it must quote or paraphrase
        # the actual error message as the basis for its diagnosis.
        prompt = (
            "You are a debugging assistant. Read the EXACT error message below carefully.\n"
            "In ONE sentence (≤80 tokens), state what the error message says went wrong and "
            "suggest the most likely fix. Do NOT invent causes that are not in the error text.\n\n"
            f"Tool: {tool_name}\n"
            f"Args: {args_summary}\n"
            f"Exact error message: {error_message[:500]}\n\n"
            "One-sentence diagnosis (based only on the error message above):"
        )
        response = _extract_generate(prompt, max_tokens=100)
        diagnosis = response.strip().split("\n")[0]  # take first line only
        output_tokens = len(diagnosis) // 4
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result=diagnosis, elapsed_ms=elapsed_ms, output_tokens=output_tokens)

    except Exception as e:
        logger.warning(f"[_handle_error_diagnose] failed: {e}")
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result=None, elapsed_ms=elapsed_ms, output_tokens=0)


async def _handle_git_summarize(payload: dict) -> AssistResponse:
    """2.7 Git summarize — summarize git output preserving key facts."""
    import time
    t0 = time.monotonic()

    command: str = payload.get("command", "")
    raw_output: str = payload.get("raw_output", "")

    try:
        import mlx_lm
        prompt = (
            "Summarize this git command output. Preserve:\n"
            "- Current branch name\n"
            "- Number of files changed\n"
            "- File names (all of them)\n"
            "- Short commit hashes and commit messages\n"
            "- Merge conflicts (if any)\n"
            "- Untracked files (if any)\n"
            "Be concise. Do not omit file names or commit hashes.\n\n"
            f"Command: {command}\n\n"
            f"Output:\n{raw_output[:4000]}\n\nSummary:"
        )
        response = _extract_generate(prompt, max_tokens=300)
        summary = response.strip() if isinstance(response, str) else str(response).strip()
        output_tokens = len(summary) // 4
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result=summary, elapsed_ms=elapsed_ms, output_tokens=output_tokens)

    except Exception as e:
        logger.warning(f"[_handle_git_summarize] failed: {e}")
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result=None, elapsed_ms=elapsed_ms, output_tokens=0)


async def _handle_rank_search(payload: dict) -> AssistResponse:
    """2.8 Rank search — rank search results by relevance to task context."""
    import time
    t0 = time.monotonic()

    pattern: str = payload.get("pattern", "")
    results: list = payload.get("results", [])
    task_context: str = payload.get("task_context", "")

    if not results:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result_data=[], elapsed_ms=elapsed_ms, output_tokens=0)

    try:
        # Fast heuristic ranking (no model call needed for most cases):
        # 1. Exact match to task_context tokens (highest)
        # 2. Proximity to recently mentioned files in task_context (medium)
        # 3. Match frequency / position (lowest — preserve original order as tiebreak)
        context_lower = task_context.lower()
        context_tokens = set(re.findall(r'\w+', context_lower))

        def _score(result_line: str) -> float:
            line_lower = result_line.lower()
            line_tokens = set(re.findall(r'\w+', line_lower))
            # Exact substring match in context
            exact_bonus = 2.0 if pattern.lower() in context_lower else 0.0
            # Token overlap with task context
            overlap = len(line_tokens & context_tokens) / max(len(line_tokens), 1)
            # File path mentioned in context
            # Extract file path portion (before the first colon or space)
            path_match = re.match(r'^([^\s:]+)', result_line)
            path_bonus = 0.0
            if path_match:
                path = path_match.group(1).lower()
                if path in context_lower:
                    path_bonus = 1.5
            return exact_bonus + overlap + path_bonus

        scored = sorted(enumerate(results), key=lambda x: _score(x[1]), reverse=True)
        ranked = [results[i] for i, _ in scored]

        output_tokens = 0
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result_data=ranked, elapsed_ms=elapsed_ms, output_tokens=output_tokens)

    except Exception as e:
        logger.warning(f"[_handle_rank_search] failed: {e}")
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result_data=results, elapsed_ms=elapsed_ms, output_tokens=0)


async def _handle_extract_section(payload: dict) -> AssistResponse:
    """2.9 Extract section — use the fast model to identify and return the most relevant
    contiguous block of a large file for the current task context.

    Falls back to token-overlap heuristic if the model call fails or is unavailable.
    """
    import time, asyncio
    t0 = time.monotonic()

    file_path: str = payload.get("file_path", "")
    file_content: str = payload.get("file_content", "")
    task_context: str = payload.get("task_context", "")

    lines = file_content.splitlines()
    if not lines:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result=file_content, elapsed_ms=elapsed_ms, output_tokens=0)

    total_lines = len(lines)

    # ── Fast model path ───────────────────────────────────────────────────────
    if _extract_model is not None and _extract_processor is not None:
        try:
            import mlx_lm

            # Build a compact file outline: line numbers + first 80 chars per line
            # Cap at 300 lines to keep the prompt small
            sample_step = max(1, total_lines // 300)
            outline_lines = []
            for i in range(0, total_lines, sample_step):
                outline_lines.append(f"{i+1}: {lines[i][:80]}")
            outline = "\n".join(outline_lines)

            prompt = (
                f"You are a code navigation assistant. Given a file outline and a task, "
                f"identify the single most relevant line number to start reading from.\n\n"
                f"Task: {task_context[:300]}\n\n"
                f"File: {file_path}\n"
                f"Outline (line: content):\n{outline}\n\n"
                f"Reply with ONLY a single integer line number (1-indexed). No explanation."
            )

            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: _extract_generate(prompt, max_tokens=8)
            )

            # Parse the line number from the response
            import re as _re
            match = _re.search(r'\d+', response.strip())
            if match:
                anchor = max(0, min(int(match.group()) - 1, total_lines - 1))
                start = max(0, anchor - 30)
                end = min(total_lines, anchor + 51)
                extracted = "\n".join(lines[start:end])
                elapsed_ms = int((time.monotonic() - t0) * 1000)
                logger.debug(f"[extract_section] fast model → anchor line {anchor+1}, extracted {start+1}-{end} ({elapsed_ms}ms)")
                return AssistResponse(
                    result=f"[Lines {start+1}-{end} of {total_lines} — fast model selected this section]\n\n{extracted}",
                    elapsed_ms=elapsed_ms,
                    output_tokens=len(extracted) // 4,
                )
        except Exception as e:
            logger.warning(f"[_handle_extract_section] fast model failed, falling back to heuristic: {e}")

    # ── Heuristic fallback: token-overlap scoring ─────────────────────────────
    try:
        context_tokens = set(re.findall(r'\w+', task_context.lower()))

        def _line_score(line: str) -> float:
            line_tokens = set(re.findall(r'\w+', line.lower()))
            if not line_tokens:
                return 0.0
            return len(line_tokens & context_tokens) / len(line_tokens)

        scores = [_line_score(line) for line in lines]
        best_idx = max(range(len(scores)), key=lambda i: scores[i])
        start = max(0, best_idx - 30)
        end = min(total_lines, best_idx + 51)
        extracted = "\n".join(lines[start:end])

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(
            result=f"[Lines {start+1}-{end} of {total_lines} — heuristic section extraction]\n\n{extracted}",
            elapsed_ms=elapsed_ms,
            output_tokens=len(extracted) // 4,
        )

    except Exception as e:
        logger.warning(f"[_handle_extract_section] heuristic failed: {e}")
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result=None, elapsed_ms=elapsed_ms, output_tokens=0)


async def _handle_detect_repetition(payload: dict) -> AssistResponse:
    """2.10 Detect repetition — detect semantic loops, planning loops, and tool retry loops."""
    import time
    t0 = time.monotonic()

    recent_responses: list = payload.get("recent_responses", [])

    if len(recent_responses) < 2:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result_data={"repeating": False}, elapsed_ms=elapsed_ms, output_tokens=0)

    try:
        # Heuristic detection (fast, no model call):

        # 1. Planning loop: multiple responses starting with "I will" without action verbs
        planning_phrases = [r for r in recent_responses if re.search(r'\bI will\b', r, re.I)]
        if len(planning_phrases) >= 2:
            # Check if they're semantically similar (share many tokens)
            tokens_sets = [set(re.findall(r'\w+', r.lower())) for r in planning_phrases]
            if len(tokens_sets) >= 2:
                overlap = len(tokens_sets[0] & tokens_sets[1]) / max(len(tokens_sets[0] | tokens_sets[1]), 1)
                if overlap > 0.5:
                    elapsed_ms = int((time.monotonic() - t0) * 1000)
                    return AssistResponse(
                        result_data={"repeating": True, "reason": "Planning loop detected: repeated 'I will...' without action."},
                        elapsed_ms=elapsed_ms, output_tokens=0,
                    )

        # 2. Semantic similarity: last two responses share >70% token overlap
        if len(recent_responses) >= 2:
            last_two = recent_responses[-2:]
            tok_a = set(re.findall(r'\w+', last_two[0].lower()))
            tok_b = set(re.findall(r'\w+', last_two[1].lower()))
            union = tok_a | tok_b
            if union:
                similarity = len(tok_a & tok_b) / len(union)
                if similarity > 0.7:
                    elapsed_ms = int((time.monotonic() - t0) * 1000)
                    return AssistResponse(
                        result_data={"repeating": True, "reason": f"Semantic loop detected: last two responses are {similarity:.0%} similar."},
                        elapsed_ms=elapsed_ms, output_tokens=0,
                    )

        # 3. Exact duplicate detection
        if len(set(r.strip() for r in recent_responses)) == 1:
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            return AssistResponse(
                result_data={"repeating": True, "reason": "Exact duplicate responses detected."},
                elapsed_ms=elapsed_ms, output_tokens=0,
            )

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result_data={"repeating": False}, elapsed_ms=elapsed_ms, output_tokens=0)

    except Exception as e:
        logger.warning(f"[_handle_detect_repetition] failed: {e}")
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result_data={"repeating": False}, elapsed_ms=elapsed_ms, output_tokens=0)


async def _handle_route_task(payload: dict) -> AssistResponse:
    """Route a task to the best agent type using the extraction model."""
    import time
    t0 = time.monotonic()

    task_text = payload.get("task", "")[:300]
    if not task_text:
        return AssistResponse(result_data={"agent_type": "general"}, elapsed_ms=0, output_tokens=0)

    try:
        import mlx_lm, asyncio
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: _extract_generate(ROUTE_TASK_PROMPT.format(task=task_text), max_tokens=10)
        )
        agent_type = "general"
        response_lower = response.strip().lower()
        logger.debug(f"[assist/route_task] raw model output: {response_lower!r}")
        # Search for any valid type anywhere in the response — first match wins
        for candidate in VALID_AGENT_TYPES:
            if candidate in response_lower:
                agent_type = candidate
                break
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.debug(f"[assist/route_task] {task_text[:60]!r} → {agent_type} ({elapsed_ms}ms)")
        return AssistResponse(result_data={"agent_type": agent_type}, elapsed_ms=elapsed_ms, output_tokens=len(response.split()))
    except Exception as e:
        logger.warning(f"[assist/route_task] failed: {e}")
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result_data={"agent_type": "general"}, elapsed_ms=elapsed_ms, output_tokens=0)


async def _handle_chat_reply(payload: dict) -> AssistResponse:
    """2.11 Chat reply — generate a short, punchy acknowledgement before the main agent starts.

    Uses the fast 0.8B model to immediately respond to the user's message with
    1-2 sentences in an energetic, action-oriented tone ("on it" vibes).

    Key fixes vs raw-prompt approach:
    - Uses apply_chat_template so the model sees a proper chat turn (not a raw
      completion prompt that triggers thinking mode on Qwen3 models).
    - Appends /no_think to the system prompt to suppress <think> blocks.
    - Strips all special tokens, thinking artifacts, and tool call leakage from
      the output before returning.
    """
    import time, asyncio, re as _re
    t0 = time.monotonic()

    user_message: str = payload.get("user_message", "")
    agent_role: str = payload.get("agent_role", "general")

    if not user_message or _extract_model is None or _extract_processor is None:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result=None, elapsed_ms=elapsed_ms, output_tokens=0)

    try:
        import mlx_lm

        # Role-specific energy — tailor the vibe to what the agent is about to do
        role_context = {
            "implementation": "writing code",
            "explore":        "exploring the codebase",
            "context-gather": "gathering context",
            "code-search":    "searching the code",
            "debug":          "debugging",
            "tester":         "running tests",
            "requirements":   "working on requirements",
            "design":         "working on the design",
        }.get(agent_role, "on it")

        system_prompt = (
            "You are a fast coding assistant giving a brief, energetic acknowledgement. "
            "Reply in 1-2 short sentences max. Be direct, confident, and action-oriented — "
            "like a skilled engineer who just got the task and is already moving. "
            "No markdown, no lists, no code blocks, no tool calls, no XML tags. "
            "Examples of good replies: "
            "'On it — reading through the codebase now.' "
            "'Got it, fixing that bug right away.' "
            "'Sure, I'll refactor that component.' "
            "/no_think"
        )

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message[:400]},
        ]

        # Use apply_chat_template so the model sees a proper chat format.
        # add_generation_prompt=True appends the assistant turn start token.
        # Falls back to raw prompt if the tokenizer doesn't support chat templates.
        try:
            prompt = _extract_processor.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
        except Exception:
            # Fallback for tokenizers without chat template support
            prompt = (
                f"System: {system_prompt}\n\n"
                f"User: {user_message[:400]}\n\n"
                f"Assistant:"
            )

        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: _extract_generate(prompt, max_tokens=60)
        )

        reply = response.strip()

        # ── Strip all artifacts ───────────────────────────────────────────────

        # 1. Thinking blocks — <think>...</think> (Qwen3 thinking mode)
        reply = _re.sub(r'<think>[\s\S]*?</think>', '', reply, flags=_re.IGNORECASE).strip()
        # 2. Unclosed think block (model was cut off mid-think)
        reply = _re.sub(r'<think>[\s\S]*$', '', reply, flags=_re.IGNORECASE).strip()

        # 3. Special tokens: <|im_start|>, <|im_end|>, <|endoftext|>, <lm_start>, etc.
        reply = _re.sub(r'<\|[^|>]+\|>', '', reply).strip()
        reply = _re.sub(r'</?(?:lm_start|lm_end|s|eos|bos|pad|unk)>', '', reply, flags=_re.IGNORECASE).strip()

        # 4. Tool call leakage
        reply = _re.sub(r'<tool_call>[\s\S]*?</tool_call>', '', reply, flags=_re.IGNORECASE).strip()
        reply = _re.sub(r'<(?:function_call|invoke|tool_use)[\s\S]*?</(?:function_call|invoke|tool_use)>', '', reply, flags=_re.IGNORECASE).strip()
        reply = _re.sub(r'\{"tool_calls"[\s\S]*?\}(?:\s*\})?', '', reply).strip()

        # 5. Role prefixes the model might echo
        for prefix in ("Assistant:", "assistant:", "Brief acknowledgement:", "AI:", "Response:"):
            if reply.startswith(prefix):
                reply = reply[len(prefix):].strip()

        # 6. Take only the first 1-2 sentences — ignore anything after
        sentences = _re.split(r'(?<=[.!?])\s+', reply)
        reply = ' '.join(sentences[:2]).strip()

        # 7. Final sanity — must be non-empty plain text
        if not reply or len(reply) < 4 or '<' in reply:
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            return AssistResponse(result=None, elapsed_ms=elapsed_ms, output_tokens=0)

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.debug(f"[chat_reply] {elapsed_ms}ms ({role_context}): {reply[:80]!r}")
        return AssistResponse(result=reply, elapsed_ms=elapsed_ms, output_tokens=len(reply.split()))

    except Exception as e:
        logger.warning(f"[_handle_chat_reply] failed: {e}")
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return AssistResponse(result=None, elapsed_ms=elapsed_ms, output_tokens=0)


_ASSIST_HANDLERS = {
    "vision": _handle_vision,
    "todo_bootstrap": _handle_todo_bootstrap,
    "todo_watch": _handle_todo_watch,
    "fetch_summarize": _handle_fetch_summarize,
    "tool_validate": _handle_tool_validate,
    "error_diagnose": _handle_error_diagnose,
    "git_summarize": _handle_git_summarize,
    "rank_search": _handle_rank_search,
    "extract_section": _handle_extract_section,
    "detect_repetition": _handle_detect_repetition,
    "route_task": _handle_route_task,
    "chat_reply": _handle_chat_reply,
}


@router.post("/assist")
async def assist(req: AssistRequest):
    """Lightweight assist endpoint — routes tasks to the extraction model.

    Supports 10 task types: vision, todo_bootstrap, todo_watch, fetch_summarize,
    tool_validate, error_diagnose, git_summarize, rank_search, extract_section,
    detect_repetition.

    Returns HTTP 400 for unknown task_type.
    Returns HTTP 503 with degraded=true when no extraction model is loaded.
    Returns HTTP 504 on timeout (60s).
    """
    import asyncio
    import time

    # Validate task_type
    if req.task_type not in _VALID_ASSIST_TASK_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported task_type: {req.task_type!r}. "
                   f"Valid values: {sorted(_VALID_ASSIST_TASK_TYPES)}"
        )

    # Degrade gracefully when no extraction model is loaded
    if _extract_model is None:
        logger.debug(f"[assist/{req.task_type}] degraded — no extraction model loaded")
        return {"degraded": True, "reason": "no extraction model loaded"}

    # Apply _fail_closed_filter to all string fields in payload before dispatch
    filtered_payload: dict = {}
    for k, v in req.payload.items():
        if isinstance(v, str):
            filtered_payload[k] = _fail_closed_filter(v)
        elif isinstance(v, list):
            filtered_payload[k] = [
                _fail_closed_filter(item) if isinstance(item, str) else item
                for item in v
            ]
        else:
            filtered_payload[k] = v

    handler = _ASSIST_HANDLERS[req.task_type]
    t0 = time.monotonic()

    try:
        response: AssistResponse = await _asyncio.wait_for(
            _assist_with_semaphore(handler(filtered_payload)),
            timeout=60.0,
        )
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.debug(
            f"[assist/{req.task_type}] completed in {elapsed_ms}ms, "
            f"output_tokens={response.output_tokens}"
        )
        return response

    except _asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Assist task timed out")
    except Exception as e:
        logger.error(f"[assist/{req.task_type}] failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))






