const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron')
const path = require('path')
const os = require('os')
const fs = require('node:fs')
const { DirectBridge, WindowSink, WindowInputRequester, sinkBus } = require('./direct-bridge')
const { AgentPool, CATEGORY_KEYWORDS } = require('./agent-pool')
const { loadSteeringDocs, formatSteeringForPrompt } = require('./steering-loader')

// IPC handler modules
const ipcServer = require('./main/ipc-server')
const ipcChat = require('./main/ipc-chat')
const ipcFiles = require('./main/ipc-files')
const ipcProjects = require('./main/ipc-projects')
const ipcTasks = require('./main/ipc-tasks')
const ipcWatcher = require('./main/ipc-watcher')
const ipcLsp = require('./main/ipc-lsp')
const ipcCalibration = require('./main/ipc-calibration')
const ipcSetup = require('./main/ipc-setup')
const ipcTerminal = require('./main/ipc-terminal')
const { LspManager } = require('./lsp-manager')
const { TelegramBot } = require('./telegram-bot')
const { RecordingManager } = require('./recording-manager')
const { RemoteJobController } = require('./remote-job-controller')
const { MiniAppServer } = require('./telegram-miniapp-server')
const { listSpecs } = require('./spec-workflow')

nativeTheme.themeSource = 'dark'

let mainWindow
let qwenBridge = null
let currentProject = null
let lspManager = null
let telegramBot = null
let recordingManager = null
let remoteJobController = null
let miniAppServer = null
let miniAppTunnel = null
let miniAppPublicUrl = null
let setupWindow = null
const SERVER_PORT = 8090
const MINIAPP_PORT = 3847
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`

// ── Subagent system prompts (multi-agent architecture) ───────────────────────
// Each subagent type gets a specialized prompt. Same model, different instructions.

// ── Role overlays ─────────────────────────────────────────────────────────────
// Each role gets a focused preamble injected into the shared core system prompt.
// The core prompt (tools, rules, workflow, LSP) is always present — roles only
// add focus and constraints on top. Both chat and orchestrator modes use this.
//
// These mirror the rolePreambles in direct-bridge.js _buildSystemPrompt but are
// the authoritative source — direct-bridge reads this._agentRole and builds the
// same preamble. Orchestrator tasks set agentRole at bridge construction time.

const ROLE_OVERLAYS = {
  'explore':
    'You are in EXPLORE mode. Open-ended investigation — understand how the codebase works as a whole.\n' +
    'Approach: list_dir → read entry points/config → search_files for patterns → bash to run/check output if helpful.\n' +
    'OUTPUT: Broad summary — structure, data flow, key components, patterns, surprises. Like writing a README for someone new.',

  'context-gather':
    'You are in CONTEXT GATHER mode. Task-scoped retrieval — find exactly the files and lines needed for a specific task, nothing more.\n' +
    'Approach: identify what the task touches → search_files for those patterns → read only relevant sections → trace direct dependencies.\n' +
    'OUTPUT: Tight list of file:line references with one sentence each on why it is relevant. Do NOT summarise the whole codebase.',

  'code-search':
    'You are in CODE SEARCH mode. Find specific patterns, definitions, usages, and call hierarchies — do NOT modify files.\n' +
    'Use search_files with regex and read_file to examine results.\n' +
    'OUTPUT: Exact file paths, line numbers, and code snippets.',

  'debug':
    'You are in DEBUG mode. Diagnose before you fix — follow this order strictly:\n' +
    '(1) Reproduce: run the failing test/command with bash, read the full error/stack trace.\n' +
    '(2) Hypothesise: use LSP call hierarchy and go-to-definition to trace the failure origin.\n' +
    '(3) Confirm root cause before touching any code.\n' +
    '(4) Apply the minimal fix.\n' +
    '(5) Re-run to verify.\n' +
    'Do NOT guess and patch — diagnose first.',

  'tester':
    'You are in TESTER mode. You can test web apps (Playwright), iOS apps (XcodeBuildMCP), and macOS apps (xcodebuild).\n' +
    '\n' +
    'ALWAYS start with xcode_setup_project() for any Swift/Xcode project — it auto-detects iOS vs macOS.\n' +
    '\n' +
    'For macOS apps (xcode_setup_project will tell you the exact commands):\n' +
    '1. xcode_setup_project() — detects macOS, returns exact xcodebuild commands\n' +
    '2. Build: bash({command: "xcodebuild -project ... -scheme ... build 2>&1 | tail -50"})\n' +
    '3. Run: bash({command: "open /path/to/App.app"}) — launches the built app\n' +
    '4. Test: bash({command: "xcodebuild -project ... -scheme ... -destination \\"platform=macOS\\" test 2>&1 | tail -80"})\n' +
    '5. Screenshot: use Playwright browser_screenshot or bash screencapture for macOS UI\n' +
    '\n' +
    'For iOS apps:\n' +
    '1. xcode_setup_project() — configures simulator automatically\n' +
    '2. xcode_build_run_simulator() — build + install + launch. Auto-opens the Simulator.app window, pushes a screenshot to the preview panel, and captures the UI hierarchy.\n' +
    '3. xcode_snapshot_ui() — full view hierarchy with coordinates\n' +
    '4. xcode_test() — XCTest results\n' +
    '5. xcode_get_coverage_report() + xcode_get_file_coverage() for coverage\n' +
    '\n' +
    'For web apps: navigate → screenshot → interact → screenshot → verify → browser_close.\n' +
    '\n' +
    'Anti-stuck: if xcode-select error, run: bash({command: "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"})',

  'requirements':
    'You are in REQUIREMENTS mode. Clarify and document what needs to be built — do NOT write implementation code.\n' +
    'Output structured requirements: user stories, acceptance criteria, edge cases, constraints.\n' +
    'Write the document to a .md file using write_file.',

  'design':
    'You are in DESIGN mode. Define architecture and technical design — do NOT write implementation code.\n' +
    'Output: interfaces, data models, component boundaries, interaction patterns, API contracts.\n' +
    'Use mermaid diagrams where helpful. Write the document to a .md file using write_file.',

  'implementation':
    'You are in IMPLEMENTATION mode. Focus on writing and modifying code.\n' +
    'Read relevant files first, then make surgical changes with write_file/edit_file.\n' +
    'Use LSP diagnostics to validate changes. Verify with bash. Each write_file under 300 lines.\n' +
    '\n' +
    'For Swift/Xcode projects:\n' +
    '1. Call xcode_setup_project() first — auto-detects project, scheme, and simulator.\n' +
    '2. After writing .swift files, call xcode_build_simulator() to validate — it returns structured errors with file/line.\n' +
    '3. Fix all build errors before calling task_complete. Use xcode_get_build_settings() to check SWIFT_VERSION, DEPLOYMENT_TARGET, BUNDLE_ID.\n' +
    '4. Use xcode_clean() only if you suspect stale derived data is causing phantom errors.',

  'general':
    'You are a general-purpose coding assistant. Adapt your approach to whatever the task requires.',

  'chat':
    'You are in CHAT mode. Answer questions, explain concepts, brainstorm, and discuss code directly in your response.\n' +
    'You may include code snippets and examples inline. Do NOT call tools or write files — respond conversationally.',
}

// ── Routing instruction builder for branch point tasks ────────────────────────
/**
 * Build routing instruction text for a branch point task.
 * Returns an instruction block explaining the RoutingDecision JSON format,
 * listing valid downstream task IDs, and providing an example.
 *
 * @param {Array<{id: string, title: string}>} routableTasks - Valid downstream tasks
 * @returns {string} Routing instruction block to append to system prompt
 */
function buildRoutingInstructions(routableTasks) {
  if (!routableTasks || routableTasks.length === 0) return ''

  const taskList = routableTasks
    .map(t => `- ${t.id}: ${t.title}`)
    .join('\n')

  const exampleId = routableTasks[0].id

  return `\n\n## Routing Instructions

You are executing a branch point task. After completing your analysis, you MUST return a routing decision as a JSON object.

### RoutingDecision Format
{"route": "<taskId>" | ["<taskId>", ...], "reason": "<optional explanation>"}

### Valid Task IDs
${taskList}

### Example
{"route": "${exampleId}", "reason": "Condition X is met, proceeding with this option"}`
}

const { SAFE_EDIT_INSTRUCTIONS } = require('./orchestrator');

const agentPool = new AgentPool({
  maxConcurrency: 1,
  getCalibrationProfile: ipcServer.getCalibrationProfile,
  safeEditInstructions: SAFE_EDIT_INSTRUCTIONS,
  agentFactory: (task, agentType, context) => {
    const typeName = agentType?.name || 'general'
    const cwd = task.cwd || currentProject || process.cwd()
    console.log('[agent-factory] Creating', typeName, 'agent for task:', task.id, task.title)

    // Ensure the working directory exists — for new projects being scaffolded
    // from scratch, the directory may not exist yet when the first task runs.
    try {
      const fs = require('node:fs')
      if (!fs.existsSync(cwd)) {
        fs.mkdirSync(cwd, { recursive: true })
        console.log('[agent-factory] Created project directory:', cwd)
      }
    } catch (err) {
      console.warn('[agent-factory] Could not create cwd:', err.message)
    }

    const bridge = new DirectBridge(new WindowSink(mainWindow), {
      agentRole: typeName,
      allowedTools: agentType?.allowedTools || null,
      lspManager,
      getCalibrationProfile: ipcServer.getCalibrationProfile,
      inputRequester: qwenBridge?._inputRequester || null,
      routeTask: async (title) => {
        const kwType = agentPool.selectType({ title, description: '' })
        const kwName = kwType?.name || 'general'
        if (kwName !== 'general') return kwName
        if (_memoryClientForRouting?.assistRouteTask) {
          return await _memoryClientForRouting.assistRouteTask(title).catch(() => null)
        }
        return null
      },
    })

    // The bridge already has agentRole set — _buildSystemPrompt will inject the correct
    // role overlay. We only need to add steering docs and routing instructions on top.
    let systemOverride = bridge._buildSystemPrompt(cwd, 'auto-edit')

    // Inject steering docs after base prompt, before routing instructions
    const steeringDocs = loadSteeringDocs(cwd)
    const steeringContent = formatSteeringForPrompt(steeringDocs)
    if (steeringContent) {
      systemOverride += '\n\n' + steeringContent
    }

    // Append routing instructions for branch point tasks
    if (task.markers && task.markers.branch && task._routableTasks) {
      systemOverride += buildRoutingInstructions(task._routableTasks)
    }

    return {
      run: async ({ prompt }) => {
        console.log('[agent-factory] Running', typeName, 'task:', task.id, 'at', Date.now())
        // Build the task prompt — keep it focused on just this task
        // Spec context is trimmed to avoid overwhelming the model
        let taskPrompt = `Task: ${prompt}`
        if (task.specContext) {
          // Truncate spec context to first 2000 chars to avoid OOM and prompt echoing
          const trimmedContext = task.specContext.length > 2000
            ? task.specContext.slice(0, 2000) + '\n\n[... truncated for brevity ...]\n'
            : task.specContext
          taskPrompt = `# Spec Context (summary)\n\n${trimmedContext}\n---\n\n# Current Task\n\n${prompt}\n\nImplement ONLY this task. Use write_file/edit_file tools directly. Do not output code in chat.`
        }
        try {
          bridge._task = task  // expose task metadata (initialTodos, etc.) to _agentLoop
          await bridge.run({
            prompt: taskPrompt,
            cwd,
            permissionMode: 'auto-edit',
            systemPromptOverride: systemOverride,
            samplingParams: { temperature: 0.3, top_p: 0.9, repetition_penalty: 1.05 },
          })
          console.log('[agent-factory] Task completed:', task.id)
          await bridge.close().catch(() => {})
          return { output: 'done' }
        } catch (err) {
          console.error('[agent-factory] Task error:', task.id, err.message)
          await bridge.close().catch(() => {})
          throw err
        }
      },
      interrupt: () => bridge.interrupt(),
    }
  },
})

// Register subagent types with keyword matching
agentPool.registerType({ name: 'explore', systemPrompt: '', allowedTools: ['read_file', 'read_files', 'list_dir', 'search_files', 'bash', 'web_search', 'web_fetch'] })
agentPool.registerType({ name: 'context-gather', systemPrompt: '', allowedTools: ['read_file', 'read_files', 'list_dir', 'search_files', 'web_search', 'web_fetch'] })
agentPool.registerType({ name: 'code-search', systemPrompt: '', allowedTools: ['read_file', 'read_files', 'list_dir', 'search_files', 'bash'] })
agentPool.registerType({ name: 'requirements', systemPrompt: '', allowedTools: [] })
agentPool.registerType({ name: 'design', systemPrompt: '', allowedTools: [] })
agentPool.registerType({ name: 'debug', systemPrompt: '', allowedTools: [
  'read_file', 'read_files', 'list_dir', 'search_files', 'bash', 'web_search', 'web_fetch',
  // Xcode / Swift — needed to reproduce crashes, read logs, inspect build errors
  'xcode_setup_project', 'xcode_discover_projects', 'xcode_set_defaults', 'xcode_show_defaults',
  'xcode_build_simulator', 'xcode_get_build_settings',
  'xcode_start_log_capture', 'xcode_stop_log_capture',
  'xcode_snapshot_ui', 'xcode_screenshot_simulator', 'xcode_open_simulator_window',
] })
agentPool.registerType({ name: 'tester', systemPrompt: '', allowedTools: [
  // Browser (web testing)
  'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type',
  'browser_get_text', 'browser_get_html', 'browser_evaluate', 'browser_wait_for',
  'browser_select_option', 'browser_close',
  // General
  'bash', 'read_file', 'read_files', 'list_dir', 'search_files',
  // Xcode / iOS / Swift testing
  'xcode_setup_project', 'xcode_discover_projects', 'xcode_set_defaults', 'xcode_show_defaults',
  'xcode_list_schemes', 'xcode_list_simulators', 'xcode_boot_simulator', 'xcode_open_simulator_window',
  'xcode_build_simulator', 'xcode_build_run_simulator', 'xcode_test', 'xcode_clean',
  'xcode_get_build_settings', 'xcode_snapshot_ui', 'xcode_screenshot_simulator',
  'xcode_start_log_capture', 'xcode_stop_log_capture',
  'xcode_get_coverage_report', 'xcode_get_file_coverage',
  'xcode_get_bundle_id', 'xcode_get_app_path', 'xcode_record_video',
] })
agentPool.registerType({ name: 'implementation', systemPrompt: '', allowedTools: [
  'read_file', 'read_files', 'write_file', 'edit_file', 'edit_files', 'list_dir', 'bash', 'search_files', 'web_search', 'web_fetch',
  // Xcode / Swift — build-validate loop after writing Swift code
  'xcode_setup_project', 'xcode_discover_projects', 'xcode_set_defaults', 'xcode_show_defaults',
  'xcode_build_simulator', 'xcode_build_run_simulator', 'xcode_get_build_settings', 'xcode_clean',
  'xcode_list_schemes', 'xcode_list_simulators', 'xcode_open_simulator_window',
  'xcode_snapshot_ui', 'xcode_screenshot_simulator',
], timeout: 1800000 }) // 30 min
agentPool.registerType({ name: 'general', systemPrompt: '', allowedTools: [
  'read_file', 'read_files', 'write_file', 'edit_file', 'edit_files', 'list_dir', 'bash', 'search_files', 'web_search', 'web_fetch',
  // Xcode / Swift — general tasks may involve Swift projects
  'xcode_setup_project', 'xcode_discover_projects', 'xcode_build_simulator', 'xcode_build_run_simulator',
  'xcode_get_build_settings', 'xcode_open_simulator_window', 'xcode_snapshot_ui', 'xcode_screenshot_simulator',
], timeout: 1800000 }) // 30 min

// ── shared accessors for IPC modules ──────────────────────────────────────────
const ctx = {
  getMainWindow: () => mainWindow,
  getServerUrl: () => SERVER_URL,
  getServerPort: () => SERVER_PORT,
  getCurrentProject: () => currentProject,
  setCurrentProject: (p) => {
    currentProject = typeof p === 'string' ? p.trim() : p
    // Start or restart LSP for the new project directory
    if (lspManager) {
      const status = lspManager.getStatus().status
      if (status === 'stopped') {
        lspManager.start(p).catch(() => {})
      } else {
        lspManager.restart(p).catch(() => {})
      }
    }
  },
  getAgentPool: () => agentPool,
  getLspManager: () => lspManager,
  getCalibrationProfile: ipcServer.getCalibrationProfile,
  findPython: ipcServer.findPython,
  appDir: __dirname,
}

// ── register all IPC handlers ─────────────────────────────────────────────────
ipcSetup.register(ipcMain)
ipcServer.register(ipcMain, ctx)
ipcChat.register(ipcMain, ctx)
ipcFiles.register(ipcMain, ctx)
ipcProjects.register(ipcMain, ctx)
ipcTasks.register(ipcMain, ctx)
ipcWatcher.register(ipcMain, ctx)
ipcLsp.register(ipcMain, ctx)
ipcCalibration.register(ipcMain, { getCalibrationProfile: ipcServer.getCalibrationProfile, setCalibrationProfile: ipcServer.setCalibrationProfile, isCalibrating: ipcServer.isCalibrating })
ipcTerminal.register(ipcMain, ctx)

// ── Setup: launch main window from setup wizard ───────────────────────────────
ipcMain.handle('setup-launch-main', async () => {
  createWindow()
  // Server is already running from the background start during setup
  // Just notify the new main window of its status
  ipcServer.waitForServer(SERVER_URL).then(ok => {
    mainWindow?.webContents.send('server-status', { running: ok })
  })
  if (setupWindow) {
    // Small delay so the main window can paint before setup closes
    setTimeout(() => {
      setupWindow?.close()
      setupWindow = null
    }, 400)
  }
  return { ok: true }
})

// ── Setup: open wizard from main app (settings panel) ────────────────────────
// Does NOT clear the setup-complete flag — a restart won't re-trigger the wizard.
// The flag is only cleared if the user explicitly clicks "Reset & Start Fresh".
ipcMain.handle('open-setup-wizard', async () => {
  if (!setupWindow) {
    createSetupWindow()
  } else {
    setupWindow.focus()
  }
  return { ok: true }
})

// ── Setup: reset flag and reopen (explicit "start fresh" action) ──────────────
ipcMain.handle('setup-reset-and-open', async () => {
  ipcSetup.resetSetup()
  if (!setupWindow) {
    createSetupWindow()
  } else {
    setupWindow.focus()
  }
  return { ok: true }
})

// ── IPC: Qwen Code agent ─────────────────────────────────────────────────────
// Memory client for small-model routing (gracefully degrades if unavailable)
let _memoryClientForRouting = null
try { _memoryClientForRouting = require('./memory-client.js') } catch (_) {}

// ── Server request queue ──────────────────────────────────────────────────────
// Serializes all direct HTTP calls to the MLX server so concurrent requests
// (agent run + role generate + calibration) don't race on the Metal GPU.
// Callers await _serverQueue.enqueue(fn) — fn runs when the server is free.
const _serverQueue = (() => {
  let _running = false
  const _waiters = []
  const queue = {
    _agentRunning: false,
    _waiters,
    /** Returns true if the server is currently busy with a request. */
    isBusy() { return _running || this._agentRunning },
    /**
     * Enqueue a function that makes a server request.
     * Returns a promise that resolves with the function's return value.
     * @param {function} fn - async function to run when the server is free
     * @param {object} [opts]
     * @param {boolean} [opts.skipIfBusy] - resolve immediately with null if busy
     * @param {number} [opts.timeoutMs] - reject after this many ms waiting in queue
     */
    enqueue(fn, opts = {}) {
      return new Promise((resolve, reject) => {
        if (opts.skipIfBusy && this.isBusy()) {
          return resolve(null)
        }
        const timeoutMs = opts.timeoutMs || 0
        let timer = null
        const waiter = async () => {
          if (timer) clearTimeout(timer)
          _running = true
          try {
            resolve(await fn())
          } catch (err) {
            reject(err)
          } finally {
            _running = false
            if (_waiters.length > 0) {
              const next = _waiters.shift()
              setImmediate(next)
            }
          }
        }
        if (!this.isBusy()) {
          waiter()
        } else {
          if (timeoutMs > 0) {
            timer = setTimeout(() => {
              const idx = _waiters.indexOf(waiter)
              if (idx !== -1) _waiters.splice(idx, 1)
              reject(new Error('Server request timed out waiting in queue'))
            }, timeoutMs)
          }
          _waiters.push(waiter)
        }
      })
    },
  }
  return queue
})()

ipcMain.handle('qwen-run', async (_, { prompt, cwd, permissionMode, agentRole, model, images, conversationHistory, samplingParams, taskGraphPath }) => {
  if (!qwenBridge) return { error: 'not ready' }
  if (typeof prompt !== 'string' || !prompt.trim()) return { error: 'prompt is required' }
  // Trim cwd to guard against trailing spaces from file pickers or stored project paths
  if (typeof cwd === 'string') cwd = cwd.trim()

  // Use small model to pick the best agent role for this prompt (if no explicit role given)
  let resolvedRole = agentRole || 'general'
  let routedByKeyword = false

  // Continuation phrases — preserve the previous agent role instead of re-routing.
  // When the user says "carry on" after an interrupt/restart, they want the same
  // agent to continue, not get re-routed to explore/general.
  const continuationPhrases = ['carry on', 'continue', 'keep going', 'go ahead', 'proceed',
    'yes', 'yeah', 'yep', 'do it', 'go for it', 'sounds good', 'ok', 'okay', 'sure']
  const promptLower = prompt.toLowerCase().trim()
  const isContinuation = continuationPhrases.some(p => promptLower === p || promptLower.startsWith(p + ' '))
  if (isContinuation && qwenBridge._agentRole && qwenBridge._agentRole !== 'general') {
    resolvedRole = qwenBridge._agentRole
    routedByKeyword = true // skip further routing
  }

  // Route via small model when user hasn't explicitly picked a non-general role
  const isAutoMode = !agentRole || agentRole === 'general'
  if (isAutoMode && !isContinuation) {
    // Keyword matching first — fast, no model call needed for unambiguous signals
    const keywordType = agentPool.selectType({ title: prompt, description: '' })
    const keywordName = keywordType?.name || 'general'

    if (keywordName !== 'general') {
      resolvedRole = keywordName
      routedByKeyword = true
      console.log('[qwen-run] keyword routing:', resolvedRole)
    } else if (_memoryClientForRouting?.assistRouteTask && !images) {
      // Skip small model routing when images are attached — direct-bridge.js
      // handles intent detection and the fast model call would block Metal
      // Ambiguous — fall back to small model
      try {
        const routed = await _memoryClientForRouting.assistRouteTask(prompt.slice(0, 200))
        console.log('[qwen-run] assistRouteTask result:', routed, '→ resolvedRole:', routed || 'general')
        if (routed) resolvedRole = routed
      } catch (err) {
        console.warn('[qwen-run] assistRouteTask failed:', err.message)
      }
    }
  } else {
    console.log('[qwen-run] routing skipped — agentRole:', agentRole, 'hasClient:', !!_memoryClientForRouting?.assistRouteTask)
  }

  // Apply resolved agent role
  if (resolvedRole !== qwenBridge._agentRole) {
    qwenBridge._agentRole = resolvedRole
  }

  // Emit agent-type event so the renderer can show which role was selected
  mainWindow?.webContents.send('qwen-event', { type: 'agent-type', agentType: resolvedRole })

  // Emit a visible routing decision message for the user
  const routingSource = !isAutoMode ? 'manual' : resolvedRole === 'general' ? 'default' : routedByKeyword ? 'keyword' : 'small model'
  mainWindow?.webContents.send('qwen-event', {
    type: 'routing-decision',
    agentType: resolvedRole,
    source: routingSource,
  })

  qwenBridge.run({ prompt, cwd: cwd || currentProject, permissionMode, model, images, conversationHistory, samplingParams, taskGraphPath }).catch(() => {})
  // ── Performance: fine-grained server queue locking ──────────────────
  // Instead of blocking the entire agent run (potentially 10+ minutes),
  // we mark the queue as busy only during inference. The bridge emits
  // 'inference-start' and 'inference-end' events around _streamCompletion
  // calls, allowing the fast model to run during tool execution gaps.
  // Fallback: also listen for session-end to ensure cleanup.
  _serverQueue._agentRunning = true
  const _releaseOnEnd = (data) => {
    if (data && (data.type === 'session-end' || data.type === 'error' || data.type === 'result')) {
      _serverQueue._agentRunning = false
      sinkBus.off('qwen-event', _releaseOnEnd)
      // Drain any queued requests now that the agent is done
      if (_serverQueue._waiters && _serverQueue._waiters.length > 0) {
        const next = _serverQueue._waiters.shift()
        setImmediate(next)
      }
    }
  }
  sinkBus.on('qwen-event', _releaseOnEnd)
  return { ok: true }
})
ipcMain.handle('qwen-interrupt', async () => { await qwenBridge?.interrupt(); return { ok: true } })

// ── IPC: Steering docs ───────────────────────────────────────────────────────
ipcMain.handle('steering-list', async () => {
  if (!currentProject) return { docs: [] }
  const docs = loadSteeringDocs(currentProject)
  return { docs }
})

ipcMain.handle('steering-create', async (_, { name, description, body }) => {
  if (!currentProject) return { error: 'No project open' }
  const fs = require('node:fs')
  const { printSteeringDoc } = require('./steering-loader')
  const steeringDir = path.join(currentProject, '.maccoder', 'steering')
  fs.mkdirSync(steeringDir, { recursive: true })
  const safeName = (name || 'untitled').replace(/\s+/g, '-').toLowerCase()
  const filePath = path.join(steeringDir, `${safeName}.md`)
  const content = printSteeringDoc({ name: name || safeName, description: description || '', auto_generated: false }, body || '')
  fs.writeFileSync(filePath, content, 'utf8')
  return { ok: true, path: filePath }
})

// ── IPC: Agent Roles ─────────────────────────────────────────────────────────
const AGENT_ROLES_PATH = path.join(os.homedir(), '.qwencoder', 'agent-roles.json')

const BUILTIN_ROLES = Object.entries(ROLE_OVERLAYS).map(([name, prompt]) => {
  const icons = { explore:'🔍', 'context-gather':'📚', 'code-search':'🔎', debug:'🐛', tester:'🧪', requirements:'📋', design:'📐', implementation:'🔨', general:'⚡', chat:'💬' }
  const type = agentPool._types.get(name)
  return { name, icon: icons[name] || '🤖', prompt, tools: type?.allowedTools || [], keywords: (CATEGORY_KEYWORDS[name] || []).join(', '), builtin: true }
})

function loadCustomRoles() {
  try {
    if (fs.existsSync(AGENT_ROLES_PATH)) return JSON.parse(fs.readFileSync(AGENT_ROLES_PATH, 'utf8'))
  } catch (_) {}
  return []
}

function saveCustomRoles(roles) {
  fs.mkdirSync(path.dirname(AGENT_ROLES_PATH), { recursive: true })
  fs.writeFileSync(AGENT_ROLES_PATH, JSON.stringify(roles, null, 2), 'utf8')
}

ipcMain.handle('agent-roles-list', async () => {
  const custom = loadCustomRoles()
  return { roles: [...BUILTIN_ROLES, ...custom] }
})

ipcMain.handle('agent-role-save', async (_, role) => {
  if (!role || !role.name) return { error: 'name required' }
  const custom = loadCustomRoles().filter(r => r.name !== role.name)
  custom.push({ ...role, builtin: false })
  saveCustomRoles(custom)
  // Register/update in the live pool
  agentPool.registerType({ name: role.name, systemPrompt: '', allowedTools: role.tools || [] })
  // Update CATEGORY_KEYWORDS for keyword routing
  if (role.keywords) {
    CATEGORY_KEYWORDS[role.name] = role.keywords.split(',').map(k => k.trim()).filter(Boolean)
  }
  return { ok: true }
})

ipcMain.handle('agent-role-delete', async (_, name) => {
  const custom = loadCustomRoles().filter(r => r.name !== name)
  saveCustomRoles(custom)
  return { ok: true }
})

ipcMain.handle('agent-role-generate', async (_, { name, description, existingPrompt }) => {
  if (!qwenBridge) return { error: 'not ready' }

  // If the main agent is running, queue this request rather than crashing Metal
  if (_serverQueue.isBusy()) {
    mainWindow?.webContents.send('qwen-event', {
      type: 'system', subtype: 'debug',
      data: 'Agent role generation queued — waiting for current agent to finish...'
    })
  }

  const allTools = ['read_file', 'read_files', 'write_file', 'edit_file', 'edit_files', 'list_dir', 'bash', 'search_files', 'web_search', 'web_fetch', 'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_get_text', 'browser_evaluate', 'browser_wait_for', 'browser_close']
  const prompt = `You are helping configure a specialized AI coding agent role.

Role name: ${name}
Description: ${description}
${existingPrompt ? `Existing prompt to improve:\n${existingPrompt}\n` : ''}

Available tools: ${allTools.join(', ')}

Generate a JSON object with exactly these fields:
{
  "prompt": "A focused system prompt overlay for this role (2-6 sentences). Start with 'You are in ${name.toUpperCase()} mode.' Describe the workflow, what to focus on, what NOT to do, and expected output format.",
  "tools": ["array", "of", "tool", "names", "from", "the", "available", "list"],
  "keywords": ["keyword1", "keyword2", "...up to 10 keywords that would trigger this role"]
}

Reply with ONLY the JSON object, no other text.`

  try {
    const result = await _serverQueue.enqueue(async () => {
      const http = require('http')
      const body = JSON.stringify({ messages: [{ role: 'user', content: prompt }], max_tokens: 512, temperature: 0.3 })
      return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: SERVER_PORT, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
          let data = ''
          res.on('data', c => data += c)
          res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(new Error(data)) } })
        })
        req.on('error', reject)
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')) })
        req.write(body)
        req.end()
      })
    }, { timeoutMs: 300000 }) // wait up to 5 min for the agent to finish
    const text = result.choices?.[0]?.message?.content || ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { error: 'Model did not return valid JSON' }
    const generated = JSON.parse(jsonMatch[0])
    return { ok: true, prompt: generated.prompt || '', tools: generated.tools || [], keywords: Array.isArray(generated.keywords) ? generated.keywords.join(', ') : '' }
  } catch (err) {
    return { error: err.message }
  }
})

// ── background task events ────────────────────────────────────────────────────
agentPool.on('bg-task-event', (evt) => {
  mainWindow?.webContents.send('bg-task-event', evt)
})
// ── Setup wizard window ───────────────────────────────────────────────────────
function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1000, minHeight: 650,
    resizable: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0f',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  setupWindow.loadFile(path.join(__dirname, 'setup.html'))
  setupWindow.on('closed', () => { setupWindow = null })
}

// ── window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1000, minHeight: 650,
    titleBarStyle: 'hiddenInset', backgroundColor: '#0f0f0f',
    vibrancy: 'under-window', visualEffectState: 'active',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.on('closed', () => { mainWindow = null })
  qwenBridge = new DirectBridge(new WindowSink(mainWindow), {
    getCalibrationProfile: ipcServer.getCalibrationProfile,
    routeTask: async (title) => {
      // Keyword-first, small model fallback — same logic as qwen-run routing
      const kwType = agentPool.selectType({ title, description: '' })
      const kwName = kwType?.name || 'general'
      if (kwName !== 'general') return kwName
      if (_memoryClientForRouting?.assistRouteTask) {
        return await _memoryClientForRouting.assistRouteTask(title).catch(() => null)
      }
      return null
    },
  })

  // Attach a WindowInputRequester so ask_user works in the desktop app
  const _windowInputRequester = new WindowInputRequester(new WindowSink(mainWindow))
  qwenBridge.setInputRequester(_windowInputRequester)

  // IPC: user submits a reply to an ask_user question
  try { ipcMain.removeHandler('ask-user-reply') } catch (_) {}
  ipcMain.handle('ask-user-reply', (_, reply) => {
    console.log('[ask_user] reply received:', reply?.slice(0, 80))
    _windowInputRequester.resolveReply(reply || '')
    return { ok: true }
  })

  // Start LSP manager asynchronously — does not block window creation
  lspManager = new LspManager()
  lspManager.on('status-change', ({ oldStatus, newStatus }) => {
    mainWindow?.webContents.send('lsp-status-change', { oldStatus, newStatus })
  })
  lspManager.on('diagnostics', ({ path: filePath, diagnostics }) => {
    mainWindow?.webContents.send('lsp-diagnostics', { path: filePath, diagnostics })
  })
  qwenBridge.setLspManager(lspManager)
  agentPool.setLspStatusGetter(() => lspManager?.getStatus()?.status)
  if (currentProject) {
    lspManager.start(currentProject).catch(() => {})
  }

  // ── Telegram Bot initialization ──
  const appDataDir = app.getPath('userData')
  telegramBot = new TelegramBot({ appDataDir })
  recordingManager = new RecordingManager({ baseDir: path.join(appDataDir, 'telegram-recordings') })

  /**
   * Build a specRunner object for RemoteJobController.
   * Provides listSpecs() and runSpec(name) backed by the real spec-workflow
   * and task-graph-execute IPC handler.
   * @returns {{ listSpecs: function, runSpec: function }}
   */
  function _makeSpecRunner() {
    return {
      listSpecs() {
        if (!currentProject) return []
        try { return listSpecs(currentProject) } catch { return [] }
      },
      async runSpec(specName) {
        const nodePath = require('node:path')
        const fs = require('node:fs')
        const fsp = require('node:fs/promises')
        const { parseTaskGraph } = require('./task-graph')
        const { Orchestrator } = require('./orchestrator')
        if (!currentProject) throw new Error('No project open')
        const specDir = nodePath.join(currentProject, '.maccoder', 'specs', specName)
        const tasksPath = nodePath.join(specDir, 'tasks.md')
        if (!fs.existsSync(tasksPath)) throw new Error(`No tasks.md found for spec "${specName}"`)

        const md = await fsp.readFile(tasksPath, 'utf-8')
        const graph = parseTaskGraph(md)

        let specContext = ''
        try {
          const reqPath = nodePath.join(specDir, 'requirements.md')
          const designPath = nodePath.join(specDir, 'design.md')
          if (fs.existsSync(reqPath)) specContext += '## Requirements\n\n' + fs.readFileSync(reqPath, 'utf-8') + '\n\n'
          if (fs.existsSync(designPath)) specContext += '## Design\n\n' + fs.readFileSync(designPath, 'utf-8') + '\n\n'
        } catch { /* optional */ }

        const orch = new Orchestrator({
          taskGraph: graph,
          agentPool,
          tasksFilePath: tasksPath,
          specContext,
          lspManager,
          projectDir: currentProject,
          getCalibrationProfile: ipcServer.getCalibrationProfile || null,
        })
        orch.on('task-status-event', (evt) => {
          mainWindow?.webContents.send('task-status-event', evt)
        })
        orch.on('completed', () => {
          mainWindow?.webContents.send('orchestrator-completed')
        })
        return orch.start()
      },
    }
  }

  // Load saved config and auto-start if valid
  const savedConfig = telegramBot.loadConfig()
  if (savedConfig && savedConfig.token && savedConfig.pairedChatId) {
    telegramBot._pairedChatId = savedConfig.pairedChatId
    telegramBot._botUsername = savedConfig.botUsername
    telegramBot.start(savedConfig.token).catch(err => {
      console.warn('[telegram-bot] Auto-start failed:', err.message)
    })
  }

  // Wire command events to RemoteJobController
  telegramBot.on('command', ({ chatId, command, args }) => {
    if (!remoteJobController && telegramBot.getPairedChatId()) {
      remoteJobController = new RemoteJobController({
        telegramBot,
        chatId: telegramBot.getPairedChatId(),
        recordingManager,
        miniAppUrl: () => miniAppPublicUrl,
        sharedBridge: qwenBridge,
        mainWindow,
        cwdGetter: () => currentProject,
        specRunner: _makeSpecRunner(),
      })
      remoteJobController.on('telegram-unavailable', ({ reason, recordingPath }) => {
        mainWindow?.webContents.send('telegram-unavailable', { reason, recordingPath })
      })
    }
    if (remoteJobController) {
      remoteJobController.handleCommand(command, args)
    }
  })

  // Re-create RemoteJobController on pairing
  telegramBot.on('paired', ({ chatId }) => {
    remoteJobController = new RemoteJobController({
      telegramBot,
      chatId,
      recordingManager,
      miniAppUrl: () => miniAppPublicUrl,
      sharedBridge: qwenBridge,
      mainWindow,
      cwdGetter: () => currentProject,
      specRunner: _makeSpecRunner(),
    })
    remoteJobController.on('telegram-unavailable', ({ reason, recordingPath }) => {
      mainWindow?.webContents.send('telegram-unavailable', { reason, recordingPath })
    })
  })

  // ── Telegram plain text → ask_user reply ──
  // When a job runs via the main app (shared bridge), ask_user uses
  // WindowInputRequester. Telegram users can also reply by sending
  // a plain text message — forward it to resolveReply.
  // If no ask_user is pending but the agent is running, inject the message
  // so the user can steer the agent from Telegram.
  telegramBot.on('message', ({ chatId, text }) => {
    if (chatId !== telegramBot.getPairedChatId()) return
    if (!text) return
    // Priority 1: resolve pending ask_user request
    if (_windowInputRequester.hasPendingRequest()) {
      console.log('[telegram→ask_user] forwarding reply:', text?.slice(0, 80))
      _windowInputRequester.resolveReply(text || '')
      return
    }
    // Priority 2: inject into running agent as a follow-up instruction
    if (qwenBridge && qwenBridge._running && typeof qwenBridge.inject === 'function') {
      console.log('[telegram→inject] injecting message:', text?.slice(0, 80))
      qwenBridge.inject(text)
      telegramBot.sendMessage(chatId, `💬 Injected: ${text.slice(0, 100)}`).catch(() => {})
    }
  })

  // ── Telegram IPC handlers ──
  ipcMain.handle('telegram-pair', async () => {
    if (!telegramBot) return { error: 'Bot not initialized' }
    return telegramBot.generatePairingToken()
  })

  ipcMain.handle('telegram-status', async () => {
    if (!telegramBot) return { connected: false, bot_username: null, polling: false, last_error: null, has_token: false, token_masked: null }
    return telegramBot.getStatus()
  })

  ipcMain.handle('telegram-get-token', async () => {
    if (!telegramBot) return { token: null }
    // Return in-memory token if available, otherwise read from saved config
    if (telegramBot._token) return { token: telegramBot._token }
    const saved = telegramBot.loadConfig()
    return { token: saved?.token || null }
  })

  ipcMain.handle('telegram-start', async (event, token) => {
    if (!telegramBot) return { error: 'Bot not initialized' }
    try {
      await telegramBot.start(token)
      return { ok: true }
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('telegram-stop', async () => {
    if (!telegramBot) return { error: 'Bot not initialized' }
    await telegramBot.stop()
    return { ok: true }
  })

  // ── Mirror agent results to Telegram when connected ──
  // This ensures that any agent run (from main chat, mini app, or telegram)
  // sends final results to the paired Telegram chat if the bot is connected.
  sinkBus.on('qwen-event', (data) => {
    if (!telegramBot || !telegramBot.getStatus().connected) return
    const chatId = telegramBot.getPairedChatId()
    if (!chatId) return

    // Only mirror final results — not every intermediate event
    if (data.type === 'result' && !data.is_error) {
      const text = data.result || data.content || ''
      if (text && text !== '__TASK_COMPLETE__') {
        telegramBot.sendMessage(chatId, text).catch(() => {})
      }
    }
    // Notify when a command has been running silently for a long time
    if (data.type === 'bash-waiting') {
      const msg = `⏳ Command still running (${data.elapsedSecs}s with no output):\n\`${data.command}\`\nTimeout in ${data.timeoutSecs - data.elapsedSecs}s`
      telegramBot.sendMessage(chatId, msg).catch(() => {})
    }
  })

  // ── Mini App IPC handlers ──
  ipcMain.handle('miniapp-start', async () => {
    try {
      // Create a stub controller if none exists yet
      if (!remoteJobController) {
        const chatId = telegramBot?.getPairedChatId() || null
        if (chatId) {
          remoteJobController = new RemoteJobController({
            telegramBot,
            chatId,
            recordingManager,
            miniAppUrl: () => miniAppPublicUrl,
            sharedBridge: qwenBridge,
            mainWindow,
            cwdGetter: () => currentProject,
            specRunner: _makeSpecRunner(),
          })
        } else {
          // Create a minimal stub controller for the mini app to work standalone
          // (no Telegram pairing). Uses mutable state so the mini app can track
          // job status via polling and the onRunJob callback handles execution.
          const { EventEmitter } = require('node:events')
          const stubCtrl = Object.assign(new EventEmitter(), {
            _state: 'idle',
            _jobId: null,
            getJobState() { return this._state },
            getJobId() { return this._jobId },
            async handleCommand(command) {
              if (command === 'stop') {
                if (this._state === 'running' && qwenBridge) {
                  qwenBridge.interrupt()
                  this._state = 'idle'
                }
              } else if (command === 'screenshot') {
                let screenshotData = null

                // Try browser screenshot from the shared bridge
                if (qwenBridge && qwenBridge._browserInstance) {
                  try {
                    const result = await qwenBridge._browserInstance.execute('browser_screenshot', {})
                    const content = result.result || ''
                    const b64Match = content.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)
                    if (b64Match) {
                      screenshotData = `data:image/png;base64,${b64Match[1]}`
                    }
                  } catch { /* fall through */ }
                }

                // Fall back to desktop screenshot
                if (!screenshotData) {
                  try {
                    const { executeDesktopTool } = require('./desktop-tool')
                    const result = await executeDesktopTool('desktop_screenshot', {})
                    if (result && result.result) {
                      const b64Match = result.result.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)
                      if (b64Match) {
                        screenshotData = `data:image/png;base64,${b64Match[1]}`
                      }
                    }
                  } catch { /* not available */ }
                }

                if (screenshotData) {
                  this.emit('agent:screenshot', { base64: screenshotData })
                }
              }
            },
          })
          remoteJobController = stubCtrl
        }
      }

      // Start the HTTP/WS server
      if (!miniAppServer) {
        miniAppServer = new MiniAppServer({
          jobController: remoteJobController,
          port: MINIAPP_PORT,
          bridgeStateGetter: () => qwenBridge?._running || false,
          bridgeGetter: () => qwenBridge,
          onStopJob: () => {
            if (qwenBridge) {
              qwenBridge.interrupt()
            }
            remoteJobController._state = 'idle'
            miniAppServer?._handleQwenEvent({ type: 'error', error: 'Job stopped by user' })
          },
          onRunJob: async (prompt) => {
            // Use the SAME qwenBridge as the main UI — so it shows in the app too
            if (!qwenBridge) {
              miniAppServer._logs.push({ type: 'log', text: '❌ Agent not ready (no bridge)', logType: 'error', time: Date.now() })
              return
            }

            const cwd = currentProject || process.cwd()
            const jobId = `miniapp_${Date.now()}`

            // Update controller state for mini app polling
            remoteJobController._state = 'running'
            remoteJobController._jobId = jobId

            miniAppServer._logs.push({ type: 'log', text: `🚀 Job started: ${prompt}`, logType: 'info', time: Date.now() })

            // ── Auto-start server & load model if needed ──
            try {
              const http = require('http')
              const serverReady = await new Promise((resolve) => {
                const req = http.get(`${SERVER_URL}/admin/status`, { timeout: 3000 }, (res) => {
                  let d = ''; res.on('data', c => d += c)
                  res.on('end', () => {
                    try { resolve(JSON.parse(d)) } catch { resolve(null) }
                  })
                })
                req.on('error', () => resolve(null))
                req.on('timeout', () => { req.destroy(); resolve(null) })
              })

              if (!serverReady) {
                // Server not running — start it
                miniAppServer._logs.push({ type: 'log', text: '⏳ Starting MLX server...', logType: 'info', time: Date.now() })
                ipcServer.startServer(SERVER_PORT, __dirname, mainWindow)
                const ok = await ipcServer.waitForServer(SERVER_URL)
                if (!ok) {
                  remoteJobController._state = 'failed'
                  miniAppServer._logs.push({ type: 'log', text: '❌ Failed to start server', logType: 'error', time: Date.now() })
                  return
                }
                miniAppServer._logs.push({ type: 'log', text: '✓ Server started', logType: 'result', time: Date.now() })
              }

              // Check if a model is loaded
              const status = serverReady || await new Promise((resolve) => {
                const req = http.get(`${SERVER_URL}/admin/status`, { timeout: 3000 }, (res) => {
                  let d = ''; res.on('data', c => d += c)
                  res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve({}) } })
                })
                req.on('error', () => resolve({}))
                req.on('timeout', () => { req.destroy(); resolve({}) })
              })

              if (!status.loaded && status.models && status.models.length > 0) {
                // No model loaded but models available — auto-load the first one
                const modelToLoad = status.models[0]
                const modelPath = modelToLoad.path || modelToLoad.id
                miniAppServer._logs.push({ type: 'log', text: `⏳ Loading model: ${modelPath}...`, logType: 'info', time: Date.now() })
                const loadResult = await new Promise((resolve) => {
                  const body = JSON.stringify({ model_path: modelPath })
                  const req = http.request({
                    hostname: '127.0.0.1', port: SERVER_PORT, path: '/admin/load', method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                    timeout: 120000,
                  }, (res) => {
                    let d = ''; res.on('data', c => d += c)
                    res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve({ status: 'ok' }) } })
                  })
                  req.on('error', (err) => resolve({ error: err.message }))
                  req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }) })
                  req.write(body); req.end()
                })
                if (loadResult.error) {
                  remoteJobController._state = 'failed'
                  miniAppServer._logs.push({ type: 'log', text: `❌ Model load failed: ${loadResult.error}`, logType: 'error', time: Date.now() })
                  return
                }
                miniAppServer._logs.push({ type: 'log', text: '✓ Model loaded', logType: 'result', time: Date.now() })
                mainWindow?.webContents.send('server-status', { running: true })
              }
            } catch (err) {
              miniAppServer._logs.push({ type: 'log', text: `⚠️ Server check: ${err.message}`, logType: 'error', time: Date.now() })
              // Continue anyway — _waitForServer in DirectBridge will retry
            }

            // Track job state transitions via sinkBus.
            // The persistent miniAppQwenListener handles log forwarding.
            const logHandler = (data) => {
              if (data.type === 'done' || data.type === 'finish' || data.type === 'session-end') {
                remoteJobController._state = 'completed'
                sinkBus.off('qwen-event', logHandler)
              } else if (data.type === 'error') {
                remoteJobController._state = 'failed'
                sinkBus.off('qwen-event', logHandler)
              }
            }

            // Listen to the events the bridge emits via sinkBus
            sinkBus.on('qwen-event', logHandler)

            // Notify the renderer so it sets up the UI to mirror this remote run
            mainWindow?.webContents.send('remote-run-start', { prompt, source: 'miniapp' })

            // Run using the shared bridge — shows in main app exactly like user typed it
            qwenBridge.run({ prompt, cwd, permissionMode: 'auto-edit' })
              .then(() => {
                if (remoteJobController._state === 'running') {
                  remoteJobController._state = 'completed'
                }
                sinkBus.off('qwen-event', logHandler)
              })
              .catch((err) => {
                remoteJobController._state = 'failed'
                sinkBus.off('qwen-event', logHandler)
              })
          },
        })
        miniAppServer.start()

        // ── Wire ask_user reply from mini app → WindowInputRequester ──
        miniAppServer._inputReplyCallback = (reply) => {
          _windowInputRequester.resolveReply(reply || '')
        }

        // ── Persistent event bridge: main app → mini app ──────────────────
        // Forward ALL qwen-events and task-status-events to the mini app so
        // orchestrator runs, spec tasks, and Telegram-triggered jobs all show
        // up in the mini app regardless of how they were started.
        // Uses sinkBus (shared EventEmitter in direct-bridge.js) because
        // Electron's webContents.on() does NOT intercept webContents.send().
        sinkBus.on('qwen-event', (data) => {
          if (miniAppServer) miniAppServer._handleQwenEvent(data)
        })
        sinkBus.on('task-status-event', (evt) => {
          if (!miniAppServer) return
          const statusEmoji = { in_progress: '⚙️', completed: '✅', failed: '❌', skipped: '⏭', not_started: '⏸' }
          const emoji = statusEmoji[evt.status] || '•'
          const text = `${emoji} Task ${evt.nodeId}: ${evt.status}${evt.error ? ` — ${evt.error}` : ''}`
          miniAppServer._handleQwenEvent({ type: 'text', text })
          miniAppServer._broadcast({ type: 'task_status', nodeId: evt.nodeId, status: evt.status, error: evt.error || null, time: Date.now() })
        })
        sinkBus.on('orchestrator-completed', () => {
          if (miniAppServer) miniAppServer._handleQwenEvent({ type: 'done' })
        })
      }

      // Start cloudflared quick tunnel for public HTTPS access.
      // Quick tunnels (trycloudflare.com) require no Cloudflare account or DNS setup —
      // just cloudflared installed. URL rotates on each restart but always works.
      if (!miniAppTunnel) {
        const { spawn, execSync } = require('node:child_process')

        // Check cloudflared is available before trying to spawn it
        let cloudflaredAvailable = false
        try {
          execSync('cloudflared --version', { stdio: 'ignore', timeout: 5000 })
          cloudflaredAvailable = true
        } catch {
          console.warn('[miniapp] cloudflared not found — tunnel unavailable. Install with: brew install cloudflared')
        }

        if (!cloudflaredAvailable) {
          return { ok: true, localUrl: `http://localhost:${MINIAPP_PORT}`, publicUrl: null, warning: 'cloudflared not installed' }
        }

        const tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${MINIAPP_PORT}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        /**
         * Extract a trycloudflare.com or ngrok URL from a cloudflared log line.
         * Splits by whitespace and checks each token — more robust than a single regex.
         * @param {string} line
         * @returns {string|null}
         */
        function extractTunnelUrl(line) {
          for (const word of line.split(/\s+/)) {
            const clean = word.replace(/[^a-zA-Z0-9.:/-]/g, '')
            if (clean.startsWith('https://') && (
              clean.includes('.trycloudflare.com') ||
              clean.includes('.ngrok.io') ||
              clean.includes('.ngrok-free.app')
            )) {
              return clean
            }
          }
          return null
        }

        // Parse the public URL from cloudflared's stderr/stdout output
        miniAppPublicUrl = await new Promise((resolve, reject) => {
          let resolved = false
          const timeout = setTimeout(() => {
            if (!resolved) reject(new Error('Tunnel startup timed out after 20s — check cloudflared is working'))
          }, 20000)

          const onData = (chunk) => {
            if (resolved) return
            const text = chunk.toString()
            for (const line of text.split('\n')) {
              const url = extractTunnelUrl(line)
              if (url) {
                resolved = true
                clearTimeout(timeout)
                tunnelProcess.stderr.off('data', onData)
                tunnelProcess.stdout.off('data', onData)
                resolve(url)
                return
              }
            }
          }
          tunnelProcess.stderr.on('data', onData)
          tunnelProcess.stdout.on('data', onData)
          tunnelProcess.on('error', (err) => {
            if (!resolved) { resolved = true; clearTimeout(timeout); reject(err) }
          })
          tunnelProcess.on('exit', (code) => {
            if (!resolved) { resolved = true; clearTimeout(timeout); reject(new Error(`cloudflared exited with code ${code}`)) }
          })
        })

        miniAppTunnel = tunnelProcess
        miniAppTunnel.on('exit', () => {
          miniAppTunnel = null
          miniAppPublicUrl = null
          if (remoteJobController) remoteJobController._miniAppUrl = null
          // Reset the bot's menu button since the URL is now dead
          if (telegramBot?._token && telegramBot.getPairedChatId()) {
            const { telegramRequest } = require('./telegram-bot')
            telegramRequest('setChatMenuButton', telegramBot._token, {
              chat_id: telegramBot.getPairedChatId(),
              menu_button: JSON.stringify({ type: 'default' }),
            }).catch(() => {})
          }
        })

        // Update the controller's mini app URL
        if (remoteJobController) {
          remoteJobController._miniAppUrl = miniAppPublicUrl
        }

        // Auto-set the bot's menu button to the mini app URL via Telegram API
        if (telegramBot?._token && telegramBot.getPairedChatId()) {
          const { telegramRequest } = require('./telegram-bot')
          telegramRequest('setChatMenuButton', telegramBot._token, {
            chat_id: telegramBot.getPairedChatId(),
            menu_button: JSON.stringify({
              type: 'web_app',
              text: '⚡ Agent',
              web_app: { url: miniAppPublicUrl },
            }),
          }).catch(() => {}) // best-effort
        }
      }

      return { ok: true, localUrl: `http://localhost:${MINIAPP_PORT}`, publicUrl: miniAppPublicUrl }
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('miniapp-stop', async () => {
    // Reset the bot's menu button back to default
    if (telegramBot?._token && telegramBot.getPairedChatId()) {
      const { telegramRequest } = require('./telegram-bot')
      telegramRequest('setChatMenuButton', telegramBot._token, {
        chat_id: telegramBot.getPairedChatId(),
        menu_button: JSON.stringify({ type: 'default' }),
      }).catch(() => {})
    }
    if (miniAppTunnel) { miniAppTunnel.kill(); miniAppTunnel = null; miniAppPublicUrl = null }
    if (miniAppServer) { miniAppServer.stop(); miniAppServer = null }
    return { ok: true }
  })

  ipcMain.handle('miniapp-status', async () => {
    return {
      running: !!miniAppServer,
      localUrl: miniAppServer ? `http://localhost:${MINIAPP_PORT}` : null,
      publicUrl: miniAppPublicUrl || null,
    }
  })
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Check if first-time setup is needed.
  // Also auto-complete setup if models are already installed — handles the case
  // where the flag was deleted but the user already has everything set up.
  let setupComplete = ipcSetup.isSetupComplete()
  if (!setupComplete) {
    const { scanInstalledModels, selectTier, getHardwareInfo } = ipcSetup
    // Quick sync check: if both recommended models are present, skip the wizard.
    // This handles the case where the flag was deleted but the user already has
    // everything set up. On a genuine first install, no models exist so this
    // check fails and the wizard shows correctly.
    try {
      const { installed, installedFolders } = scanInstalledModels()
      const hasAnyPrimary = Array.from(installedFolders).some(f => f.includes('Qwen3') && f.includes('35B'))
      const hasFast = installedFolders.has('Qwen3.5-0.8B-MLX-8bit')
      if (hasAnyPrimary && hasFast) {
        ipcSetup.markSetupComplete({ autoCompleted: true, reason: 'models already installed' })
        setupComplete = true
        console.log('[setup] Models already installed — skipping wizard')
      }
    } catch (e) {
      console.warn('[setup] Pre-check failed:', e.message)
    }
  }

  if (!setupComplete) {
    createSetupWindow()
    // Start the MLX server in the background so calibration can begin
    // as soon as the user reaches that step — no waiting
    ipcServer.startServer(SERVER_PORT, __dirname, null)
    ipcServer.waitForServer(SERVER_URL).then(ok => {
      // Notify setup window when server is ready (for calibration step)
      setupWindow?.webContents.send('server-status', { running: ok })
    })
  } else {
    createWindow()
    ipcServer.startServer(SERVER_PORT, __dirname, mainWindow)
    ipcServer.waitForServer(SERVER_URL).then(ok => {
      mainWindow?.webContents.send('server-status', { running: ok })
    })
    // Initialize Robin Router if OpenRouter is configured with robin-auto
    try {
      const { getAppSettings } = require('./projects')
      const appSettings = getAppSettings()
      if (appSettings.openrouterApiKey && appSettings.robinAutoEnabled) {
        const { robinRouter } = require('./robin-router')
        robinRouter.start(appSettings.openrouterApiKey).catch(err => {
          console.warn('[robin-router] Failed to start:', err.message)
        })
      }
    } catch (_) {}
  }
})
app.on('window-all-closed', () => {
  _cleanupAndQuit()
})

// Cmd+Q, dock quit, or Finder "Force Quit" — also need to kill the server
app.on('before-quit', () => {
  _cleanupAndQuit()
})

// Last resort — fires right before the process exits no matter what
app.on('will-quit', (e) => {
  if (!_quitting) {
    e.preventDefault()
    _cleanupAndQuit()
  }
})

let _quitting = false
function _cleanupAndQuit() {
  if (_quitting) return
  _quitting = true
  ipcServer.stopServer({ graceful: true })
  ipcWatcher.unwatchProject()
  if (lspManager) lspManager.stop().catch(() => {})
  if (telegramBot) telegramBot.stop()
  if (miniAppTunnel) { miniAppTunnel.kill(); miniAppTunnel = null }
  if (miniAppServer) { miniAppServer.stop(); miniAppServer = null }
  try { require('./robin-router').robinRouter.stop() } catch { /* not loaded */ }
  try { require('./xcode-tool').shutdown() } catch { /* not installed */ }
  // Final safety net: SIGKILL anything still on port 8090 before exiting
  setTimeout(() => {
    ipcServer.killStaleServer(8090)
    app.quit()
  }, 5000)
}
app.on('activate', () => { if (!mainWindow) createWindow() })

// ── exports for testing ───────────────────────────────────────────────────────
module.exports = { buildRoutingInstructions }
