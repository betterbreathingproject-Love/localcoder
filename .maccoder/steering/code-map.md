---
name: Code Map
description: Auto-generated symbol index for this project (read before searching)
auto_generated: true
---
# Code Map

> Auto-generated index of symbols in this project. Read this BEFORE running search_files — use the EXACT names listed here rather than guessing.

## Summary
- Project root: `/Users/matt123/Documents/Matts apps/fix lmstudio kilocode`
- Files indexed: 30
- Classes/types: 48
- Functions: 959
- Constants: 87
- Naming convention: PascalCase for classes/types, camelCase for functions and variables, snake_case for functions, SCREAMING_SNAKE for constants

## Class / type names (use these exact names when searching)

`WindowSink`, `CallbackSink`, `WorkerSink`, `WindowInputRequester`, `InputRequester`, `DirectBridge`, `TripleRequest`, `TripleResponse`, `TemporalQueryRequest`, `ArchiveRecordRequest`, `ArchiveEvent`, `VectorAddRequest`, `VectorSearchRequest`, `RetrieveRequest`, `RetrievalResult`, `RetrieveResponse`, `ExtractRequest`, `ExtractorLoadRequest`, `SessionEnrichRequest`, `SessionCrystallizeRequest`, `MemoryStatus`, `MemoryStats`, `KGClearRequest`, `AssistRequest`, `AssistResponse`, `Message`, `ToolFunction`, `Tool`, `ChatRequest`, `LoadRequest`, `SpeculativeRequest`, `KVCacheRequest`, `PrefixCacheRequest`, `BenchmarkResponse`, `Orchestrator`, `XcodeMCPClient`, `SessionCatalog`, `MiniAppServer`, `LspManager`, `TestGetExtractionSemaphore`, `TestAssistEndpointRouting`, `TestHandlerResponseShapes`, `TestSecretFilteringInAssist`, `TestTimeoutEnforcement`, `TestMemoryStatusFastAssistantEnabled`, `ClusteringService`, `ClusterViewModel`

## Event handlers attached in this project

`DOMContentLoaded`, `dragover`, `dragleave`, `drop`, `paste`, `mousedown`, `mouseenter`, `mouseleave`, `click`, `animationend`, `keydown`, `scroll`, `mousemove`, `mouseup`, `input`, `change`, `blur`, `message`, `end`, `error`

## Per-file symbols

### renderer/app.js

Functions:
  - `sanitizePath(p)` (line 16)
  - `renderFastAssistBlock(ev)` (line 31)
  - `showToast(message, type = 'info', duration = 5000)` (line 48)
  - `setAppTheme(name)` (line 69)
  - `_initTheme()` (line 80)
  - `_tryAutoLoad()` (line 98)
  - `showPanel(name, btn)` (line 206)
  - `switchMainTab(name, btn)` (line 215)
  - `togglePermMode()` (line 224)
  - `changeAgentRole(role)` (line 253)
  - `refreshStatus()` (line 260)
  - `autoLoadLastModel()` (line 270)
  - ... and 242 more
Constants:
  `_FAST_ASSIST_ICONS`, `ROLE_DESCRIPTIONS`, `ROLE_ICONS`, `PERMISSION_META`, `PERM_STATUS_LABEL`, `THINK_OPEN`, `SAMPLING_PRESETS`, `SPEC_PROMPTS`, `SLASH_COMMANDS`, `SLASH_COMMAND_INFO`, +3 more

### direct-bridge.js

Classes/types:
  - `WindowSink` (line 223)
  - `CallbackSink` (line 241)
  - `WorkerSink` (line 256)
  - `WindowInputRequester` (line 274)
  - `InputRequester` (line 312)
  - `DirectBridge` (line 2527)
Functions:
  - `_findPythonPath()` (line 56)
  - `_loadUndoStore()` (line 80)
  - `_scheduleUndoSave()` (line 93)
  - `undoRecord(sessionId, filePath, beforeContent, afterContent, tool)` (line 117)
  - `undoList(sessionId)` (line 130)
  - `undoApply(sessionId, index = 0)` (line 148)
  - `undoClear(sessionId)` (line 176)
  - `_scheduleAutoCommit(cwd)` (line 188)
  - `_performAutoCommit()` (line 197)
  - `constructor(win)` (line 224)
  - `send(channel, data)` (line 228)
  - `constructor(emitter, taskId)` (line 242)
  - ... and 53 more
Constants:
  `VALIDATED_TOOLS`, `GIT_CMD_RE`, `UNDO_MAX_PER_SESSION`, `UNDO_STORE_PATH`, `SERVER_PORT`, `SERVER_URL`, `OPENROUTER_BASE_URL`, `OPENROUTER_CHAT_URL`, `TOOL_DEFS`, `LSP_TOOL_DEFS`, +2 more

### memory-bridge.py

Classes/types:
  - `TripleRequest` (line 56)
  - `TripleResponse` (line 64)
  - `TemporalQueryRequest` (line 74)
  - `ArchiveRecordRequest` (line 81)
  - `ArchiveEvent` (line 91)
  - `VectorAddRequest` (line 103)
  - `VectorSearchRequest` (line 108)
  - `RetrieveRequest` (line 116)
  - ... and 11 more
Functions:
  - `filter_secrets(text: str)` (line 256)
  - `_redact(match, _name=pattern_name)` (line 267)
  - `_fail_closed_filter(text: str)` (line 284)
  - `initialize(data_dir: str = "~/.qwencoder/memory/")` (line 307)
  - `shutdown()` (line 376)
  - `_get_file_size(path: Path)` (line 443)
  - `_get_dir_size(dir_path: Path)` (line 451)
  - `get_memory_status()` (line 465)
  - `get_memory_stats(project_id: Optional[str] = None)` (line 487)
  - `add_triple(req: TripleRequest)` (line 570)
  - `query_entity(entity: str)` (line 617)
  - `query_temporal(req: TemporalQueryRequest)` (line 644)
  - ... and 52 more
Constants:
  `_DEFAULT_TOKEN_BUDGET`, `_EXTRACTION_PATTERNS`, `_VALID_ASSIST_TASK_TYPES`, `VALID_AGENT_TYPES`, `ROUTE_TASK_PROMPT`, `VISION_MAX_CHARS`, `_ASSIST_HANDLERS`

### server.py

Classes/types:
  - `Message` (line 610)
  - `ToolFunction` (line 618)
  - `Tool` (line 624)
  - `ChatRequest` (line 629)
  - `LoadRequest` (line 641)
  - `SpeculativeRequest` (line 1182)
  - `KVCacheRequest` (line 1256)
  - `PrefixCacheRequest` (line 1292)
  - ... and 1 more
Functions:
  - `_crash_signal_handler(signum, frame)` (line 106)
  - `_get_inference_semaphore()` (line 141)
  - `get_metal_lock()` (line 151)
  - `_estimate_prompt_tokens(prompt: str)` (line 158)
  - `_get_context_window()` (line 179)
  - `_extract(cfg: dict)` (line 186)
  - `_autotune_max_tokens(prompt: str, requested_max: int)` (line 213)
  - `_should_clear_metal_cache()` (line 237)
  - `find_models()` (line 268)
  - `_unload_model()` (line 303)
  - `load_model(model_path: str)` (line 337)
  - `_warmup_model()` (line 406)
  - ... and 41 more
Constants:
  `_INFERENCE_QUEUE_SIZE`, `_TOOL_CALL_RE`, `_BARE_FUNC_RE`, `_TOOL_CALL_JSON_RE`, `_PARAM_RE`, `_FUNC_NAME_RE`, `BENCHMARK_PROMPT`

### assets/telegram_miniapp.html

Functions:
  - `fetchJSON(path)` (line 748)
  - `postJSON(path, body)` (line 753)
  - `mediaUrl(fp)` (line 760)
  - `esc(s)` (line 761)
  - `relTime(ds)` (line 762)
  - `fmtDur(ms)` (line 770)
  - `loadAll()` (line 773)
  - `loadProjectDetail(id)` (line 787)
  - `openLightbox(src,isVideo)` (line 795)
  - `closeLightbox()` (line 803)
  - `showBanner(type,text,ms)` (line 809)
  - `render()` (line 816)
  - ... and 43 more
Constants:
  `API`

### test/memory-bridge.property.test.js

Functions:
  - `filterSecrets(text)` (line 55)
  - `arbStringFrom(chars, minLen, maxLen)` (line 73)
  - `arbOpenAIKey()` (line 79)
  - `arbAWSAccessKey()` (line 84)
  - `arbBearerToken()` (line 89)
  - `arbGitHubToken()` (line 94)
  - `arbStripeKey()` (line 99)
  - `arbSlackToken()` (line 107)
  - `arbTwilioKey()` (line 115)
  - `arbEnvSecret()` (line 120)
  - `arbSafeText()` (line 129)
  - `arbTextWithSecret(secretGen)` (line 134)
  - ... and 34 more
Constants:
  `SECRET_PATTERNS`, `ALNUM_CHARS`, `UPPER_ALNUM_CHARS`, `HEX_CHARS`, `SAFE_CHARS`

### main.js

Functions:
  - `buildRoutingInstructions(routableTasks)` (line 142)
  - `_serverQueue(()` (line 387)
  - `isBusy()` (line 394)
  - `enqueue(fn, opts = {})` (line 403)
  - `waiter()` (line 410)
  - `_releaseOnEnd(data)` (line 516)
  - `loadCustomRoles()` (line 561)
  - `saveCustomRoles(roles)` (line 568)
  - `createSetupWindow()` (line 658)
  - `createWindow()` (line 677)
  - `_makeSpecRunner()` (line 737)
  - `listSpecs()` (line 739)
  - ... and 8 more
Constants:
  `SERVER_PORT`, `MINIAPP_PORT`, `SERVER_URL`, `ROLE_OVERLAYS`, `AGENT_ROLES_PATH`, `BUILTIN_ROLES`

### setup.html

Functions:
  - `setProgress(pct)` (line 639)
  - `updateStepNav(step)` (line 643)
  - `showPanel(idx)` (line 653)
  - `renderDepsList(installedSet, missingSet)` (line 720)
  - `updateDepRow(imp, state)` (line 737)
  - `appendInstallLog(line)` (line 748)
  - `startDepsCheck()` (line 763)
  - `renderHardware(info)` (line 865)
  - `renderTierSelector(info)` (line 882)
  - `renderModels(info)` (line 898)
  - `updateModelsFooterHint()` (line 950)
  - `openModelInLmStudio(lmStudioUrl, modelId)` (line 964)
  - ... and 12 more
Constants:
  `TOTAL_STEPS`, `ALL_DEPS`, `ALL_BINARIES`, `WIZARD_PERM_META`, `WIZARD_PERM_STATUS`

### orchestrator.js

Classes/types:
  - `Orchestrator` (line 33)
Functions:
  - `constructor(options = {})` (line 44)
  - `_setState(newState)` (line 65)
  - `_updateNodeStatus(nodeId, status, extra = {})` (line 69)
  - `_rollupParentStatus(nodeId)` (line 90)
  - `_resetIfProjectEmpty()` (line 126)
  - `_countSourceFiles(dir, maxDepth)` (line 161)
  - `_rollupAllParents()` (line 192)
  - `_persist()` (line 221)
  - `start()` (line 238)
  - `_resetStaleInProgressNodes()` (line 356)
  - `_resetFailedNodes()` (line 380)
  - `_resetSkippedNodes()` (line 403)
  - ... and 27 more
Constants:
  `STATES`, `SAFE_EDIT_INSTRUCTIONS`

### telegram-miniapp.html

Functions:
  - `getApiBase()` (line 354)
  - `sendCmd(type, payload = {})` (line 358)
  - `pollStatus()` (line 387)
  - `startPolling()` (line 462)
  - `stopPolling()` (line 467)
  - `handleMessage(msg)` (line 471)
  - `runJob()` (line 543)
  - `stopJob()` (line 551)
  - `requestScreenshot()` (line 558)
  - `requestStatus()` (line 580)
  - `injectPrompt(message)` (line 584)
  - `replyToAgent(text)` (line 596)
  - ... and 29 more
Constants:
  `DISCONNECT_THRESHOLD`, `API_BASE`, `QUICK_PROMPTS`

### test/direct-bridge-lsp.test.js

Functions:
  - `createMockLspManager(opts = {})` (line 9)
  - `getStatus()` (line 18)
  - `call(name, args)` (line 21)
  - `getStatus()` (line 87)
  - `call()` (line 88)
  - `createMockSink()` (line 129)
  - `send(channel, data)` (line 133)
  - `getStatus()` (line 163)
  - `call(name, args)` (line 164)
  - `getStatus()` (line 186)
  - `call(name)` (line 187)
  - `getStatus()` (line 199)
  - ... and 51 more

### xcode-tool.js

Classes/types:
  - `XcodeMCPClient` (line 399)
Functions:
  - `_mapArgs(toolName, args)` (line 388)
  - `constructor()` (line 400)
  - `_findBinary()` (line 415)
  - `start()` (line 454)
  - `_send(msg)` (line 555)
  - `_onData(chunk)` (line 560)
  - `callTool(mcpToolName, args, timeoutMs = 120000)` (line 590)
  - `stop()` (line 613)
  - `getStatus()` (line 622)
  - `getClient()` (line 631)
  - `executeXcodeTool(toolName, args, cwd)` (line 644)
  - `isXcodeMCPAvailable()` (line 709)
  - ... and 4 more
Constants:
  `XCODE_TOOL_DEFS`, `TOOL_NAME_MAP`, `ARG_NAME_MAP`

### test/memory-client.property.test.js

Functions:
  - `createUnreachableClient()` (line 18)
  - `mockHttpRequest()` (line 20)
  - `retrieve(query, options = {})` (line 25)
  - `archiveRecord(eventType, payload, summary)` (line 37)
  - `extractTurn(message, agentName, sessionId)` (line 46)
  - `kgAddTriple(subject, predicate, object)` (line 54)
  - `kgQueryEntity(entity)` (line 64)
  - `vectorSearch(query, options = {})` (line 74)
  - `archiveSearch(query, options = {})` (line 84)
  - `getStatus()` (line 94)
  - `arbNonEmptyString()` (line 113)
  - `arbEventType()` (line 117)
  - ... and 8 more

### main/ipc-server.js

Functions:
  - `_calibrationCacheDir()` (line 19)
  - `_modelKey(modelId)` (line 23)
  - `_loadCachedProfile(modelId)` (line 28)
  - `_saveCachedProfile(modelId, profile)` (line 50)
  - `isNonEmptyString(v)` (line 63)
  - `isValidPort(v)` (line 64)
  - `findPython()` (line 67)
  - `suppressFirewallPopup(pyPath)` (line 86)
  - `getServerScript(appDir)` (line 96)
  - `setLastLoadedModel(modelPath)` (line 119)
  - `startServer(port, appDir, mainWindow)` (line 123)
  - `_reloadModel(port, modelPath, mainWindow, appDir)` (line 218)
  - ... and 11 more
Constants:
  `_STDERR_RING_SIZE`

### test/routing-decision.property.test.js

Functions:
  - `arbitraryTaskId()` (line 13)
  - `arbitrarySurroundingText()` (line 21)
  - `arbitraryReasonText()` (line 36)
  - `buildGraph(taskIds)` (line 274)
  - `arbitrarySiblingIds()` (line 445)
  - `buildBranchGraph(siblingIds)` (line 456)
  - `createNoopPool()` (line 491)
  - `arbitrarySiblingIds()` (line 639)
  - `buildBranchGraph(siblingIds)` (line 650)
  - `createNoopPool()` (line 685)
  - `arbitraryRoutableTask()` (line 871)

### vendor/taosmd/prompts.py

Functions:
  - `persona_for(agent_name: str)` (line 120)
  - `extraction_prompt(text: str, *, agent_name: str = "default")` (line 132)
  - `session_enrichment_prompt(session_log: str, *, agent_name: str = "default")` (line 162)
  - `crystallization_prompt(session_text: str, *, agent_name: str = "default")` (line 196)
  - `reflection_prompt(triples: list[tuple[str, str, str]], *, agent_name: str = "default")` (line 230)
  - `query_expansion_prompt(query: str, *, agent_name: str = "default")` (line 264)
  - `preference_extraction_prompt(text: str, *, agent_name: str = "default")` (line 305)
  - `routing_prompt(query: str, *, agent_name: str = "default")` (line 394)
  - `redaction_prompt(text: str, *, agent_name: str = "default")` (line 627)
Constants:
  `LIBRARIAN_PERSONA`

### vendor/taosmd/session_catalog.py

Classes/types:
  - `SessionCatalog` (line 130)
Functions:
  - `_slugify(text: str, max_len: int = 40)` (line 111)
  - `_format_time(ts: float)` (line 120)
  - `_format_date(ts: float)` (line 125)
  - `init(self)` (line 144)
  - `close(self)` (line 179)
  - `_read_archive_file(self, path: Path)` (line 188)
  - `_group_by_gap(self, events: list[dict])` (line 362)
  - `lookup_date(self, date: str, *, agent_name: str | None = None)` (line 386)
  - `lookup_range(self, start_date: str, end_date: str)` (line 407)
  - `search_topic(self, query: str, limit: int = 20)` (line 415)
  - `get_session(self, session_id: int)` (line 435)
  - `_accept_line(raw: str)` (line 470)
  - ... and 5 more
Constants:
  `SESSION_GAP_THRESHOLD`, `SESSION_CATEGORIES`, `SCHEMA`

### telegram-miniapp-server.js

Classes/types:
  - `MiniAppServer` (line 14)
Functions:
  - `constructor({ jobController, port = 3847, onRunJob, onStopJob, bridgeStateGetter, bridgeGetter })` (line 22)
  - `start()` (line 43)
  - `_parseBody(req)` (line 112)
  - `_handleApi(req, res, pathname)` (line 130)
  - `handler(data)` (line 263)
  - `stop()` (line 310)
  - `getUrl()` (line 323)
  - `_broadcast(msg)` (line 331)
  - `_sendTo(ws, msg)` (line 345)
  - `_handleClientMessage(msg)` (line 355)
  - `_wireController()` (line 418)
  - `_handleQwenEvent(data)` (line 486)
  - ... and 1 more

### vendor/taosmd/retrieval.py

Functions:
  - `_adapt_vector(results: list[dict])` (line 30)
  - `_adapt_kg(results: list[dict])` (line 50)
  - `_adapt_catalog(results: list[dict])` (line 86)
  - `_adapt_archive(results: list[dict])` (line 115)
  - `_adapt_crystals(results: list[dict])` (line 152)
  - `_deduplicate(results: list[dict], threshold: float = 0.8)` (line 222)
  - `_query_source(name: str, source: object, query: str, limit: int)` (line 271)
  - `_user_metadata(hit: dict)` (line 430)

### test/agent-pool.test.js

Functions:
  - `createTestTypes()` (line 9)
  - `mockAgentFactory(resolveValue = 'mock-output', delay = 0)` (line 19)
  - `createTask(id, title, metadata = {})` (line 28)
  - `slowFactory(t, type, ctx)` (line 111)
  - `failFactory()` (line 224)
  - `trackingFactory()` (line 279)
  - `createPoolWithLsp(getLspStatus)` (line 303)

### test/orchestrator.test.js

Functions:
  - `createMockAgentPool(opts = {})` (line 14)
  - `dispatch(task, context)` (line 21)
  - `dispatch(task)` (line 327)
  - `dispatch(task)` (line 406)
  - `createMockAgentPoolWithSelectType(agentTypeName)` (line 565)
  - `selectType(_node)` (line 569)
  - `dispatch(task, context)` (line 572)
  - `createMockLspManager(status)` (line 586)
  - `getStatus()` (line 588)

### test/lsp-manager.test.js

Functions:
  - `createFakeProcess()` (line 13)
  - `write(data)` (line 19)
  - `createTestManager(opts = {})` (line 38)
  - `afterEach(function ()` (line 330)

### main/ipc-setup.js

Functions:
  - `_setupFlagPath()` (line 94)
  - `isSetupComplete()` (line 98)
  - `markSetupComplete(info)` (line 109)
  - `resetSetup()` (line 123)
  - `getHardwareInfo()` (line 131)
  - `_modelsDirOverridePath()` (line 156)
  - `getModelsDir()` (line 160)
  - `saveModelsDir(dir)` (line 171)
  - `scanInstalledModels(modelsRoot)` (line 182)
  - `checkPythonDeps(pyPath)` (line 229)
  - `installDeps(pyPath, requirementsPath, onData)` (line 264)
  - `runInstall(args, label, cb)` (line 274)
  - ... and 10 more
Constants:
  `MODEL_TIERS`, `REQUIRED_PACKAGES`, `REQUIRED_BINARIES`

### lsp-manager.js

Classes/types:
  - `LspManager` (line 57)
Functions:
  - `BUNDLED_BINARY_PATH(()` (line 18)
  - `constructor(options = {})` (line 64)
  - `getStatus()` (line 92)
  - `_setStatus(newStatus)` (line 106)
  - `_findBinary()` (line 122)
  - `_detectLanguageServers()` (line 158)
  - `start(projectDir)` (line 196)
  - `onEarlyExit(code, signal)` (line 334)
  - `onceReady(msg)` (line 341)
  - `stop()` (line 415)
  - `restart(projectDir)` (line 459)
  - `_ping()` (line 473)
  - ... and 8 more
Constants:
  `LSP_STATUSES`, `DEFAULT_BINARY_PATH`, `DEFAULT_HEALTH_CHECK_INTERVAL`, `DEFAULT_MAX_RESTARTS`, `BINARY_NAME`, `KNOWN_LANGUAGE_SERVERS`, `LANGUAGE_SERVER_LANGUAGES`, `EXTRA_PATH_DIRS`

### test/integration.test.js

Functions:
  - `makeTmpDir()` (line 17)
  - `cleanDir(dir)` (line 21)
  - `createMockAgentFactory(opts = {})` (line 28)
  - `factory(task, agentType, context)` (line 33)

### test/test_memory_bridge_assist.py

Classes/types:
  - `TestGetExtractionSemaphore` (line 59)
  - `TestAssistEndpointRouting` (line 96)
  - `TestHandlerResponseShapes` (line 139)
  - `TestSecretFilteringInAssist` (line 439)
  - `TestTimeoutEnforcement` (line 488)
  - `TestMemoryStatusFastAssistantEnabled` (line 518)
Functions:
  - `run(coro)` (line 38)
  - `make_mock_model()` (line 47)
  - `make_mock_processor()` (line 53)
  - `setUp(self)` (line 60)
  - `test_returns_same_instance_on_repeated_calls(self)` (line 63)
  - `test_returns_asyncio_semaphore(self)` (line 74)
  - `test_semaphore_concurrency_is_one(self)` (line 83)
  - `setUp(self)` (line 102)
  - `test_invalid_task_type_raises_400(self)` (line 107)
  - `test_empty_task_type_raises_400(self)` (line 114)
  - `test_degraded_when_no_model_loaded(self)` (line 120)
  - `test_all_valid_task_types_degrade_gracefully(self)` (line 128)
  - ... and 33 more

### bench_long_session.py

Classes/types:
  - `ClusteringService` (line 154)
  - `ClusterViewModel` (line 209)
  - `ClusteringService` (line 258)
Functions:
  - `build_context(target_tokens: int, tokenizer)` (line 428)
  - `clear()` (line 456)
  - `peak_gb()` (line 464)
  - `active_gb()` (line 471)
  - `run_turn(model, tokenizer, prompt, draft_model=None, kv_bits=None, num_draft_tokens=4)` (line 478)
  - `estimate_tokens(text, tokenizer)` (line 501)
  - `main()` (line 521)
Constants:
  `TARGET`, `DRAFT`, `MAX_NEW_TOKENS`, `CONTEXT_CHECKPOINTS`, `SYSTEM_PROMPT`, `TURN_BLOCKS`, `CONFIGS`

## Search guidance

- If a symbol is not in the list above, it probably does not exist in the codebase under that name.
- Prefer reading the listed file at the listed line over guessing search regex.
- If the thing you need is not in this map, run `list_dir` and `read_file` to learn — do NOT make up variable names.
