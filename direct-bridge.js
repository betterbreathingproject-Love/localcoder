/**
 * DirectBridge — streams directly from the local MLX server (OpenAI-compatible)
 * without the @qwen-code/sdk subprocess overhead.
 *
 * Drop-in replacement for QwenBridge. Same EventSink interface, same qwen-event
 * channel shape, but tokens flow straight from server.py → IPC → renderer.
 *
 * Tool execution loop is handled here: model returns tool_calls → we execute
 * them locally → feed results back → repeat until finish_reason:"stop".
 */
'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('node:os')
const { execSync, spawn } = require('child_process')
const { createPlaywrightInstance, BROWSER_TOOL_DEFS } = require('./playwright-tool')
const { WEB_TOOL_DEFS, executeWebTool } = require('./web-tools')
const { DESKTOP_TOOL_DEFS, executeDesktopTool } = require('./desktop-tool')
const { getApiKeys } = require('./projects')
const compactor = require('./compactor')
const config = require('./config')

// ── Tool-loop enhancements (innovative add-ons, degrade gracefully) ──────────
let ToolSpeculator = null
try { ({ ToolSpeculator } = require('./tool-speculator')) } catch (_) { /* optional */ }
let constrainedDecoder = null
try { constrainedDecoder = require('./constrained-decoder') } catch (_) { /* optional */ }
let PostWriteCache = null
try { ({ PostWriteCache } = require('./post-write-cache')) } catch (_) { /* optional */ }
let shrinkOlderToolResults = null
try { ({ shrinkOlderToolResults } = require('./tool-result-shrinker')) } catch (_) { /* optional */ }
let systemPromptCache = null
try { systemPromptCache = require('./system-prompt-cache') } catch (_) { /* optional */ }

// ── Shared event bus for cross-module event observation ──────────────────────
// WindowSink sends events to the renderer via IPC, but other main-process
// modules (Telegram bot, mini app server) also need to observe these events.
// Electron's webContents.on() does NOT intercept webContents.send() calls,
// so we use a shared EventEmitter as a local event bus.
const { EventEmitter } = require('node:events')
const sinkBus = new EventEmitter()
sinkBus.setMaxListeners(20) // multiple listeners: telegram, miniapp, orchestrator

// Xcode MCP tools — gracefully degrades if xcodebuildmcp is not installed
let xcodeTool = null
try {
  xcodeTool = require('./xcode-tool')
} catch (_) {}

// Chrome DevTools MCP — gracefully degrades if npx is unavailable
let chromeDevTools = null
try {
  chromeDevTools = require('./chrome-devtools-mcp')
} catch (_) {}

// Memory client — gracefully degrades if memory backend is unavailable
let memoryClient = null
try {
  memoryClient = require('./memory-client.js')
} catch (_) {
  // memory-client.js not available — memory features disabled
}

// Assist client — gracefully degrades if assist backend is unavailable
let assistClient = null
try {
  assistClient = require('./assist-client.js')
} catch (_) {}


// ── Python path resolution (reuse pattern from main/ipc-server.js) ────────────
function _findPythonPath() {
  for (const p of [
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3',
    '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3',
  ]) {
    try { if (p === 'python3' || fs.existsSync(p)) return p } catch {}
  }
  return 'python3'
}
const pythonPath = _findPythonPath()

// ── Assist integration constants ──────────────────────────────────────────────
const VALIDATED_TOOLS = new Set(['edit_file', 'write_file', 'bash', 'read_file'])
const GIT_CMD_RE = /^git\s+(status|log|diff|show)\b/

// ── File undo store ───────────────────────────────────────────────────────────
// Snapshots the before-state of every file touched by write_file or edit_file.
// Keyed by sessionId → array of { filePath, beforeContent, afterContent, tool, timestamp }
// Max 50 operations per session to cap memory. Persisted to disk for cross-restart undo.
const _undoStore = new Map()  // sessionId → [{filePath, beforeContent, afterContent, tool, ts}]
const UNDO_MAX_PER_SESSION = 50
const UNDO_STORE_PATH = require('path').join(require('os').homedir(), '.qwencoder', 'undo-store.json')

function _loadUndoStore() {
  try {
    if (!fs.existsSync(UNDO_STORE_PATH)) return
    const raw = JSON.parse(fs.readFileSync(UNDO_STORE_PATH, 'utf-8'))
    const cutoff = Date.now() - 24 * 60 * 60 * 1000  // 24h
    for (const [sid, ops] of Object.entries(raw)) {
      const fresh = ops.filter(op => op.ts > cutoff)
      if (fresh.length > 0) _undoStore.set(sid, fresh)
    }
  } catch { /* non-fatal */ }
}

let _undoSaveTimer = null
function _scheduleUndoSave() {
  if (_undoSaveTimer) return
  _undoSaveTimer = setTimeout(() => {
    _undoSaveTimer = null
    try {
      const dir = require('path').dirname(UNDO_STORE_PATH)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const obj = {}
      for (const [sid, ops] of _undoStore.entries()) obj[sid] = ops
      fs.writeFileSync(UNDO_STORE_PATH, JSON.stringify(obj), 'utf-8')
    } catch { /* non-fatal */ }
  }, 2000)
}

_loadUndoStore()

/**
 * Record a file operation for undo. Called before write_file / edit_file executes.
 * @param {string} sessionId
 * @param {string} filePath  absolute path
 * @param {string|null} beforeContent  null if file didn't exist
 * @param {string} afterContent
 * @param {string} tool  'write_file' | 'edit_file'
 */
function undoRecord(sessionId, filePath, beforeContent, afterContent, tool) {
  if (!sessionId) return
  if (!_undoStore.has(sessionId)) _undoStore.set(sessionId, [])
  const ops = _undoStore.get(sessionId)
  ops.push({ filePath, beforeContent, afterContent, tool, ts: Date.now() })
  // Cap per session
  if (ops.length > UNDO_MAX_PER_SESSION) ops.splice(0, ops.length - UNDO_MAX_PER_SESSION)
  _scheduleUndoSave()
}

/**
 * Return the undo stack for a session (most recent first).
 */
function undoList(sessionId) {
  const ops = _undoStore.get(sessionId) || []
  return [...ops].reverse().map((op, i) => ({
    index: i,
    filePath: op.filePath,
    tool: op.tool,
    ts: op.ts,
    isNew: op.beforeContent === null,
    beforeSize: op.beforeContent ? op.beforeContent.length : 0,
    afterSize: op.afterContent ? op.afterContent.length : 0,
  }))
}

/**
 * Undo the Nth most recent operation for a session (0 = most recent).
 * Removes the entry from the stack after applying it.
 * Returns { ok, filePath, restored } or { error }.
 */
function undoApply(sessionId, index = 0) {
  const ops = _undoStore.get(sessionId) || []
  const opIndex = ops.length - 1 - index
  const op = ops[opIndex]
  if (!op) return { error: 'No undo entry at that index' }
  try {
    let restored
    if (op.beforeContent === null) {
      // File was created — delete it
      if (fs.existsSync(op.filePath)) fs.unlinkSync(op.filePath)
      restored = 'deleted (file was new)'
    } else {
      // Restore previous content
      fs.writeFileSync(op.filePath, op.beforeContent, 'utf-8')
      restored = `${op.beforeContent.length} chars`
    }
    // Remove the applied entry from the stack
    ops.splice(opIndex, 1)
    _scheduleUndoSave()
    return { ok: true, filePath: op.filePath, restored }
  } catch (e) {
    return { error: `Undo failed: ${e.message}` }
  }
}

/**
 * Clear the undo stack for a session.
 */
function undoClear(sessionId) {
  _undoStore.delete(sessionId)
  _scheduleUndoSave()
}

// ── Auto-commit: save every edit as a git checkpoint ──────────────────────────
// Debounced — batches rapid edits into one commit. Fires 3s after the last edit.
// Makes every change recoverable via git log / git revert.
let _autoCommitTimer = null
let _autoCommitCwd = null
const { execSync: _execSync } = require('child_process')

function _scheduleAutoCommit(cwd) {
  _autoCommitCwd = cwd
  if (_autoCommitTimer) clearTimeout(_autoCommitTimer)
  _autoCommitTimer = setTimeout(() => {
    _autoCommitTimer = null
    _performAutoCommit()
  }, 3000)
}

function _performAutoCommit() {
  const cwd = _autoCommitCwd
  if (!cwd) return
  try {
    // Check if it's a git repo
    _execSync('git rev-parse --git-dir', { cwd, encoding: 'utf-8', timeout: 3000, stdio: 'pipe' })
    // Check if there are changes to commit
    const status = _execSync('git status --porcelain', { cwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim()
    if (!status) return
    // Count changed files for the commit message
    const changedFiles = status.split('\n').filter(Boolean)
    const fileNames = changedFiles.slice(0, 3).map(l => l.slice(3).split('/').pop()).join(', ')
    const msg = changedFiles.length <= 3
      ? `auto: ${fileNames}`
      : `auto: ${fileNames} +${changedFiles.length - 3} more`
    _execSync('git add -A', { cwd, encoding: 'utf-8', timeout: 10000, stdio: 'pipe' })
    _execSync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, { cwd, encoding: 'utf-8', timeout: 10000, stdio: 'pipe' })
  } catch { /* not a git repo or commit failed — silent */ }
}

// ── EventSink implementations ─────────────────────────────────────────────────

/**
 * WindowSink — wraps BrowserWindow.webContents.send (existing behavior).
 * Used for the main foreground agent that sends events to the renderer.
 */
class WindowSink {
  constructor(win) {
    this.win = win
  }

  send(channel, data) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, data)
    }
    // Also emit on the shared bus so main-process observers (Telegram, mini app) can see events
    sinkBus.emit(channel, data)
  }
}

/**
 * CallbackSink — routes events through an EventEmitter with a taskId prefix.
 * Used by Agent Pool foreground subagents to multiplex events from multiple agents.
 */
class CallbackSink {
  constructor(emitter, taskId) {
    this.emitter = emitter
    this.taskId = taskId
  }

  send(channel, data) {
    this.emitter.emit('agent-event', { taskId: this.taskId, channel, data })
  }
}

/**
 * WorkerSink — sends events via worker_thread MessagePort.
 * Used for background tasks running in worker_threads.
 */
class WorkerSink {
  constructor(port) {
    this.port = port
  }

  send(channel, data) {
    this.port.postMessage({ channel, data })
  }
}

/**
 * WindowInputRequester — sends ask_user questions to the Electron renderer window
 * and waits for the user's reply via IPC. Used for desktop (non-Telegram) sessions.
 *
 * The sink sends a 'qwen-event' with type 'ask-user' to the renderer.
 * The renderer shows a question UI and calls back via 'ask-user-reply' IPC.
 * main.js resolves the pending promise by calling resolveAskUser(reply).
 */
class WindowInputRequester {
  constructor(sink) {
    this._sink = sink
    this._pending = false
    this._resolve = null
  }

  async ask(question, options = []) {
    this._pending = true
    console.log('[WindowInputRequester] asking:', question?.slice(0, 80))
    return new Promise((resolve) => {
      this._resolve = resolve
      this._sink.send('qwen-event', { type: 'ask-user', question, options })
    })
  }

  /** Called by main.js when the user submits a reply via IPC. */
  resolveReply(reply) {
    if (!this._resolve) {
      console.warn('[WindowInputRequester] resolveReply called but no pending request')
      return
    }
    console.log('[WindowInputRequester] resolving with:', reply?.slice(0, 80))
    this._pending = false
    const fn = this._resolve
    this._resolve = null
    fn(reply)
  }

  hasPendingRequest() {
    return this._pending
  }
}

/**
 * InputRequester — sends questions to a Telegram chat and waits for the user's reply.
 * Used by the ask_user tool during Telegram-initiated jobs.
 */
class InputRequester {
  constructor(telegramBot, chatId) {
    this._bot = telegramBot
    this._chatId = chatId
    this._pending = false
  }

  async ask(question) {
    this._pending = true
    try {
      await this._bot.sendMessage(this._chatId, `🤖 Agent asks:\n${question}`)
      return new Promise((resolve) => {
        const handler = ({ chatId, text }) => {
          if (chatId === this._chatId) {
            this._bot.removeListener('message', handler)
            this._pending = false
            resolve(text)
          }
        }
        this._bot.on('message', handler)
      })
    } catch (err) {
      this._pending = false
      return `(Failed to send question: ${err.message})`
    }
  }

  hasPendingRequest() {
    return this._pending
  }
}

const SERVER_PORT = 8090
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`

// ── OpenRouter constants ──────────────────────────────────────────────────────
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const OPENROUTER_CHAT_URL = `${OPENROUTER_BASE_URL}/chat/completions`

/**
 * POST /admin/abort — signal the server to stop the current inference and
 * wait until the inference semaphore is free (Metal cleanup done).
 * Called after interrupt() to prevent the next run() from racing with cleanup.
 * Resolves when the server confirms idle, or after 9s timeout.
 */
function _callAdminAbort() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: SERVER_PORT, path: '/admin/abort', method: 'POST',
      headers: { 'Content-Length': '0' },
    }, (res) => {
      res.resume() // drain
      res.on('end', resolve)
    })
    req.on('error', resolve) // server may be down — that's fine
    req.setTimeout(9000, () => { req.destroy(); resolve() })
    req.end()
  })
}

// ── Built-in tool definitions (what the model can call) ───────────────────────

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Returns the ENTIRE file by default — just pass the path, do NOT set start_line/end_line unless the file is over 1000 lines. Only use line ranges for very large files (1000+ lines) or when you need a specific section.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path to read' },
          start_line: { type: 'number', description: 'First line to read (1-indexed). Only use for files over 1000 lines.' },
          end_line: { type: 'number', description: 'Last line to read (1-indexed). Only use for files over 1000 lines.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_files',
      description: 'Read multiple files in a single call. Much faster than calling read_file repeatedly. Returns all file contents concatenated with clear file headers. Use when you need to understand existing code before making changes.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of file paths to read, e.g. ["src/app.js", "src/utils.js", "package.json"]',
          },
        },
        required: ['paths'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does. Creates parent directories as needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write to' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace a specific string in a file with new content. Use for surgical edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit' },
          old_string: { type: 'string', description: 'Exact string to find and replace (must match exactly)' },
          new_string: { type: 'string', description: 'Replacement string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file_lines',
      description: 'Replace a range of lines in a file with new content. Use when edit_file fails due to matching issues on large files — specify exact line numbers instead of matching text. Read the file first to confirm line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit' },
          start_line: { type: 'number', description: 'First line to replace (1-indexed, inclusive)' },
          end_line: { type: 'number', description: 'Last line to replace (1-indexed, inclusive)' },
          new_content: { type: 'string', description: 'New content to insert in place of the specified lines' },
        },
        required: ['path', 'start_line', 'end_line', 'new_content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_files',
      description: 'Apply multiple edits across one or more files in a single call. Much faster than calling edit_file repeatedly. Each edit is a find-and-replace operation. Edits are applied in order.',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            description: 'Array of edit operations to apply',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'File path to edit' },
                old_string: { type: 'string', description: 'Exact string to find and replace' },
                new_string: { type: 'string', description: 'Replacement string' },
              },
              required: ['path', 'old_string', 'new_string'],
            },
          },
        },
        required: ['edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories at the given path. Returns names with / suffix for directories. Returns a full recursive file tree with no depth limit by default — use this to get a complete picture of what files exist. Set depth=0 for a flat listing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list' },
          depth: { type: 'number', description: 'Recursion depth (default: unlimited). Set 0 for flat listing.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command and return its output. Use for running tests, installing packages, git operations, building projects, etc. Timeout: 30s for general commands, 5 minutes for install/build commands (npm install, pip install, swift build, xcodebuild, pod install, cargo build, etc.). For interactive commands that ask questions, add flags to suppress prompts (e.g. npm init -y, pip install --no-input). IMPORTANT: Do NOT call agent tools (xcode_*, lsp_*, browser_*, desktop_*, web_*, read_file, write_file, etc.) via bash — they are not shell commands. Use the tool-call interface directly.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash_batch',
      description: 'Execute multiple shell commands sequentially in a single call. Much faster than calling bash repeatedly — saves model round-trips. Commands run in order; if one fails, subsequent commands still execute (unless abort_on_error is true). Use for independent operations like running multiple tests, checking multiple files, or performing setup steps.',
      parameters: {
        type: 'object',
        properties: {
          commands: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of shell commands to execute in order, e.g. ["npm test", "npm run lint", "git status"]',
          },
          abort_on_error: {
            type: 'boolean',
            description: 'If true, stop executing after the first command that fails (non-zero exit). Default: false (run all commands regardless).',
          },
        },
        required: ['commands'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for patterns in files using grep. Returns matching lines with file paths and line numbers. Pass multiple patterns to search in batch (preferred) — all run in parallel for speed.',
      parameters: {
        type: 'object',
        properties: {
          patterns: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of search patterns (regex) to run in batch. All patterns execute in parallel. Preferred over single pattern.',
          },
          pattern: { type: 'string', description: 'Single search pattern (regex). Fallback — prefer patterns array even for one term.' },
          path: { type: 'string', description: 'Directory or file to search in (defaults to cwd)' },
          include: { type: 'string', description: 'File glob pattern to include (e.g. "*.js")' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_todos',
      description: 'Set or fully replace the todo/progress list. Use at the start of a task to establish your plan. To add, update, or remove individual items from an existing list, use edit_todos instead.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'Complete list of todo items. Replaces the entire current list.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number', description: 'Unique numeric ID for this item (1, 2, 3, ...)' },
                content: { type: 'string', description: 'Short description of the task' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Current status' },
              },
              required: ['id', 'content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_todos',
      description: 'Surgically modify the existing todo list without replacing it. Use this to: add new items (append), update the status or content of specific items (update), or remove items (remove). Prefer this over update_todos when the list already exists and you only need to change part of it — e.g. when the user asks to add a task, or when you complete one step and want to mark it done.',
      parameters: {
        type: 'object',
        properties: {
          append: {
            type: 'array',
            description: 'New items to add to the end of the list. IDs are assigned automatically — do not include id.',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Short description of the new task' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Initial status (usually pending)' },
              },
              required: ['content', 'status'],
            },
          },
          update: {
            type: 'array',
            description: 'Items to update by id. Only the fields you include are changed.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number', description: 'ID of the item to update' },
                content: { type: 'string', description: 'New content (optional)' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'New status (optional)' },
              },
              required: ['id'],
            },
          },
          remove: {
            type: 'array',
            description: 'IDs of items to remove from the list.',
            items: { type: 'number' },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agent_notes',
      description: 'Write persistent thinking notes that survive context compaction. Use this to record key discoveries, decisions, constraints, and intermediate findings you want to remember across the entire session — especially before a long tool chain where context may be compressed. Notes are re-injected automatically after every compaction event. Keep notes concise (under 500 words). Calling this replaces the previous notes entirely.',
      parameters: {
        type: 'object',
        properties: {
          notes: { type: 'string', description: 'Your thinking notes — key facts, decisions, constraints, and findings to remember. Will survive context compaction.' },
        },
        required: ['notes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rewind_context',
      description: 'Retrieve the original uncompressed content for a previously compressed section. Use when you need full detail from a compressed tool result.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The rewind key from the compression notice' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_complete',
      description: 'Signal that you have finished the user\'s request. You MUST call this tool when you are done — do NOT just output text. Include a summary of what you accomplished.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'A detailed summary of what you did: files created/modified, changes made, tests run, and anything the user should verify.' },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_xcode_project',
      description: 'Generate an Xcode project.pbxproj file from existing Swift source files. Use this instead of manually writing pbxproj files — it scans the source directory and creates all file references, groups, build phases, and configurations automatically. Also creates missing asset catalog Contents.json files. If source_dir is omitted or not found, the tool auto-discovers a directory containing *App.swift under project_dir.',
      parameters: {
        type: 'object',
        properties: {
          product_name: { type: 'string', description: 'The product/app name (e.g. "PhotoRanker"). Defaults to the project directory name.' },
          project_dir: { type: 'string', description: 'Absolute or cwd-relative path to the project root (the directory that will contain <product>.xcodeproj). Defaults to the session working directory. Use this when the Xcode project lives inside a subfolder.' },
          source_dir: { type: 'string', description: 'Source directory path relative to project_dir (e.g. "PhotoRanker" or "Outer/Inner"). If omitted or not found, auto-discovery kicks in.' },
          org_identifier: { type: 'string', description: 'Organization identifier for bundle ID (e.g. "com.example"). Defaults to "com.developer".' },
          platform: { type: 'string', description: '"macos" or "ios". Defaults to "macos".' },
          deployment_target: { type: 'string', description: 'Minimum deployment target (e.g. "14.0"). Defaults to "14.0".' },
          team_id: { type: 'string', description: 'Apple Developer Team ID for code signing. Optional.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask the user a question and wait for their reply. Use when you need clarification or input. Provide suggested options when the answer is likely one of a few choices — the user can click them or type a custom reply.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask the user' },
          options: {
            type: 'array',
            description: 'Optional list of suggested answer choices the user can click. Always include an "Other…" option if you provide choices.',
            items: { type: 'string' },
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_browser',
      description: 'Open a URL or local HTML file in the default browser. Use to preview web pages, HTML games, or any file the user should see. For local files, pass the relative path.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'URL (http://...) or relative file path to open (e.g. "index.html")' },
        },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vision_review',
      description: 'Take a screenshot of a local HTML file or URL and analyze it with the vision model. Use this to visually review your work — check layout, images, colors, spacing, broken elements, etc. Returns a detailed visual critique. Use after writing/editing web pages to catch issues like bad stock images, broken layouts, or visual bugs that you cannot detect from code alone.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'URL (http://...) or relative file path to screenshot (e.g. "index.html")' },
          prompt: { type: 'string', description: 'What to focus on in the review. E.g. "Check if the hero image looks professional" or "Review the overall layout and color scheme". Defaults to a general visual quality review.' },
          width: { type: 'number', description: 'Viewport width in pixels (default: 1280)' },
          height: { type: 'number', description: 'Viewport height in pixels (default: 900)' },
          full_page: { type: 'boolean', description: 'Capture the full scrollable page, not just the viewport (default: false)' },
        },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'undo_edit',
      description: 'Undo a previous file edit. Reverts the file to its state before the edit was applied. Call with no arguments to undo the most recent edit, or pass an index (0 = most recent, 1 = second most recent, etc.). Use undo_list first to see what can be undone.',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'Which edit to undo (0 = most recent, 1 = second most recent). Default: 0' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'undo_list',
      description: 'List recent file edits that can be undone. Shows file path, tool used, and timestamp for each. Use before undo_edit to see what is available.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  ...BROWSER_TOOL_DEFS,
  ...WEB_TOOL_DEFS,
  ...DESKTOP_TOOL_DEFS,
  // Xcode tools — only included when xcodebuildmcp is installed
  ...(xcodeTool ? xcodeTool.XCODE_TOOL_DEFS : []),
  // Chrome DevTools MCP tools — lets agent see console errors, network, DOM, perf
  ...(chromeDevTools ? chromeDevTools.DEVTOOLS_TOOL_DEFS : []),
]

// ── LSP tool definitions (same shape as TOOL_DEFS entries) ────────────────────

const LSP_TOOL_DEFS = {
  lsp_get_document_symbols: {
    type: 'function',
    function: {
      name: 'lsp_get_document_symbols',
      description: 'Get document symbols (functions, classes, variables) for a file.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the source file' },
          format: { type: 'string', description: 'Output format: "outline" for compact markdown, default returns JSON' },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
    },
  },
  lsp_get_hover: {
    type: 'function',
    function: {
      name: 'lsp_get_hover',
      description: 'Get hover information (type, documentation) for a symbol at a position.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the source file' },
          line: { type: 'integer', description: '1-indexed line number' },
          column: { type: 'integer', description: '1-indexed column offset' },
        },
        required: ['file_path', 'line', 'column'],
        additionalProperties: false,
      },
    },
  },
  lsp_get_definition: {
    type: 'function',
    function: {
      name: 'lsp_get_definition',
      description: 'Go to definition of a symbol at a position.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the source file' },
          line: { type: 'integer', description: '1-indexed line number' },
          column: { type: 'integer', description: '1-indexed column offset' },
        },
        required: ['file_path', 'line', 'column'],
        additionalProperties: false,
      },
    },
  },
  lsp_get_references: {
    type: 'function',
    function: {
      name: 'lsp_get_references',
      description: 'Find all references to a symbol at a position.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the source file' },
          line: { type: 'integer', description: '1-indexed line number' },
          column: { type: 'integer', description: '1-indexed column offset' },
          include_declaration: { type: 'boolean', description: 'Whether to include the declaration site' },
        },
        required: ['file_path', 'line', 'column'],
        additionalProperties: false,
      },
    },
  },
  lsp_get_call_hierarchy: {
    type: 'function',
    function: {
      name: 'lsp_get_call_hierarchy',
      description: 'Get incoming and outgoing calls for a symbol at a position.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the source file' },
          line: { type: 'integer', description: '1-indexed line number' },
          column: { type: 'integer', description: '1-indexed column offset' },
          direction: { type: 'string', description: 'Direction: incoming, outgoing, or both (default: both)' },
        },
        required: ['file_path', 'line', 'column'],
        additionalProperties: false,
      },
    },
  },
  lsp_get_type_definition: {
    type: 'function',
    function: {
      name: 'lsp_get_type_definition',
      description: 'Go to type definition of a symbol at a position.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the source file' },
          line: { type: 'integer', description: '1-indexed line number' },
          column: { type: 'integer', description: '1-indexed column offset' },
        },
        required: ['file_path', 'line', 'column'],
        additionalProperties: false,
      },
    },
  },
  lsp_workspace_symbol: {
    type: 'function',
    function: {
      name: 'lsp_workspace_symbol',
      description: 'Search for symbols across the workspace by name.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Symbol name or pattern to search for' },
        },
        additionalProperties: false,
      },
    },
  },
  lsp_simulate_edit_atomic: {
    type: 'function',
    function: {
      name: 'lsp_simulate_edit_atomic',
      description: 'Simulate a file edit and report diagnostic changes without writing to disk.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file to edit' },
          start_line: { type: 'integer', description: '1-indexed start line of the range to replace' },
          start_column: { type: 'integer', description: '1-indexed start column' },
          end_line: { type: 'integer', description: '1-indexed end line' },
          end_column: { type: 'integer', description: '1-indexed end column' },
          new_text: { type: 'string', description: 'Replacement text for the specified range' },
        },
        required: ['file_path', 'start_line', 'start_column', 'end_line', 'end_column', 'new_text'],
        additionalProperties: false,
      },
    },
  },
  lsp_get_diagnostics: {
    type: 'function',
    function: {
      name: 'lsp_get_diagnostics',
      description: 'Get current diagnostics (errors, warnings) for a file.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File path to get diagnostics for. If omitted, returns diagnostics for all open files' },
        },
        additionalProperties: false,
      },
    },
  },
  lsp_get_change_impact: {
    type: 'function',
    function: {
      name: 'lsp_get_change_impact',
      description: 'Analyze the blast radius of changes — which files and symbols are affected by changes to the given files.',
      parameters: {
        type: 'object',
        properties: {
          changed_files: { type: 'array', items: { type: 'string' }, description: 'List of absolute file paths to analyze' },
          include_transitive: { type: 'boolean', description: 'If true, include second-order callers' },
        },
        required: ['changed_files'],
        additionalProperties: false,
      },
    },
  },
  lsp_apply_code_action: {
    type: 'function',
    function: {
      name: 'lsp_apply_code_action',
      description: 'Get available code actions (quick fixes, refactorings) for a range in a file.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the source file' },
          start_line: { type: 'integer', description: '1-indexed start line' },
          start_column: { type: 'integer', description: '1-indexed start column' },
          end_line: { type: 'integer', description: '1-indexed end line' },
          end_column: { type: 'integer', description: '1-indexed end column' },
        },
        required: ['file_path', 'start_line', 'start_column', 'end_line', 'end_column'],
        additionalProperties: false,
      },
    },
  },
}

// ── Role-to-LSP-tool mapping ──────────────────────────────────────────────────

const LSP_TOOL_SETS = {
  'explore': ['lsp_get_document_symbols', 'lsp_get_hover', 'lsp_get_definition', 'lsp_get_references', 'lsp_get_call_hierarchy'],
  'context-gather': ['lsp_get_document_symbols', 'lsp_get_definition', 'lsp_get_references', 'lsp_get_type_definition'],
  'code-search': ['lsp_get_document_symbols', 'lsp_get_references', 'lsp_workspace_symbol', 'lsp_get_call_hierarchy'],
  'implementation': ['lsp_simulate_edit_atomic', 'lsp_get_diagnostics', 'lsp_get_definition', 'lsp_get_references', 'lsp_get_change_impact', 'lsp_apply_code_action'],
  'general': ['lsp_simulate_edit_atomic', 'lsp_get_diagnostics', 'lsp_get_definition', 'lsp_get_references', 'lsp_get_change_impact', 'lsp_apply_code_action'],
  // tester role gets xcode tools for build/run/test/UI inspection
  'tester': ['lsp_get_diagnostics'],
}

/**
 * Build the tool definitions array, merging built-in TOOL_DEFS with
 * role-specific LSP tools when the LSP manager is ready.
 * Xcode tools are already in TOOL_DEFS when xcodebuildmcp is installed.
 * @param {object|null} lspManager
 * @param {string} agentRole
 * @returns {object[]}
 */
function getToolDefs(lspManager, agentRole, allowedTools) {
  let tools = [...TOOL_DEFS]
  // Filter base tools when an explicit allowedTools list is provided
  if (allowedTools && allowedTools.length > 0) {
    tools = tools.filter(t => allowedTools.includes(t.function.name))
  } else {
    // Default filtering: exclude heavy tool sets that bloat the prompt (~15K tokens)
    // unless the agent role specifically needs them.
    // Browser tools are only included for tester role.
    // Desktop automation tools are only included for tester role.
    // Xcode tools are only included for tester/implementation roles.
    const BROWSER_NAMES = new Set(['browser_navigate', 'browser_screenshot', 'browser_click',
      'browser_type', 'browser_get_text', 'browser_get_html', 'browser_evaluate',
      'browser_wait_for', 'browser_select_option', 'browser_close'])
    const DESKTOP_NAMES = new Set(['desktop_get_screen_size', 'desktop_screenshot',
      'desktop_mouse_move', 'desktop_mouse_click', 'desktop_keyboard_type', 'desktop_keyboard_press'])
    const needsBrowser = agentRole === 'tester'
    const needsDesktop = agentRole === 'tester'
    const needsXcode = agentRole === 'tester' || agentRole === 'implementation'
    // DevTools available to tester, debug, and implementation roles
    const needsDevTools = agentRole === 'tester' || agentRole === 'debug' || agentRole === 'implementation'
    tools = tools.filter(t => {
      const name = t.function.name
      if (BROWSER_NAMES.has(name) && !needsBrowser) return false
      if (DESKTOP_NAMES.has(name) && !needsDesktop) return false
      if (name.startsWith('xcode_') && !needsXcode) return false
      if (name.startsWith('devtools_') && !needsDevTools) return false
      return true
    })
  }
  if (lspManager?.getStatus().status === 'ready') {
    const toolNames = LSP_TOOL_SETS[agentRole] || []
    for (const name of toolNames) {
      if (LSP_TOOL_DEFS[name]) {
        tools.push(LSP_TOOL_DEFS[name])
      }
    }
  }
  return tools
}

// ── Context window management ─────────────────────────────────────────────────

/**
 * Build a lightweight file tree string for the project directory.
 * Walks up to 3 levels deep, skips hidden/node_modules dirs, and caps output
 * so it stays under ~1500 tokens. Gives the agent spatial awareness of what
 * exists without burning the entire context window.
 */
function buildFileTree(dir, maxDepth = 99) {
  const lines = []
  const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.next', 'dist', 'build', '.cache', '.vscode', '.maccoder', 'coverage', '.DS_Store',
    'DerivedData', '.build', 'Pods', '.swiftpm', 'vendor', 'xcuserdata', '.xcscmblueprint'])

  function walk(current, prefix, depth) {
    if (depth > maxDepth) return
    if (lines.length > 500) return  // tighter cap — 500 lines is plenty for context
    let entries
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    entries = entries
      .filter(e => !SKIP.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      const isLast = i === entries.length - 1
      const connector = isLast ? '└── ' : '├── '
      const childPrefix = prefix + (isLast ? '    ' : '│   ')
      if (e.isDirectory()) {
        lines.push(`${prefix}${connector}${e.name}/`)
        walk(path.join(current, e.name), childPrefix, depth + 1)
      } else {
        lines.push(`${prefix}${connector}${e.name}`)
      }
    }
  }

  const base = path.basename(dir)
  lines.push(`${base}/`)
  walk(dir, '', 1)
  return lines.join('\n')
}

// Cache for buildFileTree — avoids re-walking the filesystem for every agent
// in the same orchestrator run. Invalidated after 30s so changes are picked up.
const _fileTreeCache = new Map()  // dir → { tree, timestamp }
const FILE_TREE_CACHE_TTL = 30000 // 30 seconds

function buildFileTreeCached(dir, maxDepth = 6) {
  const cached = _fileTreeCache.get(dir)
  if (cached && Date.now() - cached.timestamp < FILE_TREE_CACHE_TTL) {
    return cached.tree
  }
  const tree = buildFileTree(dir, maxDepth)
  _fileTreeCache.set(dir, { tree, timestamp: Date.now() })
  return tree
}

/**
 * Detect entry-point files in a project directory.
 * Checks package.json main field, then looks for common entry-point filenames.
 * Returns an array of absolute file paths (up to 10).
 */
function detectEntryPoints(cwd) {
  const entries = []
  const seen = new Set()

  function addIfExists(filePath) {
    const abs = path.resolve(cwd, filePath)
    if (!seen.has(abs)) {
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          seen.add(abs)
          entries.push(abs)
        }
      } catch { /* skip */ }
    }
  }

  // 1. Check package.json main field
  try {
    const pkgPath = path.join(cwd, 'package.json')
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      if (pkg.main && typeof pkg.main === 'string') {
        addIfExists(pkg.main)
      }
    }
  } catch { /* skip */ }

  // 2. Check common entry-point filenames
  const candidates = [
    'index.js', 'index.ts', 'main.js', 'main.ts', 'app.js', 'app.ts',
    'src/index.js', 'src/index.ts', 'src/main.js', 'src/main.ts', 'src/app.js', 'src/app.ts',
  ]
  for (const c of candidates) {
    if (entries.length >= 10) break
    addIfExists(c)
  }

  return entries.slice(0, 10)
}

/**
 * Format an array of LSP document symbols into a compact outline string.
 * Each symbol is rendered as "kind: name" on its own line.
 */
function formatSymbolOutline(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) return ''
  const lines = []
  for (const sym of symbols) {
    const kind = sym.kind || 'symbol'
    const name = sym.name || '?'
    lines.push(`- ${kind}: ${name}`)
    // Include direct children if present
    if (Array.isArray(sym.children)) {
      for (const child of sym.children) {
        const ck = child.kind || 'symbol'
        const cn = child.name || '?'
        lines.push(`  - ${ck}: ${cn}`)
      }
    }
  }
  return lines.join('\n')
}

/**
 * Build a compact project context string from the file tree and task graph.
 * This replaces the full conversation transcript for resumed sessions,
 * giving the agent awareness of what exists without the token cost.
 *
 * When an lspManager is provided and ready, symbol outlines for entry-point
 * files are included for richer semantic context.
 */
async function buildProjectContext(cwd, taskGraphPath, lspManager) {
  const parts = []

  // 1. File tree
  const tree = buildFileTree(cwd)
  if (tree) {
    parts.push(`## Project File Tree\n\`\`\`\n${tree}\n\`\`\``)
  }

  // 2. Task graph status (if available)
  if (taskGraphPath) {
    try {
      const content = fs.readFileSync(taskGraphPath, 'utf8')
      if (content) {
        // The tasks.md is already compact markdown — include it directly
        // but cap it to avoid blowing up context
        const trimmed = content.length > 3000 ? content.slice(0, 3000) + '\n\n... [truncated]' : content
        parts.push(`## Task Progress\n${trimmed}`)
      }
    } catch { /* task file may not exist */ }
  }

  // 3. Symbol outlines for entry-point files (when LSP is ready)
  if (lspManager?.getStatus().status === 'ready') {
    const entryFiles = detectEntryPoints(cwd)
    const symbolParts = []
    for (const file of entryFiles.slice(0, 10)) {
      try {
        const symbols = await lspManager.call('lsp_get_document_symbols', { file_path: file })
        if (Array.isArray(symbols) && symbols.length > 0) {
          const outline = formatSymbolOutline(symbols)
          if (outline) {
            symbolParts.push(`### ${path.relative(cwd, file)}\n${outline}`)
          }
        }
      } catch { /* skip file */ }
    }
    if (symbolParts.length > 0) {
      parts.push(`## Symbol Outlines\n${symbolParts.join('\n')}`)
    }

    // 4. Active diagnostics — show the agent what's currently broken
    try {
      const entryFilePaths = detectEntryPoints(cwd)
      const diagSummary = await lspManager.getProjectDiagnosticsSummary(entryFilePaths)
      if (diagSummary.totalErrors > 0 || diagSummary.totalWarnings > 0) {
        const diagLines = []
        for (const f of diagSummary.files) {
          const rel = path.relative(cwd, f.path)
          for (const e of f.errors) {
            diagLines.push(`  ❌ ${rel}:${e.line || '?'} — ${e.message}`)
          }
          for (const w of f.warnings.slice(0, 3)) { // cap warnings per file
            diagLines.push(`  ⚠️ ${rel}:${w.line || '?'} — ${w.message}`)
          }
        }
        if (diagLines.length > 0) {
          parts.push(`## Active Diagnostics (${diagSummary.totalErrors} errors, ${diagSummary.totalWarnings} warnings)\n${diagLines.join('\n')}`)
        }
      }
    } catch { /* diagnostics fetch failed — skip */ }
  }

  // Cap total to 4000 chars
  let combined = parts.length > 0 ? parts.join('\n\n') : ''
  if (combined.length > 4000) {
    combined = combined.slice(0, 4000) + '\n... [truncated]'
  }
  return combined
}

/**
 * Parse diagnostics from an MCP tool response.
 * The agent-lsp binary returns: { content: [{ type: "text", text: "{\"file://...\": [...]}" }] }
 * Returns an array of diagnostic objects with severity, message, line fields.
 *
 * Filters out LSP rejection messages that are not real code errors:
 * - sourcekit-lsp: "Unable to handle compilation, expected exactly one compiler job"
 *   (returned when sourcekit-lsp is asked about a file type it doesn't support, e.g. HTML)
 */
function parseMcpDiagnostics(result) {
  // Patterns that indicate an LSP server rejected the file type, not a real code error
  const LSP_REJECTION_PATTERNS = [
    /expected exactly one compiler job/i,
    /unable to handle compilation/i,
    /no compiler arguments/i,
  ]

  function isRejectionMessage(msg) {
    return LSP_REJECTION_PATTERNS.some(p => p.test(msg || ''))
  }

  try {
    const text = result?.content?.[0]?.text
    if (!text) return []
    const parsed = JSON.parse(text)
    const values = Object.values(parsed)
    if (values.length > 0 && Array.isArray(values[0])) {
      return values[0]
        .map(d => ({
          severity: d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : d.severity === 3 ? 'info' : 'hint',
          message: d.message || '',
          line: d.range?.start?.line != null ? d.range.start.line + 1 : undefined,
          code: d.code,
          source: d.source,
        }))
        .filter(d => !isRejectionMessage(d.message))
    }
  } catch { /* not parseable */ }
  const raw = result?.errors || result?.diagnostics || []
  return raw.filter(d => !isRejectionMessage(d.message || d))
}

/**
 * Estimate token count from a string. Rough heuristic: ~4 chars per token
 * for English/code content. Matches server-side estimation (adjusted_chars // 4).
 */
function estimateTokens(text) {
  if (!text) return 0
  // Use chars/4 to match the server's estimation (server.py uses adjusted_chars // 4)
  // Previously used 3.5 which underestimated tokens, causing 413 rejections
  return Math.ceil(text.length / 4)
}

/**
 * Estimate total tokens in a messages array.
 */
function estimateMessagesTokens(messages) {
  let total = 0
  for (const msg of messages) {
    total += estimateTokens(msg.content || '')
    // Tool calls in assistant messages — arguments may be objects (post-parse)
    // or strings (pre-parse). Handle both.
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const args = tc.function?.arguments
        if (typeof args === 'string') {
          total += estimateTokens(args)
        } else if (args && typeof args === 'object') {
          total += estimateTokens(JSON.stringify(args))
        }
        total += estimateTokens(tc.function?.name || '')
      }
    }
    total += 4 // per-message overhead
  }
  return total
}

/**
 * Trim messages to fit within a target token budget.
 * Strategy:
 *  - Always keep the system message (index 0) and the first user message (index 1)
 *  - Always keep the last 4 messages (most recent context)
 *  - Trim tool results in the middle by truncating their content
 *  - If still over budget, drop middle messages entirely
 *
 * @param {Array} messages - The conversation messages array
 * @param {number} maxInputTokens - Target max input tokens
 * @returns {Array} Trimmed messages array
 */
function trimMessages(messages, maxInputTokens) {
  let current = estimateMessagesTokens(messages)
  if (current <= maxInputTokens) return messages

  // Phase 0: Truncate the largest messages first (regardless of position).
  // This handles short conversations where a single tool result dominates.
  // IMPORTANT: Never truncate the last 2 tool results — the agent is actively using them.
  const charBudgetPerToken = 4
  const targetChars = Math.floor(maxInputTokens * charBudgetPerToken)
  for (let pass = 0; pass < 3 && current > maxInputTokens; pass++) {
    // Find the largest non-system, non-recent message
    // Protect the last 4 messages from phase-0 truncation
    const protectedFrom = Math.max(0, messages.length - 4)
    let maxIdx = -1, maxLen = 0
    for (let i = 0; i < protectedFrom; i++) {
      const m = messages[i]
      if (m.role === 'system') continue
      const len = (m.content || '').length
      if (len > maxLen) { maxLen = len; maxIdx = i }
    }
    if (maxIdx === -1 || maxLen <= 4000) break
    // Truncate to a proportional share of the budget.
    const allowedChars = Math.max(500, Math.floor(targetChars / Math.max(messages.length, 1)))
    if (maxLen > allowedChars) {
      const oldLen = messages[maxIdx].content.length
      messages[maxIdx].content = messages[maxIdx].content.slice(0, allowedChars) +
        '\n\n[§TRIMMED§ — use search_files to find specific patterns if needed.]'
      current -= Math.ceil((oldLen - messages[maxIdx].content.length) / charBudgetPerToken)
    }
  }
  if (current <= maxInputTokens) return messages

  if (messages.length <= 4) return messages

  // Phase 1: Truncate large tool result messages in the middle
  // Keep first 2 and last 6 messages intact (increased from 4 to protect recent work)
  const safeStart = 2
  const safeEnd = messages.length - 6
  const NAV_TOOL_NAMES = ['list_dir', 'search_files', 'grep_search', 'lsp_get_symbols', 'lsp_get_references']
  for (let i = safeStart; i < safeEnd && current > maxInputTokens; i++) {
    const msg = messages[i]
    if (msg.role === 'tool' && msg.content && msg.content.length > 2000) {
      // Check if this is a nav tool result by looking at the preceding assistant tool_call
      const prevMsg = i > 0 ? messages[i - 1] : null
      const isNavResult = prevMsg && prevMsg.role === 'assistant' && prevMsg.tool_calls &&
        prevMsg.tool_calls.some(tc => NAV_TOOL_NAMES.includes(tc.function?.name))
      // Nav tool results get a higher floor; scale the regular floor with target budget
      const scaledFloor = Math.max(300, Math.floor(maxInputTokens * 4 / Math.max(messages.length, 1)))
      const minKeep = isNavResult ? Math.max(scaledFloor, 2000) : scaledFloor
      if (msg.content.length > minKeep) {
        const oldLen = msg.content.length
        msg.content = msg.content.slice(0, minKeep) + '\n\n[§TRIMMED§]'
        current -= Math.ceil((oldLen - msg.content.length) / 4)
      }
    }
  }
  if (current <= maxInputTokens) return messages

  // Phase 2: Drop middle message pairs (assistant + tool results) from oldest
  const trimmed = [...messages]
  let i = safeStart
  while (i < trimmed.length - 4 && estimateMessagesTokens(trimmed) > maxInputTokens) {
    // Remove one message at a time from the middle
    trimmed.splice(i, 1)
  }

  return trimmed
}

// ── Assist integration helpers ────────────────────────────────────────────────

/**
 * Returns true if any todo item's status changed between two todo arrays.
 * Used to decide whether to emit an update_todos event after todo_watch.
 */
function hasStatusChanges(updated, current) {
  if (!Array.isArray(updated) || !Array.isArray(current)) return false
  if (updated.length !== current.length) return false
  return updated.some((item, i) => item.status !== current[i].status)
}

// ── JSON repair for malformed tool arguments from local LLMs ──────────────────

/**
 * Attempt to repair malformed JSON from local model tool calls.
 * Common issues:
 *  - Unescaped newlines inside string values
 *  - Unescaped control characters
 *  - Trailing commas before closing braces/brackets
 *  - Truncated strings (missing closing quote / braces)
 *  - Unescaped backslashes
 *
 * Returns the parsed object on success, or null on failure.
 */
function repairJSON(raw) {
  if (!raw || typeof raw !== 'string') return null

  let s = raw.trim()

  // 1. Fix unescaped control characters inside JSON string values.
  //    Walk through the string tracking whether we're inside a JSON string.
  //    If we encounter a raw newline/tab/etc inside a string, escape it.
  try {
    let out = ''
    let inString = false
    let i = 0
    while (i < s.length) {
      const ch = s[i]
      if (inString) {
        if (ch === '\\') {
          // Escaped character — pass through both chars
          out += ch + (s[i + 1] || '')
          i += 2
          continue
        }
        if (ch === '"') {
          // Possible end of string — but check if this is an unescaped quote
          // inside a value (common in code content). Heuristic: if the next
          // non-whitespace char is NOT a colon, comma, }, ], or end-of-string,
          // it's likely an embedded quote that should be escaped.
          const rest = s.slice(i + 1)
          const nextSignificant = rest.match(/^\s*(.)/)
          const nextCh = nextSignificant ? nextSignificant[1] : ''
          if (nextCh && !':,}]'.includes(nextCh) && nextCh !== '') {
            // Likely an unescaped quote inside a string value — escape it
            out += '\\"'
            i++
            continue
          }
          inString = false
          out += ch
          i++
          continue
        }
        if (ch === '\n') { out += '\\n'; i++; continue }
        if (ch === '\r') { out += '\\r'; i++; continue }
        if (ch === '\t') { out += '\\t'; i++; continue }
        out += ch
        i++
      } else {
        if (ch === '"') { inString = true }
        out += ch
        i++
      }
    }
    s = out
  } catch { /* if the walker fails, continue with original */ }

  // 2. Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1')

  // 3. Try parsing now
  try { return JSON.parse(s) } catch { /* continue to more aggressive fixes */ }

  // 4. If truncated (missing closing braces/quotes), try to close them
  //    Count open braces/brackets and add missing closers
  let braces = 0, brackets = 0, inStr = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && inStr) { i++; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{') braces++
    else if (ch === '}') braces--
    else if (ch === '[') brackets++
    else if (ch === ']') brackets--
  }
  // If we're still inside a string, close it
  if (inStr) s += '"'
  // Remove any trailing incomplete key-value pair (e.g. `, "key": "trunc`)
  // by trimming back to the last complete value
  s = s.replace(/,\s*"[^"]*":\s*"[^"]*$/, '')
  s = s.replace(/,\s*"[^"]*":\s*$/, '')
  // Close open braces/brackets
  for (let i = 0; i < brackets; i++) s += ']'
  for (let i = 0; i < braces; i++) s += '}'

  // 5. Final trailing comma cleanup and parse
  s = s.replace(/,\s*([}\]])/g, '$1')
  try { return JSON.parse(s) } catch { return null }
}

/**
 * Extract write_file arguments from malformed JSON by finding the path and
 * treating everything between the content value quotes as raw content.
 * This handles the common case where code content breaks JSON escaping.
 *
 * @param {string} raw - The raw (malformed) JSON arguments string
 * @returns {{ path: string, content: string } | null}
 */
function extractWriteFileArgs(raw) {
  if (!raw) return null

  // Try to extract "path" value — this is usually short and well-formed
  const pathMatch = raw.match(/"path"\s*:\s*"([^"]+)"/)
  if (!pathMatch) return null
  const filePath = pathMatch[1]

  // Try to extract "content" value — find the start of the content string
  // and take everything until the closing pattern
  const contentStart = raw.indexOf('"content"')
  if (contentStart === -1) return null

  // Find the opening quote of the content value
  const afterKey = raw.indexOf(':', contentStart + 9)
  if (afterKey === -1) return null

  // Skip whitespace and find the opening quote
  let i = afterKey + 1
  while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\n' || raw[i] === '\r')) i++
  if (raw[i] !== '"') return null
  i++ // skip opening quote

  // Now extract everything until we find the closing pattern: "}
  // We look for the last occurrence of "} or "\n} to find the end
  let content = ''
  const remaining = raw.slice(i)

  // Try to find the end: look for "} at the end (with optional whitespace)
  const endPatterns = [/"\s*\}\s*$/, /"\s*,\s*\}\s*$/, /"\s*$/]
  let endIdx = -1
  for (const pat of endPatterns) {
    const m = remaining.match(pat)
    if (m) { endIdx = m.index; break }
  }

  if (endIdx > 0) {
    content = remaining.slice(0, endIdx)
  } else {
    // No clean end found — take everything and strip trailing junk
    content = remaining.replace(/"\s*\}?\s*$/, '')
  }

  // Unescape the content (it may have some valid JSON escapes mixed with raw chars)
  content = content
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')

  if (!content) return null
  return { path: filePath, content }
}

/**
 * Extract edit_file arguments from malformed JSON.
 */
function extractEditFileArgs(raw) {
  if (!raw) return null
  const pathMatch = raw.match(/"path"\s*:\s*"([^"]+)"/)
  if (!pathMatch) return null

  // For edit_file, try repairJSON first since old_string/new_string are usually shorter
  const repaired = repairJSON(raw)
  if (repaired && repaired.path && repaired.old_string != null && repaired.new_string != null) {
    return repaired
  }
  return null
}

/**
 * Detect the content type hint for compactor based on tool name and content.
 * JSON and diff overrides take priority over tool-name mapping.
 */
function detectContentType(toolName, content) {
  // JSON override: content starts with { or [ and parses
  if (content && (content.trimStart().startsWith('{') || content.trimStart().startsWith('['))) {
    try { JSON.parse(content); return 'json' } catch {}
  }
  // Diff override: contains diff markers
  if (content && /^[-+]{3}\s/m.test(content) && /^@@\s/m.test(content)) return 'diff'
  // Tool name mapping
  const map = {
    read_file: 'code', search_files: 'search', grep_search: 'search',
    execute_command: 'log', bash: 'log', list_dir: 'log',
    browser_screenshot: 'prose', browser_navigate: 'prose',
    browser_click: 'prose', browser_type: 'prose',
  }
  return map[toolName] || 'auto'
}

// ── Route interactive commands to the terminal panel ──────────────────────────
// Used when bash tool detects a command that needs user input (sudo, ssh, etc.)
// Routes through the renderer → ipc-terminal 'terminal-run-interactive' handler
// so sessions are properly tracked and manageable from the UI.
async function _routeToInteractiveTerminal(command, cwd, _notify) {
  try {
    const { BrowserWindow } = require('electron')
    const mainWin = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
    if (!mainWin) return null

    const result = await mainWin.webContents.executeJavaScript(
      `window.app.terminalRunInteractive(${JSON.stringify(command)}, ${JSON.stringify(cwd || null)})`
    )
    return result
  } catch (err) {
    console.warn('[direct-bridge] terminal routing failed:', err.message)
    return null
  }
}

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name, args, cwd, browserInstance, lspManager, inputRequester, notify) {
  // notify can be a plain function (legacy) or { send, _sessionId } object
  // Normalise so callers can use notify._sessionId for undo tracking
  if (typeof notify === 'function') {
    notify = { send: notify, _sessionId: '' }
  }
  notify = notify || { send: () => {}, _sessionId: '' }

  // Route web_* tools to the web tools module
  if (name === 'web_search' || name === 'web_fetch') {
    const apiKeys = getApiKeys()
    return executeWebTool(name, args, { brave: apiKeys.brave })
  }

  // Route desktop_* tools to the desktop automation module
  if (name.startsWith('desktop_')) {
    return executeDesktopTool(name, args)
  }

  // Route devtools_* tools to Chrome DevTools MCP
  if (name.startsWith('devtools_') && chromeDevTools) {
    return chromeDevTools.executeDevToolsTool(name, args)
  }

  // Route browser_* tools to the playwright instance
  if (name.startsWith('browser_') && browserInstance) {
    return browserInstance.execute(name, args)
  }

  // Route lsp_* tools to the LSP manager
  if (name.startsWith('lsp_') && lspManager) {
    const lspStatus = lspManager.getStatus().status
    if (lspStatus !== 'ready' && lspStatus !== 'degraded') {
      return { error: 'LSP not available. Use built-in tools instead.' }
    }
    // Strip the lsp_ prefix and map to actual binary tool names
    // Agent-facing names use lsp_ prefix, binary uses different names for some tools
    const TOOL_NAME_MAP = {
      'get_hover': 'get_info_on_location',
      'get_definition': 'go_to_definition',
      'get_type_definition': 'go_to_type_definition',
      'workspace_symbol': 'get_workspace_symbols',
      'apply_code_action': 'get_code_actions',
    }
    const stripped = name.slice(4)
    const binaryToolName = TOOL_NAME_MAP[stripped] || stripped
    try {
      const result = await Promise.race([
        lspManager.call(binaryToolName, args),
        new Promise((_, reject) => setTimeout(() => reject(new Error('LSP tool timed out (30s)')), 30000))
      ])
      return { result: JSON.stringify(result) }
    } catch (err) {
      return { error: `LSP tool error: ${err.message}. Try using built-in alternatives.` }
    }
  }

  // ── path validation: prevent traversal outside the working directory ──
  function validatePath(filePath) {
    if (!filePath || typeof filePath !== 'string') return { error: 'path is required and must be a non-empty string. You must pass a "path" key in the tool arguments, e.g. read_file({"path": "index.html"})' }
    if (filePath.includes('\0')) return { error: 'path contains null bytes' }

    // Trim whitespace — agents sometimes add trailing spaces/newlines
    let effectivePath = filePath.trim()

    // If the agent passes an absolute path that's within the project, accept it
    // by converting it to a relative path. Handles cases where the agent copies
    // an absolute path from an error message or tool output.
    if (path.isAbsolute(effectivePath)) {
      const normalized = path.normalize(effectivePath)
      const normalizedCwd = path.normalize(cwd)
      if (normalized === normalizedCwd) {
        effectivePath = '.'
      } else if (normalized.startsWith(normalizedCwd + path.sep)) {
        effectivePath = path.relative(cwd, normalized)
      }
      // else: absolute path outside project — will be caught by the check below
    }

    const resolved = path.resolve(cwd, effectivePath)
    // Ensure the resolved path is within the cwd (or is the cwd itself)
    if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
      return { error: `Path "${effectivePath}" resolves outside the working directory. Use a relative path from the project root instead. Working directory: ${cwd}` }
    }
    return { resolved }
  }

  try {
    switch (name) {
      case 'read_file': {
        const v = validatePath(args.path)
        if (v.error) return v
        let p = v.resolved
        if (!fs.existsSync(p)) {
          // macOS case-insensitive fallback
          const parentDir = path.dirname(p)
          const targetName = path.basename(p)
          if (fs.existsSync(parentDir)) {
            try {
              const match = fs.readdirSync(parentDir).find(e => e.toLowerCase() === targetName.toLowerCase())
              if (match) p = path.join(parentDir, match)
            } catch { /* ignore */ }
          }
          if (!fs.existsSync(p)) {
            // Detect double-prefix: agent may have included the project folder name
            // as a path prefix after seeing it in the list_dir tree header.
            // e.g. cwd = "/projects/photo ranker", path = "photo ranker/PhotoRanker/File.swift"
            // Strip the first segment and retry.
            const rootName = path.basename(cwd)
            const parts = args.path.replace(/\\/g, '/').split('/')
            if (parts[0] === rootName && parts.length > 1) {
              const stripped = parts.slice(1).join('/')
              const strippedResolved = path.resolve(cwd, stripped)
              if (strippedResolved.startsWith(cwd) && fs.existsSync(strippedResolved)) {
                p = strippedResolved
              }
            }
          }
          if (!fs.existsSync(p)) {
            // Build a helpful error: walk up the path to find the deepest parent
            // that exists and list its entries. Agents often construct wrong
            // paths after seeing a file tree; showing nearby names is faster
            // than forcing them to call list_dir separately.
            const requested = args.path
            let cur = p
            let climbed = 0
            while (cur && cur !== path.dirname(cur) && !fs.existsSync(cur)) {
              cur = path.dirname(cur)
              climbed++
            }
            let hint = ''
            if (fs.existsSync(cur) && fs.statSync(cur).isDirectory()) {
              try {
                const entries = fs.readdirSync(cur, { withFileTypes: true })
                  .filter(e => !e.name.startsWith('.'))
                  .slice(0, 30)
                  .map(e => e.name + (e.isDirectory() ? '/' : ''))
                const relCur = path.relative(cwd, cur) || '.'
                hint = entries.length > 0
                  ? `\n\nDeepest existing parent: ${relCur}\nContents: ${entries.join(', ')}${climbed > 1 ? '\n\nThe path you passed references directories that do not exist.' : ''}`
                  : `\n\nDeepest existing parent: ${relCur} (empty)`
              } catch { /* ignore */ }
            }
            return { error: `File not found: ${requested}. Tip: paths must be relative to the project root — do not include the project folder name as a prefix.${hint}` }
          }
        }
        const stat = fs.statSync(p)
        if (stat.size > 512 * 1024) return { error: `File too large (${(stat.size / 1024).toFixed(0)}KB). Use start_line/end_line to read sections, or use search_files to find specific content.` }
        const raw = fs.readFileSync(p, 'utf-8')
        const totalLines = raw.split('\n').length
        // Line range support — lets the agent page through large files
        if (args.start_line != null || args.end_line != null) {
          const lines = raw.split('\n')
          const total = lines.length
          const start = Math.max(0, (args.start_line || 1) - 1)
          const end = args.end_line != null ? Math.min(total, args.end_line) : total
          const numbered = lines.slice(start, end).map((l, i) => `${start + i + 1}| ${l}`).join('\n')
          const hasMore = end < total
          return { result: numbered + (hasMore ? `\n\n[lines ${start + 1}-${end} of ${total} total — call read_file again with start_line=${end + 1} to continue]` : ''), _fullRead: !hasMore, _totalLines: total }
        }
        // Return full file with line numbers so the agent knows exact line positions
        const numbered = raw.split('\n').map((l, i) => `${i + 1}| ${l}`).join('\n')
        return { result: numbered, _fullRead: true, _totalLines: totalLines }
      }
      case 'read_files': {
        if (!Array.isArray(args.paths) || args.paths.length === 0) {
          return { error: 'paths must be a non-empty array of file paths' }
        }
        // Cap at 20 files to prevent context explosion
        const filePaths = args.paths.slice(0, 20)
        const results = []
        let totalChars = 0
        const charBudget = config.READ_FILE_TRUNCATE
        for (const filePath of filePaths) {
          const v = validatePath(filePath)
          if (v.error) {
            results.push(`── ${filePath} ──\n[Error: ${v.error}]`)
            continue
          }
          let p = v.resolved
          if (!fs.existsSync(p)) {
            // macOS case-insensitive fallback
            const parentDir = path.dirname(p)
            const targetName = path.basename(p)
            if (fs.existsSync(parentDir)) {
              try {
                const match = fs.readdirSync(parentDir).find(e => e.toLowerCase() === targetName.toLowerCase())
                if (match) p = path.join(parentDir, match)
              } catch { /* ignore */ }
            }
            if (!fs.existsSync(p)) {
              results.push(`── ${filePath} ──\n[Error: File not found]`)
              continue
            }
          }
          const stat = fs.statSync(p)
          if (stat.size > 512 * 1024) {
            results.push(`── ${filePath} ──\n[Error: File too large (${(stat.size / 1024).toFixed(0)}KB) — use read_file with line ranges]`)
            continue
          }
          const raw = fs.readFileSync(p, 'utf-8')
          const lines = raw.split('\n')
          // If adding this file would exceed the budget, stop reading the batch
          // and tell the agent EXACTLY what to do instead — most agents interpret
          // "[truncated]" as "read it again in full", which loops forever.
          if (totalChars + raw.length > charBudget && results.length > 0) {
            const remaining = Math.max(1000, charBudget - totalChars)
            let cutLine = lines.length
            let charCount = 0
            for (let i = 0; i < lines.length; i++) {
              charCount += lines[i].length + 1
              if (charCount > remaining) { cutLine = i; break }
            }
            const numbered = lines.slice(0, cutLine).map((l, i) => `${i + 1}| ${l}`).join('\n')
            const unreadFiles = filePaths.slice(filePaths.indexOf(filePath)).join(', ')
            results.push(
              `── ${filePath} (${lines.length} lines) ──\n${numbered}\n\n` +
              `[CONTEXT BUDGET REACHED — not all requested files fit in context]\n` +
              `Skipped files: ${unreadFiles}\n\n` +
              `DO NOT re-call read_files with the same paths — you will get the same truncation.\n` +
              `Instead:\n` +
              `  • If looking for a specific pattern (imports, references, keywords): use search_files({"patterns":["your-pattern"],"path":"..."}) — targeted and no budget issue\n` +
              `  • If you need specific sections of the skipped files: use read_file with start_line/end_line\n` +
              `  • If you need the whole files: split into smaller batches of 1-3 files at a time`
            )
            totalChars += charCount
            break // stop reading more files
          }
          const numbered = lines.map((l, i) => `${i + 1}| ${l}`).join('\n')
          results.push(`── ${filePath} (${lines.length} lines) ──\n${numbered}`)
          totalChars += raw.length
        }
        if (args.paths.length > 20) {
          results.push(`\n[Note: only first 20 of ${args.paths.length} files were read]`)
        }
        return { result: results.join('\n\n'), _fullRead: true, _totalLines: results.length }
      }
      case 'write_file': {
        // Auto-coerce objects/arrays to JSON — the model frequently passes a
        // structured literal when the "content" is JSON (Contents.json,
        // package.json, etc.). Stringify rather than erroring.
        let _coerced = false
        if (args.content !== null && typeof args.content === 'object') {
          try {
            args.content = JSON.stringify(args.content, null, 2) + '\n'
            _coerced = true
          } catch (_jsonErr) {
            return { error: 'content must be a string or a JSON-serializable value' }
          }
        }
        if (typeof args.content !== 'string') return { error: 'content must be a string (got ' + typeof args.content + '). If writing JSON, pass the serialized string or a plain object — the tool will stringify it.' }
        const v = validatePath(args.path)
        if (v.error) return v
        const p = v.resolved

        // Guard: protect orchestrator-managed files from direct agent writes.
        // tasks.md is owned by the orchestrator — agents must not overwrite it
        // directly as this corrupts the task graph (duplicates, wrong statuses).
        const protectedFiles = ['tasks.md', '.maccoder/tasks.md']
        const relPath = path.relative(cwd, p)
        if (protectedFiles.some(f => relPath === f || relPath.endsWith('/' + f) || relPath.endsWith(path.sep + f))) {
          return { error: `write_file blocked: tasks.md is managed by the orchestrator and must not be written directly. Use update_todos to track progress, or use edit_file to make surgical changes to specific task lines only.` }
        }

        // Guard: reject writes containing truncation artifacts — these mean the model
        // hit its output token limit mid-generation and the content is incomplete.
        // Writing truncated content to disk corrupts the file silently.
        const TRUNCATION_MARKERS = [
          '[TRUNCATED — original length',
          '... [truncated',
          '\n\n[compressed:',
          '[lines 1-',
          'call read_file again with start_line=',
          '[TRIMMED for context space',
        ]
        for (const marker of TRUNCATION_MARKERS) {
          if (args.content.includes(marker)) {
            return { error: `write_file rejected: content contains truncation artifact "${marker.slice(0, 40)}". The content is incomplete — the model hit its token limit mid-write. Split the write into smaller chunks (under 200 lines each) and write them separately.` }
          }
        }

        const dir = path.dirname(p)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        // Snapshot before-state for undo
        const _beforeWrite = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null
        fs.writeFileSync(p, args.content, 'utf-8')
        if (notify && notify._sessionId) undoRecord(notify._sessionId, p, _beforeWrite, args.content, 'write_file')
        _scheduleAutoCommit(cwd)
        const _coercedNote = _coerced ? ' (object auto-stringified to JSON)' : ''
        return { result: `Wrote ${args.content.length} chars to ${args.path}${_coercedNote}` }
      }
      case 'edit_file': {
        // Tolerate non-string old_string/new_string by stringifying — the model
        // sometimes sends arrays of lines or JSON objects.
        if (typeof args.old_string !== 'string') {
          if (args.old_string == null) return { error: 'old_string is required' }
          if (Array.isArray(args.old_string)) args.old_string = args.old_string.join('\n')
          else if (typeof args.old_string === 'object') args.old_string = JSON.stringify(args.old_string, null, 2)
          else args.old_string = String(args.old_string)
        }
        if (typeof args.new_string !== 'string') {
          if (args.new_string == null) return { error: 'new_string is required' }
          if (Array.isArray(args.new_string)) args.new_string = args.new_string.join('\n')
          else if (typeof args.new_string === 'object') args.new_string = JSON.stringify(args.new_string, null, 2)
          else args.new_string = String(args.new_string)
        }
        const v = validatePath(args.path)
        if (v.error) return v
        const p = v.resolved
        if (!fs.existsSync(p)) return { error: `File not found: ${args.path}` }

        // Guard: reject edits where new_string contains truncation artifacts
        const _TRUNC_MARKERS = ['[TRUNCATED — original length', '... [truncated', '\n\n[compressed:', 'call read_file again with start_line=']
        for (const marker of _TRUNC_MARKERS) {
          if (args.new_string.includes(marker)) {
            return { error: `edit_file rejected: new_string contains truncation artifact. Content is incomplete — split into smaller edits.` }
          }
        }

        const content = fs.readFileSync(p, 'utf-8')

        // ── Fuzzy match & auto-recovery for edit_file ──────────────────────
        // When old_string doesn't match exactly, try common fixups before failing.
        // This saves the agent from looping on whitespace/line-number mismatches.
        let _editOldString = args.old_string

        if (!content.includes(_editOldString)) {
          // Fix 1: Strip line-number prefixes that read_file adds (e.g. "123| ")
          const stripped = _editOldString.replace(/^\d+\| /gm, '')
          if (stripped !== _editOldString && content.includes(stripped)) {
            _editOldString = stripped
          }
        }

        if (!content.includes(_editOldString)) {
          // Fix 2: Normalize line endings (CRLF → LF)
          const lfNormalized = _editOldString.replace(/\r\n/g, '\n')
          if (lfNormalized !== _editOldString && content.includes(lfNormalized)) {
            _editOldString = lfNormalized
          }
        }

        if (!content.includes(_editOldString)) {
          // Fix 3: Trim trailing whitespace from each line
          const trimmedLines = _editOldString.split('\n').map(l => l.trimEnd()).join('\n')
          if (trimmedLines !== _editOldString && content.includes(trimmedLines)) {
            _editOldString = trimmedLines
          }
        }

        if (!content.includes(_editOldString)) {
          // Fix 4: Strip leading/trailing blank lines — agent often adds extra \n
          const trimmedEnds = _editOldString.replace(/^\n+/, '').replace(/\n+$/, '')
          if (trimmedEnds !== _editOldString && content.includes(trimmedEnds)) {
            _editOldString = trimmedEnds
          }
        }

        if (!content.includes(_editOldString)) {
          // Fix 5: Tab ↔ space normalization
          // Try converting tabs to spaces (2 and 4) and spaces to tabs
          const tabTo2 = _editOldString.replace(/\t/g, '  ')
          if (tabTo2 !== _editOldString && content.includes(tabTo2)) {
            _editOldString = tabTo2
          } else {
            const tabTo4 = _editOldString.replace(/\t/g, '    ')
            if (tabTo4 !== _editOldString && content.includes(tabTo4)) {
              _editOldString = tabTo4
            } else {
              // Try spaces → tabs (detect leading spaces pattern)
              const spacesToTabs = _editOldString.replace(/^( {2,4})/gm, (m) => '\t'.repeat(Math.ceil(m.length / 4)))
              if (spacesToTabs !== _editOldString && content.includes(spacesToTabs)) {
                _editOldString = spacesToTabs
              }
            }
          }
        }

        if (!content.includes(_editOldString)) {
          // Fix 6: Indentation level shift — content matches but at different indent
          // Detect if removing a uniform indent offset produces a match
          const oldLines = _editOldString.split('\n')
          const nonEmpty = oldLines.filter(l => l.trim().length > 0)
          if (nonEmpty.length > 0) {
            // Find minimum indent in old_string
            const oldIndents = nonEmpty.map(l => l.match(/^(\s*)/)[1].length)
            const minOldIndent = Math.min(...oldIndents)
            // Try shifting indent by -4, -2, +2, +4 spaces
            const shifts = [-4, -2, 2, 4]
            for (const shift of shifts) {
              const shifted = oldLines.map(l => {
                if (l.trim().length === 0) return l
                const currentIndent = l.match(/^(\s*)/)[1].length
                const newIndent = Math.max(0, currentIndent + shift)
                return ' '.repeat(newIndent) + l.trimStart()
              }).join('\n')
              if (shifted !== _editOldString && content.includes(shifted)) {
                _editOldString = shifted
                break
              }
            }
          }
        }

        if (!content.includes(_editOldString)) {
          // Fix 7: Smart quotes / curly apostrophes → ASCII
          const asciiQuotes = _editOldString
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/\u2014/g, '--')
            .replace(/\u2013/g, '-')
            .replace(/\u2026/g, '...')
          if (asciiQuotes !== _editOldString && content.includes(asciiQuotes)) {
            _editOldString = asciiQuotes
          }
        }

        if (!content.includes(_editOldString)) {
          // Fix 8: HTML entity leakage — model sometimes outputs &lt; &gt; &amp; in code
          const unescaped = _editOldString
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
          if (unescaped !== _editOldString && content.includes(unescaped)) {
            _editOldString = unescaped
          }
        }

        if (!content.includes(_editOldString)) {
          // Fix 9: Subset match — old_string has extra lines at start/end that
          // don't exist in the file. Try trimming 1-2 lines from each end.
          const oldLines = _editOldString.split('\n')
          if (oldLines.length >= 4) {
            // Try removing first line
            const noFirst = oldLines.slice(1).join('\n')
            if (content.includes(noFirst)) { _editOldString = noFirst }
            // Try removing last line
            else {
              const noLast = oldLines.slice(0, -1).join('\n')
              if (content.includes(noLast)) { _editOldString = noLast }
              // Try removing both
              else {
                const noBoth = oldLines.slice(1, -1).join('\n')
                if (noBoth.split('\n').length >= 2 && content.includes(noBoth)) {
                  _editOldString = noBoth
                }
              }
            }
          }
        }

        if (!content.includes(_editOldString)) {
          // No auto-fix worked — find the closest matching region and show it
          // to the agent so it can self-correct in one turn.
          const oldLines = args.old_string.replace(/^\d+\| /gm, '').split('\n')
          const contentLines = content.split('\n')

          // Find the best anchor: longest non-trivial line in old_string
          let anchorLine = ''
          for (const l of oldLines) {
            const trimmed = l.trim()
            if (trimmed.length > anchorLine.length && trimmed.length > 5) {
              anchorLine = trimmed
            }
          }
          if (!anchorLine) anchorLine = oldLines[0].trim()

          // Search for the anchor in the file
          let bestIdx = -1
          for (let i = 0; i < contentLines.length; i++) {
            if (contentLines[i].includes(anchorLine) || contentLines[i].trim() === anchorLine) {
              bestIdx = i
              break
            }
          }

          // If exact anchor not found, try substring match (first 30 chars)
          if (bestIdx === -1 && anchorLine.length > 15) {
            const sub = anchorLine.slice(0, 30)
            for (let i = 0; i < contentLines.length; i++) {
              if (contentLines[i].includes(sub)) {
                bestIdx = i
                break
              }
            }
          }

          // Last resort: find the line with the highest word overlap
          if (bestIdx === -1 && oldLines.length > 0) {
            const oldWords = new Set(oldLines.join(' ').split(/\s+/).filter(w => w.length > 3))
            if (oldWords.size > 0) {
              let bestScore = 0
              for (let i = 0; i < contentLines.length; i++) {
                const lineWords = contentLines[i].split(/\s+/).filter(w => w.length > 3)
                const score = lineWords.filter(w => oldWords.has(w)).length
                if (score > bestScore) {
                  bestScore = score
                  bestIdx = i
                }
              }
              // Only use if we matched at least 3 words
              if (bestScore < 3) bestIdx = -1
            }
          }

          if (bestIdx !== -1) {
            // Show the actual content around the anchor so the agent can copy it exactly
            const regionStart = Math.max(0, bestIdx - 2)
            const regionEnd = Math.min(contentLines.length, bestIdx + oldLines.length + 3)
            const actual = contentLines.slice(regionStart, regionEnd)
              .map((l, i) => `${regionStart + i + 1}| ${l}`)
              .join('\n')
            return { error: `old_string not found in ${args.path} (no exact match). ` +
              `A similar region was found near line ${bestIdx + 1}. Here is the ACTUAL content — copy it exactly as old_string, or use edit_file_lines with start_line=${regionStart + 1} end_line=${Math.min(regionEnd, contentLines.length)}:\n\n${actual}` }
          }

          return { error: `old_string not found in ${args.path}. Make sure it matches exactly. Tip: re-read the file with read_file first to get the current content, then use the exact text from that read.` }
        }
        const count = content.split(_editOldString).length - 1
        if (count > 1) return { error: `old_string found ${count} times in ${args.path}. Make it more specific so it matches exactly once.` }
        const _editedContent = content.replace(_editOldString, args.new_string)
        // Snapshot before-state for undo
        if (notify && notify._sessionId) undoRecord(notify._sessionId, p, content, _editedContent, 'edit_file')
        fs.writeFileSync(p, _editedContent, 'utf-8')
        _scheduleAutoCommit(cwd)
        return { result: `Edited ${args.path}` }
      }
      case 'edit_file_lines': {
        // Line-range replacement — bypasses old_string matching entirely.
        // The agent specifies start_line and end_line (1-indexed, inclusive)
        // and the content to replace those lines with.
        // Coerce arrays/objects to strings.
        if (typeof args.new_content !== 'string') {
          if (args.new_content == null) return { error: 'new_content is required' }
          if (Array.isArray(args.new_content)) args.new_content = args.new_content.join('\n')
          else if (typeof args.new_content === 'object') args.new_content = JSON.stringify(args.new_content, null, 2)
          else args.new_content = String(args.new_content)
        }
        if (typeof args.start_line !== 'number' || typeof args.end_line !== 'number') {
          return { error: 'start_line and end_line must be numbers (1-indexed)' }
        }
        if (args.start_line < 1) return { error: 'start_line must be >= 1' }
        if (args.end_line < args.start_line) return { error: 'end_line must be >= start_line' }

        const v = validatePath(args.path)
        if (v.error) return v
        const p = v.resolved
        if (!fs.existsSync(p)) return { error: `File not found: ${args.path}` }

        // Guard: reject truncation artifacts
        const _TRUNC_MARKERS_L = ['[TRUNCATED — original length', '... [truncated', '\n\n[compressed:', 'call read_file again with start_line=']
        for (const marker of _TRUNC_MARKERS_L) {
          if (args.new_content.includes(marker)) {
            return { error: `edit_file_lines rejected: new_content contains truncation artifact. Content is incomplete — split into smaller edits.` }
          }
        }

        const content = fs.readFileSync(p, 'utf-8')
        const lines = content.split('\n')
        const totalLines = lines.length

        if (args.start_line > totalLines) {
          return { error: `start_line ${args.start_line} exceeds file length (${totalLines} lines)` }
        }
        if (args.end_line > totalLines) {
          return { error: `end_line ${args.end_line} exceeds file length (${totalLines} lines). File has ${totalLines} lines.` }
        }

        // Replace the line range
        const before = lines.slice(0, args.start_line - 1)
        const after = lines.slice(args.end_line)
        const newLines = args.new_content.split('\n')
        const newContent = [...before, ...newLines, ...after].join('\n')

        // Snapshot for undo
        if (notify && notify._sessionId) undoRecord(notify._sessionId, p, content, newContent, 'edit_file_lines')
        fs.writeFileSync(p, newContent, 'utf-8')
        _scheduleAutoCommit(cwd)

        const removedCount = args.end_line - args.start_line + 1
        const insertedCount = newLines.length
        return { result: `Edited ${args.path}: replaced lines ${args.start_line}-${args.end_line} (${removedCount} lines) with ${insertedCount} lines.` }
      }
      case 'edit_files': {
        if (!Array.isArray(args.edits) || args.edits.length === 0) {
          return { error: 'edits must be a non-empty array of edit operations' }
        }
        // Cap at 20 edits per call
        const edits = args.edits.slice(0, 20)
        const results = []
        let successCount = 0
        let errorCount = 0
        for (let i = 0; i < edits.length; i++) {
          const edit = edits[i]
          if (!edit.path || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') {
            results.push(`Edit ${i + 1}: ❌ Missing required fields (path, old_string, new_string)`)
            errorCount++
            continue
          }
          const v = validatePath(edit.path)
          if (v.error) {
            results.push(`Edit ${i + 1} (${edit.path}): ❌ ${v.error}`)
            errorCount++
            continue
          }
          const ep = v.resolved
          if (!fs.existsSync(ep)) {
            results.push(`Edit ${i + 1} (${edit.path}): ❌ File not found`)
            errorCount++
            continue
          }
          // Guard: reject truncation artifacts
          const _TRUNC_MARKERS = ['[TRUNCATED — original length', '... [truncated', '\n\n[compressed:', 'call read_file again with start_line=']
          let hasArtifact = false
          for (const marker of _TRUNC_MARKERS) {
            if (edit.new_string.includes(marker)) { hasArtifact = true; break }
          }
          if (hasArtifact) {
            results.push(`Edit ${i + 1} (${edit.path}): ❌ new_string contains truncation artifact`)
            errorCount++
            continue
          }
          const fileContent = fs.readFileSync(ep, 'utf-8')
          // Apply same fuzzy-match fixups as edit_file
          let _batchOld = edit.old_string
          if (!fileContent.includes(_batchOld)) {
            const s1 = _batchOld.replace(/^\d+\| /gm, '')
            if (s1 !== _batchOld && fileContent.includes(s1)) _batchOld = s1
          }
          if (!fileContent.includes(_batchOld)) {
            const s2 = _batchOld.replace(/\r\n/g, '\n')
            if (s2 !== _batchOld && fileContent.includes(s2)) _batchOld = s2
          }
          if (!fileContent.includes(_batchOld)) {
            const s3 = _batchOld.split('\n').map(l => l.trimEnd()).join('\n')
            if (s3 !== _batchOld && fileContent.includes(s3)) _batchOld = s3
          }
          if (!fileContent.includes(_batchOld)) {
            const s4 = _batchOld.replace(/^\n+/, '').replace(/\n+$/, '')
            if (s4 !== _batchOld && fileContent.includes(s4)) _batchOld = s4
          }
          if (!fileContent.includes(_batchOld)) {
            // Tab ↔ space
            const t2 = _batchOld.replace(/\t/g, '  ')
            if (t2 !== _batchOld && fileContent.includes(t2)) { _batchOld = t2 }
            else {
              const t4 = _batchOld.replace(/\t/g, '    ')
              if (t4 !== _batchOld && fileContent.includes(t4)) _batchOld = t4
            }
          }
          if (!fileContent.includes(_batchOld)) {
            // Indent shift
            const bLines = _batchOld.split('\n')
            const shifts = [-4, -2, 2, 4]
            for (const shift of shifts) {
              const shifted = bLines.map(l => {
                if (l.trim().length === 0) return l
                const ci = l.match(/^(\s*)/)[1].length
                return ' '.repeat(Math.max(0, ci + shift)) + l.trimStart()
              }).join('\n')
              if (shifted !== _batchOld && fileContent.includes(shifted)) { _batchOld = shifted; break }
            }
          }
          if (!fileContent.includes(_batchOld)) {
            // Smart quotes → ASCII
            const aq = _batchOld.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
            if (aq !== _batchOld && fileContent.includes(aq)) _batchOld = aq
          }
          if (!fileContent.includes(_batchOld)) {
            // HTML entities
            const ue = _batchOld.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
            if (ue !== _batchOld && fileContent.includes(ue)) _batchOld = ue
          }
          if (!fileContent.includes(_batchOld)) {
            // Subset: trim first/last line
            const bLines = _batchOld.split('\n')
            if (bLines.length >= 4) {
              const noFirst = bLines.slice(1).join('\n')
              if (fileContent.includes(noFirst)) { _batchOld = noFirst }
              else {
                const noLast = bLines.slice(0, -1).join('\n')
                if (fileContent.includes(noLast)) _batchOld = noLast
              }
            }
          }
          if (!fileContent.includes(_batchOld)) {
            results.push(`Edit ${i + 1} (${edit.path}): ❌ old_string not found`)
            errorCount++
            continue
          }
          const matchCount = fileContent.split(_batchOld).length - 1
          if (matchCount > 1) {
            results.push(`Edit ${i + 1} (${edit.path}): ❌ old_string found ${matchCount} times — make it more specific`)
            errorCount++
            continue
          }
          const newContent = fileContent.replace(_batchOld, edit.new_string)
          if (notify && notify._sessionId) undoRecord(notify._sessionId, ep, fileContent, newContent, 'edit_files')
          fs.writeFileSync(ep, newContent, 'utf-8')
          results.push(`Edit ${i + 1} (${edit.path}): ✅ Applied`)
          successCount++
        }
        if (args.edits.length > 20) {
          results.push(`\n[Note: only first 20 of ${args.edits.length} edits were applied]`)
        }
        if (successCount > 0) _scheduleAutoCommit(cwd)
        return { result: `${successCount} edits applied, ${errorCount} failed:\n${results.join('\n')}` }
      }
      case 'list_dir': {
        const listPath = (args && args.path != null) ? args.path : '.'
        const v = validatePath(listPath)
        if (v.error) return { error: `list_dir failed: ${v.error}` }
        let p = v.resolved
        if (!fs.existsSync(p)) {
          // macOS is case-insensitive — try to find a case-insensitive match
          const parentDir = path.dirname(p)
          const targetName = path.basename(p)
          let caseMatch = null
          if (fs.existsSync(parentDir)) {
            try {
              const entries = fs.readdirSync(parentDir)
              caseMatch = entries.find(e => e.toLowerCase() === targetName.toLowerCase())
            } catch { /* ignore */ }
          }
          if (caseMatch) {
            // Use the correctly-cased path
            p = path.join(parentDir, caseMatch)
          } else {
            // Detect double-prefix: agent included the project folder name as a path prefix.
            // e.g. cwd = "/projects/photo ranker", listPath = "photo ranker/PhotoRanker"
            const rootName = path.basename(cwd)
            const parts = listPath.replace(/\\/g, '/').split('/')
            if (parts[0] === rootName && parts.length > 1) {
              const stripped = parts.slice(1).join('/')
              const strippedResolved = path.resolve(cwd, stripped)
              if (strippedResolved.startsWith(cwd) && fs.existsSync(strippedResolved)) {
                p = strippedResolved
                // fall through to the readdir below
              } else {
                return { error: `Directory not found: ${listPath}. Do not include the project folder name "${rootName}" as a path prefix — paths are relative to the project root.` }
              }
            } else {
              // Help the agent recover by showing what's actually at the parent directory
              let hint = ''
              if (fs.existsSync(parentDir)) {
                try {
                  const siblings = fs.readdirSync(parentDir, { withFileTypes: true })
                    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
                    .map(e => e.name)
                    .slice(0, 20)
                  if (siblings.length > 0) {
                    hint = ` Available directories in "${path.relative(cwd, parentDir) || '.'}": ${siblings.join(', ')}`
                  }
                } catch { /* ignore */ }
              }
              return { error: `Directory not found: ${listPath}.${hint}` }
            }
          }
        }
        try {
          // Guard: ensure the resolved path is actually a directory before scanning.
          const stat = fs.statSync(p)
          if (!stat.isDirectory()) {
            return { error: `list_dir error for "${listPath}": path is a file, not a directory. Use read_file to read its contents.` }
          }

          const entries = fs.readdirSync(p, { withFileTypes: true })
            .filter(e => !e.name.startsWith('.'))
            .sort((a, b) => {
              if (a.isDirectory() && !b.isDirectory()) return -1
              if (!a.isDirectory() && b.isDirectory()) return 1
              return a.name.localeCompare(b.name)
            })
            .map(e => e.isDirectory() ? e.name + '/' : e.name)

          // When listing the project root, return a full recursive tree so the
          // agent gets complete spatial awareness on demand without needing to
          // call list_dir repeatedly on each subdirectory.
          const isProjectRoot = p === cwd || p === path.resolve(cwd, '.')
          const requestedDepth = (args && args.depth != null) ? args.depth : null
          if (isProjectRoot) {
            const tree = buildFileTree(p, requestedDepth ?? 99)
            const treeResult = tree || (entries.length > 0 ? entries.join('\n') : '(empty directory)')
            // Append a clear note so the agent doesn't prepend the folder name to paths.
            // The tree header shows e.g. "photo ranker/" but that's just a label — all
            // tool paths must be relative to this root (e.g. "PhotoRanker/Models/Photo.swift").
            const rootName = path.basename(p)
            return { result: `${treeResult}\n\nNOTE: You are at the project root. Use paths relative to here — do NOT include "${rootName}/" as a prefix. Example: "PhotoRanker/Models/Photo.swift", not "${rootName}/PhotoRanker/Models/Photo.swift".` }
          }

          // For subdirectories, return a full recursive tree by default.
          const subDepth = requestedDepth ?? 99
          if (subDepth > 0) {
            const tree = buildFileTree(p, subDepth)
            if (tree) return { result: tree }
          }

          return { result: entries.length > 0 ? entries.join('\n') : '(empty directory)' }
        } catch (err) {
          return { error: `list_dir error for "${listPath}" (cwd: ${cwd}): ${err.message}` }
        }
      }
      case 'bash': {
        if (typeof args.command !== 'string' || !args.command.trim()) return { error: 'command must be a non-empty string. Usage: bash({"command": "ls -la"})' }
        // Strip the -quiet flag from xcodebuild commands. It hides the
        // "BUILD SUCCEEDED" marker along with the verbose log, leaving only
        // warnings in stderr — agents commonly misread that as a failure.
        // Keep the normal log; if the caller truly wants a short log they can
        // pipe through tail/grep themselves.
        let _quietStripped = false
        {
          const cmd = args.command
          // Match xcodebuild … -quiet (or --quiet) anywhere in a pipeline
          if (/\bxcodebuild\b/.test(cmd) && /\s-{1,2}quiet\b/.test(cmd)) {
            args.command = cmd.replace(/\s-{1,2}quiet\b/g, '')
            _quietStripped = true
          }
        }
        // Block obviously dangerous commands
        const dangerous = /\b(rm\s+-rf\s+\/|mkfs|dd\s+if=|:(){ :|fork\s*bomb)\b/i
        if (dangerous.test(args.command)) return { error: 'Command blocked for safety' }

        // Detect sudo commands that will hang waiting for a password prompt.
        // Try sudo -n first (non-interactive dry-run) — if it fails with "a password is required",
        // route the command to the interactive terminal panel so the user can type the password.
        // Allow through: sudo -n (already non-interactive), sudo -S (reads from stdin — we don't pipe one).
        const sudoInteractiveMatch = args.command.trim().match(/(?:^|[;&|]\s*)sudo(?!\s+-[a-zA-Z]*n)(?!\s+-S)\s+/)
        if (sudoInteractiveMatch) {
          // Quick non-interactive probe: sudo -n true
          try {
            const { execFileSync: _execFileSync } = require('child_process')
            _execFileSync('sudo', ['-n', 'true'], { timeout: 3000, stdio: 'pipe' })
            // Credentials are cached — let the command through
          } catch (_sudoErr) {
            const msg = (_sudoErr.stderr || '').toString()
            if (msg.includes('password is required') || msg.includes('a password is required') || _sudoErr.status === 1) {
              // Route to interactive terminal instead of failing
              try {
                const _termResult = await _routeToInteractiveTerminal(args.command, cwd, notify)
                if (_termResult && _termResult.id) {
                  return { result: _termResult.message }
                }
              } catch (_termErr) {
                // Terminal routing failed — fall back to the old error message
              }
              return { error: `This sudo command requires a password and will hang in this environment:\n  ${args.command.trim()}\n\nThe command has been sent to the interactive terminal panel at the bottom of the Preview tab. Please enter your password there.` }
            }
            // Other error (e.g. sudo not found) — let it through and fail naturally
          }
        }

        // Detect tool-call syntax used as a bash command — e.g. xcode_list_schemes(project_path="...")
        // This happens when the model confuses agent tool names with shell commands.
        // Catch: identifier followed immediately by ( with no spaces before it.
        const toolCallPattern = /^([a-z][a-z0-9_]*)\s*\(/i
        const toolCallMatch = args.command.trim().match(toolCallPattern)
        if (toolCallMatch) {
          const calledName = toolCallMatch[1]
          // Only flag if it looks like one of our known tool names (contains underscore or matches known prefixes)
          const looksLikeTool = calledName.includes('_') || /^(xcode|lsp|browser|web|read|write|edit|list|search|bash|task|ask|update)\w+/.test(calledName)
          if (looksLikeTool) {
            return { error: `"${calledName}(...)" is not a shell command — it looks like an agent tool call written in function-call syntax. Do NOT run agent tools via bash. Instead, call the tool directly using the tool-call interface. For example, to list Xcode schemes, use the xcode_list_schemes tool with {"project_path": "..."} as arguments, not bash.` }
          }
        }

        // Redirect cat/head/tail on source files to read_file — bash output is capped
        // at 2MB and has no line-range support, causing truncation on large files.
        // Match: cat/head/tail [optional flags like -n 100, -100, -c 50] <filepath>
        const catTailMatch = args.command.trim().match(/^(cat|head|tail)\s+(.+)$/s)
        if (catTailMatch) {
          const verb = catTailMatch[1]
          const rest = catTailMatch[2].trim()
          // Strip flags/arguments (e.g. -100, -n 50, -c 200, --lines=50) to isolate the file path
          const withoutFlags = rest.replace(/(?:^|\s)(?:-[a-zA-Z]+\s+\d+|-\d+|--[a-z]+=\d+)/g, '').trim()
          // Remove surrounding quotes
          const cleanPath = withoutFlags.replace(/^["']|["']$/g, '').trim()
          const sourceExt = /\.(swift|js|ts|py|go|rs|java|kt|cpp|c|h|cs|rb|php|html|css|json|yaml|yml|md|txt|sh|bash|zsh|fish|toml|xml|gradle|plist|pbxproj)$/
          if (cleanPath && sourceExt.test(cleanPath) && !cleanPath.startsWith('-')) {
            // Check if the path is absolute and outside the project — read_file won't work either
            if (path.isAbsolute(cleanPath) && !cleanPath.startsWith(cwd)) {
              // Let the bash command through for absolute paths outside the project
              // since read_file can't access them either. The agent needs bash for this.
            } else {
              // Transparently redirect to read_file instead of returning an error.
              // This saves a round-trip — the model gets the file content immediately
              // instead of getting an error and having to call read_file separately.
              const readResult = await executeTool('read_file', { path: cleanPath }, cwd, browserInstance, lspManager, inputRequester, notify)
              if (readResult.error) {
                return { error: `${verb} redirected to read_file: ${readResult.error}` }
              }
              return { result: readResult.result, _fullRead: readResult._fullRead, _totalLines: readResult._totalLines }
            }
          }
        }

        // Detect background commands (trailing & or nohup) — these never exit so we
        // run them detached and return immediately with a status message.
        const isBackground = /(?:^|;|\|)\s*(?:nohup\s+)?.+\s*&\s*$/.test(args.command.trim())
        if (isBackground) {
          // Strip the trailing & and run detached so the agent loop doesn't hang
          const cmd = args.command.trim().replace(/&\s*$/, '').trim()
          const { spawn: spawnBg } = require('child_process')
          const _bgEnv = { ...process.env }
          const _bgExtra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin']
          const _bgMissing = _bgExtra.filter(d => !(_bgEnv.PATH || '').includes(d))
          if (_bgMissing.length > 0) _bgEnv.PATH = _bgMissing.join(':') + ':' + (_bgEnv.PATH || '')
          const bgProc = spawnBg('bash', ['-c', cmd], {
            cwd,
            env: _bgEnv,
            stdio: 'ignore',
            detached: true,
          })
          bgProc.unref()
          return { result: `Background process started (PID ${bgProc.pid}): ${cmd.slice(0, 100)}` }
        }
        return new Promise((resolve) => {
          let stdout = ''
          let stderr = ''
          let killed = false
          // Augment PATH so swift, xcodebuild, git, brew etc. are found.
          // Electron strips /opt/homebrew/bin and /usr/bin from its PATH.
          const augmentedEnv = { ...process.env }
          const extraDirs = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/usr/sbin', '/bin', '/sbin']
          const currentPath = augmentedEnv.PATH || ''
          const missing = extraDirs.filter(d => !currentPath.includes(d))
          if (missing.length > 0) {
            augmentedEnv.PATH = missing.join(':') + (currentPath ? ':' + currentPath : '')
          }
          // Fix xcode-select pointing to CommandLineTools instead of Xcode.app.
          // Electron inherits the system xcode-select path which is often wrong.
          // Setting DEVELOPER_DIR overrides xcode-select for all child processes
          // (xcodebuild, xcrun, simctl, etc.) without needing sudo.
          if (!augmentedEnv.DEVELOPER_DIR) {
            const xcodeDev = '/Applications/Xcode.app/Contents/Developer'
            try {
              if (fs.existsSync(xcodeDev)) {
                augmentedEnv.DEVELOPER_DIR = xcodeDev
                // Also prepend Xcode's usr/bin so xcodebuild resolves correctly
                const xcodeBin = `${xcodeDev}/usr/bin`
                if (!augmentedEnv.PATH.includes(xcodeBin)) {
                  augmentedEnv.PATH = xcodeBin + ':' + augmentedEnv.PATH
                }
              }
            } catch { /* existsSync failed — skip */ }
          }
          const proc = spawn('bash', ['-c', args.command], {
            cwd,
            env: augmentedEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          // Use a longer timeout for known long-running commands (installs, builds, tests)
          const isLongRunning = /\b(npm\s+install|npm\s+ci|yarn\s+install|pnpm\s+install|pip\s+install|pip3\s+install|poetry\s+install|bundle\s+install|pod\s+install|swift\s+build|swift\s+package\s+resolve|xcodebuild|cargo\s+build|cargo\s+install|go\s+build|go\s+get|mvn\s+install|gradle\s+build|make\b|cmake\b|brew\s+install|apt\s+install|apt-get\s+install)\b/i.test(args.command)
          const timeoutMs = isLongRunning ? 300000 : 30000  // 5 min for installs/builds, 30s otherwise
          const timer = setTimeout(() => {
            killed = true
            proc.kill('SIGKILL')
          }, timeoutMs)

          // Heartbeat: if no new output for 60s, notify the user the command is still running.
          // Prevents the UI from looking frozen during long installs/builds.
          let lastOutputAt = Date.now()
          const heartbeatInterval = setInterval(() => {
            const silentSecs = Math.round((Date.now() - lastOutputAt) / 1000)
            if (silentSecs >= 60) {
              const elapsedTotal = Math.round((Date.now() - (lastOutputAt - silentSecs * 1000 + silentSecs * 1000)) / 1000)
              if (notify && notify.send) {
                notify.send('qwen-event', {
                  type: 'bash-waiting',
                  command: args.command.slice(0, 80),
                  elapsedSecs: silentSecs,
                  timeoutSecs: timeoutMs / 1000,
                })
              }
            }
          }, 60000)
          proc.stdout.on('data', (chunk) => {
            stdout += chunk.toString()
            lastOutputAt = Date.now()
            if (stdout.length > 2 * 1024 * 1024) { killed = true; proc.kill('SIGKILL') }
          })
          proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString()
            lastOutputAt = Date.now()
            if (stderr.length > 2 * 1024 * 1024) { killed = true; proc.kill('SIGKILL') }
          })
          proc.on('close', (code) => {
            clearTimeout(timer)
            clearInterval(heartbeatInterval)
            const _quietNote = _quietStripped
              ? '[bash note: -quiet flag removed from xcodebuild — it hides BUILD SUCCEEDED and misleads the agent]\n'
              : ''
            if (killed) {
              resolve({ error: `${_quietNote}Command timed out or exceeded output limit (${timeoutMs / 1000}s):\n${(stdout + '\n' + stderr).trim().slice(0, 2000)}` })
            } else if (code === 0) {
              if (stdout) {
                resolve({ result: _quietNote + stdout })
              } else {
                // Command succeeded with no stdout — common for write operations
                // (cat > file << EOF, echo > file, cp, mv, mkdir, etc.).
                // Return a clear success message so the agent doesn't retry thinking nothing happened.
                const cmd = (args.command || '').trim()
                const isWrite = /cat\s*>|>>\s*\S|cp\s|mv\s|mkdir\s|touch\s|rm\s|chmod\s|chown\s|ln\s|rsync\s/.test(cmd)
                resolve({ result: isWrite ? 'Done. (command succeeded, no output — this is normal for file write/move/delete operations)' : 'Done. (command succeeded with no output)' })
              }
            } else {
              const combined = (stdout + '\n' + stderr).trim()
              // When stderr is suppressed (e.g. 2>/dev/null) and stdout is empty,
              // provide a more actionable hint rather than the opaque "Unknown error".
              let errorDetail = combined
              if (!errorDetail) {
                // Check if the command references a path that doesn't exist
                const pathMatch = args.command.match(/"([^"]+)"/)
                if (pathMatch) {
                  const fs2 = require('fs')
                  const candidatePath = pathMatch[1]
                  if (!fs2.existsSync(candidatePath)) {
                    errorDetail = `No such file or directory: ${candidatePath}`
                  }
                }
                if (!errorDetail) errorDetail = 'Command exited with non-zero status and produced no output (stderr may have been suppressed with 2>/dev/null)'
              }
              resolve({ error: `${_quietNote}Command failed (exit ${code}):\n${errorDetail}` })
            }
          })
          proc.on('error', (err) => {
            clearTimeout(timer)
            clearInterval(heartbeatInterval)
            resolve({ error: `Failed to spawn command: ${err.message}` })
          })
          // Close stdin immediately — we don't send input
          proc.stdin.end()
        })
      }
      case 'bash_batch': {
        if (!Array.isArray(args.commands) || args.commands.length === 0) {
          return { error: 'commands must be a non-empty array of shell command strings' }
        }
        // Cap at 20 commands per call to prevent abuse
        const commands = args.commands.slice(0, 20)
        const abortOnError = args.abort_on_error === true
        const results = []
        let successCount = 0
        let errorCount = 0

        for (let i = 0; i < commands.length; i++) {
          const cmd = commands[i]
          if (typeof cmd !== 'string' || !cmd.trim()) {
            results.push(`[${i + 1}] ❌ (empty command)`)
            errorCount++
            if (abortOnError) break
            continue
          }
          // Execute each command via the existing bash handler
          const cmdResult = await executeTool('bash', { command: cmd }, cwd, browserInstance, lspManager, inputRequester, notify)
          if (cmdResult.error) {
            results.push(`── [${i + 1}] ${cmd} ──\n❌ ${cmdResult.error}`)
            errorCount++
            if (abortOnError) {
              results.push(`\n(aborted — ${commands.length - i - 1} remaining commands skipped)`)
              break
            }
          } else {
            results.push(`── [${i + 1}] ${cmd} ──\n${cmdResult.result}`)
            successCount++
          }
        }

        if (args.commands.length > 20) {
          results.push(`\n[Note: only first 20 of ${args.commands.length} commands were executed]`)
        }
        const summary = `${successCount} succeeded, ${errorCount} failed`
        return { result: `${summary}:\n\n${results.join('\n\n')}` }
      }
      case 'update_todos': {
        // update_todos is handled by the renderer via the tool-use/tool-result event flow.
        // We just validate and return success here — the renderer picks up the input from the tool-use event.
        let todos = args.todos

        // ── Auto-repair: model often passes todos in wrong format ──────────
        if (!Array.isArray(todos)) {
          // Fix 1: todos is a JSON string — parse it
          if (typeof todos === 'string') {
            try { todos = JSON.parse(todos) } catch { /* not valid JSON */ }
          }
          // Fix 2: model passed items at top level (no todos wrapper)
          // e.g. args = [{id:1, content:"...", status:"pending"}, ...]
          if (!Array.isArray(todos) && Array.isArray(args)) {
            todos = args
          }
          // Fix 3: model nested it as args.todos.todos or args.items
          if (!Array.isArray(todos) && todos && typeof todos === 'object') {
            if (Array.isArray(todos.todos)) todos = todos.todos
            else if (Array.isArray(todos.items)) todos = todos.items
            else if (Array.isArray(todos.list)) todos = todos.list
          }
          // Fix 4: model passed a single todo object — wrap in array
          if (!Array.isArray(todos) && todos && typeof todos === 'object' && todos.content) {
            todos = [todos]
          }
          // Fix 5: scan all args keys for any array that looks like todos
          if (!Array.isArray(todos)) {
            for (const key of Object.keys(args)) {
              if (Array.isArray(args[key]) && args[key].length > 0 && args[key][0].content) {
                todos = args[key]
                break
              }
            }
          }
          // Update args.todos so the renderer event gets the fixed value
          if (Array.isArray(todos)) args.todos = todos
        }

        if (!Array.isArray(todos)) return { error: 'todos must be an array. Pass: update_todos({"todos": [{"id": 1, "content": "task", "status": "pending"}]})' }
        // Normalize: ensure each item has required fields
        todos = todos.map((t, i) => ({
          id: t.id ?? (i + 1),
          content: t.content || t.text || t.label || t.title || t.description || `Task ${i + 1}`,
          status: t.status || 'pending',
        }))
        args.todos = todos
        const done = todos.filter(t => t.status === 'done' || t.status === 'completed').length
        return { result: `Updated todo list: ${done}/${todos.length} complete` }
      }
      case 'edit_todos': {
        // edit_todos is also handled by the renderer — we validate and return a summary.
        // The renderer picks up the operation from the tool-use event and applies it to currentTodos.
        const { append = [], update = [], remove = [] } = args
        const parts = []
        if (append.length) parts.push(`+${append.length} added`)
        if (update.length) parts.push(`${update.length} updated`)
        if (remove.length) parts.push(`${remove.length} removed`)
        return { result: `Todo list edited: ${parts.join(', ') || 'no changes'}` }
      }
      case 'agent_notes': {
        // agent_notes is handled by the agent loop (_agentNotes variable).
        // executeTool just validates and echoes back — the loop captures the value.
        const notes = args.notes
        if (typeof notes !== 'string' || !notes.trim()) return { error: 'notes must be a non-empty string' }
        return { result: `Notes saved (${notes.length} chars). They will be re-injected after any context compaction.` }
      }
      case 'task_complete': {
        // Signal that the agent has finished. Return a special marker that
        // the agent loop checks to end the session gracefully.
        return { result: '__TASK_COMPLETE__', summary: args.summary || '' }
      }
      case 'search_files': {
        // Resolve patterns — support single pattern or batch array
        let patterns = []
        if (args.patterns && Array.isArray(args.patterns) && args.patterns.length > 0) {
          patterns = args.patterns.filter(p => typeof p === 'string' && p.trim())
        } else if (typeof args.patterns === 'string') {
          // Model may have passed patterns as a string instead of array — try to parse
          try {
            const parsed = JSON.parse(args.patterns)
            if (Array.isArray(parsed)) patterns = parsed.filter(p => typeof p === 'string' && p.trim())
          } catch {
            // Treat as a single pattern
            if (args.patterns.trim()) patterns = [args.patterns.trim()]
          }
        }
        if (patterns.length === 0 && typeof args.pattern === 'string' && args.pattern.trim()) {
          patterns = [args.pattern]
        }
        if (patterns.length === 0) return { error: 'pattern or patterns must be provided. Usage: search_files({"pattern": "term"}) or search_files({"patterns": ["term1", "term2"]})' }

        // ── Pipe-guess interceptor ────────────────────────────────────────
        // When the agent uses pipe-separated guesses (e.g. "hit|damage|kill|enemy.*death")
        // and a code map exists, intercept the search and return the relevant
        // symbols from the code map instead. This stops the "No matches found"
        // loop that wastes turns guessing at names.
        const _hasPipeGuess = patterns.some(p => p.includes('|') && p.split('|').length >= 2)
        if (_hasPipeGuess) {
          try {
            const _mapPath = require('path').join(cwd, '.maccoder', 'steering', 'code-map.md')
            if (fs.existsSync(_mapPath)) {
              const _mapContent = fs.readFileSync(_mapPath, 'utf-8')
              // Extract the search terms from the pipe pattern
              const _searchTerms = patterns.flatMap(p => p.split('|')).map(t => t.replace(/[.*+?^${}()[\]\\]/g, '').trim().toLowerCase()).filter(t => t.length > 2)
              // Find matching symbols in the code map
              const _mapLines = _mapContent.split('\n')
              const _matches = []
              for (const line of _mapLines) {
                const lower = line.toLowerCase()
                if (_searchTerms.some(t => lower.includes(t)) && (line.includes('`') || line.includes('line '))) {
                  _matches.push(line.trim())
                }
              }
              if (_matches.length > 0) {
                const hint = `⚠️ PIPE-GUESS DETECTED — you searched with "${patterns[0].slice(0, 60)}" which is a guess.\n\n` +
                  `The Code Map has these ACTUAL symbols matching your intent:\n` +
                  _matches.slice(0, 15).join('\n') + '\n\n' +
                  `USE THESE EXACT NAMES for your next search_files call, or better: read_file at the listed line number directly.\n` +
                  `Do NOT search with pipe-separated guesses again.`
                return { result: hint }
              }
            }
          } catch { /* code map not available — fall through to normal search */ }
        }

        const searchV = validatePath(args.path || '.')
        if (searchV.error) return searchV
        const searchPath = searchV.resolved
        const includeFlag = args.include ? ` --include="${args.include}"` : ''

        // Execute all patterns in parallel
        const results = await Promise.all(patterns.map(pat => {
          const cmd = `grep -rn "${pat.replace(/"/g, '\\"')}" "${searchPath}"${includeFlag} 2>/dev/null | head -50`
          return new Promise((resolve) => {
            let output = ''
            const proc = spawn('bash', ['-c', cmd], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
            const timer = setTimeout(() => { proc.kill('SIGKILL') }, 10000)
            proc.stdout.on('data', (chunk) => { output += chunk.toString() })
            proc.on('close', () => { clearTimeout(timer); resolve({ pattern: pat, output: output || 'No matches found.' }) })
            proc.on('error', () => { clearTimeout(timer); resolve({ pattern: pat, output: 'No matches found.' }) })
            proc.stdin.end()
          })
        }))

        // Format output — single pattern returns flat result, batch returns grouped
        if (results.length === 1) {
          return { result: results[0].output }
        }
        const grouped = results.map(r => `── ${r.pattern} ──\n${r.output}`).join('\n\n')
        return { result: grouped }
      }
      case 'rewind_context': {
        if (!args.key) return { error: 'key parameter is required' }
        const rewindResult = await compactor.rewind(pythonPath, args.key)
        if (rewindResult.found) {
          return { result: rewindResult.content }
        }
        // Key not found — likely because the session was interrupted and restarted,
        // or the model hallucinated a key. Guide the agent to re-read the file.
        return { error: `Rewind key "${args.key}" not found — the previous session context was lost when you were interrupted. ` +
          `Use read_file to re-read any files you need, or use search_files to find specific code. ` +
          `Do NOT retry rewind_context — the keys from the previous session are gone.` }
      }
      case 'ask_user': {
        if (!inputRequester) return { result: '(No input channel available — proceeding without user input)' }
        try {
          // Normalise options — model may send as array or JSON string
          let opts = args.options || []
          if (typeof opts === 'string') {
            try { opts = JSON.parse(opts) } catch { opts = [] }
          }
          if (!Array.isArray(opts)) opts = []
          const reply = await inputRequester.ask(args.question, opts)
          return { result: reply }
        } catch (err) {
          return { result: `(User input timed out: ${err.message})` }
        }
      }
      case 'undo_list': {
        const sessionId = notify._sessionId || ''
        const entries = undoList(sessionId)
        if (entries.length === 0) {
          return { result: 'No edits to undo in this session.' }
        }
        const lines = entries.map((e, i) => {
          const ago = Math.round((Date.now() - e.ts) / 1000)
          const agoStr = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`
          const action = e.isNew ? 'created' : 'edited'
          return `${i}. ${e.filePath} — ${action} via ${e.tool} (${agoStr})`
        })
        return { result: `${entries.length} undoable edits (most recent first):\n${lines.join('\n')}\n\nUse undo_edit({"index": 0}) to undo the most recent.` }
      }
      case 'undo_edit': {
        const sessionId = notify._sessionId || ''
        const index = args.index != null ? args.index : 0
        const result = undoApply(sessionId, index)
        if (result.error) return { error: result.error }
        _scheduleAutoCommit(cwd)
        return { result: `✓ Undone: ${result.filePath} — restored (${result.restored})` }
      }
      case 'vision_review': {
        if (!args.target || typeof args.target !== 'string') {
          return { error: 'target is required (URL or file path to screenshot)' }
        }
        let reviewUrl = args.target.trim()
        // Resolve local files to file:// URLs
        if (!reviewUrl.startsWith('http://') && !reviewUrl.startsWith('https://') && !reviewUrl.startsWith('file://')) {
          const v = validatePath(reviewUrl)
          if (v.error) return v
          if (!fs.existsSync(v.resolved)) return { error: `File not found: ${reviewUrl}` }
          reviewUrl = `file://${v.resolved}`
        }
        // Use Playwright to take a screenshot
        const _pw = require('playwright')
        let _reviewBrowser = null
        try {
          const vpWidth = parseInt(args.width, 10) || 1280
          const vpHeight = parseInt(args.height, 10) || 900
          _reviewBrowser = await _pw.chromium.launch({ headless: true })
          const _reviewPage = await _reviewBrowser.newPage({ viewport: { width: vpWidth, height: vpHeight } })
          await _reviewPage.goto(reviewUrl, { waitUntil: 'networkidle', timeout: 30000 })
          // Small delay for any animations/transitions to settle
          await new Promise(r => setTimeout(r, 500))
          const screenshotBuf = await _reviewPage.screenshot({
            fullPage: args.full_page === true || args.full_page === 'true',
            type: 'jpeg',
            quality: 80,
          })
          await _reviewBrowser.close()
          _reviewBrowser = null

          // ── Vision routing: fast model first, hot-swap fallback ──────────
          // If the fast model (0.8B) is loaded with vision, use it directly —
          // no model swap needed, ~2s response. If unavailable, fall back to
          // hot-swapping the 35B into vision mode (~10-15s but full intelligence).
          const imgB64 = `data:image/jpeg;base64,${screenshotBuf.toString('base64')}`
          const reviewPrompt = args.prompt ||
            'Review this webpage screenshot for visual quality. Focus on:\n' +
            '- Image quality: Are stock images relevant, high-quality, and professional? Or are they generic/ugly/broken?\n' +
            '- Layout: Is spacing consistent? Are elements aligned properly?\n' +
            '- Typography: Is text readable? Are font sizes appropriate?\n' +
            '- Colors: Is the color scheme cohesive and professional?\n' +
            '- Overall impression: Does this look polished or amateurish?\n' +
            'Be specific about what needs fixing and where on the page.'

          let reviewText = null
          let visionSource = 'unknown'

          // Try fast model first (if loaded)
          if (assistClient) {
            const rawB64 = screenshotBuf.toString('base64')
            const fastResult = await assistClient.assistVision(rawB64, 'image/jpeg', reviewPrompt)
            if (fastResult) {
              reviewText = fastResult
              visionSource = 'fast-model (0.8B)'
              if (notify && notify.send) {
                notify.send('qwen-event', { type: 'system', subtype: 'debug', data: '⚡ Vision review via fast model (no swap needed)' })
              }
            }
          }

          // Fast model unavailable or returned nothing — hot-swap the 35B
          if (!reviewText) {
            if (notify && notify.send) {
              notify.send('qwen-event', { type: 'system', subtype: 'debug', data: '🔄 Vision swap: loading 35B in vision mode for review...' })
            }
            const visionContent = [
              { type: 'text', text: reviewPrompt },
              { type: 'image_url', image_url: { url: imgB64 } },
            ]
            const visionBody = JSON.stringify({
              messages: [{ role: 'user', content: visionContent }],
              max_tokens: 1024,
            })
            const visionResult = await new Promise((resolve, reject) => {
              const req = http.request({
                hostname: '127.0.0.1', port: SERVER_PORT,
                path: '/admin/vision-inference', method: 'POST',
                timeout: 180000, // 3 min — includes model swap time
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(visionBody) },
              }, (res) => {
                let data = ''
                res.on('data', chunk => data += chunk)
                res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(new Error(data || 'Empty response')) } })
              })
              req.on('timeout', () => { req.destroy(); reject(new Error('Vision review timed out (180s) — model swap may have failed')) })
              req.on('error', reject)
              req.write(visionBody)
              req.end()
            })
            reviewText = visionResult.choices?.[0]?.message?.content || 'Vision model returned no analysis.'
            const swapTime = visionResult.vision_swap_time_s || '?'
            visionSource = `35B vision model, ${swapTime}s swap`
            if (notify && notify.send) {
              notify.send('qwen-event', { type: 'system', subtype: 'debug', data: `✅ Vision review complete (${swapTime}s swap cycle)` })
            }
          }

          if (notify && notify.send) {
            notify.send('qwen-event', { type: 'vision-analysis', text: `[Vision Review: ${args.target}]\n${reviewText}` })
          }
          return { result: `[Vision Review of ${args.target} — ${visionSource}]\n\n${reviewText}` }
        } catch (err) {
          if (_reviewBrowser) { try { await _reviewBrowser.close() } catch {} }
          return { error: `vision_review failed: ${err.message}` }
        }
      }
      case 'open_browser': {
        if (!args.target || typeof args.target !== 'string') {
          return { error: 'target is required (URL or file path)' }
        }
        let url = args.target.trim()
        // If it's a relative path (not a URL), resolve to absolute file:// URL
        if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
          const v = validatePath(url)
          if (v.error) return v
          if (!fs.existsSync(v.resolved)) return { error: `File not found: ${url}` }
          url = `file://${v.resolved}`
        }
        try {
          // macOS: use 'open' command to launch default browser
          const { execSync: _execSync } = require('child_process')
          _execSync(`open "${url.replace(/"/g, '\\"')}"`, { timeout: 5000 })
          return { result: `Opened ${url} in default browser` }
        } catch (err) {
          return { error: `Failed to open browser: ${err.message}` }
        }
      }
      default: {
        // Generate Xcode project — programmatic, no LLM needed
        if (name === 'generate_xcode_project') {
          try {
            const { generateXcodeProject } = require('./xcode-project-gen')
            // Resolve project_dir: accept absolute or cwd-relative paths,
            // and reject anything that escapes the session cwd.
            let resolvedProjectDir = cwd
            if (typeof args.project_dir === 'string' && args.project_dir.trim()) {
              // Strip surrounding quotes the model sometimes includes.
              const rawDir = args.project_dir.trim().replace(/^['"]|['"]$/g, '').trim()
              const candidate = path.isAbsolute(rawDir)
                ? path.normalize(rawDir)
                : path.resolve(cwd, rawDir)
              const normalizedCwd = path.normalize(cwd)
              if (candidate !== normalizedCwd && !candidate.startsWith(normalizedCwd + path.sep)) {
                return { error: `project_dir "${args.project_dir}" resolves outside the working directory (${cwd}). Use a path inside the project root.` }
              }
              resolvedProjectDir = candidate
            }
            const result = generateXcodeProject({
              projectDir: resolvedProjectDir,
              productName: args.product_name || path.basename(resolvedProjectDir),
              orgIdentifier: args.org_identifier || 'com.developer',
              platform: args.platform || 'macos',
              deploymentTarget: args.deployment_target || '14.0',
              sourceDir: args.source_dir || null,
              teamId: args.team_id || '',
            })
            if (result.error) return { error: result.error }
            return { result: `Generated ${result.path}\n${result.stats.swiftFiles} Swift files, ${result.stats.assetCatalogs} asset catalogs, ${result.stats.groups} groups, ${result.stats.totalFileRefs} file references.` }
          } catch (err) {
            return { error: `generate_xcode_project failed: ${err.message}` }
          }
        }
        // Route xcode_* tools to XcodeBuildMCP
        if (name.startsWith('xcode_') && xcodeTool) {
          return xcodeTool.executeXcodeTool(name, args, cwd)
        }
        return { error: `Unknown tool: ${name}` }
      }
    }
  } catch (err) {
    return { error: err.message || String(err) }
  }
}

// ── SSE stream parser ─────────────────────────────────────────────────────────

function streamSSE(url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body)
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      ...extraHeaders,
    }
    // Use https for external URLs (e.g. OpenRouter), http for local server
    const isHttps = url.startsWith('https://')
    const transport = isHttps ? require('https') : http
    const req = transport.request(url, {
      method: 'POST',
      headers,
    }, (res) => {
      resolve({ res, req })
    })
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

/**
 * Detect recall phrases in a user message that indicate the user wants
 * to retrieve past context. Returns 'thorough' if recall phrases found,
 * 'fast' otherwise.
 * @param {string} message
 * @returns {'fast'|'thorough'}
 */
function detectRecallMode(message) {
  if (!message || typeof message !== 'string') return 'fast'
  const recallPhrases = [
    'remember when',
    'what did i say about',
    'last time',
    'previously',
  ]
  const lower = message.toLowerCase()
  for (const phrase of recallPhrases) {
    if (lower.includes(phrase)) return 'thorough'
  }
  return 'fast'
}

// ── Xcode platform detection for turn-0 hint injection ───────────────────────
/**
 * Scan `cwd` (and one level of subdirectories) for an Xcode project, detect
 * whether it targets macOS or iOS, and return a tailored system-prompt hint.
 *
 * Detection strategy (fast, no subprocess):
 *   1. Find the first .xcodeproj in cwd or immediate subdirs.
 *   2. Read project.pbxproj and look for SDKROOT / SUPPORTED_PLATFORMS.
 *   3. Fall back to checking for macOS-only SwiftUI lifecycle markers in Swift files.
 *
 * Returns a hint string, or null if no Xcode project is found.
 */
function _detectXcodePlatformHint(cwd) {
  if (!cwd) return null
  try {
    const fsSync = require('fs')
    const pathMod = require('path')

    // ── 1. Find .xcodeproj ──────────────────────────────────────────────
    function findXcodeproj(dir, depth) {
      if (depth > 2) return null
      let entries
      try { entries = fsSync.readdirSync(dir) } catch { return null }
      const proj = entries.find(e => e.endsWith('.xcodeproj'))
      if (proj) return pathMod.join(dir, proj)
      const SKIP = new Set(['.git', 'node_modules', 'build', 'DerivedData', '.build', 'Pods', '__pycache__'])
      for (const e of entries) {
        if (SKIP.has(e) || e.startsWith('.')) continue
        try {
          const sub = pathMod.join(dir, e)
          if (fsSync.statSync(sub).isDirectory()) {
            const found = findXcodeproj(sub, depth + 1)
            if (found) return found
          }
        } catch { /* skip */ }
      }
      return null
    }

    const xcodeproj = findXcodeproj(cwd, 0)
    if (!xcodeproj) return null  // no Xcode project — no hint needed

    const projDir = pathMod.dirname(xcodeproj)
    const schemeName = pathMod.basename(xcodeproj, '.xcodeproj')
    const projectArg = `-project "${xcodeproj}"`

    // ── 2. Detect platform from pbxproj ────────────────────────────────
    let platform = null  // 'macOS' | 'iOS' | null
    try {
      const pbxprojPath = pathMod.join(xcodeproj, 'project.pbxproj')
      const pbx = fsSync.readFileSync(pbxprojPath, 'utf-8')
      // SDKROOT = macosx  →  macOS
      // SDKROOT = iphoneos / iphonesimulator  →  iOS
      // SUPPORTED_PLATFORMS = macosx  →  macOS
      if (/SDKROOT\s*=\s*macosx\b/i.test(pbx) || /SUPPORTED_PLATFORMS\s*=\s*macosx\b/i.test(pbx)) {
        platform = 'macOS'
      } else if (/SDKROOT\s*=\s*(iphoneos|iphonesimulator)\b/i.test(pbx) ||
                 /SUPPORTED_PLATFORMS\s*=\s*(iphoneos|iphonesimulator)\b/i.test(pbx)) {
        platform = 'iOS'
      }
      // IPHONEOS_DEPLOYMENT_TARGET present but no MACOSX_DEPLOYMENT_TARGET → iOS
      if (!platform) {
        const hasIOS = /IPHONEOS_DEPLOYMENT_TARGET/.test(pbx)
        const hasMac = /MACOSX_DEPLOYMENT_TARGET/.test(pbx)
        if (hasIOS && !hasMac) platform = 'iOS'
        else if (hasMac && !hasIOS) platform = 'macOS'
      }
    } catch { /* pbxproj unreadable — fall through */ }

    // ── 3. Fallback: scan Swift files for lifecycle markers ─────────────
    if (!platform) {
      try {
        const { execSync } = require('child_process')
        // macOS-only SwiftUI/AppKit APIs
        const macGrep = execSync(
          `grep -rl "NSApplicationDelegateAdaptor\\|import AppKit\\|\\.windowStyle\\|\\.windowToolbarStyle\\|NSApp\\b" "${projDir}" --include="*.swift" 2>/dev/null | head -1`,
          { timeout: 5000, encoding: 'utf-8' }
        ).trim()
        if (macGrep) {
          platform = 'macOS'
        } else {
          // iOS-only UIKit APIs
          const iosGrep = execSync(
            `grep -rl "UIApplicationDelegateAdaptor\\|import UIKit\\|UIViewController\\|UINavigationController" "${projDir}" --include="*.swift" 2>/dev/null | head -1`,
            { timeout: 5000, encoding: 'utf-8' }
          ).trim()
          if (iosGrep) platform = 'iOS'
        }
      } catch { /* grep failed — leave platform null */ }
    }

    // ── 3b. Deployment target fallback (no SDKROOT/SUPPORTED_PLATFORMS set) ─
    // iOS projects almost always have IPHONEOS_DEPLOYMENT_TARGET explicitly.
    // macOS projects often only have MACOSX_DEPLOYMENT_TARGET.
    if (!platform) {
      try {
        const pbxprojPath = pathMod.join(xcodeproj, 'project.pbxproj')
        const pbx = fsSync.readFileSync(pbxprojPath, 'utf-8')
        const hasMac = /MACOSX_DEPLOYMENT_TARGET/.test(pbx)
        const hasIOS = /IPHONEOS_DEPLOYMENT_TARGET/.test(pbx)
        if (hasMac && !hasIOS) platform = 'macOS'
        else if (hasIOS && !hasMac) platform = 'iOS'
        // both present → Catalyst → leave null → "unknown" hint
      } catch { /* non-fatal */ }
    }

    // ── 4. Check for saved macOS config (xcode_setup_project already ran) ─
    let savedConfig = null
    try {
      const configPath = pathMod.join(projDir, '.xcodebuildmcp', 'macos-config.json')
      if (fsSync.existsSync(configPath)) {
        savedConfig = JSON.parse(fsSync.readFileSync(configPath, 'utf-8'))
        if (savedConfig.platform) platform = savedConfig.platform
      }
    } catch { /* non-fatal */ }

    // ── 5. Build the hint ───────────────────────────────────────────────
    if (platform === 'macOS') {
      const scheme = savedConfig?.scheme || schemeName
      const buildCmd = savedConfig?.projectArg
        ? `xcodebuild ${savedConfig.projectArg} -scheme "${scheme}" -configuration Debug build 2>&1 | tail -30`
        : `xcodebuild ${projectArg} -scheme "${scheme}" -configuration Debug build 2>&1 | tail -30`
      return (
        `XCODE PROJECT DETECTED: macOS app — "${schemeName}" at ${xcodeproj}\n` +
        `Platform: macOS (native app — NO simulator)\n\n` +
        `Correct workflow:\n` +
        `  1. Call xcode_setup_project() to configure the session and get exact build commands.\n` +
        `  2. Build with bash: ${buildCmd}\n` +
        `  3. Find the .app: bash({command: "xcodebuild ${projectArg} -scheme \\"${scheme}\\" -showBuildSettings 2>/dev/null | grep ' BUILT_PRODUCTS_DIR' | head -1 | awk '{print $3}'"})\n` +
        `  4. Launch: bash({command: "open /path/to/${scheme}.app"})\n` +
        `  5. Screenshot: use desktop_screenshot() to capture the running app — it captures the full screen.\n\n` +
        `⚠️  Do NOT call xcode_build_run_simulator() — that is iOS only and will fail for macOS targets.`
      )
    }

    if (platform === 'iOS') {
      return (
        `XCODE PROJECT DETECTED: iOS app — "${schemeName}" at ${xcodeproj}\n` +
        `Platform: iOS (runs on simulator)\n\n` +
        `Correct workflow:\n` +
        `  1. Call xcode_setup_project() — it picks the best available simulator and configures the session.\n` +
        `  2. Call xcode_build_run_simulator() — builds, installs, and launches on the simulator in one step.\n` +
        `  3. Call xcode_snapshot_ui() to inspect the running UI.\n` +
        `  4. Call xcode_screenshot_simulator() to capture a screenshot.\n\n` +
        `⚠️  Do NOT use bash xcodebuild with platform=macOS for an iOS project.`
      )
    }

    // Platform unknown — give a generic "call setup first" hint
    return (
      `XCODE PROJECT DETECTED: "${schemeName}" at ${xcodeproj}\n` +
      `Platform: unknown — call xcode_setup_project() FIRST.\n` +
      `It will detect whether this is a macOS or iOS project and return the exact build commands to use.\n` +
      `⚠️  Do NOT assume iOS simulator — the project may target macOS.`
    )
  } catch { return null }
}

// ── DirectBridge ──────────────────────────────────────────────────────────────

class DirectBridge {
  constructor(sink, opts = {}) {
    this.sink = sink
    this._aborted = false
    this._running = false   // guard against concurrent run() calls
    this._activeReq = null
    this._browserInstance = null
    this._lspManager = opts.lspManager || null
    this._agentRole = opts.agentRole || 'general'
    this._allowedTools = opts.allowedTools || null
    this._telegramForwarder = opts.telegramForwarder || null
    this._getCalibrationProfile = opts.getCalibrationProfile || null
    // Optional: function(title) → role string | null — used for todo-driven re-routing
    this._routeTask = opts.routeTask || null
    // Queue of user messages to inject at the next turn boundary
    this._pendingInjections = []
    // Flag: true when inject() destroyed the active request — skip retry backoff
    this._injectionInterrupt = false
    // WindowInputRequester for desktop ask_user — set via setInputRequester()
    this._inputRequester = opts.inputRequester || null

    // ── Performance: tool defs cache ──────────────────────────────────────
    // Avoids rebuilding tool definitions every turn. Invalidated when agent
    // role or LSP status changes.
    this._cachedToolDefs = null
    this._cachedToolDefsKey = null

    // ── Adaptive max_tokens ───────────────────────────────────────────────
    // Starts at the configured baseline. Steps up on truncation (finish_reason
    // 'length'), decays back toward baseline on clean stops so we don't
    // permanently inflate KV cache allocation after a one-off large response.
    // When opts.maxTokensFloor is provided (e.g. for cascade-eligible roles
    // like code-search/context-gather that rarely need long responses), the
    // floor is lowered so per-turn generation is shorter and finishes faster.
    const _ceil = opts.maxTokensCeil ?? 32768
    const _floor = Math.min(opts.maxTokensFloor ?? config.MAX_OUTPUT_TOKENS, _ceil)
    this._adaptiveMaxTokens = _floor
    this._adaptiveMaxTokensFloor = _floor   // baseline / floor
    this._adaptiveMaxTokensCeil = _ceil     // hard ceiling
    this._adaptiveCleanTurns = 0  // consecutive clean-stop turns since last bump

    // ── Performance: deferred LSP diagnostics ─────────────────────────────
    // After write_file/edit_file, diagnostics are fetched asynchronously and
    // injected as a system message on the next turn instead of blocking.
    this._pendingDiagnostics = null  // Promise<{path, diagnostics}> | null
    this._coalescedToolCallIds = new Set()  // Track auto-coalesced read_file IDs

    // ── Speculative tool execution ────────────────────────────────────────
    // When the model streams a safe tool_call (read_file, search_files, etc.),
    // we can parse partial args and start executing the tool in the background.
    // By the time the full tool_call arrives, the result is often ready.
    // Safe default: enable if module is available, disable via opts.speculateTools = false
    this._toolSpeculator = null
    this._speculateEnabled = opts.speculateTools !== false && !!ToolSpeculator
    // Lazily created when we have a cwd (per-run). See _agentLoop and _streamCompletion.
    this._currentCwd = null
    this._specStreamArgs = new Map()  // Map<idx, lastSpeculatedArgs>

    // ── Post-write read cache ─────────────────────────────────────────────
    // Cache the content of files we just wrote. If the agent reads them back
    // within N turns and the file hasn't been modified externally, return
    // the cache directly instead of re-prefilling the model.
    // Disable via opts.postWriteCache = false.
    this._postWriteCache = (opts.postWriteCache !== false && PostWriteCache)
      ? new PostWriteCache({ maxEntries: 50, ttlTurns: 10 })
      : null
  }

  setLspManager(lspManager) {
    this._lspManager = lspManager
  }

  /** Attach a WindowInputRequester so ask_user works in the desktop app. */
  setInputRequester(requester) {
    this._inputRequester = requester
  }

  /**
   * Inject a user message into the running agent. Aborts the current inference
   * so the message is processed immediately instead of waiting for the turn to
   * finish. The fast model generates an instant acknowledgement while the main
   * model restarts with the injection in context.
   */
  inject(message) {
    if (!message || typeof message !== 'string' || !message.trim()) return
    const trimmed = message.trim()
    this._pendingInjections.push(trimmed)

    // Abort the current SSE stream so the agent loop picks up the injection
    // on the next iteration instead of waiting for inference to finish.
    // This makes injections feel immediate — the model restarts its turn
    // with the user's message already in context.
    if (this._activeReq) {
      this._injectionInterrupt = true  // flag so retry loop skips backoff
      try { this._activeReq.destroy() } catch {}
      this._activeReq = null
    }
  }

  send(channel, data) {
    this.sink.send(channel, data)
  }

  async run({ prompt, cwd, permissionMode, model, images, conversationHistory, systemPromptOverride, samplingParams, taskGraphPath }) {
    const _runT0 = Date.now();
    console.log('[direct-bridge] run() called, role:', this._agentRole, 'hasSystemOverride:', !!systemPromptOverride);
    this.send('qwen-event', { type: 'system', subtype: 'debug', data: `[bridge] run() called — role: ${this._agentRole}` })
    // Prevent concurrent runs — if a previous run is still winding down after
    // interrupt(), wait up to 3s for it to finish before starting the new one.
    // Also resolve any pending ask_user request so the old run can unblock.
    if (this._running) {
      if (this._inputRequester && this._inputRequester.hasPendingRequest()) {
        console.log('[direct-bridge] resolving stale ask_user request (user sent new prompt)')
        this._inputRequester.resolveReply('(User sent a new message — ask_user cancelled)')
      }
      const deadline = Date.now() + 3000
      while (this._running && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100))
      }
    }
    this._running = true
    this._aborted = false
    this._samplingParams = samplingParams || {}
    // Apply role-specific sampling defaults if not explicitly set
    // Implementation role: lower temperature for more deterministic tool selection
    // The model at temp 0.6 tends to "explore" (read more files) instead of committing to write
    if (!this._samplingParams.temperature) {
      const role = this._agentRole || 'general'
      if (role === 'implementation' || role === 'general') {
        this._samplingParams.temperature = 0.3
      }
    }

    // Set up browser instance with video recording enabled
    const recordingDir = path.join(os.tmpdir(), 'qwencoder-recordings')
    this._browserInstance = createPlaywrightInstance({
      recordingOptions: { dir: recordingDir, size: { width: 1280, height: 720 } },
    })

    // ── Intent detection: conversational vs task ──────────────────────────────
    // Use the fast model to classify whether the user wants to chat/discuss or
    // wants the agent to take action (write code, fix bugs, etc.).
    // Conversational prompts get a direct streaming response — no tools, no
    // file tree, no project context. Much faster and more natural for discussion.
    // Only applies to vibe mode (no systemPromptOverride) to avoid interfering
    // with spec-driven flows.
    if (!systemPromptOverride && !taskGraphPath) {
      let isChat = false
      const hasImages = images && images.length > 0

      if (hasImages) {
        // Images attached — default to chat mode (describe the image) UNLESS
        // the prompt text clearly indicates a task (fix, broken, look at, etc.).
        // The agent loop already handles images by describing them via the vision
        // model and injecting the description as context for tool use.
        const lower = (prompt || '').toLowerCase()
        const taskSignals = [
          'fix', 'broken', 'bug', 'error', 'wrong', 'issue', 'not working',
          'look at', 'update', 'change', 'modify', 'add', 'remove', 'delete',
          'implement', 'create', 'build', 'refactor', 'move', 'rename',
          'its broken', "it's broken", 'the path', 'debug', 'solve', 'repair',
        ]
        const hasTaskIntent = taskSignals.some(s => lower.includes(s))
        if (!hasTaskIntent) {
          isChat = true
        }
        // If task intent detected with images, fall through to agent loop which
        // will describe the image via vision model and use it as context for tools.
      } else if (assistClient) {
        // Text-only: use fast model to classify intent (~200ms)
        try {
          const classifyResult = await assistClient._assistRequest('route_task', {
            task: `Classify this user message as either "chat" or "task". Reply with ONLY the word "chat" or "task".\n- "chat" = the user wants to discuss, ask questions, brainstorm ideas, plan, get explanations, or have a conversation\n- "task" = the user wants you to write code, fix bugs, create files, run commands, build something, or make concrete changes to files\n\nUser message: "${prompt.slice(0, 300)}"`
          }, 5000)
          const routeResult = classifyResult?.result_data?.agent_type || classifyResult?.result || ''
          isChat = routeResult.toLowerCase().trim() === 'chat'
        } catch { /* classification failed — default to task */ }
      }

      // Keyword fallback: catch obvious conversational signals the small model might miss
      if (!isChat) {
        const lower = prompt.toLowerCase()
        const chatSignals = ['let\'s discuss', 'let\'s brainstorm', 'let\'s think', 'what do you think',
          'ideas for', 'thoughts on', 'help me decide', 'pros and cons', 'should i',
          'what would you', 'can you explain', 'tell me about', 'how does',
          'what is the difference', 'let\'s plan', 'let\'s talk', 'opinion on']
        if (chatSignals.some(s => lower.includes(s))) isChat = true
      }

      if (isChat) {
        this.send('qwen-event', { type: 'session-start', cwd: cwd || process.cwd() })
        this.send('qwen-event', { type: 'system', subtype: 'debug', data: '💬 Chat mode — direct response (intent classified as chat, not task)' })
        this.send('qwen-event', { type: 'agent-type', agentType: 'chat' })

        try {
          if (hasImages) {
            // Image chat: fast model describes the image via /v1/chat/completions
            const userContent = [{ type: 'text', text: prompt || 'Describe what you see in this image in detail.' }]
            for (const img of images) {
              userContent.push({ type: 'image_url', image_url: { url: img.b64 } })
            }
            const body = JSON.stringify({ messages: [{ role: 'user', content: userContent }], max_tokens: 512 })
            const result = await new Promise((resolve, reject) => {
              const r = http.request({
                hostname: '127.0.0.1', port: SERVER_PORT,
                path: '/v1/chat/completions', method: 'POST',
                timeout: 120000,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
              }, (res) => {
                let data = ''
                res.on('data', chunk => data += chunk)
                res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(new Error(data || 'Empty')) } })
              })
              r.on('error', reject)
              r.on('timeout', () => { r.destroy(); reject(new Error('Vision request timed out')) })
              r.write(body)
              r.end()
            })
            const text = result.choices?.[0]?.message?.content || 'Could not analyze the image.'
            // Send as text-delta events (accumulated text) — matches renderer's expected format
            let accumulated = ''
            for (const word of text.split(' ')) {
              accumulated += word + ' '
              this.send('qwen-event', { type: 'text-delta', text: accumulated })
            }
          } else {
            // Text chat: stream from main model with conversation history + project context
            const workDir = cwd || process.cwd()
            const chatSystemPrompt = `You are a helpful coding assistant working on a project at ${workDir}. You can discuss code, answer questions, brainstorm ideas, and explain concepts.

When brainstorming or presenting options, end your response with a clear numbered list of short choices (one line each, under 60 characters) so the user can easily pick one. Example:
Which direction interests you?
1. Option A
2. Option B
3. Option C

When the user wants you to take action (write code, fix bugs, etc.), tell them to phrase it as a task and you'll switch to agent mode.`
            const messages = [{ role: 'system', content: chatSystemPrompt }]
            if (conversationHistory && conversationHistory.length > 0) {
              for (const m of conversationHistory.slice(-20)) {
                messages.push({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 2000) : m.content })
              }
            }
            messages.push({ role: 'user', content: prompt })
            const body = JSON.stringify({ messages, max_tokens: 2048, stream: true })
            let _chatAccumulated = ''
            await new Promise((resolve, reject) => {
              // ── OpenRouter routing for chat mode ──────────────────────────
              // Try OpenRouter first; any failure falls through to local server.
              try {
                const { getAppSettings } = require('./projects')
                const appSettings = getAppSettings()
                if (appSettings.provider === 'openrouter' && appSettings.openrouterApiKey) {
                  const orBody = JSON.parse(body)
                  // Robin Auto: pick best free model
                  if (appSettings.robinAutoEnabled) {
                    try {
                      const { robinRouter } = require('./robin-router')
                      if (robinRouter.enabled) {
                        const selected = robinRouter.selectModel()
                        if (selected) orBody.model = selected
                      } else {
                        orBody.model = 'openrouter/auto'
                      }
                    } catch (_) { orBody.model = 'openrouter/auto' }
                  } else if (appSettings.openrouterModel) {
                    orBody.model = appSettings.openrouterModel
                  }
                  delete orBody.repetition_penalty
                  const orBodyStr = JSON.stringify(orBody)
                  // Build headers fresh — never share with the local fallback path
                  const orHeaders = {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(orBodyStr),
                    'Authorization': `Bearer ${appSettings.openrouterApiKey}`,
                    'HTTP-Referer': 'https://github.com/qwencoder-mac-studio',
                    'X-Title': 'QwenCoder Mac Studio',
                  }
                  const https = require('https')
                  const r = https.request(OPENROUTER_CHAT_URL, { method: 'POST', headers: orHeaders, timeout: 120000 }, (res) => {
                    if (res.statusCode && res.statusCode >= 400) {
                      let errBody = ''
                      res.on('data', c => { errBody += c })
                      res.on('end', () => {
                        let errMsg = `OpenRouter HTTP ${res.statusCode}`
                        try { const p = JSON.parse(errBody); errMsg = p.error?.message || p.detail || errMsg } catch {}
                        reject(new Error(errMsg))
                      })
                      return
                    }
                    let buf = ''
                    let _chatReasoning = ''
                    res.on('data', chunk => {
                      if (this._aborted) { r.destroy(); return }
                      buf += chunk.toString()
                      const lines = buf.split('\n')
                      buf = lines.pop()
                      for (const line of lines) {
                        if (line.startsWith('data: [DONE]')) continue
                        if (line.startsWith('data: ')) {
                          try {
                            const parsed = JSON.parse(line.slice(6))
                            const delta = parsed.choices?.[0]?.delta
                            if (delta?.reasoning_content) {
                              _chatReasoning += delta.reasoning_content
                              this.send('qwen-event', { type: 'thinking-delta', text: _chatReasoning })
                            }
                            if (delta?.content) {
                              _chatAccumulated = (_chatAccumulated || '') + delta.content
                              this.send('qwen-event', { type: 'text-delta', text: _chatAccumulated })
                            }
                          } catch { /* skip malformed SSE line */ }
                        }
                      }
                    })
                    res.on('end', resolve)
                    res.on('error', reject)
                  })
                  r.on('error', reject)
                  r.on('timeout', () => { r.destroy(); reject(new Error('OpenRouter request timed out')) })
                  r.write(orBodyStr)
                  r.end()
                  this._currentReq = r
                  return
                }
              } catch (_) { /* projects unavailable — fall through to local server */ }
              // ── Local MLX server ──────────────────────────────────────────
              const localHeaders = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              }
              const r = http.request({
                hostname: '127.0.0.1', port: SERVER_PORT,
                path: '/v1/chat/completions', method: 'POST',
                timeout: 120000,
                headers: localHeaders,
              }, (res) => {
                let buf = ''
                let _localReasoning = ''
                res.on('data', chunk => {
                  if (this._aborted) { r.destroy(); return }
                  buf += chunk.toString()
                  const lines = buf.split('\n')
                  buf = lines.pop()
                  for (const line of lines) {
                    if (line.startsWith('data: [DONE]')) continue
                    if (line.startsWith('data: ')) {
                      try {
                        const parsed = JSON.parse(line.slice(6))
                        const delta = parsed.choices?.[0]?.delta
                        if (delta?.reasoning_content) {
                          _localReasoning += delta.reasoning_content
                          this.send('qwen-event', { type: 'thinking-delta', text: _localReasoning })
                        }
                        if (delta?.content) {
                          _chatAccumulated = (_chatAccumulated || '') + delta.content
                          this.send('qwen-event', { type: 'text-delta', text: _chatAccumulated })
                        }
                      } catch { /* skip */ }
                    }
                  }
                })
                res.on('end', resolve)
                res.on('error', reject)
              })
              r.on('error', reject)
              r.on('timeout', () => { r.destroy(); reject(new Error('Request timed out')) })
              r.write(body)
              r.end()
              this._currentReq = r
            })
          }
        } catch (err) {
          if (!this._aborted) {
            this.send('qwen-event', { type: 'text-delta', text: `Error: ${err.message}` })
          }
        } finally {
          // Only send session-end here if not aborted — interrupt() already sent it
          if (!this._aborted) {
            this.send('qwen-event', { type: 'session-end' })
          }
          this._running = false
          this._currentReq = null
        }
        return
      }
    }

    // If images are attached, describe them via the vision endpoint first,
    // then inject the description as text context for the agent loop.
    // Images always go to /v1/chat/completions which the server routes to the
    // fast model via _route_vision_request (main model is text-only).
    let imageContext = ''
    if (images && images.length > 0) {
      this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Analyzing ${images.length} image(s)...` })
      try {
        const descriptions = []
        for (let i = 0; i < images.length; i++) {
          const img = images[i]
          // In task mode, guide the vision model to describe the technical issue
          // rather than giving generic advice. The description feeds into the agent
          // loop which will use tools to fix the problem.
          const visionPrompt = prompt
            ? `You are a code debugging assistant. The user says: "${prompt}"\n\nDescribe what you see in this screenshot that relates to the issue. Focus on:\n- What UI elements are visible and their state\n- What appears broken or incorrect\n- Any error messages, console output, or visual glitches\n- Specific coordinates, positions, or layout issues\nBe technical and precise. Do NOT give advice on how to fix it — just describe what you observe.`
            : 'Describe what you see in this image in detail. Focus on any visible errors, broken UI elements, or incorrect behavior.'
          const content = [
            { type: 'text', text: visionPrompt },
            { type: 'image_url', image_url: { url: img.b64 } },
          ]
          const body = JSON.stringify({ messages: [{ role: 'user', content }], max_tokens: 1024 })
          const result = await new Promise((resolve, reject) => {
            const req = http.request({
              hostname: '127.0.0.1', port: SERVER_PORT,
              path: '/v1/chat/completions', method: 'POST',
              timeout: 120000,
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, (res) => {
              let data = ''
              res.on('data', chunk => data += chunk)
              res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(new Error(data || 'Empty response')) } })
            })
            req.on('timeout', () => { req.destroy(); reject(new Error('Vision request timed out')) })
            req.on('error', reject)
            req.write(body)
            req.end()
          })
          const desc = result.choices?.[0]?.message?.content || 'Could not analyze image.'
          descriptions.push(`[Image ${i + 1}: ${img.name}]\n${desc}`)
        }
        imageContext = `\n\nThe user attached image(s). Here is what the vision model sees:\n\n${descriptions.join('\n\n')}`
        // Show the vision analysis inline in chat so the user sees what the model detected
        this.send('qwen-event', { type: 'vision-analysis', text: descriptions.join('\n\n') })
      } catch (err) {
        imageContext = `\n\n(The user attached images but vision analysis failed: ${err.message})`
      }
    }

    const workDir = cwd || process.cwd()
    // Use the cache when available — identical (role, cwd, permissionMode)
    // tuples produce byte-identical prompts so the server's prefix cache can hit.
    const systemPrompt = systemPromptOverride || (
      systemPromptCache
        ? systemPromptCache.getCachedSystemPrompt(
            this._agentRole || 'general',
            workDir,
            permissionMode,
            () => this._buildSystemPrompt(workDir, permissionMode)
          )
        : this._buildSystemPrompt(workDir, permissionMode)
    )

    // ── Performance: split system prompt for prefix cache stability ────────
    // The MLX server caches the KV state of the system prompt prefix. When the
    // prompt changes (file tree, steering docs), the cache is invalidated.
    // By putting the stable core prompt first and variable content (file tree,
    // steering) in a separate system message, the prefix cache stays valid
    // across turns even as the project evolves. This gives 1.8-3.1x TTFT
    // improvement on cache hits.
    let stableSystemPrompt = systemPrompt
    let variableSystemContent = ''

    // ── Code map auto-generation ──────────────────────────────────────────
    // Before loading steering docs, ensure a fresh code-map.md exists. This
    // is the symbol index the agent reads before running search_files — it
    // stops the model from guessing at variable/function names (as seen in
    // debug sessions where `search_files({pattern: "enemy|Enemy|enemies"})`
    // returns no matches because the codebase uses different names).
    // Generation is cheap (static regex scan, ~30 files max) and runs
    // synchronously only when the map is missing or stale (>1h old).
    if (!systemPromptOverride) {
      try {
        const { generateCodeMap, hasFreshCodeMap } = require('./project-map-generator')
        if (!hasFreshCodeMap(workDir)) {
          const t0 = Date.now()
          const result = generateCodeMap(workDir)
          if (!result.skipped) {
            console.log('[direct-bridge] code-map generated: %d files in %dms',
              result.filesScanned, Date.now() - t0)
          }
        }
      } catch (err) {
        console.warn('[direct-bridge] code-map generation failed:', err.message)
        /* non-fatal — continue without code map */
      }
    }

    // Inject steering docs into the system prompt (vibe mode)
    // For spec mode, systemPromptOverride already includes steering from the agent factory
    if (!systemPromptOverride) {
      try {
        const { loadSteeringDocs, formatSteeringForPrompt } = require('./steering-loader')
        const { formatted: steeringContent } = systemPromptCache
          ? systemPromptCache.getCachedSteering(workDir, loadSteeringDocs, formatSteeringForPrompt)
          : { formatted: formatSteeringForPrompt(loadSteeringDocs(workDir)) }
        if (steeringContent) {
          variableSystemContent += '\n\n' + steeringContent
        }
      } catch { /* steering loader not available — skip */ }
    } else {
      // systemPromptOverride already has everything — no split needed
      stableSystemPrompt = systemPrompt
    }

    // Inject a compact file tree — goes into the variable section so it
    // doesn't invalidate the prefix cache when files change.
    try {
      const tree = buildFileTreeCached(workDir, 6)
      if (tree) {
        const treeLines = tree.split('\n')
        const cappedTree = treeLines.length > 150
          ? treeLines.slice(0, 150).join('\n') + '\n... [truncated — use list_dir for deeper paths]'
          : tree
        variableSystemContent += `\n\n## Project file tree (${workDir})\n\`\`\`\n${cappedTree}\n\`\`\``
      }
    } catch { /* buildFileTree failed — skip */ }

    // ── Two-message system prompt for prefix cache stability ──────────────
    // messages[0] = stable core prompt (cached by server, KV state reused)
    // messages[1] = variable context (file tree, steering — changes often)
    // The server's get_system_prompt() returns messages[0].content for cache
    // matching. Variable content in messages[1] is part of the delta that
    // gets prefilled fresh each turn, so file tree changes don't invalidate
    // the cached KV state. This gives consistent prefix cache hits.

    // Build the final prompt — use lightweight project context when conversation
    // history is large (>8 messages), falling back to full transcript for short chats.
    // This prevents oversized prompts that choke local models on session resume.
    let finalPrompt = ''

    if (conversationHistory && conversationHistory.length > 0) {
      const estimatedHistoryTokens = conversationHistory.reduce((sum, m) => sum + estimateTokens(m.content), 0)

      // Inject recently modified files so the agent knows what was already touched
      let recentChangesCtx = ''
      try {
        const { execSync } = require('child_process')
        // Try git first — shows files changed in the last hour
        const gitChanges = execSync('git diff --name-only HEAD 2>/dev/null || git status --short 2>/dev/null | head -20', { cwd: workDir, timeout: 3000, encoding: 'utf-8' }).trim()
        if (gitChanges) {
          recentChangesCtx = `\n\n## Recently Modified Files\nThese files have uncommitted changes (likely from your previous work):\n${gitChanges}\n`
        }
      } catch {
        // git not available — try find for recently modified files
        try {
          const { execSync } = require('child_process')
          const recent = execSync('find . -name "*.html" -o -name "*.js" -o -name "*.css" -o -name "*.swift" -o -name "*.py" -o -name "*.ts" | xargs ls -lt 2>/dev/null | head -10', { cwd: workDir, timeout: 3000, encoding: 'utf-8' }).trim()
          if (recent) recentChangesCtx = `\n\n## Recently Modified Files\n${recent}\n`
        } catch { /* skip */ }
      }

      if (estimatedHistoryTokens > 6000) {
        // Large history — use file tree + task graph instead of full transcript.
        // Keep only the last 2 exchanges for immediate conversational context.
        const projectCtx = await buildProjectContext(workDir, taskGraphPath, this._lspManager)
        const recentHistory = conversationHistory.slice(-4)
        const recentTranscript = recentHistory.map(m => {
          const role = m.role === 'user' ? 'User' : 'Assistant'
          // Trim long assistant messages to just the first 500 chars
          const content = m.role === 'assistant' && m.content.length > 500
            ? m.content.slice(0, 500) + '...'
            : m.content
          return `[${role}]: ${content}`
        }).join('\n\n')

        finalPrompt = `${projectCtx}\n\n## Recent Conversation\n${recentTranscript}${recentChangesCtx}\n\n---\n\n`
      } else {
        // Short history — include full transcript (original behavior)
        const transcript = conversationHistory.map(m => {
          const role = m.role === 'user' ? 'User' : 'Assistant'
          return `[${role}]: ${m.content}`
        }).join('\n\n')
        finalPrompt = `Here is the conversation so far:\n\n${transcript}${recentChangesCtx}\n\n---\n\n`
      }
    }

    finalPrompt += prompt + imageContext

    // When the user interrupted a previous task (conversation history exists)
    // and sent a new message (with or without images), instruct the agent to
    // address the new request then offer to resume the previous work.
    if (conversationHistory && conversationHistory.length > 0) {
      finalPrompt += '\n\nIMPORTANT: After you address the user\'s request, ask: "Should we carry on with the previous work, or do you want help with something else?"'
    }

    const messages = [
      { role: 'system', content: stableSystemPrompt },
    ]
    // Variable content (file tree, steering) goes in a separate system message
    // so it doesn't invalidate the prefix cache when it changes.
    if (variableSystemContent) {
      messages.push({ role: 'system', content: variableSystemContent.trim() })
    }
    messages.push({ role: 'user', content: finalPrompt })

    this.send('qwen-event', { type: 'session-start', cwd: workDir })

    try {
      // Wait for the server to be ready before starting the agent loop
      console.log('[direct-bridge] run() pre-server-wait, elapsed %dms', Date.now() - _runT0);
      await this._waitForServer()
      console.log('[direct-bridge] run() server ready, elapsed %dms', Date.now() - _runT0);

      // ── Memory & LSP pre-flight: skip for orchestrator tasks ────────────
      // When running under the orchestrator (systemPromptOverride is set),
      // skip the expensive memory retrieval and LSP diagnostics pre-fetch.
      // Each agent already gets spec context from the orchestrator, and the
      // LSP diagnostics scan (especially for Swift projects with 20+ files)
      // can hang for minutes, blocking all concurrent agents.
      const _isOrchestratorTask = !!systemPromptOverride

      // ── Memory: session-start retrieval ──────────────────────────────────
      // Retrieve relevant past context using the current prompt as the query.
      // This is especially valuable on session resume when conversation history
      // has been trimmed — the agent gets relevant memories even without full history.
      // Fetch more candidates than needed, then filter by relevance score and
      // cap by token budget so high-relevance sessions get rich context while
      // cold starts with no good matches waste minimal tokens.
      if (memoryClient && !_isOrchestratorTask) {
        try {
          console.log('[direct-bridge] run() memory retrieval starting, elapsed %dms', Date.now() - _runT0);
          const recallMode = detectRecallMode(prompt)
          const memResult = await memoryClient.retrieve(prompt, {
            mode: recallMode,
            agentName: this._agentRole || 'main-agent',
            topK: 20,
            projectId: path.basename(workDir),
          })
          if (memResult && memResult.results && memResult.results.length > 0) {
            // Filter by relevance score — drop items below 0.3 threshold
            const SCORE_THRESHOLD = 0.3
            const TOKEN_BUDGET = 2000 // ~8000 chars of memory context
            const charBudget = TOKEN_BUDGET * 4
            const relevant = memResult.results.filter(r => (r.score || 0) >= SCORE_THRESHOLD)
            // Cap by token budget
            let totalChars = 0
            const capped = []
            for (const r of relevant) {
              const line = `[${r.source}] ${r.content}`
              if (totalChars + line.length > charBudget && capped.length > 0) break
              capped.push(line)
              totalChars += line.length
            }
            if (capped.length > 0) {
              messages.push({
                role: 'system',
                content: `[Memory Context — from previous sessions]\n${capped.join('\n')}`,
              })
              this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Memory: retrieved ${capped.length} relevant items (of ${memResult.results.length} candidates, score >= ${SCORE_THRESHOLD})` })
            }
          }
        } catch (_) { /* memory unavailable — proceed without */ }
        console.log('[direct-bridge] run() memory retrieval done, elapsed %dms', Date.now() - _runT0);

        // ── Session resume brief ──────────────────────────────────────────
        // When conversation history was trimmed (large session), inject a
        // structured brief of what was already accomplished so the agent
        // doesn't re-search things it already found.
        const historyWasTrimmed = conversationHistory && conversationHistory.length > 0 &&
          conversationHistory.reduce((sum, m) => sum + estimateTokens(m.content), 0) > 6000
        if (historyWasTrimmed) {
          try {
            // Search the archive for tool_call and decision events from this project
            const priorWork = await memoryClient.archiveSearch(
              'tool_call decision',
              { limit: 20, projectId: path.basename(workDir) }
            )
            if (priorWork && priorWork.length > 0) {
              // Build a compact "what was already done" brief
              const toolCalls = priorWork
                .filter(r => r.event_type === 'tool_call' || r.event_type === 'decision')
                .slice(0, 10)
                .map(r => `• ${r.summary || (typeof r.payload === 'string' ? r.payload.slice(0, 100) : JSON.stringify(r.payload || '').slice(0, 100))}`)
                .join('\n')
              if (toolCalls) {
                messages.push({
                  role: 'system',
                  content: `[Session Resume — prior work in this project]\nThe following was already done in previous sessions. Do NOT repeat these searches or actions unless the user explicitly asks:\n${toolCalls}\n\nContinue from where the work left off.`,
                })
                this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Memory: injected session resume brief (${toolCalls.split('\n').length} prior actions)` })
              }
            }
          } catch (_) { /* archive unavailable — proceed without */ }
        }
      }

      // Gather active diagnostics — fire-and-forget so it doesn't block agent start.
      // Results are injected as a system message on the first turn of _agentLoop
      // via the existing _pendingDiagnostics mechanism.
      if (!_isOrchestratorTask && this._lspManager?.getStatus().status === 'ready') {
        console.log('[direct-bridge] run() LSP diagnostics starting (lazy), elapsed %dms', Date.now() - _runT0);
        const _lspMgr = this._lspManager
        const _workDir = workDir
        this._pendingDiagnostics = (async () => {
          try {
            let diagFiles = detectEntryPoints(_workDir)
            const hasXcodeProject = (() => {
              try {
                return fs.readdirSync(_workDir).some(e => e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace'))
              } catch { return false }
            })()
            if (hasXcodeProject) {
              try {
                const { execSync } = require('child_process')
                const swiftFiles = execSync(
                  `find "${_workDir}" -name "*.swift" -not -path "*/DerivedData/*" -not -path "*/.build/*" 2>/dev/null | head -40`,
                  { timeout: 5000, encoding: 'utf-8' }
                ).trim().split('\n').filter(Boolean)
                const priority = swiftFiles.filter(f => /App\.swift$|ContentView\.swift$|main\.swift$/i.test(f))
                const rest = swiftFiles.filter(f => !priority.includes(f))
                diagFiles = [...priority, ...rest].slice(0, 20)
              } catch { /* fall back to default */ }
            }

            const diagSummary = await _lspMgr.getProjectDiagnosticsSummary(diagFiles)
            if (diagSummary.totalErrors > 0) {
              const diagLines = []
              for (const f of diagSummary.files) {
                const rel = path.relative(_workDir, f.path)
                for (const e of f.errors) {
                  diagLines.push(`  ${rel}:${e.line || '?'} — ${e.message}`)
                }
              }
              return {
                path: 'project',
                errors: diagLines.slice(0, 30).map(l => ({ message: l.trim(), severity: 'error' })),
              }
            }
          } catch { /* non-fatal */ }
          return null
        })()
      }

      console.log('[direct-bridge] run() entering agentLoop, elapsed %dms', Date.now() - _runT0);
      this.send('qwen-event', { type: 'system', subtype: 'debug', data: `[bridge] entering agent loop (elapsed ${Date.now() - _runT0}ms)` })
      await this._agentLoop(messages, workDir, model)
      this.send('qwen-event', { type: 'session-end' })
    } catch (err) {
      if (!this._aborted) {
        this.send('qwen-event', { type: 'error', error: err.message || String(err) })
      }
    } finally {
      this._running = false
    }
  }

  /**
   * The core agentic loop: call model → if tool_calls, execute & loop → else done.
   */
  async _agentLoop(messages, cwd, model, maxTurns = 50) {
    // Scope the rewind store to this project so keys don't collide across projects
    compactor.setRewindProject(cwd)

    // ── Initialize speculative tool executor for this run ────────────────
    // Binds cwd/lspManager/etc so the speculator can call executeTool with
    // the right project scope. Cleared at close()/interrupt().
    if (this._speculateEnabled && ToolSpeculator && !this._toolSpeculator) {
      this._currentCwd = cwd
      this._toolSpeculator = new ToolSpeculator({
        maxInflight: 4,
        execute: async (name, args) => {
          return await executeTool(
            name, args, cwd,
            this._browserInstance, this._lspManager, this._inputRequester,
            { send: () => {} /* silent events for speculations */, _sessionId: 'speculative' }
          )
        },
        onSpeculate: (info) => {
          this.send('qwen-event', { type: 'system', subtype: 'debug',
            data: `🔮 speculating ${info.name}(${JSON.stringify(info.args).slice(0, 60)})` })
        },
      })
    }

    // Read calibrated settings if available, fall back to parameter/hardcoded defaults
    const profile = this._getCalibrationProfile?.()
    const effectiveMaxTurns = profile?.maxTurns ?? maxTurns
    const effectiveMaxInputTokens = profile?.maxInputTokens ?? config.MAX_INPUT_TOKENS
    const effectiveCompactionThreshold = profile?.compactionThreshold ?? config.COMPACTION_THRESHOLD
    const effectiveReadFileTruncate = profile?.readFileTruncate ?? config.READ_FILE_TRUNCATE
    const effectiveToolOutputTruncate = profile?.toolOutputTruncate ?? config.TOOL_OUTPUT_TRUNCATE

    let consecutiveErrors = 0
    let consecutiveReadsWithoutWrite = 0  // Track read-only loops
    let _lastFailedEditPath = null  // Track path of last failed edit — exempt re-reads of this file
    const _editAttemptedPaths = new Set()  // All paths the agent has tried to edit — exempt from read blocks
    let lastTextResponses = []  // Track recent text-only responses for repetition detection
    let consecutivePlanningNudges = 0  // Track how many times we've nudged for planning-only responses
    let _annotationNudgeCount = 0  // Track consecutive hallucinated-annotation nudges — cap to prevent infinite loop
    let _lastTodos = null  // Track the latest todo list for completion checking
    let _agentNotes = null  // Persistent thinking notes — survive compaction, re-injected after each compact
    // Also stored on instance so interrupt() can access it for session resume
    this._lastAgentNotes = null

    // ── Restore agent notes from conversation history (session resume) ────
    // When resuming a session, scan the messages for the last agent_notes.
    // Notes are saved as system messages with prefix [agent_notes]: in the
    // conversation history by the renderer.
    for (let mi = messages.length - 1; mi >= 0; mi--) {
      const m = messages[mi]
      // Check for the persisted [agent_notes]: format
      if (m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[agent_notes]:')) {
        _agentNotes = m.content.slice('[agent_notes]:'.length).trim()
        break
      }
      // Also check for tool_calls format (in case history has them)
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of (m.tool_calls || [])) {
          if (tc.function?.name === 'agent_notes') {
            try {
              const args = typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments) : tc.function.arguments
              if (args.notes && typeof args.notes === 'string') {
                _agentNotes = args.notes.trim()
              }
            } catch {}
          }
        }
        if (_agentNotes) break
      }
    }
    // If notes were found, inject them into the initial context
    if (_agentNotes) {
      messages.push({
        role: 'system',
        content: `[Your thinking notes from the previous run — use these to avoid re-discovering things]:\n${_agentNotes}`,
      })
    } else {
      // Fallback: use the last assistant message (task_complete summary) as context
      for (let mi = messages.length - 1; mi >= 0; mi--) {
        const m = messages[mi]
        if (m.role === 'assistant' && m.content && m.content.length > 100) {
          messages.push({
            role: 'system',
            content: `[Summary from your previous run — do not repeat this work]:\n${m.content.slice(0, 2000)}`,
          })
          break
        }
      }
    }
    let _bootstrapDone = false  // Track whether todo bootstrap has fired
    let _textOnlyTurns = 0  // Track consecutive text-only responses for safety valve
    // ── Unproductive turn tracking ────────────────────────────────────────
    // A turn is "productive" if it writes/edits a file, runs a successful bash
    // command, or completes a task. If the agent goes N turns without any
    // productive action, it's spinning and should be stopped.
    let _unproductiveTurns = 0
    const _MAX_UNPRODUCTIVE_TURNS = 20  // abort after this many wasted turns
    // After a compaction pass, skip memory re-injection for a few turns so we
    // don't immediately re-inflate the context we just compressed.
    let _postCompactionCooldown = 0

    // ── Compile-error loop detection ──────────────────────────────────────────
    // Tracks consecutive compile failures per file. When the same file fails
    // to compile 3+ times in a row, inject targeted guidance so the agent
    // can break out of the patch loop instead of spinning forever.
    const _compileFailCounts = new Map()  // filePath → consecutive fail count
    let _lastCompileFile = null

    // ── Tool call repetition detection ────────────────────────────────────────
    // Tracks recent tool calls by signature (name + args). When the agent calls
    // the same tool with the same arguments 3+ times and keeps getting errors,
    // it's stuck in a loop. Inject a hard break and force a different approach.
    const _recentToolCalls = []  // { sig, isError, turn }
    const _TOOL_REPEAT_WINDOW = 8  // look at last N tool calls
    const _TOOL_REPEAT_THRESHOLD = 3  // same call N times = stuck
    let _consecutiveSingleReads = 0  // Track single read_file turns for batching nudge

    // ── Missing-type search detection ─────────────────────────────────────────
    // When search_files returns no results for the same query twice, the type
    // likely doesn't exist yet. Inject a hint to create it rather than search again.
    const _emptySearchHistory = new Map()  // query → count of empty results

    // ── A-B-A-B alternating loop detection ───────────────────────────────────
    // Tracks the last 6 tool names. When two tools alternate perfectly (A-B-A-B-A-B
    // or A-B-A-B with 3+ full cycles), the agent is cycling between two tools
    // that each feed an incomplete result to the other — neither makes progress.
    // Distinct from the identical-call detector: the calls are different each time
    // but the pair repeats. Window of 6 catches 3 full A-B cycles.
    const _recentToolNames = []  // last N tool names (no args — pattern only)
    const _ABAB_WINDOW = 6

    // ── No-op write guard ─────────────────────────────────────────────────────
    // Tracks write_file calls by path → content hash. When the agent writes the
    // same content to the same file 2+ times, it's not making progress — it
    // thinks it hasn't committed the write yet. Intercept and confirm the write
    // already happened instead of executing again.
    const _writeHistory = new Map()  // path → { hash, count, turn }

    // ── Read-file loop detection ─────────────────────────────────────────────
    // Tracks read_file calls per path with file modification times. When the
    // agent re-reads a file it already fully read and the file hasn't changed
    // (mtime unchanged), return a compact notice instead of the full content.
    // If the file WAS modified (agent edited it), allow the re-read.
    // This breaks the truncation loop while still letting the agent see its edits.
    const _readFileHistory = new Map()  // path → { count, lastTurn, fullRead, totalLines, mtime }

    // ── Helper: build assistant message with reasoning_content ─────────────
    // Used by all paths that push assistant messages to the conversation.
    // Preserves the model's chain-of-thought so the Jinja template can render
    // it in history, preventing the model from losing its reasoning between
    // tool loop iterations (which causes re-read loops).
    function _buildAssistantMsg(content, reasoning) {
      const msg = { role: 'assistant', content: content || null }
      if (reasoning) msg.reasoning_content = reasoning
      return msg
    }

    // ── Memory: session start ─────────────────────────────────────────────────
    const _sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    if (memoryClient) {
      memoryClient.archiveRecord('session_start', { session_id: _sessionId }, 'Session started', {
        agentName: this._agentRole || 'main-agent',
        sessionId: _sessionId,
        projectId: path.basename(cwd),
      }).catch(() => {})
    }

    for (let turn = 0; turn < effectiveMaxTurns; turn++) {
      if (this._aborted) return
      console.log('[direct-bridge] _agentLoop turn %d START', turn)

      // Clear coalesced tool call IDs from previous turn
      this._coalescedToolCallIds.clear()
      // Clear per-stream speculator tracking (new turn = new streams)
      if (this._specStreamArgs) this._specStreamArgs.clear()

      // Drain any user-injected messages (from mid-run prompts / spec iteration).
      // Insert them as user messages so the model sees the updated objective.
      // The model MUST acknowledge the injection, respond to it, and then
      // continue working on the main task from the new state.
      if (this._pendingInjections.length > 0) {
        const allInjections = []
        while (this._pendingInjections.length > 0) {
          allInjections.push(this._pendingInjections.shift())
        }
        // Combine all pending injections into a single user turn
        const combined = allInjections.join('\n\n')
        messages.push({ role: 'user', content: `[User update mid-run]: ${combined}` })
        // Add a system instruction so the model acknowledges and follows the injection
        messages.push({
          role: 'system',
          content: 'IMPORTANT: The user just sent a message while you were working. You MUST:\n' +
            '1. Acknowledge the user\'s message — briefly confirm you received it.\n' +
            '2. Follow any instructions in the message (e.g. change approach, fix something, answer a question).\n' +
            '3. After addressing the user\'s message, continue working on the main task from this new state.\n' +
            'Do NOT ignore the user\'s message. Respond to it first, then resume your work.',
        })
        for (const injected of allInjections) {
          this.send('qwen-event', { type: 'user-injection', content: injected })
        }
      }

      // ── Performance: inject deferred LSP diagnostics from previous turn ──
      // Instead of blocking the tool loop waiting for diagnostics, we fire them
      // async and inject results here at the start of the next turn.
      if (this._pendingDiagnostics) {
        try {
          // Non-blocking: check if the LSP scan has completed, don't wait for it.
          // If it's still running, skip and it'll be picked up next turn.
          const diagResult = await Promise.race([
            this._pendingDiagnostics,
            new Promise(r => setTimeout(() => r(null), 0)),
          ])
          if (diagResult && diagResult.errors && diagResult.errors.length > 0) {
            const diagLines = diagResult.errors.map(d => `  ${d.severity || 'error'}: ${d.message} (line ${d.line || '?'})`).join('\n')
            messages.push({
              role: 'system',
              content: `⚠️ LSP diagnostics for ${diagResult.path} (from previous edit):\n${diagLines}\nFix these errors before continuing.`,
            })
            this.send('qwen-event', { type: 'lsp-activity', action: 'deferred-diagnostics', path: diagResult.path, count: diagResult.errors.length })
            this._pendingDiagnostics = null  // consumed — clear it
          } else if (diagResult === null) {
            // Timeout — LSP scan still running, leave the promise for next turn
          } else {
            this._pendingDiagnostics = null  // no errors — clear it
          }
        } catch {
          this._pendingDiagnostics = null  // failed — clear it
        }
      }

      // Warn the model when running low on turns so it can wrap up gracefully
      // instead of being cut off mid-task
      if (turn === effectiveMaxTurns - 5) {
        messages.push({
          role: 'system',
          content: 'NOTICE: You have only 5 tool turns remaining. Wrap up your current task — finish any in-progress file writes, run a final verification if needed, then provide a summary of what you accomplished and what remains.',
        })
      }

      // Retry on transient connection errors (ECONNRESET, ECONNREFUSED)
      let completion = null
      let _archivedCount = 0
      let _archiveStatus = 'skipped'

      // ── Proactive context hygiene ──────────────────────────────────────────
      // Before checking compaction, prune low-value messages that accumulate
      // over long sessions. This keeps the context lean so compaction triggers
      // less often, preserving more useful content for the model.
      if (turn > 0 && turn % 5 === 0 && messages.length > 12) {
        const keepRecent = 8  // always keep the last N messages intact
        const cutoff = messages.length - keepRecent
        let pruned = 0
        // Count leading system messages to skip (stable prompt + variable context)
        let sysSkip = 0
        while (sysSkip < messages.length && messages[sysSkip]?.role === 'system') sysSkip++
        for (let pi = sysSkip; pi < cutoff; pi++) {
          const m = messages[pi]
          if (!m || !m.content) continue

          // Prune stale system nudges (STATUS, planning nudges, old warnings)
          // These are injected by the agent loop and become stale after a few turns.
          // IMPORTANT: Do NOT prune read-loop enforcement (STOP READING, BLOCKED, REJECTED)
          // or CHECKPOINT messages — those must persist to maintain pressure on the agent.
          if (m.role === 'system' && /^(STATUS:|NOTICE:|You described what|You are STUCK)/.test(m.content)) {
            messages.splice(pi, 1)
            pi--
            pruned++
            continue
          }
          // Prune old WARNING messages but keep the most recent one (it's the active enforcement)
          if (m.role === 'system' && /^(WARNING:)/.test(m.content)) {
            // Check if there's a newer WARNING after this one — only prune if so
            const hasNewerWarning = messages.slice(pi + 1).some(mm => mm.role === 'system' && /^(WARNING:)/.test(mm.content))
            if (hasNewerWarning) {
              messages.splice(pi, 1)
              pi--
              pruned++
              continue
            }
          }

          // Prune short write_file/edit_file confirmations from old turns.
          // "Wrote 500 chars to file.js" and "Edited file.js" are useful for
          // one turn but waste tokens after that — the file is on disk.
          if (m.role === 'tool' && m.content.length < 200 &&
              /^(Wrote \d+ chars to |Edited |Updated todo list|Todo list edited)/.test(m.content)) {
            messages.splice(pi, 1)
            pi--
            pruned++
            continue
          }
        }
        if (pruned > 0) {
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Context hygiene: pruned ${pruned} stale messages (~${pruned * 50} tokens saved)` })
        }
      }

      // ── Proactive tool-result shrinking ──────────────────────────────────
      // Every turn, shrink older tool results to compact receipts with rewind
      // keys. Prevents context from ballooning — particularly important on
      // hybrid-architecture models (Qwen3.6-A3B) where turn-to-turn KV cache
      // reuse isn't possible, so every token in context gets re-prefilled.
      // Keeps the most recent 3 tool results intact so the agent can still
      // act on them; older ones can be retrieved via rewind_context if needed.
      // Benchmark: typical agent workflow saves 35s+ prefill per turn.
      if (shrinkOlderToolResults) {
        try {
          const result = shrinkOlderToolResults(messages, compactor, {
            keepRecentN: 3,
            minShrinkChars: 3000,
            log: (m) => this.send('qwen-event', { type: 'system', subtype: 'debug', data: m }),
          })
          if (result.shrunk > 0) {
            this.send('qwen-event', { type: 'system', subtype: 'debug',
              data: `⚡ shrunk ${result.shrunk} older tool result(s), saved ~${result.tokensSaved.toLocaleString()} tokens` })
          }
        } catch (e) {
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: `shrinker error (non-fatal): ${e.message}` })
        }
      }

      // Compress context if it's getting too large — trigger compaction early
      // ── Performance: adaptive compaction threshold ──────────────────────
      // Early turns: let context grow (75%) — short sessions rarely need compaction.
      // Mid session: standard threshold (65%).
      // Long sessions: aggressive (55%) — accumulated cruft needs pruning.
      const adaptiveCompactionThreshold = turn < 10
        ? Math.floor(effectiveMaxInputTokens * 0.75)
        : turn < 30
          ? Math.floor(effectiveMaxInputTokens * 0.65)
          : Math.floor(effectiveMaxInputTokens * 0.55)
      // Never compact below the calibrator floor — prevents premature compaction
      // when memory pressure has already reduced effectiveMaxInputTokens
      const activeCompactionThreshold = Math.max(
        config.CALIBRATOR_FLOOR,
        Math.min(adaptiveCompactionThreshold, effectiveCompactionThreshold)
      )

      // (at the compaction threshold) to give the compactor room to work before
      // hitting the hard maxInputTokens ceiling.
      if (estimateMessagesTokens(messages) > activeCompactionThreshold) {
        console.log('[direct-bridge] _agentLoop turn %d: COMPACTION triggered', turn)
        this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Compaction triggered: ~${estimateMessagesTokens(messages)} tokens > threshold ${activeCompactionThreshold} (adaptive: ${adaptiveCompactionThreshold}, calibrated: ${effectiveCompactionThreshold}, turn: ${turn})` })
        const before = messages.length
        // Preserve the user's original request so compaction can't erase the task
        const originalUserMsg = messages.find(m => m.role === 'user')
        const originalRequest = originalUserMsg?.content?.slice(0, 500) || ''

        // ── Protect system messages through compaction ─────────────────
        // System messages contain the role preamble, tool rules (messages[0])
        // and variable context like file tree and steering (messages[1]).
        // Snapshot all leading system messages and restore them after compaction.
        const originalSystemMessages = []
        for (let si = 0; si < messages.length; si++) {
          if (messages[si]?.role === 'system') originalSystemMessages.push(messages[si])
          else break
        }

        // ── Memory: archive messages before compaction ────────────────────
        if (memoryClient) {
          try {
            const messagesToArchive = messages.slice(0, Math.max(0, messages.length - 4))
            for (const msg of messagesToArchive) {
              if (msg.content && msg.content.length > 0) {
                await memoryClient.archiveRecord('pre_compaction', msg.content, msg.content.slice(0, 200), {
                  agentName: this._agentRole || 'main-agent',
                  sessionId: _sessionId,
                  turnNumber: turn,
                  projectId: path.basename(cwd),
                })
                _archivedCount++
              }
            }
            _archiveStatus = 'ok'
          } catch (_archiveErr) {
            _archiveStatus = 'error'
          }
        }

        try {
          const result = await compactor.compressMessages(pythonPath, messages, { dedup: true, keepRecent: 12 })
          if (result && result.messages) {
            messages.length = 0
            messages.push(...result.messages)
            // Emit compaction stats
            if (result.stats) {
              this.send('qwen-event', { type: 'compaction-stats', data: result.stats })
            }
            this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Compressed context: ${before} → ${messages.length} messages (~${estimateMessagesTokens(messages)} tokens, engine: ${result.stats?.engine || 'unknown'})` })

            // Re-inject the original request as a reminder after compaction
            // so the model doesn't lose track of what it was asked to do.
            // Also re-inject the file tree so the agent retains spatial awareness
            // of the project without needing to re-run list_dir.
            if (originalRequest) {
              let reminderContent = `REMINDER — the user's original request (continue working on this):\n"${originalRequest}"`
              try {
                const tree = buildFileTree(cwd)
                if (tree) {
                  const treeLines = tree.split('\n')
                  const cappedTree = treeLines.length > 80
                    ? treeLines.slice(0, 80).join('\n') + '\n... [use list_dir for deeper paths]'
                    : tree
                  reminderContent += `\n\nProject file tree (refreshed after compaction):\n\`\`\`\n${cappedTree}\n\`\`\``
                }
              } catch { /* skip */ }
              // Re-inject agent notes so the model doesn't lose its scratchpad
              if (_agentNotes) {
                reminderContent += `\n\n[Your thinking notes — written by you earlier, survived compaction]:\n${_agentNotes}`
              }
              // Re-inject todo list so the model retains its progress checklist
              if (_lastTodos && _lastTodos.length > 0) {
                const done = _lastTodos.filter(t => t.status === 'done' || t.status === 'completed').length
                const todoLines = _lastTodos.map(t => {
                  const icon = (t.status === 'done' || t.status === 'completed') ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜'
                  return `${icon} [${t.id}] ${t.content}`
                }).join('\n')
                reminderContent += `\n\nYour todo list (${done}/${_lastTodos.length} complete — restored after compaction):\n${todoLines}`
              }
              messages.push({
                role: 'system',
                content: reminderContent,
              })
            }
          }
        } catch (compactErr) {
          // Compactor failed entirely — fall back to trimMessages
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Compactor error: ${compactErr.message}, falling back to trimMessages` })
          const trimmed = trimMessages(messages, effectiveMaxInputTokens)
          messages.length = 0
          messages.push(...trimmed)
        }
        // Secondary fallback: if compactor result still exceeds the token limit, trim
        if (estimateMessagesTokens(messages) > effectiveMaxInputTokens) {
          const trimmed = trimMessages(messages, effectiveMaxInputTokens)
          messages.length = 0
          messages.push(...trimmed)
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Post-compaction trim: ${before} → ${messages.length} messages (~${estimateMessagesTokens(messages)} tokens)` })
        }

        // ── Restore system messages after all compaction paths ─────────
        // Regardless of which compaction path ran (Python, builtin, or
        // trimMessages fallback), ensure the original system messages are at
        // the front. The builtin compactor already preserves system messages,
        // but the Python compactor and trimMessages don't — so this is the
        // safety net that guarantees role preamble, tool rules, steering docs,
        // and file tree survive every compaction.
        if (originalSystemMessages.length > 0) {
          // Strip any mangled system messages from the front
          while (messages.length > 0 && messages[0]?.role === 'system') {
            messages.shift()
          }
          // Re-insert the originals at the front in their original order.
          // Use splice(0, 0, ...arr) instead of repeated unshift() — unshift
          // in a reverse loop would reverse the order of multiple system messages.
          messages.splice(0, 0, ...originalSystemMessages)
        }

        // Suppress memory re-injection for the next 3 turns so we don't
        // immediately re-inflate the context we just compressed.
        _postCompactionCooldown = 3

        // Clear read-file history after compaction — the original file content
        // has been trimmed/compressed away, so the agent genuinely needs to
        // re-read files it wants to edit. Without this, the loop detection
        // blocks re-reads of files whose content is no longer in context.
        _readFileHistory.clear()
        _writeHistory.clear()  // also reset write dedup — content may have changed

        // Re-inject read-loop enforcement state after compaction so the agent
        // doesn't lose the pressure to write. The counter survives but the
        // system messages in the array were wiped by compaction.
        if (consecutiveReadsWithoutWrite >= 8) {
          messages.push({
            role: 'system',
            content: `REMINDER: You have made ${consecutiveReadsWithoutWrite} consecutive read calls without writing. ` +
              `You MUST call edit_file or write_file on your next turn. Further read calls will be rejected.`,
          })
        }
      }

      // ── Memory: emit memory-archive event after compaction ────────────────
      if (_archiveStatus !== 'skipped') {
        this.send('qwen-event', { type: 'memory-archive', archivedCount: _archivedCount, status: _archiveStatus })
      }

      // ── Memory: pre-LLM retrieval ─────────────────────────────────────────
      // Retrieve relevant context from memory before each LLM call.
      // Use 'thorough' mode when user message contains recall phrases.
      // Skip injection if context is already above 70% of the compaction threshold
      // to avoid re-inflating right after a compaction pass.
      // Also skip for _postCompactionCooldown turns after a compaction to let
      // the context stabilise before adding more.
      // Cooldown check: skip this turn if cooling down, then decrement for next turn.
      const _memSkipCooldown = _postCompactionCooldown > 0
      if (_postCompactionCooldown > 0) _postCompactionCooldown--
      const _currentTokens = estimateMessagesTokens(messages)
      const _memInjectBudget = Math.floor(effectiveCompactionThreshold * 0.70)
      if (memoryClient && _currentTokens < _memInjectBudget && !_memSkipCooldown) {
        try {
          const userMsg = messages.filter(m => m.role === 'user').pop()
          const userText = typeof userMsg?.content === 'string' ? userMsg.content : ''
          const recallMode = detectRecallMode(userText)
          const memBudget = parseInt(process.env.MEMORY_CONTEXT_BUDGET || '2048', 10)
          const memResult = await memoryClient.retrieve(userText, {
            mode: recallMode,
            agentName: this._agentRole || 'main-agent',
            topK: 10,
            projectId: path.basename(cwd),
          })
          if (memResult && memResult.results && memResult.results.length > 0) {
            // Remove any previous [Memory Context] injection to avoid accumulation.
            // Each turn gets a fresh retrieval — stale ones waste context space.
            for (let mi = messages.length - 1; mi >= 0; mi--) {
              if (messages[mi].role === 'system' && messages[mi].content &&
                  messages[mi].content.startsWith('[Memory Context]')) {
                messages.splice(mi, 1)
              }
            }
            // Build memory context string
            const memLines = memResult.results.map(r => `[${r.source}] ${r.content}`).join('\n')
            const memContextMsg = {
              role: 'system',
              content: `[Memory Context]\n${memLines}`,
            }
            // Inject immediately before the last user message
            const lastUserIdx = messages.map(m => m.role).lastIndexOf('user')
            if (lastUserIdx >= 0) {
              messages.splice(lastUserIdx, 0, memContextMsg)
            } else {
              messages.push(memContextMsg)
            }
          }
        } catch (_) {
          // Memory retrieval failed — continue without context
        }
      }

      // Vision offload — replace image parts with text descriptions before LLM call
      console.log('[direct-bridge] _agentLoop turn %d: pre-vision-offload', turn)
      if (assistClient) {
        for (const msg of messages) {
          if (!Array.isArray(msg.content)) continue
          for (let i = 0; i < msg.content.length; i++) {
            const part = msg.content[i]
            if (part.type === 'image_url' || part.type === 'image') {
              const imageData = part.image_url?.url || part.source?.data || ''
              const mimeType = part.image_url?.detail ? 'image/png' : (part.source?.media_type || 'image/png')
              const desc = await assistClient.assistVision(
                imageData, mimeType,
                'Describe this screenshot in detail, focusing on UI elements, error messages, and code visible on screen.'
              )
              if (desc) {
                msg.content[i] = { type: 'text', text: `[Vision: ${desc}]` }
                this.send('qwen-event', { type: 'fast-assist', task: 'vision', label: '⚡ Fast Assistant — image described', detail: desc.slice(0, 120) })
              } else {
                // Fast model not loaded — replace image with a note so the main model
                // doesn't receive a raw base64 blob it can't process
                msg.content[i] = { type: 'text', text: '[image attached — vision model not loaded, cannot describe]' }
              }
            }
          }
        }
      }

      // ── Fast model context gathering ──────────────────────────────────
      // Disabled: the prompt is already 60-80k chars with file tree + steering
      // + tools. Adding pre-gathered file contents pushes it over the limit
      // and makes prefill take 4+ minutes. The main model gathers its own
      // context via read_file/search_files which is more targeted.
      // TODO: Re-enable when prompt size is reduced or prefix cache covers it.

      // Todo bootstrap — disabled for fast model to avoid conflict with main model.
      // The fast model (0.8B) generates a todo list before the main model starts,
      // but the main model then creates its own plan via update_todos, causing
      // duplicate/conflicting todo lists. Let the main model own the plan.
      if (turn === 0) {
        if (Array.isArray(this._task?.initialTodos) && this._task.initialTodos.length > 0 && !_bootstrapDone) {
          // Orchestrator provided subtasks from tasks.md — use them directly,
          // no fast model call needed. Agent follows the spec's detailed plan.
          this.send('qwen-event', { type: 'todo-bootstrap', todos: this._task.initialTodos })
          _lastTodos = this._task.initialTodos
          _bootstrapDone = true
        }
        // Fast model bootstrap disabled — main model creates its own plan via update_todos
      }

      // ── Task-aware tool hints (turn 0 only) ────────────────────────────
      // Detect specific task patterns and inject hints about specialized tools
      // that the model might not discover on its own from the tool list.
      if (turn === 0) {
        const userPrompt = messages.filter(m => m.role === 'user').pop()?.content || ''
        const promptLower = typeof userPrompt === 'string' ? userPrompt.toLowerCase() : ''

        // Xcode project generation
        if (promptLower.includes('pbxproj') || promptLower.includes('xcodeproj') ||
            (promptLower.includes('xcode') && promptLower.includes('project')) ||
            (promptLower.includes('missing') && promptLower.includes('project'))) {
          messages.push({
            role: 'system',
            content: 'HINT: You have a generate_xcode_project tool that creates project.pbxproj files automatically from Swift source files. ' +
              'Call it with the product name and source directory — do NOT manually read files or write pbxproj XML. ' +
              'If the project lives inside a subfolder of your working directory, pass project_dir pointing at that subfolder. ' +
              'Example: generate_xcode_project({"product_name": "MyApp", "project_dir": "MyApp Folder", "source_dir": "MyApp"}). ' +
              'If the call returns "Source directory not found", the error will list candidate directories — re-invoke with source_dir set to one of them rather than guessing.',
          })
        }

        // ── Xcode platform detection — inject authoritative build workflow ──
        // Scan the cwd for an Xcode project and detect its platform from build
        // settings. This fires whenever an Xcode project exists in the working
        // directory, regardless of what the user typed — so the agent always
        // gets the right workflow for iOS vs macOS without guessing from keywords.
        const xcodeHint = _detectXcodePlatformHint(cwd)
        if (xcodeHint) {
          messages.push({ role: 'system', content: xcodeHint })
        }
      }

      // ── Turn 0: ask the model to explain its approach before acting ─────
      // This produces visible inline text so the user knows what's about to happen.
      // Keep it short — 1-2 sentences max, then proceed with tool calls.
      if (turn === 0) {
        messages.push({
          role: 'system',
          content: 'Before using any tools, briefly tell the user what you\'re about to do and why (1-2 sentences). Then proceed with your first tool call in the same response.',
        })
      }

      for (let attempt = 0; attempt < 8; attempt++) {
        if (this._aborted) return
        try {
          this._injectionInterrupt = false
          console.log('[direct-bridge] _agentLoop turn %d attempt %d: calling _streamCompletion', turn, attempt)  // reset before each attempt
          console.log('[direct-bridge] _agentLoop turn %d: calling _streamCompletion, messages=%d, ~%d tokens', turn, messages.length, estimateMessagesTokens(messages))
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: `[bridge] calling inference (turn ${turn}, ${messages.length} msgs, ~${estimateMessagesTokens(messages)} tokens)` })
          completion = await this._streamCompletion(messages, cwd, model)
          break
        } catch (err) {
          if (this._aborted) return
          // If the stream was destroyed by inject(), skip retry and proceed
          // to the next turn where the injection will be drained immediately.
          if (this._injectionInterrupt) {
            this._injectionInterrupt = false
            completion = { text: '', toolCalls: [], usage: null, finishReason: 'interrupted', reasoningContent: null }
            this.send('qwen-event', { type: 'system', subtype: 'debug', data: '⚡ Inference interrupted by user message — processing immediately' })
            break
          }
          const code = err.code || ''
          const msg = err.message || ''
          const isTransient = code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE'
          // Also retry on HTTP 500/502/503 — local MLX server can return these
          // when overloaded (e.g. after processing a large tool output)
          const isServerError = /Server returned HTTP (500|502|503)/.test(msg)
          // HTTP 413 — prompt too large. Trim messages and retry.
          const isPromptTooLarge = /Server returned HTTP 413|Prompt too large/.test(msg)
          if (isPromptTooLarge && attempt < 7) {
            // Parse the server's actual limit from the error if available
            let serverLimit = effectiveMaxInputTokens
            const limitMatch = msg.match(/"limit"\s*:\s*(\d+)/)
            if (limitMatch) serverLimit = Math.min(serverLimit, parseInt(limitMatch[1], 10))
            // Progressive reduction: each retry reduces budget by 20% more
            // Floor at 0.15 (not 0.3) so we can actually escape very large contexts
            const reductionFactor = 1 - (0.2 * (attempt + 1))
            const targetTokens = Math.floor(serverLimit * Math.max(reductionFactor, 0.15))
            this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Prompt too large (HTTP 413), trimming context and retrying... (attempt ${attempt + 1}, target: ${targetTokens} tokens)` })
            const trimmed = trimMessages(messages, targetTokens)
            messages.length = 0
            messages.push(...trimmed)
            // If still over budget, aggressively truncate the largest messages
            // Protect the last 6 messages — those are what the agent is actively using
            if (estimateMessagesTokens(messages) > targetTokens) {
              const protectedFrom = Math.max(0, messages.length - 6)
              const indexed = messages.map((m, idx) => ({ idx, len: (m.content || '').length, role: m.role }))
                .filter(e => e.role !== 'system' && e.len > 1000 && e.idx < protectedFrom)
                .sort((a, b) => b.len - a.len)
              const maxTotalChars = Math.floor(targetTokens * 4)
              let currentChars = messages.reduce((sum, m) => sum + (m.content || '').length, 0)
              for (const entry of indexed) {
                if (currentChars <= maxTotalChars) break
                const m = messages[entry.idx]
                const allowedChars = Math.max(800, Math.floor(maxTotalChars / messages.length))
                if (m.content.length > allowedChars) {
                  const oldLen = m.content.length
                  m.content = m.content.slice(0, allowedChars) + '\n\n[§TRIMMED§]'
                  currentChars -= (oldLen - m.content.length)
                }
              }
            }
            await new Promise(r => setTimeout(r, 1000))
            continue
          }
          // Last-resort 413 handler: all 8 attempts exhausted — nuclear trim.
          // Keep only system prompt + user message + last 2 tool results, then
          // surface a friendly message instead of crashing with raw JSON.
          if (isPromptTooLarge) {
            this.send('qwen-event', { type: 'system', subtype: 'debug', data: 'HTTP 413: all trim attempts exhausted — applying nuclear context reset' })
            const sysMsg = messages.find(m => m.role === 'system')
            const userMsg = messages.find(m => m.role === 'user')
            const lastToolMsgs = messages.filter(m => m.role === 'tool').slice(-2)
            messages.length = 0
            if (sysMsg) messages.push(sysMsg)
            if (userMsg) messages.push(userMsg)
            messages.push(...lastToolMsgs)
            messages.push({
              role: 'system',
              content: 'CONTEXT RESET: The conversation history was too large and had to be cleared. Summarize what you have done so far based on the tool results above, then continue working on the original task. Be concise — avoid large outputs.',
            })
            this.send('qwen-event', {
              type: 'system', subtype: 'warning',
              data: '⚠️ Context was too large and had to be reset. The agent will continue from a summary. Some history may be lost.',
            })
            continue
          }
          // SSE mid-stream errors are transient (server OOM during generation)
          const isSseError = /SSE error from server/.test(msg)
          if ((isTransient || isServerError || isSseError) && attempt < 7) {
            const reason = isServerError ? msg.match(/HTTP \d+/)?.[0] || 'server error' : code
            // If the error is "No model loaded" (503), wait for the model to
            // actually be loaded before retrying. This prevents all concurrent
            // agents from hammering the server with 503-producing requests
            // during crash recovery.
            const isNoModel = /No model loaded/i.test(msg)
            if (isNoModel) {
              this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Model not loaded — polling /admin/status until ready... (${attempt + 1}/7)` })
              const modelReady = await this._waitForModelReady(60)
              if (this._aborted) return
              if (!modelReady) {
                this.send('qwen-event', { type: 'system', subtype: 'debug', data: 'Model still not loaded after 60s — retrying anyway' })
              }
              // Add a small stagger (0-3s) so concurrent agents don't all hit
              // the server at the exact same instant after model loads
              const jitter = Math.floor(Math.random() * 3000)
              await new Promise(r => setTimeout(r, jitter))
              continue
            }
            // Backoff schedule designed to survive a full crash+restart+model-reload cycle:
            // attempt 0→1: 5s, 1→2: 8s, 2→3: 12s, 3→4: 15s, 4→5: 20s, 5→6: 25s, 6→7: 30s
            // Total max wait: ~115s — enough for 5s crash delay + server start + model reload
            // For ECONNREFUSED/ECONNRESET (server down or crashed mid-stream),
            // poll for model readiness instead of blind backoff — the server may
            // take variable time to restart + reload. This applies from attempt 0
            // since SIGABRT recovery (6s cooldown + server start + model reload)
            // always exceeds the initial 5s backoff.
            if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
              this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Server ${code === 'ECONNREFUSED' ? 'down' : 'crashed mid-stream'} (${code}) — waiting for model to be ready... (${attempt + 1}/7)` })
              const modelReady = await this._waitForModelReady(90)
              if (this._aborted) return
              if (modelReady) {
                const jitter = Math.floor(Math.random() * 3000)
                await new Promise(r => setTimeout(r, jitter))
                continue
              }
              // Fall through to fixed backoff if model didn't come back
            }
            const delay = attempt < 2 ? 5 + attempt * 3 : Math.min(12 + (attempt - 2) * 5, 30)
            this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Server not ready (${reason}), retrying in ${delay}s... (${attempt + 1}/7)` })
            // Sleep in 1s increments so we can check _aborted
            for (let w = 0; w < delay && !this._aborted; w++) {
              await new Promise(r => setTimeout(r, 1000))
            }
            if (this._aborted) return
            continue
          }
          throw err
        }
      }

      const { text: rawText, toolCalls, usage, finishReason, reasoningContent } = completion

      // ── Injection interrupt: skip tool execution, go straight to next turn ──
      // When inject() destroyed the active request, the completion is empty.
      // Skip all processing and loop back so the injection is drained immediately.
      if (finishReason === 'interrupted') {
        continue
      }

      // ── Adaptive max_tokens adjustment ───────────────────────────────────
      // If the model was truncated (finish_reason 'length'), step up the budget
      // so the next turn has more room. On clean stops, decay back toward the
      // baseline floor so we don't permanently inflate KV cache allocation.
      if (finishReason === 'length') {
        const prev = this._adaptiveMaxTokens
        this._adaptiveMaxTokens = Math.min(
          this._adaptiveMaxTokensCeil,
          Math.round(this._adaptiveMaxTokens * 1.5)
        )
        this._adaptiveCleanTurns = 0
        if (this._adaptiveMaxTokens !== prev) {
          this.send('qwen-event', { type: 'system', subtype: 'debug',
            data: `[adaptive] max_tokens bumped ${prev} → ${this._adaptiveMaxTokens} (truncation detected)` })
        }
      } else if (finishReason === 'stop' || finishReason === 'tool_calls') {
        this._adaptiveCleanTurns++
        // After 3 consecutive clean turns, step back down toward the floor
        if (this._adaptiveCleanTurns >= 3 && this._adaptiveMaxTokens > this._adaptiveMaxTokensFloor) {
          const prev = this._adaptiveMaxTokens
          // Decay by 25% per 3-turn window, floor at baseline
          this._adaptiveMaxTokens = Math.max(
            this._adaptiveMaxTokensFloor,
            Math.round(this._adaptiveMaxTokens * 0.75)
          )
          this._adaptiveCleanTurns = 0
          if (this._adaptiveMaxTokens !== prev) {
            this.send('qwen-event', { type: 'system', subtype: 'debug',
              data: `[adaptive] max_tokens decayed ${prev} → ${this._adaptiveMaxTokens} (3 clean turns)` })
          }
        }
      }
      // The model sometimes generates text like "[Response interrupted by ...]"
      // or "[Summarized by ...]" by mimicking injected annotations it sees in context.
      // These confuse users — strip them. Real interruptions are handled by abort.
      // IMPORTANT: keep this specific — do NOT use /\[Response [^\]]*\]/ as that
      // would strip legitimate model output like "[Response: ...]".
      const HALLUCINATED_ANNOTATIONS = /\[Response interrupted[^\]]*\]|\[Response trimmed[^\]]*\]|\[Summarized by[^\]]*\]|\[TRIMMED[^\]]*\]|\[§TRIMMED§[^\]]*\]|\[compressed:\s*\d+%[^\]]*\]/g
      let text = rawText ? rawText.replace(HALLUCINATED_ANNOTATIONS, '').trim() : rawText

      // ── Client-side thinking extraction ─────────────────────────────────
      // If the server didn't separate reasoning_content (e.g. non-streaming
      // fallback or older server), extract <think>...</think> from the text
      // and preserve it so the Jinja template can maintain chain-of-thought.
      let _reasoningContent = reasoningContent || null
      if (text) {
        const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/)
        if (thinkMatch) {
          if (!_reasoningContent) {
            _reasoningContent = thinkMatch[1].trim() || null
          }
          text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        }
        // Handle unclosed think block (model hit max_tokens mid-think)
        const unclosedMatch = text.match(/^<think>([\s\S]*)$/)
        if (unclosedMatch) {
          if (!_reasoningContent) {
            _reasoningContent = unclosedMatch[1].trim() || null
          }
          text = ''
        }
      }

      // Send usage stats
      if (usage) {
        this.send('qwen-event', {
          type: 'raw-stream',
          event: {
            usage: {
              prompt_tokens: usage.prompt_tokens || 0,
              completion_tokens: usage.completion_tokens || 0,
            },
            x_stats: {
              prompt_tps: usage.prompt_tps || 0,
              generation_tps: usage.generation_tps || 0,
              peak_memory_gb: usage.peak_memory_gb || 0,
            },
          },
        })
      }

      // ── Memory: post-turn async fact extraction ───────────────────────────
      // Fire-and-forget extraction — must not block the agent loop
      if (memoryClient && text && text.length > 0) {
        const _extractAgentRole = this._agentRole || 'main-agent'
        const _extractSelf = this
        memoryClient.extractTurn(text, _extractAgentRole, _sessionId)
          .then((result) => {
            // Notify the UI which model performed extraction
            if (result && result.llm_extraction_queued) {
              // Check extraction source after a short delay (LLM extraction is async)
              setTimeout(() => {
                memoryClient.getStatus().then(status => {
                  if (status) {
                    const src = status.extractionModel ? `🧠 Memory: extracting facts via ${status.extractionModel}` : '🧠 Memory: extracting facts via primary model'
                    _extractSelf.send('qwen-event', { type: 'memory-extract', source: status.extractionModel || 'primary_model', message: src })
                  }
                }).catch(() => {})
              }, 500)
            }
          })
          .catch(() => {})
      }

      // ── Memory: archive assistant decisions ───────────────────────────────
      if (memoryClient && text && text.length > 50) {
        const summary = text.slice(0, 200)
        memoryClient.archiveRecord('decision', text, summary, {
          agentName: this._agentRole || 'main-agent',
          sessionId: _sessionId,
          projectId: path.basename(cwd),
        }).catch(() => {})
      }

      // Guard: empty completion — server returned nothing (0 tokens, no text, no tools).
      // This can happen when the prompt is too large for the model or the server
      // returned an error as a non-SSE response. Retry once with trimmed context,
      // then fail gracefully instead of silently finishing.
      if (!text && (!toolCalls || toolCalls.length === 0) && !usage) {
        // Special case: the model generated only hallucinated system annotations
        // (e.g. "[Response interrupted by edit_files]") which were stripped to empty.
        // rawText is non-empty but text is empty — the model was mimicking an
        // interruption marker it saw in its context. Inject a nudge to continue
        // rather than treating this as a server error.
        if (rawText && rawText.trim().length > 0) {
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: '⚠️ Model generated only hallucinated annotations — injecting continuation nudge' })
          _annotationNudgeCount++
          if (_annotationNudgeCount >= 3) {
            // Model is stuck generating only annotations — stop nudging and let it fail gracefully
            _annotationNudgeCount = 0
            this.send('qwen-event', { type: 'result', subtype: 'error', is_error: true, result: '⚠️ The model kept generating system annotation markers instead of a real response. Try starting a new session or rephrasing your request.' })
            return
          }
          messages.push({
            role: 'system',
            content: 'IMPORTANT: Do NOT generate text like "[Response interrupted by ...]", "[Response trimmed for context space]", or "[Summarized by ...]" — these are system markers, not part of your output. Your last response was stripped entirely because it contained only these markers. Continue your work: call the appropriate tool (write_file, edit_file, bash, etc.) to make progress on the task.',
          })
          continue
        }

        if (turn === 0 && messages.length >= 2) {
          // First turn empty — likely oversized prompt from conversation history.
          // Trim the user message if it contains a conversation transcript.
          const userMsg = messages[messages.length - 1]
          if (userMsg && userMsg.role === 'user' && userMsg.content && userMsg.content.length > 4000) {
            const sepIdx = userMsg.content.lastIndexOf('---\n\n')
            if (sepIdx > 0) {
              // Keep only the part after the separator (the actual prompt)
              const actualPrompt = userMsg.content.slice(sepIdx + 5)
              userMsg.content = actualPrompt
              this.send('qwen-event', { type: 'system', subtype: 'debug', data: 'Empty response — trimmed conversation history and retrying...' })
              continue
            }
          }
        }
        this.send('qwen-event', {
          type: 'result',
          subtype: 'error',
          is_error: true,
          result: '⚠️ Server returned an empty response. This usually means the prompt is too large for the model. You can:\n• Start a new session to clear conversation history\n• Shorten your message\n• Try a model with a larger context window',
        })
        return
      }

      // No tool calls — check if we hit the token limit
      if (!toolCalls || toolCalls.length === 0) {
        // If text is empty after stripping hallucinated annotations (but rawText had content),
        // inject a nudge to continue rather than falling through to the text-only handler.
        if (!text && rawText && rawText.trim().length > 0) {
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: '⚠️ Model generated only hallucinated annotations (with usage) — injecting continuation nudge' })
          _annotationNudgeCount++
          if (_annotationNudgeCount >= 3) {
            _annotationNudgeCount = 0
            this.send('qwen-event', { type: 'result', subtype: 'error', is_error: true, result: '⚠️ The model kept generating system annotation markers instead of a real response. Try starting a new session or rephrasing your request.' })
            return
          }
          messages.push({
            role: 'system',
            content: 'IMPORTANT: Do NOT generate text like "[Response interrupted by ...]", "[Response trimmed for context space]", or "[Summarized by ...]" — these are system markers, not part of your output. Your last response was stripped entirely because it contained only these markers. Continue your work: call the appropriate tool (write_file, edit_file, bash, etc.) to make progress on the task.',
          })
          continue
        }

        // If the model hit the token limit, it may have been trying to output
        // code as text instead of using write_file. Nudge it to use tools.
        if (finishReason === 'length' && text && text.length > 200) {
          // Check if this is a repetition of previous length-truncated output
          lastTextResponses.push(text.slice(0, 500))
          if (lastTextResponses.length > 3) lastTextResponses.shift()
          const prevSimilar = lastTextResponses.length >= 2 &&
            lastTextResponses[lastTextResponses.length - 2].slice(0, 200) === lastTextResponses[lastTextResponses.length - 1].slice(0, 200)

          if (prevSimilar) {
            // Model is stuck generating the same long text repeatedly
            this.send('qwen-event', { type: 'system', subtype: 'debug', data: 'Repetition detected in length-truncated output. Resetting context.' })
            // Aggressive context reset — keep only essentials
            const systemMsg = messages.find(m => m.role === 'system')
            const userMsg = messages.find(m => m.role === 'user')
            messages.length = 0
            if (systemMsg) messages.push(systemMsg)
            if (userMsg) messages.push(userMsg)
            messages.push({
              role: 'system',
              content: 'You are STUCK generating the same text repeatedly. STOP outputting text. You MUST use a tool call in your next response. Call write_file, edit_file, read_file, or bash. Do NOT output any text — only a tool call.',
            })
            lastTextResponses = []
            continue
          }

          messages.push(_buildAssistantMsg(text, _reasoningContent))
          messages.push({
            role: 'system',
            content: 'STOP. You were outputting code as text which is not allowed. You MUST use tools instead:\n- Use write_file to create or overwrite files\n- Use edit_file to make surgical edits\n- For files with complex template literals or backticks, use bash with heredoc: bash({command: "cat > file << \'EOF\'\\n...\\nEOF"})\nNever output code blocks in your text response. Use one tool call at a time.',
          })
          continue
        }

        // Detect code blocks in text output — model is writing code as text
        // instead of using write_file/edit_file tools. Nudge it to use tools.
        const codeBlockPattern = /```[\w]*\n[\s\S]{200,}/
        if (text && codeBlockPattern.test(text) && turn < maxTurns - 1) {
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: 'Code block detected in text output — nudging model to use file tools' })
          messages.push(_buildAssistantMsg(text, _reasoningContent))
          messages.push({
            role: 'system',
            content: 'STOP. You just output a code block as text. The user CANNOT copy-paste from chat. You MUST use write_file or edit_file tools to create/modify files. Take the code you just wrote and call write_file NOW to save it to a file. Do NOT repeat the code as text.',
          })
          continue
        }

        // If the model described what it plans to do but didn't actually do it,
        // nudge it to take action. Look for planning language without tool calls.
        // On turn 0, allow a brief acknowledgment but still nudge if it contains
        // clear planning language indicating more work is needed.
        const planningPatterns = /\b(let me|i('ll| will)|let's|i need to|i should|first.*then|i'm going to|i'll start|starting now)\b/i
        if (text && text.length > 50 && planningPatterns.test(text) && turn < maxTurns - 1) {
          // On turn 0, only nudge if the text is clearly planning (not just a brief answer)
          // UNLESS the agent is in a task-oriented role — then always nudge.
          const _isTaskOriented = this._agentRole && this._agentRole !== 'general' && this._agentRole !== 'explore'
          if (turn === 0 && text.length < 200 && !text.includes('Let me') && !_isTaskOriented) {
            // Short acknowledgment on turn 0 — let it through as final response
          } else {
          consecutivePlanningNudges++

          // Repetition detection: check if the model is producing similar text
          // across consecutive turns (stuck in a loop)
          lastTextResponses.push(text.slice(0, 500))
          if (lastTextResponses.length > 3) lastTextResponses.shift()

          const isRepeating = lastTextResponses.length >= 2 && (() => {
            const prev = lastTextResponses[lastTextResponses.length - 2]
            const curr = lastTextResponses[lastTextResponses.length - 1]
            // Check for high similarity: same first 200 chars or >60% overlap
            if (prev.slice(0, 200) === curr.slice(0, 200)) return true
            const words = new Set(prev.toLowerCase().split(/\s+/))
            const currWords = curr.toLowerCase().split(/\s+/)
            const overlap = currWords.filter(w => words.has(w)).length
            return currWords.length > 0 && (overlap / currWords.length) > 0.6
          })()

          if (isRepeating || consecutivePlanningNudges >= 3) {
            // Model is stuck in a repetition loop — take aggressive corrective action
            this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Repetition detected (${consecutivePlanningNudges} planning-only turns). Breaking loop.` })

            // Inform the user
            this.send('qwen-event', {
              type: 'system', subtype: 'warning',
              data: '⚠️ The agent is stuck in a loop — it keeps describing what it plans to do without acting. Resetting context and forcing tool use. If this persists, try:\n• Sending a more specific instruction (e.g. "edit file X, change Y to Z")\n• Starting a new session\n• Breaking the task into smaller steps',
            })

            // Strip all previous planning messages and nudges to reset context
            const cleanedMessages = messages.filter(m =>
              !(m.role === 'system' && m.content && m.content.includes('Use your tools NOW')) &&
              !(m.role === 'system' && m.content && m.content.includes('You are STUCK'))
            )
            // Keep only system prompt + user prompt + last tool result (if any)
            const systemMsg = cleanedMessages.find(m => m.role === 'system')
            const userMsg = cleanedMessages.find(m => m.role === 'user')
            const lastToolResult = [...cleanedMessages].reverse().find(m => m.role === 'tool')
            const lastAssistantWithTools = [...cleanedMessages].reverse().find(m => m.role === 'assistant' && m.tool_calls)

            messages.length = 0
            if (systemMsg) messages.push(systemMsg)
            if (userMsg) messages.push(userMsg)
            if (lastAssistantWithTools && lastToolResult) {
              messages.push(lastAssistantWithTools)
              messages.push(lastToolResult)
            }
            messages.push({
              role: 'system',
              content: 'You are STUCK in a repetition loop. STOP planning and describing. You MUST call a tool RIGHT NOW in your very next response. Pick the single most important action and do it. If you need to read a file, call read_file. If you need to write code, call write_file. Do NOT output any text — only a tool call.',
            })
            consecutivePlanningNudges = 0
            lastTextResponses = []
            continue
          }

          messages.push(_buildAssistantMsg(text, _reasoningContent))
          messages.push({
            role: 'system',
            content: 'You described what you plan to do but did not take action. Use your tools NOW. Call read_file, edit_file, write_file, or bash to actually do the work. Do not just describe — act.',
          })
          continue
          }
        }

        // Assist-based repetition detection — await to prevent concurrent Metal inference
        if (assistClient && text) {
          lastTextResponses.push(text.slice(0, 500))
          if (lastTextResponses.length > 3) lastTextResponses.shift()
          if (lastTextResponses.length >= 2) {
            const _responsesSnapshot = [...lastTextResponses]
            const _turnAtDetection = turn
            try {
              const result = await assistClient.assistDetectRepetition(_responsesSnapshot)
              if (result && result.repeating && turn === _turnAtDetection) {
                messages.push({ role: 'system', content: `[Repetition detected: ${result.reason || 'semantic loop'}] Please take a different approach or use a tool to make progress.` })
              }
            } catch (_) {}
          }
        }

        // ── Text-only response: the model did NOT use any tools ──
        // Instead of treating this as "done", nudge the model to use tools.
        // The ONLY way to properly end a session is via the task_complete tool.
        // This prevents premature stops where the model just describes what it
        // plans to do (or did) without actually finishing.

        // Exception: if this is a simple Q&A (no tools ever used, short answer),
        // allow it through as a final response.
        // BUT: if the response contains planning language ("I'll", "let me",
        // "first", etc.) the model intends to act — nudge it to use tools
        // instead of stopping prematurely. This catches the case where
        // speculative decoding or other factors cause the model to emit only
        // a planning sentence without following through with a tool call.
        const hasToolHistory = messages.some(m => m.role === 'tool')
        if (!hasToolHistory && turn === 0) {
          const planningRe = /\b(i('ll| will)|let me|let's|i need to|i should|first.*then|i'm going to|i'll start|starting now|here's what|here is what)\b/i
          const isPlanning = text && text.length > 10 && planningRe.test(text)
          const isTaskRole = this._agentRole && this._agentRole !== 'general' && this._agentRole !== 'explore'
          if (!isPlanning && !isTaskRole) {
            // Pure Q&A — no tools used at all, first turn, no planning intent.
            this.send('qwen-event', {
              type: 'result',
              subtype: 'success',
              is_error: false,
              result: text,
            })
            return
          }
          // Model described its plan but didn't act — fall through to the
          // nudge logic below which will push it to use tools.
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: 'Turn 0 text-only with planning intent — nudging to use tools' })
        }

        // Check incomplete todos
        if (_lastTodos && _lastTodos.length > 0) {
          const incomplete = _lastTodos.filter(t => t.status !== 'done' && t.status !== 'completed')
          if (incomplete.length > 0) {
            const remaining = incomplete.map(t => t.content || t.text || t.label || t.title || 'unnamed').join(', ')
            this.send('qwen-event', { type: 'system', subtype: 'debug', data: `${incomplete.length} todo items still incomplete` })
            messages.push(_buildAssistantMsg(text, _reasoningContent))
            messages.push({
              role: 'system',
              content: `You have ${incomplete.length} incomplete todo items: ${remaining}. Continue working. When ALL items are done, call task_complete with a summary.`,
            })
            continue
          }
        }

        // After many consecutive text-only turns, allow completion as a safety valve
        _textOnlyTurns = (_textOnlyTurns || 0) + 1
        if (_textOnlyTurns >= 5) {
          // Model has given 5 text-only responses in a row — it's probably done
          // or stuck. Let it through rather than looping forever.
          this.send('qwen-event', {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: text,
          })
          return
        }

        // Nudge the model to use tools or call task_complete
        messages.push(_buildAssistantMsg(text, _reasoningContent))
        const todoStatus = _lastTodos
          ? `\nYour todo list: ${_lastTodos.filter(t => t.status === 'done' || t.status === 'completed').length}/${_lastTodos.length} complete.`
          : '\nYou have NOT created a todo list yet — call update_todos first.'

        // If the model has been reading files, it should now write
        const hasReads = messages.some(m => m.role === 'tool' && m.content && m.content.includes('── '))
        const hasWrites = messages.some(m => m.role === 'tool' && m.content && (m.content.startsWith('Wrote ') || m.content.startsWith('Edited ')))
        const readButNoWrite = hasReads && !hasWrites
        const writeNudge = readButNoWrite
          ? '\n\nYou have READ files but NOT WRITTEN anything yet. You MUST write code now. Call write_file to create the file you need.'
          : ''

        messages.push({
          role: 'system',
          content: `REJECTED: Text-only responses are not allowed. You must use a tool.${todoStatus}${writeNudge}\n\nOptions:\n- If NOT done: call a tool (read_file, write_file, edit_file, bash, browser_navigate, etc.)\n- If you haven't made a todo list: call update_todos\n- If ALL work is complete: call task_complete({"summary": "what you did"})`,
        })
        continue
      }

      // Check for truncated tool calls — model hit token limit mid-tool-call
      // The arguments JSON will be incomplete and unparseable.
      if (finishReason === 'length' && toolCalls && toolCalls.length > 0) {
        // Check if any tool call has truncated (unparseable) arguments
        let hasTruncated = false
        for (const tc of toolCalls) {
          try { JSON.parse(tc.function.arguments) } catch {
            // Try repair before declaring truncated
            const repaired = repairJSON(tc.function.arguments)
            if (repaired) {
              tc.function.arguments = JSON.stringify(repaired)
            } else if (tc.function.name === 'write_file') {
              // For write_file, try direct extraction — content may be truncated but usable
              const extracted = extractWriteFileArgs(tc.function.arguments)
              if (extracted) {
                tc.function.arguments = JSON.stringify(extracted)
                this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Recovered truncated write_file (${extracted.content.length} chars)` })
              } else {
                hasTruncated = true; break
              }
            } else {
              hasTruncated = true; break
            }
          }
        }
        if (hasTruncated) {
          // Don't try to execute truncated tool calls — tell the model to break it up
          messages.push(_buildAssistantMsg(text || 'I was writing a file but hit the output limit.', _reasoningContent))
          messages.push({
            role: 'system',
            content: 'Your write_file tool call was TRUNCATED — the file was NOT written. The output token limit was hit mid-write. Try one of these:\n1. Write the file using bash with heredoc: bash({command: "cat > filepath << \'FILEEOF\'\\n...all content...\\nFILEEOF"})\n2. Or split into two write_file calls — first half, then use bash to append the rest.\nDo this NOW.',
          })
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: 'Tool call truncated — asking model to write in chunks' })
          continue
        }
      }

      // Add assistant message with tool_calls to history
      const assistantMsg = { role: 'assistant', content: text || null }
      // Preserve reasoning_content so the Jinja template can render the model's
      // chain-of-thought in conversation history. Without this, the model loses
      // its reasoning between tool loop iterations and re-derives conclusions
      // from scratch (manifesting as re-read loops).
      if (_reasoningContent) {
        assistantMsg.reasoning_content = _reasoningContent
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map(tc => {
          // Parse arguments from JSON string to object so the Jinja chat template
          // can iterate over them. The template checks `arguments is mapping` —
          // if arguments is a string, no parameters are rendered in the history,
          // causing the model to learn that tool calls don't need parameters.
          let parsedArgs = tc.function.arguments
          try {
            const parsed = JSON.parse(tc.function.arguments)
            if (parsed && typeof parsed === 'object') parsedArgs = parsed
          } catch { /* keep as string if parse fails */ }
          return {
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: parsedArgs },
          }
        })
      }
      messages.push(assistantMsg)

      // ── Performance: auto-coalesce multiple read_file into read_files ───
      // When the model returns 2+ read_file calls in one turn, merge them
      // into a single read_files call. This saves N-1 tool result round-trips
      // and is much faster than processing each read_file sequentially.
      if (toolCalls.length >= 2) {
        const readFileCalls = toolCalls.filter(tc => tc.function.name === 'read_file')
        if (readFileCalls.length >= 2) {
          // Check that all are simple reads (no line ranges — those need individual handling)
          const simpleReads = readFileCalls.filter(tc => {
            try {
              const a = JSON.parse(tc.function.arguments)
              return a.path && a.start_line == null && a.end_line == null
            } catch { return false }
          })
          if (simpleReads.length >= 2) {
            const paths = simpleReads.map(tc => {
              try { return JSON.parse(tc.function.arguments).path } catch { return null }
            }).filter(Boolean)

            this.send('qwen-event', { type: 'system', subtype: 'debug', data: `⚡ Auto-coalescing ${simpleReads.length} read_file calls into read_files(${paths.length} files)` })

            // Execute the batch read
            const batchResult = await executeTool(
              'read_files', { paths }, cwd,
              this._browserInstance, this._lspManager, this._inputRequester,
              { send: this.send.bind(this), _sessionId }
            )

            // Feed back results for each original tool call
            const batchContent = batchResult.error || batchResult.result || ''
            for (const tc of simpleReads) {
              let tcPath
              try { tcPath = JSON.parse(tc.function.arguments).path } catch { tcPath = '?' }
              // Extract this file's section from the batch result
              const fileHeader = `── ${tcPath} `
              const headerIdx = batchContent.indexOf(fileHeader)
              let fileContent
              if (headerIdx >= 0) {
                // Find the next file header or end of string
                const nextHeader = batchContent.indexOf('\n\n── ', headerIdx + fileHeader.length)
                fileContent = nextHeader >= 0
                  ? batchContent.slice(headerIdx, nextHeader)
                  : batchContent.slice(headerIdx)
              } else {
                // Couldn't extract — give the full batch result to the first call,
                // and a reference note to the rest
                fileContent = batchResult.error
                  ? `Error reading ${tcPath}: ${batchResult.error}`
                  : `(included in batch read above)`
              }

              this.send('qwen-event', {
                type: 'tool-result',
                tool_use_id: tc.id,
                content: fileContent.slice(0, 200) + (fileContent.length > 200 ? '...' : ''),
                is_error: !!batchResult.error,
              })
              messages.push({ role: 'tool', tool_call_id: tc.id, content: fileContent })

              // Update read history
              if (!batchResult.error) {
                const lines = fileContent.split('\n')
                try {
                  const resolvedPath = path.resolve(cwd, tcPath.trim())
                  const mtime = fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath).mtimeMs : null
                  _readFileHistory.set(tcPath, { count: 1, lastTurn: turn, fullRead: true, totalLines: lines.length, mtime })
                } catch { /* ignore */ }
              }
            }

            // Track coalesced IDs so the normal processing loop skips them
            const coalescedIds = new Set(simpleReads.map(tc => tc.id))
            if (!this._coalescedToolCallIds) this._coalescedToolCallIds = new Set()
            for (const id of coalescedIds) this._coalescedToolCallIds.add(id)
          }
        }
      }

      // ── Performance: nudge consecutive single read_file turns ───────────
      // If the model keeps making one read_file per turn (not batching),
      // inject a reminder after 3 consecutive single-read turns.
      if (toolCalls.length === 1 && toolCalls[0].function.name === 'read_file') {
        _consecutiveSingleReads = (_consecutiveSingleReads || 0) + 1
        if (_consecutiveSingleReads >= 3) {
          messages.push({
            role: 'system',
            content: 'PERFORMANCE: You are reading files one at a time. Use read_files({"paths": ["file1", "file2", ...]}) to batch multiple reads into a single call. This is 5-10x faster.',
          })
          _consecutiveSingleReads = 0
        }
      } else {
        _consecutiveSingleReads = 0
      }

      // ── Performance: auto-coalesce multiple edit_file into edit_files ───
      // When the model returns 2+ edit_file calls in one turn, merge them
      // into a single edit_files call. Edits on the same file are applied
      // sequentially within the batch (order preserved).
      if (toolCalls.length >= 2) {
        const editFileCalls = toolCalls.filter(tc => tc.function.name === 'edit_file')
        if (editFileCalls.length >= 2) {
          const validEdits = editFileCalls.filter(tc => {
            try {
              const a = JSON.parse(tc.function.arguments)
              return a.path && typeof a.old_string === 'string' && typeof a.new_string === 'string'
            } catch { return false }
          })
          if (validEdits.length >= 2) {
            // All edits batch together — edit_files handles same-file edits sequentially
            const edits = validEdits.map(tc => {
              try { return JSON.parse(tc.function.arguments) } catch { return null }
            }).filter(Boolean)

            this.send('qwen-event', { type: 'system', subtype: 'debug', data: `⚡ Auto-coalescing ${validEdits.length} edit_file calls into edit_files(${edits.length} edits)` })

            const batchResult = await executeTool(
              'edit_files', { edits }, cwd,
              this._browserInstance, this._lspManager, this._inputRequester,
              { send: this.send.bind(this), _sessionId }
            )

            const resultContent = batchResult.error || batchResult.result || ''
            for (const tc of validEdits) {
              let tcPath
              try { tcPath = JSON.parse(tc.function.arguments).path } catch { tcPath = '?' }
              // Extract this edit's result line from the batch output
              const editLine = resultContent.split('\n').find(l => l.includes(tcPath)) || resultContent
              this.send('qwen-event', {
                type: 'tool-result',
                tool_use_id: tc.id,
                content: editLine.slice(0, 200),
                is_error: !!batchResult.error,
              })
              messages.push({ role: 'tool', tool_call_id: tc.id, content: editLine || `Edited ${tcPath}` })
            }

            // Track coalesced IDs
            for (const tc of validEdits) this._coalescedToolCallIds.add(tc.id)
          }
        }
      }

      // ── Performance: auto-coalesce multiple search_files into batch ─────
      // When the model returns 2+ search_files calls, merge their patterns
      // into a single call with the patterns array.
      if (toolCalls.length >= 2) {
        const searchCalls = toolCalls.filter(tc => tc.function.name === 'search_files')
        if (searchCalls.length >= 2) {
          const validSearches = searchCalls.filter(tc => {
            try {
              const a = JSON.parse(tc.function.arguments)
              return a.pattern || (a.patterns && a.patterns.length > 0)
            } catch { return false }
          })
          if (validSearches.length >= 2) {
            // Merge all patterns into one call
            const allPatterns = []
            let searchPath = '.'
            let searchInclude = null
            for (const tc of validSearches) {
              try {
                const a = JSON.parse(tc.function.arguments)
                if (a.patterns) allPatterns.push(...a.patterns)
                else if (a.pattern) allPatterns.push(a.pattern)
                if (a.path) searchPath = a.path
                if (a.include) searchInclude = a.include
              } catch { /* skip */ }
            }

            this.send('qwen-event', { type: 'system', subtype: 'debug', data: `⚡ Auto-coalescing ${validSearches.length} search_files into batch(${allPatterns.length} patterns)` })

            const batchArgs = { patterns: allPatterns, path: searchPath }
            if (searchInclude) batchArgs.include = searchInclude
            const batchResult = await executeTool(
              'search_files', batchArgs, cwd,
              this._browserInstance, this._lspManager, this._inputRequester,
              { send: this.send.bind(this), _sessionId }
            )

            const resultContent = batchResult.error || batchResult.result || ''
            // Feed back grouped results to each original call
            for (let i = 0; i < validSearches.length; i++) {
              const tc = validSearches[i]
              let tcPattern
              try {
                const a = JSON.parse(tc.function.arguments)
                tcPattern = a.pattern || (a.patterns && a.patterns[0]) || '?'
              } catch { tcPattern = '?' }
              // Extract this pattern's section from grouped output
              const sectionHeader = `── ${tcPattern} ──`
              const headerIdx = resultContent.indexOf(sectionHeader)
              let sectionContent
              if (headerIdx >= 0) {
                const nextSection = resultContent.indexOf('\n\n── ', headerIdx + sectionHeader.length)
                sectionContent = nextSection >= 0
                  ? resultContent.slice(headerIdx, nextSection)
                  : resultContent.slice(headerIdx)
              } else {
                // Single pattern result or couldn't split — give full result to first, reference to rest
                sectionContent = i === 0 ? resultContent : `(included in batch search above)`
              }
              this.send('qwen-event', {
                type: 'tool-result',
                tool_use_id: tc.id,
                content: sectionContent.slice(0, 200) + (sectionContent.length > 200 ? '...' : ''),
                is_error: !!batchResult.error,
              })
              messages.push({ role: 'tool', tool_call_id: tc.id, content: sectionContent })
            }
            for (const tc of validSearches) this._coalescedToolCallIds.add(tc.id)
          }
        }
      }

      // ── Performance: auto-coalesce multiple bash into bash_batch ────────
      // When the model returns 2+ bash calls in one turn, merge them into
      // a single bash_batch call for sequential execution without round-trips.
      if (toolCalls.length >= 2) {
        const bashCalls = toolCalls.filter(tc => tc.function.name === 'bash')
        if (bashCalls.length >= 2) {
          const validBash = bashCalls.filter(tc => {
            try {
              const a = JSON.parse(tc.function.arguments)
              return a.command && typeof a.command === 'string'
            } catch { return false }
          })
          if (validBash.length >= 2) {
            const commands = validBash.map(tc => {
              try { return JSON.parse(tc.function.arguments).command } catch { return null }
            }).filter(Boolean)

            this.send('qwen-event', { type: 'system', subtype: 'debug', data: `⚡ Auto-coalescing ${validBash.length} bash calls into bash_batch(${commands.length} commands)` })

            const batchResult = await executeTool(
              'bash_batch', { commands }, cwd,
              this._browserInstance, this._lspManager, this._inputRequester,
              { send: this.send.bind(this), _sessionId }
            )

            const resultContent = batchResult.error || batchResult.result || ''
            // Extract per-command results
            for (let i = 0; i < validBash.length; i++) {
              const tc = validBash[i]
              const cmd = commands[i] || '?'
              // Find this command's section in the output
              const cmdHeader = `── [${i + 1}] ${cmd} ──`
              const headerIdx = resultContent.indexOf(cmdHeader)
              let cmdContent
              if (headerIdx >= 0) {
                const nextCmd = resultContent.indexOf(`\n\n── [${i + 2}]`, headerIdx)
                cmdContent = nextCmd >= 0
                  ? resultContent.slice(headerIdx + cmdHeader.length, nextCmd).trim()
                  : resultContent.slice(headerIdx + cmdHeader.length).trim()
              } else {
                cmdContent = i === 0 ? resultContent : `(included in batch above)`
              }
              const isErr = cmdContent.includes('❌') || cmdContent.includes('Command failed')
              this.send('qwen-event', {
                type: 'tool-result',
                tool_use_id: tc.id,
                content: cmdContent.slice(0, 200) + (cmdContent.length > 200 ? '...' : ''),
                is_error: isErr,
              })
              messages.push({ role: 'tool', tool_call_id: tc.id, content: cmdContent })
            }
            for (const tc of validBash) this._coalescedToolCallIds.add(tc.id)
          }
        }
      }

      // ── Performance: parallel pre-fetch for read-only tools ─────────────
      // When the model returns read-only tool calls (read_file, search_files,
      // list_dir, web_search, ast_search, lsp_*), execute the actual I/O in
      // parallel before the sequential processing loop. Results are cached
      // in a Map and looked up during the normal loop, avoiding redundant I/O.
      //
      // Mixed turns (2 reads + 1 write) also win here — the reads are fired
      // while the write still has to go through its own side-effect path
      // (post-write cache, LSP deferred, etc.), so by the time the loop
      // reaches the reads they're already resolved.
      const PREFETCH_TOOLS = new Set([
        'read_file', 'read_files', 'search_files', 'list_dir',
        'web_search', 'web_fetch',
        'ast_search', 'undo_list',
        'lsp_get_document_symbols', 'lsp_get_hover', 'lsp_get_definition',
        'lsp_get_references', 'lsp_get_type_definition',
        'lsp_workspace_symbol', 'lsp_get_call_hierarchy',
        'lsp_get_diagnostics',
      ])
      const _prefetchResults = new Map()  // tc.id → Promise<result>
      // Prefetch whenever we have at least one eligible read in a multi-tool
      // turn, OR a single read that can overlap with downstream per-tool
      // housekeeping. No downside — the executeTool promise just sits in the
      // map until the serial loop awaits it.
      if (toolCalls.length >= 1) {
        const prefetchable = toolCalls.filter(tc => {
          // Skip calls the earlier auto-coalescers already handled — those
          // IDs now resolve via the _coalescedToolCallIds path in the loop.
          if (this._coalescedToolCallIds?.has(tc.id)) return false
          try {
            const args = JSON.parse(tc.function.arguments)
            return PREFETCH_TOOLS.has(tc.function.name) && args
          } catch { return false }
        })
        // Only worth firing when there's more than one tool call in the turn
        // (otherwise the serial loop runs the same executeTool directly with
        // no extra overhead).
        if (prefetchable.length >= 1 && toolCalls.length > 1) {
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: `⚡ Parallel pre-fetch: ${prefetchable.length} read-only tool(s) of ${toolCalls.length} total` })
          for (const tc of prefetchable) {
            let args
            try { args = JSON.parse(tc.function.arguments) } catch { continue }
            _prefetchResults.set(tc.id, executeTool(
              tc.function.name, args, cwd,
              this._browserInstance, this._lspManager, this._inputRequester,
              { send: this.send.bind(this), _sessionId }
            ))
          }
        }
      }

      // Execute each tool call
      for (const tc of toolCalls) {
        if (this._aborted) return

        // Skip tool calls that were already handled by auto-coalescing
        if (this._coalescedToolCallIds && this._coalescedToolCallIds.has(tc.id)) {
          this._coalescedToolCallIds.delete(tc.id)
          continue
        }

        const fnName = tc.function.name

        // ── Pre-flight: block excessive reads when no writes have happened ──
        // If the model is trying to read 10+ files and hasn't written anything
        // yet, it's gathering context it doesn't need. For file CREATION tasks,
        // the file tree is sufficient. Intercept and tell it to write.
        // Exempt: reads of files the agent has already tried (and failed) to edit.
        if ((fnName === 'read_files' || fnName === 'read_file') && consecutiveReadsWithoutWrite >= 8) {
          // Skip this check entirely if reading a file we already tried to edit
          let _preflightArgs = {}
          try { _preflightArgs = JSON.parse(tc.function.arguments) } catch { /* ignore — parsed properly below */ }
          const _preflightPath = fnName === 'read_file' && _preflightArgs.path
          const _isEditTargetRead = _preflightPath && (_lastFailedEditPath === _preflightArgs.path || _editAttemptedPaths.has(_preflightArgs.path))
          if (!_isEditTargetRead) {
          const hasAnyWrites = messages.some(m => m.role === 'tool' && m.content &&
            (m.content.startsWith('Wrote ') || m.content.startsWith('Edited ') || m.content.includes('edits applied')))
          if (!hasAnyWrites && fnName === 'read_files') {
            try {
              const readArgs = JSON.parse(tc.function.arguments)
              if (Array.isArray(readArgs.paths) && readArgs.paths.length >= 8) {
                this.send('qwen-event', { type: 'system', subtype: 'warning',
                  data: `⚠️ Blocked bulk read of ${readArgs.paths.length} files — agent has read ${consecutiveReadsWithoutWrite} times without writing. Forcing write action.` })
                const interceptMsg = `BLOCKED: You are trying to read ${readArgs.paths.length} files but you have NOT written anything yet. ` +
                  `You already have the file tree showing all paths. For CREATING a new file, you do NOT need to read existing file contents. ` +
                  `Call write_file NOW to create the file. Use the file paths from the tree above.`
                this.send('qwen-event', { type: 'tool-result', tool_use_id: tc.id, content: interceptMsg, is_error: true })
                messages.push({ role: 'tool', tool_call_id: tc.id, content: interceptMsg })
                consecutiveReadsWithoutWrite = 0
                continue
              }
            } catch { /* parse failed — let it through */ }
          }
          } // end !_isEditTargetRead
        }

        // Update badge when agent shifts to writing code
        const _writeTools = new Set(['write_file', 'edit_file', 'edit_file_lines'])
        const _inferredRole = _writeTools.has(fnName) ? 'implementation' : null
        if (_inferredRole && _inferredRole !== this._agentRole) {
          this._agentRole = _inferredRole
          this.send('qwen-event', { type: 'agent-type', agentType: _inferredRole })
        }

        let fnArgs = {}
        // ── Enhanced repair: try constrained-decoder first ────────────────
        // Handles key renames (args→arguments, tool→name), markdown fences,
        // single quotes, trailing commas, type coercion, and schema validation.
        // Falls through to existing logic if this fails.
        if (constrainedDecoder) {
          try {
            const toolDefs = getToolDefs(this._lspManager, this._agentRole, null)
            const repair = constrainedDecoder.repairAndValidate(
              { function: { name: fnName, arguments: tc.function.arguments } },
              toolDefs
            )
            if (repair.valid) {
              const parsed = JSON.parse(repair.repaired.function.arguments)
              if (repair.issues.length > 0) {
                this.send('qwen-event', { type: 'system', subtype: 'debug',
                  data: `constrained-decoder repaired ${fnName}: ${repair.issues.join(', ')}` })
              }
              fnArgs = parsed
              // Skip downstream parse — we have valid args already
              tc.function.arguments = repair.repaired.function.arguments
            }
          } catch (_) { /* fall through to existing logic */ }
        }
        // ── Existing JSON parse + repair chain (unchanged) ─────────────────
        if (Object.keys(fnArgs).length === 0) try { fnArgs = JSON.parse(tc.function.arguments) } catch (parseErr) {
          const raw = tc.function.arguments || ''

          // Strategy 1: For write_file, extract path and content directly from raw string
          // This bypasses JSON entirely and handles unescaped code content
          if (fnName === 'write_file') {
            const extracted = extractWriteFileArgs(raw)
            if (extracted) {
              fnArgs = extracted
              this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Extracted write_file args directly (bypassed JSON)` })
            } else {
              // Try repairJSON as fallback
              const repaired = repairJSON(raw)
              if (repaired && typeof repaired === 'object' && repaired.path) {
                fnArgs = repaired
                this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Repaired malformed JSON in write_file` })
              } else {
                const guidance = 'Your file content broke JSON serialization. Use the bash tool with heredoc instead:\nbash({command: "cat > filepath << \'FILEEOF\'\\n...content...\\nFILEEOF"})'
                this.send('qwen-event', { type: 'tool-result', tool_use_id: tc.id, content: guidance, is_error: true })
                messages.push({ role: 'tool', tool_call_id: tc.id, content: guidance })
                continue
              }
            }
          } else if (fnName === 'edit_file') {
            // Strategy 2: For edit_file, try extractEditFileArgs
            const extracted = extractEditFileArgs(raw)
            if (extracted) {
              fnArgs = extracted
              this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Extracted edit_file args from malformed JSON` })
            } else {
              const guidance = 'Your edit_file content broke JSON serialization. Use the bash tool with sed or heredoc instead.'
              this.send('qwen-event', { type: 'tool-result', tool_use_id: tc.id, content: guidance, is_error: true })
              messages.push({ role: 'tool', tool_call_id: tc.id, content: guidance })
              continue
            }
          } else {
            // Strategy 3: For other tools, try repairJSON then split-objects
            const repaired = repairJSON(raw)
            if (repaired && typeof repaired === 'object') {
              fnArgs = repaired
              this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Repaired malformed JSON in ${fnName} tool call` })
            } else {
              const splitObjects = raw.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)
              if (splitObjects && splitObjects.length > 1) {
                let parsed = false
                for (const obj of splitObjects) {
                  const fixed = repairJSON(obj)
                  if (fixed && typeof fixed === 'object' && Object.keys(fixed).length > 0) {
                    fnArgs = fixed; parsed = true; break
                  }
                  try { fnArgs = JSON.parse(obj); if (Object.keys(fnArgs).length > 0) { parsed = true; break } } catch { /* try next */ }
                }
                if (!parsed) {
                  const errContent = `Invalid JSON in tool arguments: ${parseErr.message}. Raw: ${raw.slice(0, 200)}`
                  this.send('qwen-event', { type: 'tool-result', tool_use_id: tc.id, content: errContent, is_error: true })
                  messages.push({ role: 'tool', tool_call_id: tc.id, content: errContent })
                  continue
                }
              } else {
                const errContent = `Invalid JSON in tool arguments: ${parseErr.message}. Raw: ${raw.slice(0, 200)}`
                this.send('qwen-event', { type: 'tool-result', tool_use_id: tc.id, content: errContent, is_error: true })
                messages.push({ role: 'tool', tool_call_id: tc.id, content: errContent })
                continue
              }
            }
          }
        }

        // Emit tool-use event
        // For update_todos: auto-repair the todos arg before emitting so the renderer gets valid data
        if (fnName === 'update_todos' && !Array.isArray(fnArgs.todos)) {
          let _repaired = fnArgs.todos
          if (typeof _repaired === 'string') {
            try { _repaired = JSON.parse(_repaired) } catch { /* not JSON */ }
          }
          if (!Array.isArray(_repaired) && Array.isArray(fnArgs)) _repaired = fnArgs
          if (!Array.isArray(_repaired) && _repaired && typeof _repaired === 'object') {
            if (Array.isArray(_repaired.todos)) _repaired = _repaired.todos
            else if (Array.isArray(_repaired.items)) _repaired = _repaired.items
            else if (Array.isArray(_repaired.list)) _repaired = _repaired.list
          }
          if (!Array.isArray(_repaired) && _repaired && typeof _repaired === 'object' && _repaired.content) {
            _repaired = [_repaired]
          }
          if (!Array.isArray(_repaired)) {
            for (const key of Object.keys(fnArgs)) {
              if (Array.isArray(fnArgs[key]) && fnArgs[key].length > 0 && fnArgs[key][0].content) {
                _repaired = fnArgs[key]; break
              }
            }
          }
          if (Array.isArray(_repaired)) {
            fnArgs.todos = _repaired.map((t, i) => ({
              id: t.id ?? (i + 1),
              content: t.content || t.text || t.label || t.title || t.description || `Task ${i + 1}`,
              status: t.status || 'pending',
            }))
          }
        }
        this.send('qwen-event', { type: 'tool-use', id: tc.id, name: fnName, input: fnArgs })

        // Track todo state for completion checking
        if (fnName === 'update_todos' && Array.isArray(fnArgs.todos)) {
          _bootstrapDone = true
          _lastTodos = fnArgs.todos || null
        }
        if (fnName === 'edit_todos') {
          _bootstrapDone = true
          // Apply the edit operations to _lastTodos so completion checking stays accurate
          if (_lastTodos) {
            let todos = [..._lastTodos]
            // append
            if (Array.isArray(fnArgs.append)) {
              const maxId = todos.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0)
              fnArgs.append.forEach((item, i) => {
                todos.push({ id: maxId + i + 1, content: item.content, status: item.status || 'pending' })
              })
            }
            // update
            if (Array.isArray(fnArgs.update)) {
              todos = todos.map(t => {
                const patch = fnArgs.update.find(u => String(u.id) === String(t.id))
                return patch ? { ...t, ...patch } : t
              })
            }
            // remove
            if (Array.isArray(fnArgs.remove)) {
              const removeSet = new Set(fnArgs.remove.map(String))
              todos = todos.filter(t => !removeSet.has(String(t.id)))
            }
            _lastTodos = todos
          }
        }

        // Track agent notes — persist across compaction as a JS variable
        if (fnName === 'agent_notes' && typeof fnArgs.notes === 'string' && fnArgs.notes.trim()) {
          _agentNotes = fnArgs.notes.trim()
          this._lastAgentNotes = _agentNotes  // sync to instance for interrupt access
          this.send('qwen-event', { type: 'agent-notes', notes: _agentNotes, turn })
        }


        // Only run speculative edit simulation for files that previously had
        // compile errors. Clean files rarely benefit from pre-checking, and
        // the 10s timeout adds significant latency to every write.
        let speculativeMsg = ''
        const _lspSupportedExts = new Set()
        if (this._lspManager?.getStatus().status === 'ready') {
          for (const srv of (this._lspManager.getStatus().servers || [])) {
            for (const lang of (srv.languages || [])) {
              const extMap = {
                swift: ['.swift'], 'objective-c': ['.m', '.mm', '.h'],
                javascript: ['.js', '.mjs', '.cjs'], typescript: ['.ts', '.tsx', '.d.ts'],
                python: ['.py'], go: ['.go'], rust: ['.rs'],
                c: ['.c', '.h'], cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'],
                java: ['.java'],
              }
              for (const ext of (extMap[lang] || [])) _lspSupportedExts.add(ext)
            }
          }
        }
        const _fileExt = fnArgs.path ? path.extname(fnArgs.path).toLowerCase() : ''
        const _lspApplies = _lspSupportedExts.size > 0 && _lspSupportedExts.has(_fileExt)

        // Only run speculative check if this file has failed compilation before
        const _hasCompileHistory = fnArgs.path && (
          _compileFailCounts.has(fnArgs.path) ||
          [..._compileFailCounts.keys()].some(k => k.endsWith(path.basename(fnArgs.path || '')))
        )
        if (fnName === 'write_file' && this._lspManager?.getStatus().status === 'ready' && _lspApplies && _hasCompileHistory) {
          this.send('qwen-event', { type: 'lsp-activity', action: 'speculative-check', path: fnArgs.path })
          try {
            const simResult = await Promise.race([
              this._lspManager.call('lsp_simulate_edit_atomic', {
                file_path: path.resolve(cwd, fnArgs.path),
                start_line: 1, start_column: 1,
                end_line: 999999, end_column: 1,
                new_text: fnArgs.content,
              }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('speculative edit timed out')), 10000))
            ])
            if (simResult?.newDiagnostics?.length > 0) {
              // Filter out LSP rejection messages (e.g. sourcekit-lsp on unsupported file types)
              const realDiags = simResult.newDiagnostics.filter(d =>
                !/expected exactly one compiler job|unable to handle compilation|no compiler arguments/i.test(d.message || '')
              )
              if (realDiags.length > 0) {
                const diagLines = realDiags.map(d => `  ${d.severity || 'error'}: ${d.message} (line ${d.line || '?'})`).join('\n')
                speculativeMsg = `⚠️ Speculative edit preview found new diagnostics:\n${diagLines}\n\n`
                this.send('qwen-event', { type: 'lsp-activity', action: 'speculative-warn', path: fnArgs.path, count: realDiags.length })
              } else {
                speculativeMsg = '✅ Speculative edit validation passed — no new errors detected.\n\n'
                this.send('qwen-event', { type: 'lsp-activity', action: 'speculative-ok', path: fnArgs.path })
              }
            } else {
              speculativeMsg = '✅ Speculative edit validation passed — no new errors detected.\n\n'
              this.send('qwen-event', { type: 'lsp-activity', action: 'speculative-ok', path: fnArgs.path })
            }
          } catch {
            // On failure/timeout, skip speculative check and proceed normally
          }
        }

        // Tool pre-validation — advisory check via fast model (non-blocking).
        // The 0.8B model can flag suspicious tool calls but does NOT have veto power
        // Await tool validation to prevent concurrent Metal inference.
        // Advisory only — we log the warning but always proceed with execution.
        if (assistClient && VALIDATED_TOOLS.has(fnName)) {
          const recentContext = messages.slice(-6).map(m => typeof m.content === 'string' ? m.content : '').join('\n')
          try {
            const validation = await assistClient.assistValidateTool(fnName, fnArgs, recentContext)
            if (validation && !validation.valid) {
              this.send('qwen-event', { type: 'fast-assist', task: 'tool_validate', label: `⚡ Fast Assistant — tool warning: ${fnName}`, detail: validation.reason || 'flagged' })
            }
          } catch (_) {}
        }

        // ── No-op write guard ────────────────────────────────────────────────
        // When the agent writes the same content to the same path twice, it
        // thinks the write didn't happen (e.g. waiting for a downstream effect
        // that never materialises). Skip the redundant write and confirm it
        // already succeeded — this breaks the no-op write loop without
        // executing the write again (which would reset mtime and confuse LSP).
        if (fnName === 'write_file' && fnArgs.path && typeof fnArgs.content === 'string') {
          const _wKey = fnArgs.path
          const _wHash = require('node:crypto').createHash('sha1').update(fnArgs.content).digest('hex').slice(0, 16)
          const _wPrev = _writeHistory.get(_wKey)
          if (_wPrev && _wPrev.hash === _wHash) {
            _wPrev.count++
            _writeHistory.set(_wKey, _wPrev)
            this.send('qwen-event', {
              type: 'system', subtype: 'warning',
              data: `⚠️ No-op write detected: "${_wKey}" already has this exact content (written on turn ${_wPrev.turn}). Skipping duplicate write.`,
            })
            // Replace the tool result already pushed to messages with a confirmation
            const lastToolMsg = messages[messages.length - 1]
            if (lastToolMsg && lastToolMsg.role === 'tool' && lastToolMsg.tool_call_id === tc.id) {
              lastToolMsg.content = `File "${_wKey}" already contains this exact content (written on turn ${_wPrev.turn}). No changes needed — the write already happened. Move on to the next step.`
            }
          } else {
            _writeHistory.set(_wKey, { hash: _wHash, count: 1, turn })
          }
        }

        // ── Read-file loop interception ──────────────────────────────────────
        // If the agent is re-reading a file it already fully read in this session,
        // and it's NOT using line ranges (which would indicate intentional paging),
        // check whether the file has actually changed since the last read.
        // Only intercept if the original content is still in the conversation —
        // if it was trimmed/compacted away, the agent genuinely needs to re-read.
        if (fnName === 'read_file' && fnArgs.path && fnArgs.start_line == null && fnArgs.end_line == null) {
          const readKey = fnArgs.path
          const prev = _readFileHistory.get(readKey)
          if (prev && prev.count >= 1 && prev.fullRead) {
            // Check if the ACTUAL file content is still FULLY in context.
            // A message counts as "content present" only if it:
            //   1. Is a tool result with substantial content
            //   2. Contains the filename
            //   3. Does NOT have trimming/compression markers
            //   4. Has enough content to represent most of the file (>60% of original)
            const TRIMMED_MARKERS = ['[TRIMMED for context space', '[TRUNCATED', '[compressed:', '[§TRIMMED§', '[lines ', 'Do NOT call read_file again']
            const expectedMinChars = prev.totalLines ? prev.totalLines * 20 : 2000  // rough estimate: 20 chars/line avg
            const contentStillInContext = messages.some(m => {
              if (m.role !== 'tool' || !m.content) return false
              if (!m.content.includes(readKey.split('/').pop())) return false
              // Must have at least 60% of expected content size
              if (m.content.length < expectedMinChars * 0.6) return false
              const head = m.content.slice(0, 200)
              const tail = m.content.slice(-300)
              for (const marker of TRIMMED_MARKERS) {
                if (head.includes(marker) || tail.includes(marker)) return false
              }
              return true
            })
            if (contentStillInContext) {
              try {
                const resolvedPath = path.resolve(cwd, fnArgs.path.trim())
                const currentMtime = fs.statSync(resolvedPath).mtimeMs
                if (prev.mtime && currentMtime <= prev.mtime) {
                  // Block once, then allow on the next attempt
                  prev.blockedCount = (prev.blockedCount || 0) + 1
                  _readFileHistory.set(readKey, prev)
                  if (prev.blockedCount >= 2) {
                    this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Releasing read lock on ${readKey} after ${prev.blockedCount} blocked attempts` })
                    prev.blockedCount = 0
                    prev.mtime = null
                    _readFileHistory.set(readKey, prev)
                    // Fall through to execute the actual read
                  } else {
                    this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Skipped re-read of ${readKey} (unchanged, content still in context, blocked ${prev.blockedCount}x)` })
                    const interceptContent = `File unchanged since your last read (${prev.totalLines} lines, turn ${prev.lastTurn}). ` +
                      `The content is still in your context above. ` +
                      `Proceed with edit_file or search_files — do NOT re-read the full file.`
                    this.send('qwen-event', { type: 'tool-result', tool_use_id: tc.id, content: interceptContent, is_error: false })
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: interceptContent })
                    continue
                  }
                }
              } catch { /* stat failed — fall through */ }
            }
            // Content was trimmed from context — allow the re-read
          }
        }

        // ── Paged re-read interception ───────────────────────────────────────
        // If the agent already fully read a file and is now paging through it
        // with start_line/end_line, ALLOW it. The agent is requesting specific
        // lines because the full read was likely truncated for context space.
        // Only block if the file was read AND the content is genuinely still
        // complete in context (no truncation markers AND total chars match).
        if (fnName === 'read_file' && fnArgs.path && (fnArgs.start_line != null || fnArgs.end_line != null)) {
          // Always allow paged reads — the agent is trying to access specific
          // sections that may have been truncated from the initial full read.
          // The full-read interception above handles the "don't re-read the
          // whole file" case; paged reads are a legitimate navigation pattern.
        }

        // ── Batch re-read interception (read_files) ──────────────────────────
        // If the agent calls read_files with paths that were ALL already fully
        // read and still in context, intercept the entire call.
        // If some are new, filter out the already-read ones and only read new files.
        if (fnName === 'read_files' && Array.isArray(fnArgs.paths) && fnArgs.paths.length > 0) {
          const alreadyRead = []
          const needsRead = []
          const TRIMMED_MARKERS = ['[TRIMMED for context space', '[TRUNCATED', '[compressed:', '[§TRIMMED§']
          for (const filePath of fnArgs.paths) {
            const prev = _readFileHistory.get(filePath)
            if (prev && prev.fullRead) {
              const contentStillInContext = messages.some(m => {
                if (m.role !== 'tool' || !m.content || m.content.length <= 500) return false
                if (!m.content.includes(filePath.split('/').pop())) return false
                const head = m.content.slice(0, 200)
                const tail = m.content.slice(-300)
                for (const marker of TRIMMED_MARKERS) {
                  if (head.includes(marker) || tail.includes(marker)) return false
                }
                return true
              })
              if (contentStillInContext) {
                try {
                  const resolvedPath = path.resolve(cwd, filePath.trim())
                  const currentMtime = fs.statSync(resolvedPath).mtimeMs
                  if (prev.mtime && currentMtime <= prev.mtime) {
                    alreadyRead.push(filePath)
                    continue
                  }
                } catch { /* stat failed — treat as needs read */ }
              }
            }
            needsRead.push(filePath)
          }
          if (alreadyRead.length > 0 && needsRead.length === 0) {
            // All files already read and in context — skip entirely
            // Track how many times we've blocked batch re-reads this session
            this._batchRereadBlocks = (this._batchRereadBlocks || 0) + 1
            this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Skipped batch re-read of ${alreadyRead.length} files (all already in context, block #${this._batchRereadBlocks})` })

            let interceptContent
            if (this._batchRereadBlocks >= 3) {
              // Third+ time being blocked — allow through and reset counter so
              // the guard re-arms. Permanently blocking causes an infinite loop
              // where the agent can never get content it needs.
              this._batchRereadBlocks = 0
              this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Batch re-read block limit reached — allowing read through, resetting counter` })
              // Fall through to actually execute the read (don't intercept)
            } else if (this._batchRereadBlocks >= 2) {
              // Second time being blocked — model is stuck reading instead of writing
              interceptContent = `STOP READING. You have tried to re-read these files ${this._batchRereadBlocks} times — they are ALL still in your context. ` +
                `You MUST write code NOW. Call write_file to create the file you need, or call edit_file to modify an existing file. ` +
                `Do NOT call read_file or read_files again.`
            } else {
              interceptContent = `All ${alreadyRead.length} files were already read and are still in your context. ` +
                `Do NOT re-read them. Proceed with write_file (to create new files) or edit_file (to modify existing files).`
            }
            if (interceptContent) {
            this.send('qwen-event', { type: 'tool-result', tool_use_id: tc.id, content: interceptContent, is_error: false })
            messages.push({ role: 'tool', tool_call_id: tc.id, content: interceptContent })
            continue
            }
          }
          if (alreadyRead.length > 0 && needsRead.length > 0) {
            // Some already read — rewrite args to only read new files
            this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Filtered batch read: ${alreadyRead.length} already in context, reading ${needsRead.length} new files` })
            fnArgs.paths = needsRead
          }
        }

        // ── Hard block: reject read tools when in a severe read loop ──────────
        // Exempt paged reads (start_line/end_line) — the agent is navigating a
        // large file to find the section it needs to edit. Also exempt search_files
        // since it's trying to locate code to modify.
        // Fix #3: Also exempt reads of files the agent has attempted to edit —
        // it needs the current content to construct a valid old_string.
        const _READ_BLOCK_TOOLS = new Set(['read_file', 'read_files', 'list_dir'])
        const isPagedRead = fnName === 'read_file' && (fnArgs.start_line != null || fnArgs.end_line != null)
        const isReadOfEditTarget = fnName === 'read_file' && fnArgs.path &&
          (_lastFailedEditPath === fnArgs.path || _editAttemptedPaths.has(fnArgs.path))
        if (consecutiveReadsWithoutWrite >= 7 && _READ_BLOCK_TOOLS.has(fnName) && !isPagedRead && !isReadOfEditTarget) {
          // Only hard-block if the agent is re-reading the SAME files it already has.
          // Reading different sections of a large file or different files is legitimate investigation.
          const readPath = fnArgs.path || (fnArgs.paths && fnArgs.paths[0]) || ''
          const isNewContent = readPath && !_readFileHistory.has(readPath)
          if (isNewContent && consecutiveReadsWithoutWrite < 15) {
            // Allow — agent is reading new files, just nudge
            messages.push({
              role: 'system',
              content: `Note: ${consecutiveReadsWithoutWrite} reads without writing. You're reading new content which is fine, but start writing your fix soon.`,
            })
          } else {
          const blockMsg = `REJECTED: You have made ${consecutiveReadsWithoutWrite} consecutive read calls without writing. ` +
            `This call to ${fnName} has been blocked. You MUST call edit_file or write_file next. ` +
            `Use the information already in your context to make your edit.`
          this.send('qwen-event', { type: 'tool-result', tool_use_id: tc.id, content: blockMsg, is_error: true })
          messages.push({ role: 'tool', tool_call_id: tc.id, content: blockMsg })
          continue
          }
        }

        // Execute — use pre-fetched result if available (parallel I/O optimization),
        // then check speculator for in-flight speculations that match.
        let result
        // ── Post-write cache: serve recently-written files without re-read ─
        // If the agent wrote this file recently and it hasn't changed externally,
        // return a SHORT notice pointing to the existing content in context
        // (which is the same content the agent just wrote). This eliminates a
        // full re-prefill of the file.
        if (!result && this._postWriteCache && fnName === 'read_file' && fnArgs.path
            && fnArgs.start_line == null && fnArgs.end_line == null) {
          const absPath = path.resolve(cwd, fnArgs.path)
          const cached = this._postWriteCache.tryServe(absPath, turn)
          if (cached) {
            // Short receipt instead of full content — the content is already
            // in the conversation from when we wrote it, so no need to re-prefill.
            const totalLines = cached.content.split('\n').length
            result = {
              result:
                `[post-write cache] File unchanged since you wrote it ${cached.ageInTurns} turn(s) ago ` +
                `(${totalLines} lines, hash=${cached.hash}). ` +
                `The content you wrote is already in your context above — refer to that. ` +
                `Do NOT re-read the file. Proceed to the next step.`,
              _fullRead: true,
              _totalLines: totalLines,
            }
            this.send('qwen-event', { type: 'system', subtype: 'debug',
              data: `⚡ post-write cache hit: ${fnArgs.path} (age=${cached.ageInTurns} turns, ${totalLines} lines)` })
          }
        }
        if (result) {
          // already served from post-write cache
        } else if (_prefetchResults.has(tc.id)) {
          result = await _prefetchResults.get(tc.id)
        } else if (this._toolSpeculator && ToolSpeculator && ToolSpeculator.isSafe(fnName)) {
          // Speculator path — hit returns cached result; miss falls through to fresh exec
          const specResolved = await this._toolSpeculator.resolve(fnName, fnArgs)
          result = specResolved.result
          if (specResolved.hit) {
            this.send('qwen-event', { type: 'system', subtype: 'debug',
              data: `⚡ speculation hit for ${fnName} — skipped tool wait` })
          }
        } else {
          result = await executeTool(fnName, fnArgs, cwd, this._browserInstance, this._lspManager, this._inputRequester, { send: this.send.bind(this), _sessionId })
        }
        const isError = !!result.error
        let content = result.error || result.result
        // Track whether read_file returned the complete file — used to prevent
        // the truncation loop where the model re-reads a file that was already
        // fully read but later trimmed for context space.
        const _wasFullRead = !!(result._fullRead)

        // Update read_file history after successful reads
        if (fnName === 'read_file' && !isError && fnArgs.path) {
          const readKey = fnArgs.path
          const prev = _readFileHistory.get(readKey) || { count: 0, lastTurn: turn, fullRead: false, totalLines: 0, mtime: 0 }
          prev.count++
          prev.lastTurn = turn
          if (_wasFullRead) {
            prev.fullRead = true
            prev.totalLines = result._totalLines || 0
          }
          // Store file mtime so we can detect changes on re-read
          try {
            const resolvedPath = path.resolve(cwd, fnArgs.path.trim())
            prev.mtime = fs.statSync(resolvedPath).mtimeMs
          } catch { /* ignore */ }
          _readFileHistory.set(readKey, prev)
        }

        // Update read_file history for batch reads (read_files)
        // Track each file in the batch so re-read interception works
        if (fnName === 'read_files' && !isError && Array.isArray(fnArgs.paths)) {
          for (const filePath of fnArgs.paths) {
            const readKey = filePath
            const prev = _readFileHistory.get(readKey) || { count: 0, lastTurn: turn, fullRead: false, totalLines: 0, mtime: 0 }
            prev.count++
            prev.lastTurn = turn
            prev.fullRead = true
            // Extract line count from the result header: "── path (N lines) ──"
            const lineMatch = (content || '').match(new RegExp(`── ${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\((\\d+) lines\\)`))
            prev.totalLines = lineMatch ? parseInt(lineMatch[1], 10) : 0
            try {
              const resolvedPath = path.resolve(cwd, filePath.trim())
              prev.mtime = fs.statSync(resolvedPath).mtimeMs
            } catch { /* ignore */ }
            _readFileHistory.set(readKey, prev)
          }
        }

        // ── Memory: archive tool call ─────────────────────────────────────
        if (memoryClient) {
          const argsSummary = JSON.stringify(fnArgs).slice(0, 200)
          const resultSize = (content || '').length
          const archivePayload = {
            tool: fnName,
            args_summary: argsSummary,
            result_status: isError ? 'error' : 'success',
            result_size_bytes: resultSize,
          }
          // Archive the full tool result to TAOSMD — it writes to SSD (JSONL)
          // so there's no memory pressure from large payloads. The retrieval
          // pipeline enforces its own token budget, so storing full content
          // here gives FTS5 the best search coverage and lets the agent
          // recover file content from memory when context trimming removes it.
          // Only cap truly massive outputs (>500K) to avoid pathological cases.
          const archiveLimit = 500000
          const archiveContent = (content || '').length > archiveLimit
            ? (content || '').slice(0, archiveLimit)
            : (content || '')
          const truncated = (content || '').length > archiveLimit
          if (truncated) archivePayload.truncated = true

          memoryClient.archiveRecord('tool_call', { ...archivePayload, result: archiveContent }, `${fnName}: ${argsSummary.slice(0, 100)}`, {
            agentName: this._agentRole || 'main-agent',
            sessionId: _sessionId,
            projectId: path.basename(cwd),
          }).catch(() => {})
        }

        // Prepend speculative edit message if available
        if (speculativeMsg && content) {
          content = speculativeMsg + content
        }

        // ── Post-write cache: stash content for fast re-read ────────────
        // Record every successful write so the agent can re-read without
        // hitting disk + re-prefilling. Independent of LSP availability.
        if ((fnName === 'write_file' || fnName === 'edit_file') && !isError && this._postWriteCache && fnArgs.path) {
          try {
            const absPath = path.resolve(cwd, fnArgs.path)
            if (fnName === 'write_file' && typeof fnArgs.content === 'string') {
              this._postWriteCache.recordWrite(absPath, fnArgs.content, turn)
            } else if (fnName === 'edit_file') {
              // For edit_file, read back the post-edit content
              try {
                const after = fs.readFileSync(absPath, 'utf-8')
                this._postWriteCache.recordWrite(absPath, after, turn)
              } catch { /* skip caching if read fails */ }
            }
          } catch { /* non-fatal */ }
        }

        // ── Performance: deferred post-edit diagnostics ─────────────────────
        // Instead of blocking the tool loop for up to 10s waiting for LSP
        // diagnostics, fire the request async and inject results at the start
        // of the next turn. This saves 2-10s per file write.
        if ((fnName === 'write_file' || fnName === 'edit_file') && !isError && this._lspManager?.getStatus().status === 'ready' && _lspApplies) {
          // Reset compile-error loop counter when the file is successfully rewritten
          if (fnArgs.path) {
            const basename = path.basename(fnArgs.path)
            for (const key of _compileFailCounts.keys()) {
              if (key.endsWith(basename) || key === fnArgs.path) {
                _compileFailCounts.delete(key)
              }
            }
          }

          this.send('qwen-event', { type: 'lsp-activity', action: 'diagnostics-check-deferred', path: fnArgs.path })
          const _diagPath = fnArgs.path
          const _diagLspManager = this._lspManager
          this._pendingDiagnostics = (async () => {
            try {
              const diags = await Promise.race([
                _diagLspManager.call('lsp_get_diagnostics', { file_path: _diagPath }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('diagnostic timeout')), 10000))
              ])
              if (diags?.content || diags?.errors) {
                const errorDiags = parseMcpDiagnostics(diags).filter(d => d.severity === 'error')
                if (errorDiags.length > 0) {
                  return { path: _diagPath, errors: errorDiags }
                }
              }
              return null
            } catch { return null }
          })()
        }

        // ── Swift build check: after writing a .swift file, trigger a fast build ──
        // Gives the agent immediate compiler feedback without it having to ask.
        // Only runs when xcodebuildmcp is available, the file is Swift, and the
        // project is iOS (macOS builds use xcodebuild directly via bash).
        if ((fnName === 'write_file' || fnName === 'edit_file') && !isError
            && xcodeTool && xcodeTool.isXcodeMCPAvailable()
            && (fnArgs.path || '').endsWith('.swift')) {
          // Check if a macOS config exists — if so, skip xcodebuildmcp build_sim
          const _macosConfig = (() => {
            try {
              const p = require('path').join(cwd, '.xcodebuildmcp', 'macos-config.json')
              return require('fs').existsSync(p) ? JSON.parse(require('fs').readFileSync(p, 'utf-8')) : null
            } catch { return null }
          })()

          if (_macosConfig) {
            // macOS project — run xcodebuild directly
            try {
              this.send('qwen-event', { type: 'system', subtype: 'debug', data: '🔨 Swift file changed — running macOS build check...' })
              const { execSync } = require('child_process')
              const buildOut = execSync(
                `xcodebuild ${_macosConfig.projectArg} -scheme "${_macosConfig.scheme}" -configuration Debug build 2>&1 | grep -E "error:|warning:|BUILD SUCCEEDED|BUILD FAILED" | tail -20`,
                { timeout: 60000, encoding: 'utf-8', cwd }
              )
              const hasErrors = /error:/.test(buildOut)
              const hasFailed = /BUILD FAILED/.test(buildOut)
              if (hasErrors || hasFailed) {
                const errors = buildOut.split('\n').filter(l => /error:|warning:/.test(l)).slice(0, 15)
                content = `🔴 macOS build errors after edit:\n${errors.join('\n')}\n\n${content}`
                this.send('qwen-event', { type: 'system', subtype: 'debug', data: `🔴 macOS build failed: ${errors.length} issue(s)` })
              } else {
                this.send('qwen-event', { type: 'system', subtype: 'debug', data: '✅ macOS build succeeded after Swift edit' })
              }
            } catch (e) {
              // Build timed out or xcodebuild not available — skip silently
            }
          } else {
            // iOS project — use xcodebuildmcp build_sim
            try {
              this.send('qwen-event', { type: 'system', subtype: 'debug', data: '🔨 Swift file changed — running incremental build...' })
              const buildResult = await xcodeTool.executeXcodeTool('xcode_build_simulator', {}, cwd)
              if (buildResult.result) {
                const lines = buildResult.result.split('\n')
                const errors = lines.filter(l => /error:|warning:/.test(l)).slice(0, 20)
                if (errors.length > 0) {
                  const hasErrors = errors.some(l => /\berror:/.test(l))
                  const prefix = hasErrors ? '🔴 Build errors after edit:' : '⚠️ Build warnings after edit:'
                  content = `${prefix}\n${errors.join('\n')}\n\n${content}`
                  this.send('qwen-event', { type: 'system', subtype: 'debug', data: `${prefix} ${errors.length} issue(s)` })
                } else {
                  this.send('qwen-event', { type: 'system', subtype: 'debug', data: '✅ Build succeeded after Swift edit' })
                }
              } else if (buildResult.error && !buildResult.error.includes('Missing required session defaults')) {
                content = `⚠️ Build check: ${buildResult.error.slice(0, 200)}\n\n${content}`
              }
            } catch { /* non-fatal */ }
          }
        }

        // Post-bash diagnostic hook: detect file-writing bash commands and check diagnostics
        // Catches heredocs (cat > file), redirects (echo > file), sed -i, etc.
        if (fnName === 'bash' && !isError && this._lspManager?.getStatus().status === 'ready') {
          const cmd = fnArgs.command || ''
          // Invalidate post-write cache — bash may have touched any file on disk.
          // Conservative: clear everything when bash runs a write-ish command.
          if (this._postWriteCache && /\b(?:cat\s*>|>>?|tee|sed\s+-i|mv|cp|rm|git\s+(?:checkout|reset|apply|commit)|npm\s+install|pip\s+install|xcodebuild\s+[^\s]*build)\b/.test(cmd)) {
            this._postWriteCache.clear()
          }
          const fileWritePatterns = [
            /cat\s+>\s*(\S+)/,           // cat > file
            />\s*(\S+)/,                  // echo "x" > file
            /tee\s+(\S+)/,               // tee file
            /sed\s+-i[^\s]*\s+.*\s+(\S+)/, // sed -i 's/x/y/' file
            /cp\s+\S+\s+(\S+)/,          // cp src dest
            /mv\s+\S+\s+(\S+)/,          // mv src dest
            /<<\s*'?\w+'?\s*\n?.*?>\s*(\S+)/s, // heredoc > file
          ]
          const touchedFiles = new Set()
          for (const pat of fileWritePatterns) {
            const m = cmd.match(pat)
            if (m && m[1]) {
              const fp = m[1].replace(/['"]/g, '')
              if (fp && !fp.startsWith('-') && /\.\w+$/.test(fp)) {
                touchedFiles.add(path.resolve(cwd, fp))
              }
            }
          }
          for (const fp of touchedFiles) {
            // Skip files the active LSP servers don't handle (e.g. HTML when only sourcekit-lsp is running)
            const fpExt = path.extname(fp).toLowerCase()
            if (_lspSupportedExts.size > 0 && !_lspSupportedExts.has(fpExt)) continue
            try {
              this.send('qwen-event', { type: 'lsp-activity', action: 'diagnostics-check', path: fp })
              const diags = await Promise.race([
                this._lspManager.call('lsp_get_diagnostics', { file_path: fp }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('diagnostic timeout')), 8000))
              ])
              if (diags?.content || diags?.errors) {
                const errorDiags = parseMcpDiagnostics(diags).filter(d => d.severity === 'error')
                if (errorDiags.length > 0) {
                  const diagLines = errorDiags.map(d => `  ${d.severity || 'error'}: ${d.message} (line ${d.line || '?'})`).join('\n')
                  content += `\n\n⚠️ LSP detected errors in ${path.relative(cwd, fp)}:\n${diagLines}`
                  this.send('qwen-event', { type: 'lsp-activity', action: 'diagnostics-errors', path: fp, count: errorDiags.length })
                }
              }
            } catch { /* skip */ }
          }
        }

        // ── Compile-error loop detection ──────────────────────────────────────
        // When the agent runs a compile command (swiftc, swift build, xcodebuild,
        // kotlinc, etc.) and it fails, track the failure count per target file.
        // After 3 consecutive failures on the same file, inject targeted guidance
        // to break the patch loop — including Swift 6 specific API notes.
        if (fnName === 'bash' && typeof content === 'string') {
          const cmd = fnArgs.command || ''
          const isCompileCmd = /\b(swiftc|swift\s+build|xcodebuild|kotlinc|javac|tsc|rustc|go\s+build|gcc|g\+\+|clang)\b/i.test(cmd)
          if (isCompileCmd) {
            // Key selection:
            //  - xcodebuild: key on (project|workspace, scheme) so repeated
            //    xcodebuild invocations on the same target collapse to one
            //    counter even when the full command string varies.
            //  - everything else: key on the primary source filename,
            //    falling back to a command prefix.
            let compileTarget
            if (/\bxcodebuild\b/.test(cmd)) {
              const projMatch = cmd.match(/-(?:project|workspace)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/)
              const schemeMatch = cmd.match(/-scheme\s+(?:"([^"]+)"|'([^']+)'|(\S+))/)
              const proj = projMatch ? (projMatch[1] || projMatch[2] || projMatch[3]) : null
              const scheme = schemeMatch ? (schemeMatch[1] || schemeMatch[2] || schemeMatch[3]) : null
              if (proj || scheme) {
                compileTarget = `xcodebuild:${proj || '?'}:${scheme || '?'}`
              } else {
                compileTarget = 'xcodebuild:' + cmd.slice(0, 60)
              }
            } else {
              const fileMatch = cmd.match(/\b(\S+\.(swift|kt|java|ts|rs|go|c|cpp|m))\b/)
              compileTarget = fileMatch ? fileMatch[1] : cmd.slice(0, 60)
            }
            const hasError = /error:/i.test(content) || /exit.*[1-9]/.test(content) || /Command failed/i.test(content)

            if (hasError) {
              const prev = _compileFailCounts.get(compileTarget) || 0
              _compileFailCounts.set(compileTarget, prev + 1)
              _lastCompileFile = compileTarget

              const failCount = prev + 1
              if (failCount >= 3) {
                // Build targeted guidance based on the errors seen
                const isSwift = /\.swift\b|swiftc|swift\s+build|xcodebuild/i.test(cmd)
                let guidance = `\n\n⚠️ COMPILE LOOP DETECTED: "${compileTarget}" has failed to compile ${failCount} times in a row. Stop patching and take a different approach:\n`
                guidance += `1. Re-read the ENTIRE file with read_file before making any more edits.\n`
                guidance += `2. Identify ALL errors at once — don't fix one at a time.\n`
                guidance += `3. If the approach is fundamentally broken, rewrite the file from scratch with a simpler design.\n`

                if (isSwift) {
                  guidance += `\nSwift 6 API notes (common sources of compile errors):\n`
                  guidance += `- FileHandle.availableData returns Data (non-optional) — use "let data = stdin.availableData; guard !data.isEmpty else { return nil }"\n`
                  guidance += `- posix_spawn_pid_t does NOT exist — use pid_t instead: "var pid: pid_t = 0"\n`
                  guidance += `- posix_spawnattr_setbininfo_np does NOT exist — use posix_spawn directly with nil for attr\n`
                  guidance += `- For raw terminal mode, use: bash({"command": "stty -icanon -echo"}) and restore with stty icanon echo — do NOT use posix_spawn in Swift\n`
                  guidance += `- For non-blocking stdin reads, use: FileHandle.standardInput.availableData (returns Data, not Optional<Data>)\n`
                  guidance += `- Conditional binding (guard let / if let) requires Optional type — don't use it on non-optional values\n`
                  guidance += `- "private func" is not accessible from outside the class — use "func" or "internal func"\n`
                  guidance += `- For a terminal game, the simplest approach is: use stty via bash for raw mode, read from FileHandle.standardInput.availableData directly\n`
                }

                content += guidance
                this.send('qwen-event', {
                  type: 'system', subtype: 'warning',
                  data: `⚠️ Compile loop on ${compileTarget} (${failCount} failures) — injecting guidance to break the loop`,
                })
              }
            } else {
              // Successful compile — reset the counter for this file
              _compileFailCounts.delete(compileTarget)
              _lastCompileFile = null
            }
          }
        }

        // Compress large tool outputs to avoid blowing up the context window.
        // Uses compactor for intelligent compression; falls back to hard truncation on failure.
        // For screenshots, extract the image first so compression doesn't destroy it.
        let _screenshotImg = ''
        if (fnName === 'browser_screenshot' && content && content.includes('![screenshot](data:image')) {
          const imgRe = /!\[screenshot\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)/
          const m = content.match(imgRe)
          if (m) {
            _screenshotImg = m[0]
            content = content.replace(imgRe, '[screenshot image captured]')
          }
        }

        const truncateLimit = fnName === 'read_file' ? effectiveReadFileTruncate : effectiveToolOutputTruncate

        // Navigational tools (list_dir, search, grep) get a higher limit and skip
        // the expensive Python compressor — their output is structural data the agent
        // needs intact for project navigation. Simple truncation is better than lossy
        // compression that destroys directory/search structure.
        const NAV_TOOLS = ['list_dir', 'search_files', 'grep_search', 'lsp_get_symbols', 'lsp_get_references']
        const isNavTool = NAV_TOOLS.includes(fnName)
        const effectiveLimit = isNavTool ? Math.max(truncateLimit, 40000) : truncateLimit

        if (content && content.length > effectiveLimit) {

          // File extract — DISABLED. The fast model (0.8B) often extracts the
          // wrong section for complex tasks (e.g. picks HTML/CSS instead of JS
          // game logic when user says "fix the path"). This silently discards
          // the code the agent needs and causes read loops. The line-number
          // format + paged reads are a better approach for large files.
          // TODO: Re-enable when using a more capable extraction model.
          /*
          if (assistClient && fnName === 'read_file') {
            const taskContext = messages.filter(m => m.role === 'user').pop()?.content || ''
            if (taskContext) {
              const section = await assistClient.assistExtractRelevantSection(fnArgs.path || '', content, taskContext)
              if (section) {
                const _origLen = content.length
                content = section
                this.send('qwen-event', { type: 'fast-assist', task: 'extract_section', label: '⚡ Fast Assistant — extracted relevant section', detail: `${fnArgs.path ? fnArgs.path.split('/').pop() : 'file'} · ${_origLen.toLocaleString()} chars → ${section.length.toLocaleString()} chars` })
              }
            }
          }
          */

          // Re-check after extraction — may now be within limits
          if (content.length > effectiveLimit) {
            // Nav tools and read_file: skip Python compressor, truncate cleanly.
            // read_file content is source code the agent needs verbatim for editing —
            // lossy compression destroys it and forces a rewind round-trip that often fails.
            if (isNavTool || fnName === 'read_file') {
              const lines = content.split('\n')
              let charCount = 0
              let cutLine = lines.length
              for (let i = 0; i < lines.length; i++) {
                charCount += lines[i].length + 1
                if (charCount > effectiveLimit) { cutLine = i; break }
              }
              if (fnName === 'read_file') {
                if (_wasFullRead) {
                  content = lines.slice(0, cutLine).join('\n') +
                    `\n\n[FILE TOO LARGE — showing lines 1-${cutLine} of ${lines.length} total]\n` +
                    `DO NOT re-call read_file with the same arguments — you will get the same output.\n` +
                    `To see the rest:\n` +
                    `  • read_file({"path":"...","start_line":${cutLine + 1}}) for the next section\n` +
                    `  • search_files({"patterns":["keyword"],"path":"..."}) to find specific content — targeted and fits in context`
                } else {
                  content = lines.slice(0, cutLine).join('\n') +
                    `\n\n[section truncated — showing lines 1-${cutLine} of requested range]\n` +
                    `To continue: read_file with start_line=${cutLine + 1}`
                }
              } else {
                content = lines.slice(0, cutLine).join('\n') +
                  `\n\n... [${lines.length - cutLine} more entries — use a more specific path or pattern to narrow results]`
              }
            } else {
            const contentType = detectContentType(fnName, content)
            let compressed = false
            try {
              const compResult = await compactor.compressText(pythonPath, content, contentType, { maxChars: effectiveToolOutputTruncate })
              if (compResult.stats?.compressed) {
                content = compResult.compressed || compResult.text || content
                const pct = compResult.stats.reduction_pct ?? 0
                const origTokens = compResult.stats.original_tokens ?? 0
                // Put the rewind notice at the START of the content so it is never
                // cut off by trimMessages (which truncates from the end). A truncated
                // key causes the model to call rewind_context with a partial key that
                // will never match anything in the store.
                let notice = `[compressed: ${pct}% reduction, original ${origTokens} tokens`
                if (compResult.stats.rewind_key) {
                  notice += `, rewind key: ${compResult.stats.rewind_key} — call rewind_context with this key to retrieve the full original`
                }
                notice += ']\n\n'
                content = notice + content
                compressed = true
                this.send('qwen-event', { type: 'compaction-stats', data: { ...compResult.stats, source: 'tool-result', tool: fnName, contentType } })
              }
            } catch {
              // compressText failed — fall through to hard truncation
            }
            if (!compressed) {
              // Count total lines so the agent knows how to page through the file
              const totalLines = content.split('\n').length
              const shownLines = content.slice(0, effectiveLimit).split('\n').length
              if (_wasFullRead) {
                content = content.slice(0, effectiveLimit) +
                  `\n\n[FILE TOO LARGE — showing lines 1-${shownLines} of ${totalLines} total]\n` +
                  `DO NOT re-call the same tool with the same arguments — the output will not change.\n` +
                  `To see the rest:\n` +
                  `  • read_file with start_line=${shownLines + 1} for the next section\n` +
                  `  • search_files({"patterns":["keyword"],"path":"..."}) to find specific content — targeted and fits in context`
              } else {
                content = content.slice(0, effectiveLimit) +
                  `\n\n[section truncated — showing lines 1-${shownLines}]\n` +
                  `To continue: read_file with start_line=${shownLines + 1}`
              }
            }
            } // end non-nav-tool compression
          }
        }

        // Error diagnosis — prepend fast model diagnosis to tool errors (awaited, 15s timeout)
        if (assistClient && isError && content) {
          const recentContext = messages.slice(-4).map(m => typeof m.content === 'string' ? m.content : '').join('\n')
          const diagnosis = await assistClient.assistDiagnoseError(fnName, fnArgs, content, recentContext)
          if (diagnosis) {
            content = `⚡ Diagnosis: ${diagnosis}\n\n${content}`
            this.send('qwen-event', { type: 'fast-assist', task: 'error_diagnose', label: '⚡ Fast Assistant — error diagnosed', detail: diagnosis.slice(0, 120) })
          }
        }

        // Vision offload for browser_screenshot results
        if (assistClient && fnName === 'browser_screenshot' && content) {
          // content may be a base64 image or contain one
          const imageMatch = content.match(/data:(image\/[^;]+);base64,([A-Za-z0-9+/=]+)/)
          if (imageMatch) {
            const mimeType = imageMatch[1]
            const imageData = imageMatch[2]
            const desc = await assistClient.assistVision(
              imageData, mimeType,
              'Describe this screenshot in detail, focusing on UI elements, error messages, and code visible on screen.'
            )
            if (desc) {
              content = `[Vision: ${desc}]`
              this.send('qwen-event', { type: 'fast-assist', task: 'vision', label: '⚡ Fast Assistant — screenshot described', detail: desc.slice(0, 120) })
            } else {
              // Fast model not loaded — strip the base64 blob so it doesn't bloat context,
              // and tell the agent it can't see the screenshot
              content = content.replace(/!\[screenshot\]\(data:image\/[^)]+\)/g, '[screenshot captured — vision model not loaded, cannot describe image]')
              content = content.replace(/data:(image\/[^;]+);base64,[A-Za-z0-9+/=]+/g, '[image data — vision model not loaded]')
            }
          }
        }

        // ── Auto-snapshot after build_run_sim ─────────────────────────────────
        // After successfully launching the app on the simulator:
        //   1. Open Simulator.app so the window is actually visible on screen
        //      (simctl boot is headless — the agent otherwise can't see the UI).
        //   2. Capture a screenshot and push it to the renderer's preview panel.
        //   3. Capture the full UI view hierarchy (coordinates) for the agent.
        if (fnName === 'xcode_build_run_simulator' && !isError && xcodeTool && xcodeTool.isXcodeMCPAvailable()) {
          try {
            // 1. Open the Simulator window — idempotent, cheap, ~instant.
            xcodeTool.openSimulatorWindow()
            this.send('qwen-event', { type: 'system', subtype: 'debug', data: '🖥 Opened Simulator.app window' })

            // Small delay to let the app finish launching before grabbing UI/screenshot.
            await new Promise(r => setTimeout(r, 2000))

            // 2. Screenshot → renderer preview panel.
            try {
              const os = require('os')
              const path = require('path')
              const fs = require('fs')
              const shotPath = path.join(os.tmpdir(), `qc-sim-${Date.now()}.png`)
              const shot = await xcodeTool.executeXcodeTool(
                'xcode_screenshot_simulator',
                { output_path: shotPath },
                cwd,
              )
              // Prefer the path we asked for; fall back to scanning the MCP response for a png path.
              let resolvedPath = fs.existsSync(shotPath) ? shotPath : null
              if (!resolvedPath && shot.result) {
                const m = shot.result.match(/(\/\S+?\.png)/)
                if (m && fs.existsSync(m[1])) resolvedPath = m[1]
              }
              if (resolvedPath) {
                const b64 = fs.readFileSync(resolvedPath).toString('base64')
                this.send('qwen-event', {
                  type: 'simulator-preview',
                  dataUrl: `data:image/png;base64,${b64}`,
                  path: resolvedPath,
                  at: Date.now(),
                })
                this.send('qwen-event', { type: 'system', subtype: 'debug', data: '📸 Simulator screenshot → preview panel' })
              }
            } catch { /* non-fatal */ }

            // 3. Structured UI hierarchy for the agent.
            const snap = await xcodeTool.executeXcodeTool('xcode_snapshot_ui', {}, cwd)
            if (snap.result && snap.result.length > 10) {
              content = `${content}\n\n📱 UI snapshot after launch:\n${snap.result.slice(0, 3000)}`
              this.send('qwen-event', { type: 'system', subtype: 'debug', data: '📱 Auto-captured UI snapshot after app launch' })
            }
          } catch { /* non-fatal */ }
        }

        // ── Auto-screenshot after xcode_screenshot_simulator ──────────────────
        // When the agent takes a simulator screenshot, describe it via the fast
        // vision model so the agent gets a text description it can reason about.
        if (fnName === 'xcode_screenshot_simulator' && !isError && assistClient && content) {
          // xcodebuildmcp returns the screenshot as a file path or base64
          // Try to read the file if it's a path
          const screenshotPath = content.match(/saved to[:\s]+(\S+\.png)/i)?.[1]
          if (screenshotPath) {
            try {
              const imgBytes = require('fs').readFileSync(screenshotPath)
              const b64 = imgBytes.toString('base64')
              const desc = await assistClient.assistVision(b64, 'image/png',
                'Describe this iOS simulator screenshot in detail. Note all visible UI elements, text, layout, any errors or loading states.')
              if (desc) {
                content = `${content}\n\n[Vision description: ${desc}]`
                this.send('qwen-event', { type: 'fast-assist', task: 'vision', label: '⚡ Fast Assistant — simulator screenshot described', detail: desc.slice(0, 120) })
              }
            } catch { /* non-fatal */ }
          }
        }

        // Fetch summarize — summarize large web_fetch results
        if (assistClient && fnName === 'web_fetch' && typeof content === 'string' && content.length > assistClient.FETCH_SUMMARIZE_THRESHOLD) {
          const _origFetchLen = content.length
          const summary = await assistClient.assistFetchSummarize(fnArgs.url || '', content, 512)
          if (summary) {
            content = `(summarized — original: ${_origFetchLen} chars)\n\n${summary}`
            this.send('qwen-event', { type: 'fast-assist', task: 'fetch_summarize', label: '⚡ Fast Assistant — web content summarized', detail: `${fnArgs.url ? fnArgs.url.slice(0, 60) : 'URL'} · ${_origFetchLen.toLocaleString()} chars → ${summary.length.toLocaleString()} chars` })
          }
        }

        // Git summarize — summarize large git command outputs
        if (assistClient && fnName === 'bash' && typeof content === 'string' && content.length > assistClient.GIT_SUMMARIZE_THRESHOLD) {
          const cmd = fnArgs.command || ''
          if (/^git\s+(status|log|diff|show)\b/.test(cmd)) {
            const _origGitLen = content.length
            const summary = await assistClient.assistGitSummarize(cmd, content)
            if (summary) {
              content = `(git summary — original: ${_origGitLen} chars)\n\n${summary}`
              this.send('qwen-event', { type: 'fast-assist', task: 'git_summarize', label: '⚡ Fast Assistant — git output summarized', detail: `\`${cmd.slice(0, 40)}\` · ${_origGitLen.toLocaleString()} chars → ${summary.length.toLocaleString()} chars` })
            }
          }
        }

        // Search rank — DISABLED. The 0.8B model often misjudges relevance
        // for domain-specific searches (e.g. game pathfinding, custom APIs) and
        // discards the results the agent actually needs. Better to show all
        // results and let the main model decide what's relevant.
        /*
        if (assistClient && fnName === 'search_files' && typeof content === 'string') {
          const lines = content.split('\n').filter(Boolean)
          if (lines.length > assistClient.SEARCH_RANK_THRESHOLD) {
            const taskContext = messages.filter(m => m.role === 'user').pop()?.content || ''
            const ranked = await assistClient.assistRankSearchResults(fnArgs.pattern || '', lines, taskContext)
            if (ranked) {
              content = `(top 15 of ${lines.length} matches)\n\n${ranked.slice(0, 15).join('\n')}`
              this.send('qwen-event', { type: 'fast-assist', task: 'rank_search', label: '⚡ Fast Assistant — search results ranked', detail: `"${(fnArgs.pattern || '').slice(0, 40)}" · ${lines.length} → 15 results` })
            }
          }
        }
        */

        // ── Missing-type detection ────────────────────────────────────────────
        // When search_files returns no results for the same type/symbol query
        // twice in a row, the type almost certainly doesn't exist yet.
        // Inject a targeted hint to create it rather than search again.
        if ((fnName === 'search_files' || fnName === 'grep_search') && !isError) {
          const pattern = fnArgs.pattern || fnArgs.query || ''
          const isEmpty = !content || content.trim() === '' ||
            /no matches found|0 results|nothing found/i.test(content) ||
            content.split('\n').filter(l => l.trim() && !l.startsWith('Searching')).length === 0

          if (isEmpty && pattern) {
            // Normalize the pattern to a canonical key (strip regex anchors/pipes for display)
            const displayPattern = pattern.replace(/[\\^$[\]{}*+?]/g, '').replace(/\|/g, ' / ').slice(0, 60)
            const prevCount = _emptySearchHistory.get(pattern) || 0
            _emptySearchHistory.set(pattern, prevCount + 1)

            if (prevCount >= 1) {
              // Second empty result for the same query — the type doesn't exist
              const isTypeSearch = /^(struct|class|enum|protocol|func|interface|def|function|const|type)\s+\w+/.test(pattern) ||
                /^(struct|class|enum|protocol)\s*\|/.test(pattern) ||
                /\bstruct\b|\bclass\b|\benum\b|\bprotocol\b/.test(pattern)

              const hint = isTypeSearch
                ? `MISSING TYPE: "${displayPattern}" does not exist in the codebase — you have searched for it ${prevCount + 1} times with no results.\n\n` +
                  `Do NOT search again. The type needs to be CREATED. Use write_file to create a new Swift file with this type definition.\n` +
                  `Example: write_file({"path": "MyApp/TypeName.swift", "content": "import SwiftUI\\n\\nstruct TypeName: View { ... }"})`
                : `"${displayPattern}" was not found after ${prevCount + 1} searches. It does not exist in the codebase.\n` +
                  `Stop searching for it. Either create it with write_file, or adjust your approach.`

              messages.push({ role: 'system', content: hint })
              this.send('qwen-event', {
                type: 'system', subtype: 'warning',
                data: `⚠️ Missing type detected: "${displayPattern}" not found after ${prevCount + 1} searches — injecting create hint`,
              })
            }
          } else if (!isEmpty && pattern) {
            // Found results — clear the empty history for this pattern
            _emptySearchHistory.delete(pattern)
          }
        }

        // For screenshots, send the full content (with base64 image) to the renderer
        // but strip the image data from the model context to save tokens
        let rendererContent = content
        let modelContent = content
        if (_screenshotImg) {
          // Re-attach the image for the renderer
          rendererContent = content.replace('[screenshot image captured]', _screenshotImg)
          // Model already has the stripped version
          modelContent = content
        }

        // Emit tool-result event (renderer gets full content with images)
        this.send('qwen-event', {
          type: 'tool-result',
          tool_use_id: tc.id,
          content: rendererContent,
          is_error: isError,
        })

        // Screenshot forwarding to Telegram (non-blocking)
        if (fnName === 'browser_screenshot' && !isError && this._telegramForwarder) {
          try {
            const b64Match = (rendererContent || '').match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)
            if (b64Match) {
              const tmpPath = path.join(os.tmpdir(), `screenshot_${Date.now()}.png`)
              fs.writeFileSync(tmpPath, Buffer.from(b64Match[1], 'base64'))
              this._telegramForwarder.sendPhoto(tmpPath, 'Browser screenshot').catch(() => {})
            }
          } catch { /* non-blocking — don't fail the tool call */ }
        }

        // ── Auto-advance todos on successful writes ──────────────────────
        // When a write tool succeeds and there's a todo marked in_progress,
        // auto-mark it done and advance the next pending one to in_progress.
        // This eliminates the need for the agent to waste a turn calling edit_todos.
        const _WRITE_TOOLS_AUTO = new Set(['write_file', 'edit_file', 'edit_file_lines', 'edit_files', 'bash'])
        if (!isError && _lastTodos && _WRITE_TOOLS_AUTO.has(fnName)) {
          const inProgressIdx = _lastTodos.findIndex(t => t.status === 'in_progress')
          if (inProgressIdx !== -1) {
            // For bash: only auto-advance if it looks like a verification step
            // (test pass, build success, lint clean). Don't advance for exploratory commands.
            let shouldAdvance = fnName !== 'bash'
            if (fnName === 'bash') {
              const bashContent = (content || '').toLowerCase()
              const isVerification = /\b(pass|passed|success|ok|0 error|0 warning|build succeeded|tests? passed|all tests)\b/i.test(bashContent)
              shouldAdvance = isVerification
            }
            if (shouldAdvance) {
              // If the next tool call in this turn is also a write, don't advance yet.
              const remainingCalls = toolCalls.slice(toolCalls.indexOf(tc) + 1)
              const nextIsAlsoWrite = remainingCalls.some(rtc => {
                try { return _WRITE_TOOLS_AUTO.has(rtc.function.name) } catch { return false }
              })
              if (!nextIsAlsoWrite) {
                _lastTodos[inProgressIdx].status = 'done'
                // Advance next pending to in_progress
                const nextPending = _lastTodos.find(t => t.status === 'pending')
                if (nextPending) nextPending.status = 'in_progress'
                this.send('qwen-event', { type: 'todo-watch', todos: _lastTodos })
              }
            }
          }
        }

        // Todo watch — await after each tool result to prevent concurrent Metal inference
        if (assistClient && assistClient.TODO_WATCH_ENABLED && _lastTodos) {
          const _todosSnapshot = _lastTodos  // capture current reference
          try {
            const updated = await assistClient.assistTodoWatch(fnName, content, _todosSnapshot)
            if (updated && hasStatusChanges(updated, _todosSnapshot)) {
              _lastTodos = updated  // update the tracked todos
              this.send('qwen-event', { type: 'todo-watch', todos: updated })

              // Re-route when a new todo becomes in_progress
              const newlyActive = updated.find((t, i) => {
                const prev = _todosSnapshot[i]
                return t.status === 'in_progress' && prev?.status !== 'in_progress'
              })
              if (newlyActive && memoryClient && typeof memoryClient.assistRouteTask === 'function') {
                // Use injected routeTask (keyword + small model) if available, else small model only
                let newRole = null
                if (typeof this._routeTask === 'function') {
                  newRole = await this._routeTask(newlyActive.text).catch(() => null)
                } else {
                  newRole = await memoryClient.assistRouteTask(newlyActive.text).catch(() => null)
                }

                if (newRole && newRole !== this._agentRole) {
                  this._agentRole = newRole
                  this.send('qwen-event', { type: 'agent-type', agentType: newRole })
                  this.send('qwen-event', { type: 'routing-decision', agentType: newRole, source: 'todo' })
                  // Update system message so the model gets the new role preamble on the next turn
                  const sysMsg = messages.find(m => m.role === 'system')
                  if (sysMsg) {
                    sysMsg.content = systemPromptCache
                      ? systemPromptCache.getCachedSystemPrompt(
                          newRole, cwd, permissionMode,
                          () => this._buildSystemPrompt(cwd, permissionMode)
                        )
                      : this._buildSystemPrompt(cwd, permissionMode)
                  }
                }
              }
            }
          } catch (_) {}
        }

        // Add tool result to messages (model gets stripped content)
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: modelContent,
        })

        if (isError) consecutiveErrors++
        else consecutiveErrors = 0

        // ── Tool call repetition detection ───────────────────────────────
        // Build a signature from tool name + key arguments to detect loops.
        // When the same call repeats 3+ times (especially with errors), the
        // agent is stuck and needs a hard intervention.
        const _tcSig = fnName + ':' + JSON.stringify(fnArgs).slice(0, 200)
        _recentToolCalls.push({ sig: _tcSig, isError, turn })
        if (_recentToolCalls.length > _TOOL_REPEAT_WINDOW) _recentToolCalls.shift()

        // Count how many times this exact signature appears in the window
        const _sigCount = _recentToolCalls.filter(r => r.sig === _tcSig).length
        const _sigErrorCount = _recentToolCalls.filter(r => r.sig === _tcSig && r.isError).length

        // ── A-B-A-B alternating loop detection ───────────────────────────
        // Track tool names (no args) in a short window. When two distinct tools
        // alternate perfectly for 3+ full cycles (A-B-A-B-A-B), neither is
        // making progress — each feeds an incomplete result to the other.
        // This is distinct from the identical-call detector: the signatures
        // differ each time but the pair repeats.
        _recentToolNames.push(fnName)
        if (_recentToolNames.length > _ABAB_WINDOW) _recentToolNames.shift()
        if (_recentToolNames.length === _ABAB_WINDOW) {
          const [a0, b0, a1, b1, a2, b2] = _recentToolNames
          const isABAB = a0 !== b0 && a0 === a1 && a1 === a2 && b0 === b1 && b1 === b2
          if (isABAB) {
            this.send('qwen-event', {
              type: 'system', subtype: 'warning',
              data: `⚠️ A-B-A-B loop detected: agent is alternating between "${a0}" and "${b0}" without making progress. Breaking the cycle.`,
            })
            _recentToolNames.length = 0
            _recentToolCalls.length = 0
            messages.push({
              role: 'system',
              content: `STOP. You are stuck in an alternating loop: you keep calling "${a0}" and "${b0}" in sequence without making progress. Neither tool is giving you enough to move forward.\n\n` +
                `You MUST break this cycle. Options:\n` +
                `- If you are gathering context: you have enough — stop reading and start writing/editing\n` +
                `- If a file path is wrong: use list_dir(".") to get the full project tree\n` +
                `- If you need a specific pattern: use search_files instead of reading whole files\n` +
                `- If you are truly stuck: call ask_user to get guidance from the user\n` +
                `Do NOT call "${a0}" or "${b0}" again until you have taken a different action first.`,
            })
          }
        }

        if (_sigCount >= _TOOL_REPEAT_THRESHOLD) {
          // Same tool call repeated 3+ times — agent is looping
          const allErrors = _sigErrorCount >= _TOOL_REPEAT_THRESHOLD
          this.send('qwen-event', {
            type: 'system', subtype: 'warning',
            data: `⚠️ Loop detected: the agent called ${fnName} with the same arguments ${_sigCount} times${allErrors ? ' (all failed)' : ''}. Breaking the loop and forcing a different approach.`,
          })

          // Clear the repetition window so we don't re-trigger immediately
          _recentToolCalls.length = 0
          _recentToolNames.length = 0

          // ── Reviewer escalation ──────────────────────────────────────────
          // Use the already-loaded primary model with a focused diagnostic
          // system prompt. No model swap — avoids Metal memory churn and
          // SIGABRT crashes on Apple Silicon.
          this.send('qwen-event', {
            type: 'system', subtype: 'debug',
            data: `🔍 Escalating to reviewer mode for loop diagnosis...`,
          })

          // Build compact diagnostic context from last 6 tool exchanges
          const recentExchanges = messages.slice(-12).map(m => {
            if (m.role === 'system') return null
            if (m.role === 'assistant' && m.tool_calls) {
              const calls = m.tool_calls.map(tc =>
                `  → ${tc.function.name}(${JSON.stringify(tc.function.arguments || {}).slice(0, 120)})`
              ).join('\n')
              return `[assistant tool calls]\n${calls}`
            }
            if (m.role === 'tool') return `[tool result]\n${(m.content || '').slice(0, 400)}`
            if (m.role === 'user') return `[user]\n${(m.content || '').slice(0, 300)}`
            return null
          }).filter(Boolean).join('\n\n')

          const reviewerMessages = [
            {
              role: 'system',
              content: 'You are a senior code reviewer diagnosing a stuck AI agent. The agent is in a tool-call loop and cannot make progress. Analyse the recent tool calls and results, identify the root cause, and provide a concrete 2-3 step action plan to break the loop. Be specific about what tool to call next and with what arguments. Do NOT use any tools yourself — respond with plain text only.',
            },
            {
              role: 'user',
              content: `The agent has called \`${fnName}\` with identical arguments ${_sigCount} times${allErrors ? ' and it failed every time' : ' without making progress'}.\n\nRecent tool exchange:\n${recentExchanges}\n\nWhat is the root cause and what should the agent do next? Give a concrete action plan (2-3 steps max).`,
            },
          ]

          try {
            const reviewerBody = {
              model: model || 'default',
              messages: reviewerMessages,
              stream: false,
              max_tokens: 512,
              temperature: 0.3,
            }
            const reviewerResponse = await new Promise((resolve) => {
              // Hard wall-clock timeout — don't block the agent loop if the
              // server is busy processing another inference on the semaphore.
              const wallTimer = setTimeout(() => resolve(null), 20000)
              const bodyStr = JSON.stringify(reviewerBody)
              const req = http.request({
                hostname: '127.0.0.1', port: SERVER_PORT,
                path: '/v1/chat/completions', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
              }, (res) => {
                let data = ''
                res.on('data', c => data += c)
                res.on('end', () => { clearTimeout(wallTimer); try { resolve(JSON.parse(data)) } catch { resolve(null) } })
              })
              req.on('error', () => { clearTimeout(wallTimer); resolve(null) })
              req.write(bodyStr)
              req.end()
            })
            const diagnosis = reviewerResponse?.choices?.[0]?.message?.content
            if (diagnosis && diagnosis.trim()) {
              this.send('qwen-event', {
                type: 'system', subtype: 'debug',
                data: `🔍 Reviewer diagnosis: ${diagnosis.slice(0, 200)}`,
              })
              messages.push({
                role: 'system',
                content: `REVIEWER DIAGNOSIS:\n\n${diagnosis}\n\nFollow this plan exactly. Do NOT repeat the same ${fnName} call.`,
              })
            } else {
              throw new Error('empty reviewer response')
            }
          } catch (reviewerErr) {
            this.send('qwen-event', {
              type: 'system', subtype: 'debug',
              data: `Reviewer escalation failed (${reviewerErr.message}) — using standard loop-break`,
            })
            if (allErrors) {
              messages.push({
                role: 'system',
                content: `STOP. You have called ${fnName} with the same arguments ${_sigCount} times and it failed every time. This approach is not working. You MUST try a DIFFERENT tool or a DIFFERENT approach entirely.\n\n` +
                  `What failed: ${fnName}(${JSON.stringify(fnArgs).slice(0, 150)})\n` +
                  `Error: ${modelContent.slice(0, 300)}\n\n` +
                  `Options:\n` +
                  `- If you need to read a file, use read_file (not cat/head/tail via bash)\n` +
                  `- If a command needs a password (sudo/ssh), tell the user via ask_user\n` +
                  `- If a path is wrong, use list_dir to find the correct path\n` +
                  `- If you are truly stuck, call ask_user to get help from the user\n` +
                  `Do NOT repeat the same failing call.`,
              })
            } else {
              messages.push({
                role: 'system',
                content: `WARNING: You have called ${fnName} with identical arguments ${_sigCount} times. You are not making progress. Move on to the next step of your task. If you need different information, change your arguments. If you are done reading, start writing/editing.`,
              })
            }
          }
        }

        // Track read-only loops: if the model keeps reading without writing,
        // inject a system nudge to force it to start editing.
        // Paged reads (start_line/end_line) count as 0.5 since they're legitimate
        // navigation of a large file, not aimless re-reading.
        const READ_TOOLS = new Set(['read_file', 'read_files', 'list_dir', 'search_files'])
        const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'edit_file_lines', 'edit_files', 'undo_edit'])
        if (READ_TOOLS.has(fnName) && !isError) {
          const isPagedNav = fnName === 'read_file' && (fnArgs.start_line != null || fnArgs.end_line != null)
          consecutiveReadsWithoutWrite += isPagedNav ? 0.5 : 1
        } else if (WRITE_TOOLS.has(fnName) && !isError) {
          consecutiveReadsWithoutWrite = 0
          _lastFailedEditPath = null  // Clear — successful write
        } else if (WRITE_TOOLS.has(fnName) && isError) {
          // Fix #1 & #2: A failed write attempt (e.g. old_string not found) shows
          // the agent IS trying to write — it just needs to re-read the file to get
          // the correct content. Reset the counter to allow the re-read, and track
          // the target path so it's exempt from future read blocks.
          const editTarget = fnArgs.path || fnArgs.file || null
          if (editTarget) {
            _lastFailedEditPath = editTarget
            _editAttemptedPaths.add(editTarget)
          }
          // Reduce counter significantly — the agent demonstrated write intent
          consecutiveReadsWithoutWrite = Math.max(0, consecutiveReadsWithoutWrite - 4)
        }
        // Escalating enforcement — gets progressively more forceful
        if (consecutiveReadsWithoutWrite === 5) {
          messages.push({
            role: 'system',
            content: `You have made ${consecutiveReadsWithoutWrite} consecutive read/search calls without writing any code. ` +
              `You likely have enough context now. Your NEXT call MUST be one of:\n` +
              `- edit_file to modify an existing file\n` +
              `- write_file to create a new file\n` +
              `- bash to run a command\n` +
              `State in one sentence what you learned, then make your edit.`,
          })
          this.send('qwen-event', { type: 'system', subtype: 'warning', data: `⚠️ Read-only loop detected (${consecutiveReadsWithoutWrite} reads, 0 writes) — nudging agent to start writing` })
        } else if (consecutiveReadsWithoutWrite === 8) {
          messages.push({
            role: 'system',
            content: `STOP READING. You have made ${consecutiveReadsWithoutWrite} read calls without a single write. ` +
              `You are in a read loop. You MUST write code NOW.\n` +
              `Use the information you already have. If you don't know the exact fix, make your best attempt — ` +
              `an imperfect edit is better than reading forever.\n` +
              `Your NEXT tool call MUST be edit_file or write_file. Any further read calls will be rejected.`,
          })
          this.send('qwen-event', { type: 'system', subtype: 'warning', data: `⚠️ Read-only loop escalation (${consecutiveReadsWithoutWrite} reads) — forcing write` })
        } else if (consecutiveReadsWithoutWrite >= 12) {
          // Hard block: reject the read and force a write
          messages.push({
            role: 'system',
            content: `BLOCKED: ${consecutiveReadsWithoutWrite} consecutive reads with zero writes. You are stuck in a loop.\n` +
              `Your read calls are no longer providing new information. You MUST:\n` +
              `1. Use edit_file to fix the issue with what you know NOW\n` +
              `2. If you cannot determine the fix, call ask_user to get guidance\n` +
              `Do NOT call read_file, search_files, or list_dir again until you have written at least one edit.`,
          })
          this.send('qwen-event', { type: 'system', subtype: 'warning', data: `🚫 Read loop BLOCKED (${consecutiveReadsWithoutWrite} reads) — must write or ask_user` })
          // Clear read history so if the agent does finally write, it can re-read after
          _readFileHistory.clear()
          _writeHistory.clear()
        }

        // Check if the model called task_complete — end the session
        if (fnName === 'task_complete' && !isError) {
          const summary = fnArgs.summary || text || 'Task completed.'

          // ── Auto-save session notes for resume ──────────────────────────
          // If the agent didn't explicitly call agent_notes, auto-generate
          // notes from the session so "carry on" after restart has context.
          if (!_agentNotes) {
            const autoNotes = []
            autoNotes.push(`Task: ${summary.slice(0, 200)}`)
            // Collect files that were edited
            const editedFiles = new Set()
            const readFiles = new Set()
            for (const m of messages) {
              if (m.role === 'tool' && typeof m.content === 'string') {
                const editMatch = m.content.match(/^(?:Wrote|Edited)\s+(.+?)(?:\s|$)/)
                if (editMatch) editedFiles.add(editMatch[1])
              }
              if (m.role === 'assistant' && m.content) {
                // Extract file paths from read_file calls in tool_calls
              }
            }
            if (editedFiles.size > 0) autoNotes.push(`Files modified: ${[...editedFiles].join(', ')}`)
            // Collect key findings from assistant messages (last 3 substantive ones)
            const assistantFindings = messages
              .filter(m => m.role === 'assistant' && m.content && m.content.length > 50)
              .slice(-3)
              .map(m => m.content.slice(0, 150))
            if (assistantFindings.length > 0) {
              autoNotes.push(`Key findings: ${assistantFindings.join(' | ')}`)
            }
            _agentNotes = autoNotes.join('\n')
          }
          // Persist notes into the conversation for session resume
          if (_agentNotes) {
            this._lastAgentNotes = _agentNotes  // sync to instance
            messages.push({ role: 'system', content: `[agent_notes]:${_agentNotes}` })
          }

          // ── Memory: session end ─────────────────────────────────────────
          if (memoryClient) {
            memoryClient.archiveRecord('session_end', { session_id: _sessionId, summary }, 'Session ended', {
              agentName: this._agentRole || 'main-agent',
              sessionId: _sessionId,
              projectId: path.basename(cwd),
            }).catch(() => {})
            memoryClient._httpRequest?.('POST', '/memory/session/enrich', { session_id: _sessionId }, 5000).catch(() => {})
          }

          // NOTE: We intentionally do NOT emit an 'ask-user' event here even
          // when the summary contains numbered follow-up options. The renderer's
          // session-end handler already calls _injectQuickReplyChips() which
          // parses the same numbered options out of the task_complete summary
          // and renders clickable quick-reply chips that dispatch the user's
          // choice as a NEW agent run (the correct flow for "what next").
          //
          // Emitting an ask-user event here creates a phantom .ask-user-card
          // whose reply channel (WindowInputRequester.resolveReply) has no
          // pending promise to resolve — so every reply (chip, "Other…" box,
          // and main prompt box, which sendAgentMode routes to the card) is
          // silently dropped. See renderer/app.js _injectQuickReplyChips.

          this.send('qwen-event', {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: summary,
          })

          return
        }
      }

      // Reset planning/repetition counters when tools are used (model is making progress)
      consecutivePlanningNudges = 0
      _annotationNudgeCount = 0
      lastTextResponses = []
      _textOnlyTurns = 0  // Reset — model is using tools again

      // ── Unproductive turn tracking ─────────────────────────────────────
      // Check if this turn produced any "productive" action (file write/edit,
      // successful bash, task_complete). If not, increment the waste counter.
      const _turnToolNames = toolCalls.map(tc => {
        try { return tc.function.name } catch { return '' }
      })
      const _turnHadWrite = _turnToolNames.some(n => ['write_file', 'edit_file', 'edit_file_lines', 'edit_files', 'undo_edit'].includes(n))
      const _turnHadBash = _turnToolNames.includes('bash')
      const _turnHadTodo = _turnToolNames.some(n => ['update_todos', 'edit_todos', 'task_complete'].includes(n))
      // DevTools calls are productive — they gather runtime data the agent can't get from source
      const _turnHadDevTools = _turnToolNames.some(n => n.startsWith('devtools_'))
      // A bash call counts as productive only if it succeeded (not an error)
      const _turnBashSucceeded = _turnHadBash && messages.slice(-toolCalls.length * 2)
        .some(m => m.role === 'tool' && m.content && !m.content.startsWith('Use read_file') && !m.content.includes('Command failed') && !m.content.includes('Command blocked'))

      if (_turnHadWrite || _turnBashSucceeded || _turnHadTodo || _turnHadDevTools) {
        _unproductiveTurns = 0  // Reset — agent did something useful
      } else {
        _unproductiveTurns++
      }

      // ── Checkpoint: force the model to state what it learned and what's next ──
      // Every 3 turns, inject a brief checkpoint that makes the model reflect.
      // This keeps it on task without using the fast model — the main model
      // itself articulates its progress, which the user sees as inline text.
      if (turn > 0 && turn % 3 === 0 && _lastTodos) {
        const done = _lastTodos.filter(t => t.status === 'done' || t.status === 'completed').length
        const total = _lastTodos.length
        const pending = _lastTodos.filter(t => t.status === 'pending').map(t => `${t.id}: ${t.content || t.text || '?'}`).join(', ')
        const inProgress = _lastTodos.find(t => t.status === 'in_progress')
        if (pending) {
          const urgency = turn >= 9 ? ' You are running low on turns — prioritize writing code over gathering more context.' : ''
          messages.push({
            role: 'system',
            content: `CHECKPOINT (turn ${turn}): ${done}/${total} tasks done.${inProgress ? ` Current: "${inProgress.content || inProgress.text}".` : ''} Remaining: ${pending}.\n` +
              `State in ONE sentence what you accomplished since the last checkpoint, then make your next edit_file or write_file call.${urgency}`,
          })
        }
      } else if (turn > 0 && turn % 3 === 0 && !_lastTodos) {
        const urgency = turn >= 9 ? ' You are running low on turns — write code now.' : ''
        messages.push({
          role: 'system',
          content: `CHECKPOINT (turn ${turn}): State what you've accomplished and what you're doing next. Then make your next edit.${urgency}`,
        })
      }

      if (_unproductiveTurns >= _MAX_UNPRODUCTIVE_TURNS) {
        this.send('qwen-event', {
          type: 'system', subtype: 'warning',
          data: `⚠️ The agent has gone ${_unproductiveTurns} turns without writing any files or running successful commands. Auto-stopping to save resources. You can:\n• Send a more specific instruction\n• Start a new session\n• Break the task into smaller steps`,
        })
        this.send('qwen-event', {
          type: 'result',
          subtype: 'warning',
          is_error: false,
          result: `Auto-stopped after ${_unproductiveTurns} unproductive turns. The agent was not making progress — it kept reading/searching without writing any code or running successful commands. Send a follow-up message to continue.`,
        })
        return
      } else if (_unproductiveTurns >= 8 && _unproductiveTurns % 4 === 0) {
        // Build a summary of what the agent has been doing to help it self-correct
        const recentToolSummary = messages.slice(-16)
          .filter(m => m.role === 'assistant' && m.tool_calls)
          .flatMap(m => m.tool_calls.map(tc => tc.function?.name))
          .filter(Boolean)
          .join(', ')
        messages.push({
          role: 'system',
          content: `You have gone ${_unproductiveTurns} turns without writing any files or running successful commands. Your recent tool calls: ${recentToolSummary || 'none'}.\n\nReflect: what have you learned from all this reading? You likely have enough context now. Pick the most important next step and act on it:\n1. Write code with write_file or edit_file\n2. Run a command with bash\n3. If you're genuinely blocked, call ask_user\n4. If you're done, call task_complete\nYou will be auto-stopped at ${_MAX_UNPRODUCTIVE_TURNS} turns without progress.`,
        })
      }

      // Enforce todo list: block progress until todos are created.
      // After the first tool turn, if no todos exist, keep injecting the reminder
      // every turn until the model complies. This is aggressive but necessary
      // because local models often ignore single instructions.
      if (turn >= 1 && !_lastTodos) {
        messages.push({
          role: 'system',
          content: 'BLOCKED: You MUST call update_todos before any other tool. Create your todo list NOW with all steps needed, each set to "pending". No other tools will be effective until you do this. Example: update_todos({"todos": [{"id": 1, "content": "Step 1 description", "status": "pending"}, {"id": 2, "content": "Step 2 description", "status": "pending"}]})',
        })
      }

      // Inject status summary every few turns so the model stays aware of progress
      if (_lastTodos && turn > 0 && turn % 3 === 0) {
        const done = _lastTodos.filter(t => t.status === 'done' || t.status === 'completed').length
        const total = _lastTodos.length
        const pending = _lastTodos.filter(t => t.status === 'pending').map(t => t.content || t.text || t.label || t.title || '?')
        if (pending.length > 0) {
          messages.push({
            role: 'system',
            content: `STATUS: ${done}/${total} todo items complete. Remaining: ${pending.join(', ')}. Keep working. When all done, call task_complete.`,
          })
        }
      }

      // If too many consecutive errors, nudge the model and inform the user
      if (consecutiveErrors >= 3) {
        // Build a summary of recent errors to help the model understand what's going wrong
        const recentToolMsgs = messages.slice(-6).filter(m => m.role === 'tool' && m.content && m.content.includes('must be'))
        const errorSummary = recentToolMsgs.map(m => m.content.split('.')[0]).join('; ')

        // Show user-facing suggestion in chat
        if (consecutiveErrors >= 5) {
          this.send('qwen-event', {
            type: 'system', subtype: 'warning',
            data: `⚠️ The agent has hit ${consecutiveErrors} consecutive errors and may be stuck. You can:\n• Send a follow-up message with more specific instructions\n• Start a new session to reset context\n• Try rephrasing your request more simply`,
          })
        } else {
          this.send('qwen-event', {
            type: 'system', subtype: 'warning',
            data: `⚠️ The agent is having trouble with tool calls (${consecutiveErrors} errors in a row). Attempting to self-correct...`,
          })
        }

        messages.push({
          role: 'system',
          content: `WARNING: ${consecutiveErrors} consecutive tool errors. Recent errors: ${errorSummary || 'missing required parameters'}.\n\nREMINDER — correct tool call formats:\n- read_file({"path": "file.js"})\n- write_file({"path": "file.js", "content": "..."})\n- edit_file({"path": "file.js", "old_string": "...", "new_string": "..."})\n- search_files({"pattern": "searchTerm", "path": "."})\n- bash({"command": "ls -la"})\n- list_dir({"path": "."})\n\nAll parameters shown above are REQUIRED. Do NOT omit any.`,
        })
        consecutiveErrors = 0
      }

      // ── Broader error pattern detection ─────────────────────────────────
      // Detect when the agent keeps hitting the same type of error across
      // different tool calls (e.g. cat → read_file redirect on 20 different
      // files). Look at the last N tool results for repeated error patterns.
      if (_recentToolCalls.length >= 5) {
        const recentErrors = _recentToolCalls.filter(r => r.isError)
        if (recentErrors.length >= 4) {
          // Check if the errors share a common pattern (same error prefix)
          const errorMsgs = messages.slice(-(_TOOL_REPEAT_WINDOW * 2))
            .filter(m => m.role === 'tool' && m.content)
            .map(m => m.content.slice(0, 80))
          const patterns = new Map()
          for (const msg of errorMsgs) {
            // Extract the first 40 chars as a pattern key
            const key = msg.slice(0, 40)
            patterns.set(key, (patterns.get(key) || 0) + 1)
          }
          const topPattern = [...patterns.entries()].sort((a, b) => b[1] - a[1])[0]
          if (topPattern && topPattern[1] >= 4) {
            this.send('qwen-event', {
              type: 'system', subtype: 'warning',
              data: `⚠️ Error pattern detected: "${topPattern[0].slice(0, 50)}..." repeated ${topPattern[1]} times. The agent is stuck hitting the same error with different arguments. Forcing a strategy change.`,
            })
            _recentToolCalls.length = 0
            messages.push({
              role: 'system',
              content: `STOP. You keep hitting the same error repeatedly with different arguments:\n"${topPattern[0]}..."\n\n` +
                `This approach is fundamentally broken. You MUST change your strategy:\n` +
                `- If bash commands keep failing, use the built-in tools instead (read_file, write_file, list_dir)\n` +
                `- If you cannot read files outside the project, use bash with the full path or ask the user\n` +
                `- If a command needs interactive input (password, confirmation), use ask_user to tell the user\n` +
                `- If you are stuck, call ask_user({"question": "I'm having trouble with X. Can you help?"})`,
            })
          }
        }
      }

      // Detect if the agent wrote a tasks.md file — signal the renderer
      // so the orchestrator can pick it up after the session ends.
      // Also break out of the agent loop immediately: the system prompt tells
      // the agent to STOP after writing tasks.md, but without an explicit break
      // the agent continues and produces a text-only "I've created the plan..."
      // response which triggers the planning-loop detector and resets context.
      const writeCall = toolCalls.find(tc => tc.function.name === 'write_file')
      if (writeCall) {
        try {
          const writeArgs = JSON.parse(writeCall.function.arguments)
          const writtenPath = writeArgs.path || ''
          if (writtenPath.endsWith('tasks.md') || writtenPath.endsWith('todo.md')) {
            const resolvedPath = path.resolve(cwd, writtenPath)
            this.send('qwen-event', { type: 'tasks-file-written', path: resolvedPath })
            // Stop the loop — the orchestrator takes over from here
            return
          }
        } catch (_) { /* ignore parse errors */ }
      }
    }

    // Max turns reached
    this.send('qwen-event', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: `(reached ${maxTurns} tool turns — send a follow-up message to continue where I left off)`,
    })
  }

  /**
   * Wait for the MLX server to be reachable before starting work.
   * Shows status updates so the user knows what's happening.
   */
  async _waitForServer(maxWait = 60000) {
    const start = Date.now()
    let attempt = 0
    while (Date.now() - start < maxWait) {
      if (this._aborted) return
      try {
        await new Promise((resolve, reject) => {
          const req = http.get(`${SERVER_URL}/admin/status`, { timeout: 3000 }, (res) => {
            let d = ''; res.on('data', c => d += c)
            res.on('end', () => resolve(d))
          })
          req.on('error', reject)
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
        })
        return // server is up
      } catch {
        attempt++
        if (attempt === 1) {
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: 'Waiting for server to be ready...' })
        } else {
          const elapsed = Math.round((Date.now() - start) / 1000)
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Waiting for server... (${elapsed}s)` })
        }
        // Sleep 2s, checking abort each second
        for (let w = 0; w < 2 && !this._aborted; w++) {
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    }
    throw new Error('Server not available. It may still be loading a model — try again in a moment.')
  }

  /**
   * Stream a single completion from the server, emitting text-delta events
   * as tokens arrive. Returns the accumulated text + any tool_calls.
   */
  async _streamCompletion(messages, cwd, model) {
    return new Promise(async (resolve, reject) => {
      if (this._aborted) return resolve({ text: '', toolCalls: [], usage: null, finishReason: 'stop', reasoningContent: null })

      // ── Performance: cache tool definitions ──────────────────────────────
      // Tool defs only change when agent role or LSP status changes. Caching
      // avoids rebuilding the full tool list (including LSP/browser/xcode
      // filtering) on every turn.
      const lspStatus = this._lspManager?.getStatus().status || 'stopped'
      const toolDefsKey = `${this._agentRole}:${lspStatus}:${(this._allowedTools || []).join(',')}`
      if (toolDefsKey !== this._cachedToolDefsKey) {
        this._cachedToolDefs = getToolDefs(this._lspManager, this._agentRole, this._allowedTools)
        this._cachedToolDefsKey = toolDefsKey
      }

      const body = {
        model: model || 'default',
        messages,
        tools: this._cachedToolDefs,
        stream: true,
        max_tokens: this._adaptiveMaxTokens,
      }
      // Merge sampling parameters (temperature, top_p, repetition_penalty)
      if (this._samplingParams) {
        if (this._samplingParams.temperature != null) body.temperature = this._samplingParams.temperature
        if (this._samplingParams.top_p != null) body.top_p = this._samplingParams.top_p
        if (this._samplingParams.repetition_penalty != null) body.repetition_penalty = this._samplingParams.repetition_penalty
      }

      let accumulated = ''
      let toolCalls = []
      let usage = null
      let finishReason = null
      let buf = ''
      let _lastToolDeltaTime = 0
      let reasoningContent = ''  // Accumulated from server's reasoning_content deltas

      // Client-side prompt size guard: estimate tokens and trim if over budget
      // Use calibrated maxInputTokens + small headroom as the hard cap
      const _scProfile = this._getCalibrationProfile?.()
      const _scMaxInput = _scProfile?.maxInputTokens ?? config.MAX_INPUT_TOKENS
      const preSendLimit = Math.floor(_scMaxInput * 1.04)
      const estimatedTokens = estimateMessagesTokens(messages)
      if (estimatedTokens > preSendLimit) {
        this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Prompt too large (~${estimatedTokens} tokens), trimming to ${preSendLimit} before sending` })
        const trimmed = trimMessages(messages, preSendLimit)
        // If trimMessages didn't reduce enough (large content in recent messages),
        // aggressively truncate the largest messages first.
        // Protect the last 6 messages — those are what the agent is actively using.
        if (estimateMessagesTokens(trimmed) > preSendLimit) {
          const maxTotalChars = Math.floor(preSendLimit * 4)
          const protectedFrom = Math.max(0, trimmed.length - 6)
          const indexed = trimmed.map((m, idx) => ({ idx, len: (m.content || '').length, role: m.role }))
            .filter(e => e.role !== 'system' && e.len > 1500 && e.idx < protectedFrom)
            .sort((a, b) => b.len - a.len)
          let currentChars = trimmed.reduce((sum, m) => sum + (m.content || '').length, 0)
          for (const entry of indexed) {
            if (currentChars <= maxTotalChars) break
            const m = trimmed[entry.idx]
            const allowedChars = Math.max(1000, Math.floor(maxTotalChars / trimmed.length))
            if (m.content.length > allowedChars) {
              const oldLen = m.content.length
              m.content = m.content.slice(0, allowedChars) + '\n\n[§TRIMMED§]'
              currentChars -= (oldLen - m.content.length)
            }
          }
        }
        body.messages = trimmed
      }

      try {
        // ── OpenRouter routing ────────────────────────────────────────────
        // When the user has configured OpenRouter as the provider (via app
        // settings), route the completion request to OpenRouter instead of
        // the local MLX server. The body is OpenAI-compatible so no other
        // changes are needed.
        // Robin Auto mode uses the robin-router to select the best free model.
        let completionUrl = `${SERVER_URL}/v1/chat/completions`
        let extraHeaders = {}
        let _robinModelId = null
        let _robinStartTime = 0
        try {
          const { getAppSettings } = require('./projects')
          const appSettings = getAppSettings()
          if (appSettings.provider === 'openrouter' && appSettings.openrouterApiKey) {
            completionUrl = OPENROUTER_CHAT_URL
            extraHeaders = {
              'Authorization': `Bearer ${appSettings.openrouterApiKey}`,
              'HTTP-Referer': 'https://github.com/qwencoder-mac-studio',
              'X-Title': 'QwenCoder Mac Studio',
            }
            // Robin Auto: use robin-router to pick the best free model
            if (appSettings.robinAutoEnabled) {
              try {
                const { robinRouter } = require('./robin-router')
                if (robinRouter.enabled) {
                  const selected = robinRouter.selectModel()
                  if (selected) {
                    body.model = selected
                    _robinModelId = selected
                    _robinStartTime = Date.now()
                    this.send('qwen-event', { type: 'system', subtype: 'debug', data: `[Robin] routing to ${selected}` })
                  }
                } else {
                  // Robin not ready yet — fall back to OpenRouter auto
                  body.model = 'openrouter/auto'
                  this.send('qwen-event', { type: 'system', subtype: 'debug', data: '[Robin] pool not ready, using openrouter/auto' })
                }
              } catch (_) {
                body.model = 'openrouter/auto'
              }
            } else if (appSettings.openrouterModel) {
              // Use the configured OpenRouter model if set, otherwise keep body.model
              body.model = appSettings.openrouterModel
            }
            // OpenRouter doesn't support repetition_penalty — remove it
            delete body.repetition_penalty
            this.send('qwen-event', { type: 'system', subtype: 'debug', data: `[OpenRouter] routing to ${body.model}` })
          }
        } catch (_) { /* projects not available — use local server */ }

        const { res, req } = await streamSSE(completionUrl, body, extraHeaders)
        this._activeReq = req
        this._sseErrorPending = false

        // Check for HTTP errors — server may return JSON error instead of SSE stream
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = ''
          res.on('data', c => errBody += c)
          res.on('end', () => {
            this._activeReq = null
            let errMsg = `Server returned HTTP ${res.statusCode}`
            try { const parsed = JSON.parse(errBody); errMsg = parsed.error?.message || parsed.detail || errMsg } catch {}
            // Record Robin failure on HTTP error
            if (_robinModelId) {
              try {
                const { robinRouter } = require('./robin-router')
                robinRouter.recordFailure(_robinModelId)
              } catch (_) {}
            }
            reject(new Error(errMsg))
          })
          return
        }

        res.on('data', (chunk) => {
          if (this._aborted) { req.destroy(); return }

          buf += chunk.toString()
          const lines = buf.split('\n')
          buf = lines.pop() // keep incomplete line

          for (const line of lines) {
            if (line.startsWith('data: [DONE]')) continue

            // Handle SSE event: error lines from the server (mid-stream crash)
            if (line.startsWith('event: error')) {
              // The next data: line contains the error payload — set a flag
              this._sseErrorPending = true
              continue
            }

            if (this._sseErrorPending && line.startsWith('data: ')) {
              this._sseErrorPending = false
              let errMsg = 'Server stream error'
              try {
                const errPayload = JSON.parse(line.slice(6))
                errMsg = errPayload.error || errMsg
              } catch {}
              this._activeReq = null
              req.destroy()
              return reject(new Error(`SSE error from server: ${errMsg}`))
            }

            if (!line.startsWith('data: ')) continue

            let parsed
            try { parsed = JSON.parse(line.slice(6)) } catch { continue }

            // Handle prompt processing progress events from server
            if (parsed.x_progress) {
              this.send('qwen-event', {
                type: 'raw-stream',
                event: { x_progress: parsed.x_progress },
              })
              continue
            }

            // Handle usage/stats chunks
            if (parsed.usage && parsed.usage.prompt_tokens) {
              usage = { ...parsed.usage }
              if (parsed.x_stats) {
                usage.prompt_tps = parsed.x_stats.prompt_tps
                usage.generation_tps = parsed.x_stats.generation_tps
                usage.peak_memory_gb = parsed.x_stats.peak_memory_gb
                // Use server's actual token count for compaction decisions
                // (more accurate than client-side chars/4 heuristic)
                if (parsed.x_stats.prompt_tokens_actual) {
                  usage.prompt_tokens = parsed.x_stats.prompt_tokens_actual
                }
              }
              // Forward raw stats to renderer
              this.send('qwen-event', {
                type: 'raw-stream',
                event: {
                  usage: parsed.usage,
                  x_stats: parsed.x_stats || {},
                },
              })
              continue
            }

            const choice = parsed.choices?.[0]
            if (!choice) continue

            // Content delta — stream it immediately
            const delta = choice.delta
            if (delta?.content) {
              accumulated += delta.content
              // Strip hallucinated system annotations in real-time so they never
              // appear in the UI. The model sometimes generates these by mimicking
              // injected markers it sees in context (e.g. "[Response interrupted by ...]").
              // IMPORTANT: keep this specific — do NOT use /\[Response [^\]]*\]/ as that
              // would strip legitimate model output like "[Response: ...]".
              const STREAM_ANNOTATION_RE = /\[Response interrupted[^\]]*\]|\[Response trimmed[^\]]*\]|\[Summarized by[^\]]*\]|\[TRIMMED[^\]]*\]|\[§TRIMMED§[^\]]*\]|\[compressed:\s*\d+%[^\]]*\]/g
              // Also strip raw tool call XML that leaks into the text stream when the
              // model outputs tool calls as XML text rather than structured tool_calls.
              // Matches both complete and partial (still-streaming) tool call blocks.
              // Includes Qwen's <function=name> <parameter=key> format.
              const TOOL_CALL_XML_RE = /<tool_call>[\s\S]*?<\/tool_call>|<\/tool_call>|<function[\s\S]*?<\/function>|><function=[^>]*>[\s\S]*|<function=[^>]*>[\s\S]*|<parameter=[^>]*>[\s\S]*?<\/parameter>|l>\s*function=[\s\S]*/g
              let displayText = accumulated.replace(STREAM_ANNOTATION_RE, '').replace(TOOL_CALL_XML_RE, '').trim()
              // If the accumulated text ends with a partial tool call opener, hide it
              if (displayText.endsWith('<tool_call>') || displayText.endsWith('><function=') || /<tool_call>[^<]*$/.test(displayText) || displayText.endsWith('l>') || /<function=[^>]*$/.test(displayText)) {
                displayText = displayText.replace(/<tool_call>[^<]*$/, '').replace(/<function=[^>]*$/, '').replace(/l>\s*$/, '').trim()
              }
              this.send('qwen-event', { type: 'text-delta', text: displayText })
            }

            // Reasoning content — stream to renderer and preserve for conversation
            // history continuity. The server sends this incrementally so we accumulate
            // and emit thinking-delta events so the UI can show the chain-of-thought.
            if (delta?.reasoning_content) {
              reasoningContent += delta.reasoning_content
              this.send('qwen-event', { type: 'thinking-delta', text: reasoningContent })
            }

            // Tool calls in delta (streaming tool calls)
            // OpenAI streams tool_calls incrementally: each chunk has an index,
            // and name/arguments are built up across multiple deltas.
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                if (!toolCalls[idx]) {
                  toolCalls[idx] = {
                    id: tc.id || `call_${idx}`,
                    type: 'function',
                    function: { name: '', arguments: '' },
                  }
                }
                if (tc.id) toolCalls[idx].id = tc.id
                if (tc.function?.name) {
                  // Name is sent once (not streamed incrementally like arguments),
                  // so set it rather than append to avoid duplication
                  if (!toolCalls[idx].function.name) {
                    toolCalls[idx].function.name = tc.function.name
                  }
                }
                if (tc.function?.arguments) {
                  // Our MLX server sends full JSON args each delta (not fragments),
                  // so replace rather than append. Detect by checking if it starts with '{'
                  const incoming = tc.function.arguments
                  if (incoming.startsWith('{')) {
                    toolCalls[idx].function.arguments = incoming
                  } else {
                    toolCalls[idx].function.arguments += incoming
                  }

                  // ── Speculative tool execution hook ─────────────────────
                  // Each delta, try to parse current args. If they're a
                  // complete, safe tool call, fire a background execution.
                  // If guess is wrong, speculator discards it silently.
                  if (this._speculateEnabled && this._toolSpeculator) {
                    const accumulated = toolCalls[idx].function.arguments
                    const fnName = toolCalls[idx].function.name
                    if (fnName && ToolSpeculator && ToolSpeculator.isSafe(fnName)) {
                      try {
                        const parsedArgs = JSON.parse(accumulated)
                        // Only re-speculate if args changed since last attempt
                        const lastSig = this._specStreamArgs.get(idx)
                        const currentSig = JSON.stringify(parsedArgs)
                        if (lastSig !== currentSig) {
                          this._specStreamArgs.set(idx, currentSig)
                          this._toolSpeculator.speculate(fnName, parsedArgs)
                        }
                      } catch { /* args still streaming — try again next delta */ }
                    }
                  }
                }

                // Stream tool call progress to the renderer so users can see
                // what the agent is generating in real-time (file content, commands, etc.)
                // Throttle to ~15fps to avoid flooding the renderer with tiny deltas
                const currentTc = toolCalls[idx]
                const now = Date.now()
                if (currentTc.function.name && (now - _lastToolDeltaTime > 66)) {
                  _lastToolDeltaTime = now
                  this.send('qwen-event', {
                    type: 'tool-delta',
                    index: idx,
                    id: currentTc.id,
                    name: currentTc.function.name,
                    argumentsSoFar: currentTc.function.arguments,
                  })
                }
              }
              finishReason = 'tool_calls'
            }

            if (choice.finish_reason) {
              finishReason = choice.finish_reason
            }
          }
        })

        res.on('end', () => {
          this._activeReq = null
          // Send final tool-delta for each tool call so the preview shows complete content
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i]
            if (tc && tc.function.name) {
              this.send('qwen-event', {
                type: 'tool-delta',
                index: i,
                id: tc.id,
                name: tc.function.name,
                argumentsSoFar: tc.function.arguments,
              })
            }
          }
          // Record Robin metrics on success
          if (_robinModelId && _robinStartTime) {
            try {
              const { robinRouter } = require('./robin-router')
              robinRouter.recordSuccess(_robinModelId, Date.now() - _robinStartTime)
            } catch (_) {}
          }
          resolve({ text: accumulated, toolCalls, usage, finishReason, reasoningContent: reasoningContent || null })
        })

        res.on('error', (err) => {
          this._activeReq = null
          // Record Robin metrics on failure
          if (_robinModelId) {
            try {
              const { robinRouter } = require('./robin-router')
              robinRouter.recordFailure(_robinModelId)
            } catch (_) {}
          }
          reject(err)
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  /**
   * Poll /admin/status until a model is loaded or timeout expires.
   * Returns true if model became ready, false if timed out.
   * @param {number} maxWaitSec - Maximum seconds to wait
   * @returns {Promise<boolean>}
   */
  async _waitForModelReady(maxWaitSec = 60) {
    const pollInterval = 3000 // 3s between polls
    const maxAttempts = Math.ceil((maxWaitSec * 1000) / pollInterval)
    for (let i = 0; i < maxAttempts; i++) {
      if (this._aborted) return false
      try {
        const ready = await new Promise((resolve) => {
          const req = http.request({
            hostname: '127.0.0.1', port: SERVER_PORT, path: '/admin/status',
            method: 'GET', timeout: 5000,
          }, (res) => {
            let body = ''
            res.on('data', (d) => { body += d })
            res.on('end', () => {
              try {
                const status = JSON.parse(body)
                resolve(!!status.loaded)
              } catch { resolve(false) }
            })
          })
          req.on('error', () => resolve(false))
          req.on('timeout', () => { req.destroy(); resolve(false) })
          req.end()
        })
        if (ready) return true
      } catch { /* ignore */ }
      // Wait before next poll
      for (let w = 0; w < pollInterval / 1000 && !this._aborted; w++) {
        await new Promise(r => setTimeout(r, 1000))
      }
    }
    return false
  }

  _buildSystemPrompt(cwd, permissionMode) {
    const autoEdit = permissionMode === 'auto-edit'

    // Role-specific focus preamble — authoritative source, mirrors ROLE_OVERLAYS in main.js
    // Optimised for Qwen3 35B: numbered constraints, explicit output format, strong action bias
    const rolePreambles = {
      'explore':
        'You are in EXPLORE mode. Investigate the codebase structure and report findings.\n' +
        'CRITICAL: Gather ALL context in minimum turns. Follow this exact sequence:\n' +
        '  Turn 1: list_dir on root to see the full project structure.\n' +
        '  Turn 2: read_files with ALL key files in ONE call (up to 20 files). Include entry points, configs, main source files. Do NOT read one file at a time.\n' +
        '  Turn 3: If needed, one more read_files batch for files you missed. Then STOP reading.\n' +
        '  Turn 4: Summarize findings and call task_complete.\n' +
        'You MUST use read_files (batch) not read_file (single). Maximum 4 turns total.\n' +
        'Constraint: do NOT write or modify any files.\n' +
        'Output format: structured summary — what exists, what works, what\'s missing, recommendations.',

      'context-gather':
        'You are in CONTEXT GATHER mode. Find the exact files and lines needed for a specific task — nothing more.\n' +
        'CRITICAL: Gather ALL context in minimum turns:\n' +
        '  Turn 1: list_dir to identify relevant paths.\n' +
        '  Turn 2: read_files with ALL relevant files in ONE call (up to 20). Do NOT read one file at a time.\n' +
        '  Turn 3: Summarize what you found and call task_complete.\n' +
        'You MUST use read_files (batch) not read_file (single). Maximum 3 turns total.\n' +
        'Constraint: do NOT write or modify any files. Do NOT read the entire project.\n' +
        'Output format: list of `file:line_range — reason it is relevant` entries. Be precise and minimal.',

      'code-search':
        'You are in CODE SEARCH mode. Locate specific symbols, patterns, usages, and call chains.\n' +
        'Strategy: if you don\'t know the variable names used in the codebase, read the file first (or a section of it) to discover naming conventions BEFORE searching. Guessing names wastes turns.\n' +
        'Use search_files with regex patterns, then read_file to confirm matches.\n' +
        'Constraint: do NOT write or modify any files.\n' +
        'Output format: exact file paths, line numbers, and the matching code snippet for each result.',

      'debug':
        'You are in DEBUG mode. Diagnose the root cause before writing any fix.\n' +
        'Required sequence:\n' +
        '  0. Context — read the relevant file (or section) FIRST to learn the actual variable/function names used. Do NOT guess names for search_files — read first, then search with the real names you found.\n' +
        '  1. Reproduce — run the failing command/test with bash. Read the full error and stack trace.\n' +
        '     For web/HTML apps: use devtools_navigate to open the page, then devtools_console_logs to see JavaScript errors and devtools_network_errors for failed requests. This is faster than guessing from source code.\n' +
        '  2. Locate — use search_files with the ACTUAL names you found in step 0.\n' +
        '  3. Hypothesise — state your root cause theory in one sentence before touching code.\n' +
        '     IMPORTANT: Call agent_notes NOW with your hypothesis and key findings (file names, line numbers, variable names). This ensures you can resume if interrupted.\n' +
        '  4. Fix — apply the minimal change. One file at a time.\n' +
        '  5. Verify — re-run the failing command. For web apps, use devtools_console_logs to confirm the error is gone.\n' +
        'Constraint: do NOT skip to step 4 without completing steps 0-3.',

      'tester':
        'You are in TESTER mode. Verify behaviour through the browser, native macOS/iOS app, or desktop automation. Do NOT write or modify application code.\n' +
        '\n' +
        '## For native macOS/iOS apps (Swift/Xcode projects):\n' +
        '  0. PREREQUISITE for iOS apps: run bash({command: "xcrun simctl list runtimes 2>&1"}) FIRST.\n' +
        '     If no iOS runtime is listed, STOP and tell the user: "No iOS simulator runtime installed. Run: xcodebuild -downloadPlatform iOS"\n' +
        '     Do NOT call xcode_setup_project() or xcode_build_run_simulator() without a runtime — it will loop forever.\n' +
        '     Also run bash({command: "xcrun simctl list devices available 2>&1 | head -20"}) to confirm actual devices exist (not just device types).\n' +
        '  1. Call xcode_setup_project() FIRST — it detects iOS vs macOS and returns the exact build commands.\n' +
        '  2. macOS apps: use bash() with the xcodebuild command returned by xcode_setup_project. Then open the .app with bash({command: "open /path/to/App.app"}).\n' +
        '     Do NOT call xcode_build_run_simulator() for macOS — it only works for iOS.\n' +
        '  3. iOS apps: use xcode_build_run_simulator() after xcode_setup_project() configures the session.\n' +
        '  4. To capture the running macOS app: use desktop_screenshot() — it captures the full screen including the running app.\n' +
        '  5. To get the built .app path: bash({command: "xcodebuild -scheme SCHEME -showBuildSettings 2>/dev/null | grep BUILT_PRODUCTS_DIR | head -1 | awk \'{print $3}\'"}).\n' +
        '\n' +
        '## For Electron / desktop apps (non-browser, non-Xcode):\n' +
        '  Use the desktop_* tools to interact with any native app running on screen.\n' +
        '  Required sequence — never skip steps:\n' +
        '  1. desktop_get_screen_size() — know the canvas before placing clicks.\n' +
        '  2. desktop_screenshot() — always look before you act. Describe exactly what you see.\n' +
        '  3. desktop_mouse_move({x, y}) — move to the target coordinates identified in the screenshot.\n' +
        '  4. desktop_mouse_click() — click. Then desktop_screenshot() again to confirm the result.\n' +
        '  5. desktop_keyboard_type({text}) or desktop_keyboard_press({key, modifiers}) — for text input or shortcuts.\n' +
        '  6. Repeat screenshot → act → screenshot until the task is verified.\n' +
        '\n' +
        '  Key rules for desktop automation:\n' +
        '  - ALWAYS take a screenshot before every click. Coordinates from a previous screenshot may be stale.\n' +
        '  - Move the mouse first (desktop_mouse_move), then click (desktop_mouse_click) — do not click without moving.\n' +
        '  - For keyboard shortcuts: desktop_keyboard_press({key: "c", modifiers: ["command"]}) for Cmd+C.\n' +
        '  - To open an app: bash({command: "open -a \\"App Name\\""}) then wait 2s with bash({command: "sleep 2"}), then screenshot.\n' +
        '  - If a click has no visible effect after a screenshot, re-examine coordinates — the UI may have shifted.\n' +
        '  - Use desktop_keyboard_press({key: "tab"}) to move focus between fields; desktop_keyboard_press({key: "return"}) to confirm.\n' +
        '  - Common shortcuts: Cmd+Q quit, Cmd+W close window, Cmd+, preferences, Cmd+R reload.\n' +
        '\n' +
        '## For web apps (browser testing):\n' +
        '  1. browser_navigate to the URL. Then browser_wait_for("body", "visible") before any interaction.\n' +
        '  2. browser_screenshot immediately — this is your baseline. Describe exactly what you see.\n' +
        '  3. One interaction at a time (browser_click / browser_type / browser_select_option), then browser_screenshot.\n' +
        '  4. browser_get_text or browser_evaluate to assert expected state.\n' +
        '  5. browser_close at the end — this saves the video recording.\n' +
        '\n' +
        'Anti-stuck rules (all modes):\n' +
        '  - Never click the same element twice without a screenshot between attempts.\n' +
        '  - If stuck after 3 attempts, describe what you see and use ask_user to get guidance.\n' +
        '  - Blank/black screenshot: the app may not be in focus — bash({command: "open -a \\"App Name\\""}) to bring it forward.\n' +
        '  - iOS simulator loop: if xcode_setup_project() or list_simulators returns no devices more than once, STOP. Tell the user the iOS runtime is missing and call task_complete with a FAIL verdict. Do NOT retry.\n' +
        'Output format: for each step — action taken / expected result / screenshot observation / pass or fail. End with a clear PASS or FAIL verdict.',

      'requirements':
        'You are in REQUIREMENTS mode. Clarify and document what needs to be built.\n' +
        'Constraint: do NOT write implementation code.\n' +
        'Output format: write a .md file using write_file containing — user stories, acceptance criteria, edge cases, out-of-scope items.',

      'design':
        'You are in DESIGN mode. Define the technical architecture before any code is written.\n' +
        'Constraint: do NOT write implementation code.\n' +
        'Output format: write a .md file using write_file containing — component diagram (mermaid), interfaces, data models, API contracts, key decisions and trade-offs.',

      'implementation':
        'You are in IMPLEMENTATION mode. Write and modify code to complete the task.\n' +
        'For CREATING new files: call write_file immediately. Do NOT read other files first unless you need specific content from them. The file tree in your context has all the paths you need.\n' +
        'For EDITING existing files:\n' +
        '  1. Read ONLY the file you are about to edit — do NOT read the entire project.\n' +
        '  2. Make one focused change at a time using edit_file.\n' +
        '  3. After each file change, check LSP diagnostics in the tool result. Fix any errors before continuing.\n' +
        '  4. Verify with bash (run tests, check syntax, start the app).\n' +
        'For FIXING BUGS in web/HTML apps:\n' +
        '  1. Use devtools_navigate to open the page, then devtools_console_logs to see runtime errors.\n' +
        '  2. Read the file where the bug lives (use the Code Map line numbers if available).\n' +
        '  3. Apply the fix with edit_file.\n' +
        '  4. Verify with devtools_console_logs — confirm the error is gone.\n' +
        'For FIXING BUGS in other code:\n' +
        '  1. Read the file where the bug lives FIRST (use the Code Map line numbers if available).\n' +
        '  2. Learn the ACTUAL variable/function names from what you read.\n' +
        '  3. Only THEN search with those exact names if needed. NEVER search with pipe-separated guesses like "hit|damage|kill" — this wastes turns.\n' +
        '  4. Apply the fix with edit_file.\n' +
        'CRITICAL: Do NOT read all project files before starting. If you need file paths, use list_dir — do NOT read file contents just to learn what files exist.\n' +
        'Constraint: each write_file call should be under 300 lines for source code. Generated config files (pbxproj, Package.swift, CMakeLists) can be longer.\n' +
        '\n' +
        '## iOS/Xcode build verification:\n' +
        'Before running xcodebuild or xcode_build_run_simulator(), run: bash({command: "xcrun simctl list runtimes 2>&1"})\n' +
        'If no iOS runtime is listed, STOP trying to build for simulator. Tell the user: "No iOS simulator runtime installed. Run: xcodebuild -downloadPlatform iOS"\n' +
        'Do NOT retry xcode_setup_project() or xcodebuild if simulators are unavailable — it will loop forever. Mark the build verification step as blocked and move on.',

      'general':
        'You are a general-purpose coding assistant. Complete the task using whatever tools are appropriate.\n' +
        'For CREATING new files: use write_file immediately — do not read existing files unless you need specific content from them.\n' +
        'For EDITING existing files: read the target file first to learn the actual variable/function names, then edit. Do NOT guess names for search_files — read a section first.\n' +
        'For DEBUGGING: read the relevant code section first to discover naming conventions, then search with the real names you found.\n' +
        '\n' +
        '## iOS/Xcode build verification:\n' +
        'Before running xcodebuild or xcode_build_run_simulator(), run: bash({command: "xcrun simctl list runtimes 2>&1"})\n' +
        'If no iOS runtime is listed, STOP. Tell the user: "No iOS simulator runtime installed. Run: xcodebuild -downloadPlatform iOS"\n' +
        'Do NOT retry if simulators are unavailable — it will loop forever.',
    }
    const rolePreamble = rolePreambles[this._agentRole] || rolePreambles['general']

    // Orient-first: check whether a code map exists for this project. If it
    // does, the agent gets a strong nudge to read it before searching.
    // Prevents the "search for enemy|Enemy|enemies and get no matches" loop.
    let orientPreamble = ''
    try {
      const fsLocal = require('node:fs')
      const pathLocal = require('node:path')
      const mapPath = pathLocal.join(cwd, '.maccoder', 'steering', 'code-map.md')
      if (fsLocal.existsSync(mapPath)) {
        orientPreamble =
          '\n\n## Orient before searching\n' +
          'A `Code Map` section is included in your project context below. It lists the EXACT class/type names, function signatures, and event handlers used in this codebase.\n' +
          '- Before calling `search_files`, check the Code Map for the name you need. Use the EXACT name listed there — do NOT guess with pipes like `Enemy|enemy|enemies`.\n' +
          '- If the name you are looking for is NOT in the Code Map, the symbol likely does not exist under that name. Read the relevant file from the map to discover the real name, then search.\n' +
          '- For bug fixes: read the file at the line listed in the Code Map first. Then search by the concrete names you found. This stops the "no matches found" loop.\n'
      } else {
        // No code map yet (generator skipped or failed). Fall back to a
        // softer orient rule: read before searching when names are unknown.
        orientPreamble =
          '\n\n## Orient before searching\n' +
          'No Code Map was generated for this project. Before calling `search_files` with guessed names, read ONE relevant file first (via `read_file` or `read_files`) to discover the actual variable, class, and function names used. Then search with those concrete names.\n' +
          'Do NOT run multiple `search_files` calls with pipe-separated guesses like `Enemy|enemy|enemies` — each miss wastes a turn.\n'
      }
    } catch { /* non-fatal */ }

    // Note: the Qwen3 jinja template injects the full tool list automatically into the system block.
    // We do NOT repeat tool descriptions here — that wastes tokens and can confuse the model.
    // We only document tool call format and critical behavioural rules.

    return `You are a coding assistant running on Qwen3. You have access to tools — use them to take real actions.

## Role
${rolePreamble}${orientPreamble}

## Working directory
${cwd}
The project file tree is included at the end of this prompt — read it before calling list_dir on the root.

## Tool call rules
- ALWAYS use tools to read, write, and execute. Never output code or file contents as plain text — the user cannot use it.
- read_file: use this to read source files — NOT bash/cat. read_file handles large files correctly with line ranges and avoids output limits. Never use cat, head, or tail to read source files. For files under 500 lines, read the entire file at once (omit start_line/end_line). For larger files, read in chunks of 500+ lines — never page through a file 200 lines at a time.
- read_files: PREFERRED over read_file when you need 2+ files. Pass all paths in one call — this is 5-10x faster than separate read_file calls. ALWAYS batch your reads: if you know you need multiple files, use read_files({"paths": ["file1.swift", "file2.swift", ...]}) instead of calling read_file on each one separately. Maximum 20 files per call.
- edit_file: re-read the target file before editing IF the file content is no longer in your context (e.g. after compaction). If you just read it this session and it's still visible above, proceed directly with the edit.
- edit_files: PREFERRED over edit_file when editing 2+ different files. Pass an array of {path, old_string, new_string} objects — all edits execute in one call. Much faster than calling edit_file repeatedly. Use this whenever you have edits across multiple files.
- write_file: aim for under 300 lines per call for source code. For generated config files (pbxproj, Package.swift, CMakeLists, etc.) you can write longer files in one call. If a write gets truncated, split into chunks and use bash with heredoc to append.
- bash: prefer single focused commands. Check exit codes in the output. For installs and builds (npm install, pip install, swift build, xcodebuild), the timeout is 5 minutes — use them directly. Always add non-interactive flags to suppress prompts: npm init -y, pip install --no-input, brew install --no-interaction.
- search_files: use regex patterns. Narrow with path/include filters to avoid noise.
- NEVER generate text that looks like system annotations: "[Response interrupted by ...]", "[Response trimmed for context space]", "[Summarized by ...]", or any text in square brackets that mimics system-injected markers. These are NOT part of your output format. If you generate them, they will be stripped and your response will be treated as empty — causing the loop to stall. Always use a tool call to continue your work.

## Progress tracking
Before starting any multi-step task, call update_todos with all steps as "pending". Mark each "in_progress" when you start it and "done" when complete. Call task_complete when all items are done — this is the ONLY way to end a session.

When calling task_complete, your summary MUST:
1. Summarize what you accomplished (2-4 sentences)
2. End with 3 numbered follow-up options the user can pick from

Format:
task_complete({"summary": "I analyzed the project and found X, Y, Z.\n\nWhat would you like to do next?\n1. First option\n2. Second option\n3. Third option"})

The options will be automatically extracted and shown as clickable buttons.

Use **edit_todos** (not update_todos) when you need to:
- Add new steps discovered mid-task: edit_todos({"append": [{"content": "New step", "status": "pending"}]})
- Mark a single item done: edit_todos({"update": [{"id": 3, "status": "done"}]})
- Remove a step that's no longer needed: edit_todos({"remove": [4]})

Use **update_todos** only to set the initial plan or completely reset the list.

## Thinking notes
Use **agent_notes** to write a persistent scratchpad that survives context compaction. Record key discoveries, decisions, constraints, and intermediate findings you want to remember across the entire session. Notes are re-injected automatically after every compaction event — they are your long-term working memory.
Call agent_notes whenever you discover something important: agent_notes({"notes": "Found that X uses Y pattern. Auth is in auth.js line 42. Do NOT touch config.py — it's auto-generated."})
Keep notes concise (under 500 words). Each call replaces the previous notes entirely, so include everything you want to keep.

## Asking the user
When you need the user to choose between options, use the ask_user tool — it renders clickable buttons. Provide short options (under 60 chars each) in the "options" array.

## Planning
For complex tasks the user asks you to plan: write a task graph to .maccoder/tasks.md using write_file, then STOP. The orchestrator will execute each task with a subagent. Format:
\`\`\`
- [ ] 1 First task
- [ ] 2 Second task
- [ ] 3 Third task
\`\`\`

## LSP
After every write_file or edit_file the LSP reports new errors in the tool result. If you see ⚠️ fix the errors before continuing. You can also call lsp_get_diagnostics proactively.

## Compressed context
Large tool results are compressed automatically. If you see [compressed: ... rewind key: rw_XXXX] at the top of a tool result, you can call rewind_context({"key": "rw_XXXX"}) with the EXACT key shown to retrieve the full original. Only use keys you see in actual compression notices — do NOT guess or invent keys.
If you see [TRUNCATED], the file was too large to fit in context. Use read_file with start_line to page through it, or use search_files to find specific patterns.

## Memory system
Your context may include injected blocks — read them before starting work:
- **[Memory Context — from previous sessions]**: relevant facts retrieved from past sessions. Use this to avoid re-discovering things you already know.
- **[Session Resume — prior work]**: a list of actions already completed in this project. Do NOT repeat these searches or file reads unless the user explicitly asks you to redo them.
- **[LSP] errors**: active diagnostics — keep these in mind and avoid making them worse.

If the user asks about something from a past session ("remember when...", "what did I say about..."), that triggers a deeper memory search automatically — you don't need to do anything special.

## Fast assistant (running alongside you)
A small 0.8B model runs in the gaps between your turns. It handles:
- Generating your initial todo list (you can refine it with update_todos)
- Updating todo statuses as tool calls complete
- Summarising large web pages, git diffs, and search results before they reach you
- Diagnosing tool errors with a one-sentence root cause
- Validating tool arguments before execution

You don't need to manage any of this — it happens transparently.

## Anti-loop rules
1. NEVER read the same file twice in one session unless you modified it between reads. If you already read a file and it's still in your context, proceed directly with edit_file.
2. After reading a file, your NEXT action MUST be edit_file, write_file, or bash — not another read_file on a different file. Read only what you need, then act.
3. If you have read 3+ files without writing anything, STOP reading and START writing. You have enough context.
4. Do NOT describe what you plan to do — just do it. Call the tool directly.
5. When creating new files, call write_file immediately. Do NOT read existing files first unless you need specific content from them.
${autoEdit ? '\nAuto-edit mode: proceed with all changes without asking for confirmation.' : ''}`
  }

  async interrupt() {
    this._aborted = true

    // Resolve any pending ask_user request so the tool loop can unblock and exit
    if (this._inputRequester && this._inputRequester.hasPendingRequest()) {
      this._inputRequester.resolveReply('(Interrupted by user)')
    }

    // Track whether we actually had an active request to abort
    let hadActiveRequest = false

    // Destroy agent-loop streaming request
    if (this._activeReq) {
      try { this._activeReq.destroy() } catch {}
      this._activeReq = null
      hadActiveRequest = true
    }

    // Destroy chat-mode request (separate ref — not covered by _activeReq)
    if (this._currentReq) {
      try { this._currentReq.destroy() } catch {}
      this._currentReq = null
      hadActiveRequest = true
    }

    // Reset per-run state so the next run() starts clean
    this._pendingInjections = []
    this._injectionInterrupt = false
    this._pendingDiagnostics = null
    this._coalescedToolCallIds = new Set()
    this._sseErrorPending = false
    this._batchRereadBlocks = 0
    // Clear cached tool defs — LSP status may have changed during the interrupted run
    this._cachedToolDefs = null
    this._cachedToolDefsKey = null

    // ── Clear tool speculator ───────────────────────────────────────────
    // Drop any in-flight speculations — their cwd scope is no longer valid.
    // The speculator itself is recreated in _agentLoop on next run().
    if (this._toolSpeculator) {
      this._toolSpeculator.clear()
      this._toolSpeculator = null
    }
    this._specStreamArgs = new Map()
    this._currentCwd = null

    // ── Clear post-write cache on interrupt ────────────────────────────
    if (this._postWriteCache) this._postWriteCache.clear()

    // ── Persist agent notes on interrupt for session resume ────────────────
    // If the agent saved notes during this run, emit them so the renderer
    // can append them to the session history. On next "carry on", the notes
    // will be found by the _agentNotes restore logic at the start of _agentLoop.
    if (this._lastAgentNotes) {
      this.send('qwen-event', { type: 'agent-notes-persist', notes: this._lastAgentNotes })
    }

    // Only call admin abort if we actually had an active inference request.
    // Calling it unconditionally risks aborting the *next* run's inference
    // if the abort HTTP request resolves after the new run has already started
    // (the request can take up to 9s to resolve).
    if (hadActiveRequest) {
      try { await _callAdminAbort() } catch {}
    }

    this.send('qwen-event', { type: 'session-end' })
  }

  async close() {
    this._aborted = true
    if (this._activeReq) {
      try { this._activeReq.destroy() } catch {}
    }
    if (this._browserInstance) {
      await this._browserInstance.closeBrowser().catch(() => {})
    }
    this._browserInstance = null
    // Clear speculator on close too
    if (this._toolSpeculator) {
      this._toolSpeculator.clear()
      this._toolSpeculator = null
    }
    // Clear post-write cache on close
    if (this._postWriteCache) this._postWriteCache.clear()
    // Stop Chrome DevTools MCP server if running
    if (chromeDevTools) {
      try { chromeDevTools.stopDevTools() } catch {}
    }
  }
}

module.exports = { DirectBridge, WindowSink, CallbackSink, WorkerSink, InputRequester, WindowInputRequester, executeTool, getToolDefs, LSP_TOOL_SETS, LSP_TOOL_DEFS, buildProjectContext, detectEntryPoints, formatSymbolOutline, detectContentType, undoList, undoApply, undoClear, undoRecord, sinkBus }
