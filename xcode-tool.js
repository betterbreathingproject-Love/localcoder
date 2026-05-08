/**
 * xcode-tool.js — XcodeBuildMCP integration for LocalCoder Mac Studio.
 *
 * Spawns xcodebuildmcp as a stdio MCP server subprocess and exposes its tools
 * to the agent loop via the same interface as LSP tools.
 *
 * Install: npm install -g xcodebuildmcp@latest  OR  brew install xcodebuildmcp
 *
 * Gracefully degrades: if xcodebuildmcp is not installed, all tool calls
 * return a helpful error and the agent falls back to raw bash.
 */
'use strict'

const { spawn } = require('child_process')
const { EventEmitter } = require('node:events')

// ── Tool definitions exposed to the agent ────────────────────────────────────
// Updated for XcodeBuildMCP v2.3.2 which uses a session-based API.
// Call session_set_defaults first, then build/test/etc. with no required args.

const XCODE_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'xcode_setup_project',
      description: 'Auto-discover and configure the Xcode project in the current directory. Works for both iOS and macOS apps. For macOS: detects the platform and returns the exact xcodebuild commands to use (macOS apps build and run directly, no simulator needed). For iOS: configures xcodebuildmcp session with scheme + simulator. Call this FIRST when starting work on any Swift/Xcode project.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_set_defaults',
      description: 'Configure the active XcodeBuildMCP session: set project/workspace path, scheme, simulator, and other build defaults. Call this FIRST before any build/test/run operation. Settings persist for the session.',
      parameters: {
        type: 'object',
        properties: {
          project_path:       { type: 'string', description: 'Path to .xcodeproj file' },
          workspace_path:     { type: 'string', description: 'Path to .xcworkspace file (use instead of project_path for CocoaPods/SPM workspaces)' },
          scheme:             { type: 'string', description: 'Xcode scheme to use for build/test' },
          configuration:      { type: 'string', description: 'Build configuration: Debug or Release (default: Debug)' },
          simulator_name:     { type: 'string', description: 'Simulator name, e.g. "iPhone 16"' },
          simulator_platform: { type: 'string', description: 'Simulator platform, e.g. "iOS Simulator"' },
          platform:           { type: 'string', description: 'Platform: iOS, macOS, watchOS, tvOS' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_show_defaults',
      description: 'Show the current XcodeBuildMCP session defaults (project, scheme, simulator, etc.). Call this to check what is configured before building.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_discover_projects',
      description: 'Scan a directory to find Xcode project (.xcodeproj) and workspace (.xcworkspace) files. Use this to find the project path before calling xcode_set_defaults.',
      parameters: {
        type: 'object',
        properties: {
          workspace_root: { type: 'string', description: 'Directory to scan (defaults to project root)' },
          max_depth:      { type: 'number', description: 'How deep to scan (default: 3)' },
        },
        required: ['workspace_root'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_list_schemes',
      description: 'List all available schemes in an Xcode project or workspace.',
      parameters: {
        type: 'object',
        properties: {
          project_path:   { type: 'string', description: 'Path to .xcodeproj file' },
          workspace_path: { type: 'string', description: 'Path to .xcworkspace file' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_build_simulator',
      description: 'Build the Xcode project for a simulator using the current session defaults. Call xcode_set_defaults first to configure project/scheme/simulator.',
      parameters: {
        type: 'object',
        properties: {
          extra_args: { type: 'array', items: { type: 'string' }, description: 'Extra xcodebuild arguments' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_test',
      description: 'Run tests for the Xcode project using the current session defaults. Call xcode_set_defaults first.',
      parameters: {
        type: 'object',
        properties: {
          extra_args: { type: 'array', items: { type: 'string' }, description: 'Extra xcodebuild arguments' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_clean',
      description: 'Clean the build directory for the current session defaults.',
      parameters: {
        type: 'object',
        properties: {
          platform:   { type: 'string', description: 'Platform override: iOS, macOS, etc.' },
          extra_args: { type: 'array', items: { type: 'string' }, description: 'Extra xcodebuild arguments' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_list_simulators',
      description: 'List available simulators.',
      parameters: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: 'Only show enabled simulators' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_boot_simulator',
      description: 'Boot a simulator by name or UDID.',
      parameters: {
        type: 'object',
        properties: {
          simulator_name: { type: 'string', description: 'Simulator name' },
          simulator_id:   { type: 'string', description: 'Simulator UDID' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_open_simulator_window',
      description: 'Open the Simulator.app window so the booted iOS simulator is visible on screen (and inside the QwenCoder preview panel). Booting a simulator with simctl alone is headless — this brings up the actual window. Called automatically after xcode_build_run_simulator, but you can also call it manually.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_get_build_settings',
      description: 'Get Xcode build settings for the current session (PRODUCT_BUNDLE_IDENTIFIER, SWIFT_VERSION, DEPLOYMENT_TARGET, etc.).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_screenshot_simulator',
      description: 'Take a screenshot of the current simulator.',
      parameters: {
        type: 'object',
        properties: {
          output_path: { type: 'string', description: 'Path to save the screenshot PNG' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_build_run_simulator',
      description: 'Build, install, and launch the app on the iOS Simulator in one step. Boots the simulator automatically. Preferred over separate build + launch steps. ⚠️ iOS ONLY — do NOT use for macOS apps. For macOS: call xcode_setup_project() first, then use bash() with the xcodebuild command it returns, then open the .app with bash({command: "open /path/to/App.app"}).',
      parameters: {
        type: 'object',
        properties: {
          extra_args: { type: 'array', items: { type: 'string' }, description: 'Extra xcodebuild arguments' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_snapshot_ui',
      description: 'Capture the full UI view hierarchy of the running simulator app with precise element coordinates (x, y, width, height). Use this to inspect what is on screen, find UI elements to interact with, or verify UI state after a code change.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_start_log_capture',
      description: 'Start capturing console logs from the running simulator app. Returns a logSessionId to use with xcode_stop_log_capture.',
      parameters: {
        type: 'object',
        properties: {
          capture_console: { type: 'boolean', description: 'Capture console output (default: true)' },
          subsystem_filter: { type: 'string', description: 'Filter logs by subsystem, e.g. "com.example.MyApp"' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_stop_log_capture',
      description: 'Stop log capture and return all captured logs from the simulator app. Call after xcode_start_log_capture.',
      parameters: {
        type: 'object',
        properties: {
          log_session_id: { type: 'string', description: 'Session ID returned by xcode_start_log_capture' },
        },
        required: ['log_session_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_get_coverage_report',
      description: 'Show per-target code coverage from a test run. Run xcode_test first, then pass the xcresult path. Shows which targets have low coverage.',
      parameters: {
        type: 'object',
        properties: {
          xcresult_path: { type: 'string', description: 'Path to the .xcresult bundle from a test run' },
          target: { type: 'string', description: 'Filter to a specific target name' },
          show_files: { type: 'boolean', description: 'Show per-file breakdown (default: false)' },
        },
        required: ['xcresult_path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_get_file_coverage',
      description: 'Show function-level code coverage and uncovered line ranges for a specific Swift file. Use after xcode_test to find exactly which lines need tests.',
      parameters: {
        type: 'object',
        properties: {
          xcresult_path: { type: 'string', description: 'Path to the .xcresult bundle from a test run' },
          file: { type: 'string', description: 'Swift file path or name to inspect, e.g. "MyViewModel.swift"' },
          show_lines: { type: 'boolean', description: 'Show specific uncovered line numbers (default: true)' },
        },
        required: ['xcresult_path', 'file'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_get_bundle_id',
      description: 'Extract the bundle identifier from a built .app bundle. Useful to get the bundle ID before launching or installing.',
      parameters: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Path to the .app bundle' },
        },
        required: ['app_path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_get_app_path',
      description: 'Get the path to the built .app bundle in the simulator derived data. Use this to find the app after building.',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: 'Platform: iOS, macOS, etc.' },
        },
        required: ['platform'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_record_video',
      description: 'Record a video of the simulator screen. Call with start=true to begin, then start=false/stop=true to stop and save.',
      parameters: {
        type: 'object',
        properties: {
          start:       { type: 'boolean', description: 'true to start recording' },
          stop:        { type: 'boolean', description: 'true to stop recording and save' },
          fps:         { type: 'number',  description: 'Frames per second (default: 30)' },
          output_file: { type: 'string',  description: 'Output path for the video file' },
        },
        additionalProperties: false,
      },
    },
  },
]

// Map our tool names to XcodeBuildMCP tool names (v2.3.2 snake_case names)
const TOOL_NAME_MAP = {
  xcode_setup_project:         null,  // handled locally in executeXcodeTool
  xcode_open_simulator_window: null,  // handled locally in executeXcodeTool
  xcode_set_defaults:          'session_set_defaults',
  xcode_show_defaults:         'session_show_defaults',
  xcode_discover_projects:     'discover_projs',
  xcode_build_simulator:       'build_sim',
  xcode_build_macos:           'build_sim',
  xcode_build_run_simulator:   'build_run_sim',
  xcode_test:                  'test_sim',
  xcode_clean:                 'clean',
  xcode_list_schemes:          'list_schemes',
  xcode_list_simulators:       'list_sims',
  xcode_boot_simulator:        'boot_sim',
  xcode_install_app_simulator: 'install_app_sim',
  xcode_launch_app_simulator:  'launch_app_sim',
  xcode_screenshot_simulator:  'screenshot',
  xcode_snapshot_ui:           'snapshot_ui',
  xcode_start_log_capture:     'start_sim_log_cap',
  xcode_stop_log_capture:      'stop_sim_log_cap',
  xcode_get_coverage_report:   'get_coverage_report',
  xcode_get_file_coverage:     'get_file_coverage',
  xcode_get_bundle_id:         'get_app_bundle_id',
  xcode_get_app_path:          'get_sim_app_path',
  xcode_record_video:          'record_sim_video',
  xcode_get_build_settings:    'show_build_settings',
  xcode_resolve_packages:      'clean',
}

// Map our snake_case arg names to XcodeBuildMCP camelCase arg names
const ARG_NAME_MAP = {
  project_path:       'projectPath',
  workspace_path:     'workspacePath',
  workspace_root:     'workspaceRoot',
  scheme:             'scheme',
  configuration:      'configuration',
  simulator_name:     'simulatorName',
  simulator_id:       'simulatorId',
  simulator_platform: 'simulatorPlatform',
  device_id:          'deviceId',
  platform:           'platform',
  bundle_id:          'bundleId',
  extra_args:         'extraArgs',
  max_depth:          'maxDepth',
  output_path:        'outputPath',
  output_file:        'outputFile',
  enabled:            'enabled',
  app_path:           'appPath',
  xcresult_path:      'xcresultPath',
  show_files:         'showFiles',
  show_lines:         'showLines',
  target:             'target',
  file:               'file',
  log_session_id:     'logSessionId',
  capture_console:    'captureConsole',
  subsystem_filter:   'subsystemFilter',
  start:              'start',
  stop:               'stop',
  fps:                'fps',
}

// Map our arg names to XcodeBuildMCP arg names
function _mapArgs(toolName, args) {
  const mapped = {}
  for (const [k, v] of Object.entries(args || {})) {
    const mappedKey = ARG_NAME_MAP[k] || k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    mapped[mappedKey] = v
  }
  return mapped
}

// ── XcodeMCPClient ────────────────────────────────────────────────────────────

class XcodeMCPClient extends EventEmitter {
  constructor() {
    super()
    this._proc = null
    this._ready = false
    this._msgId = 0
    this._pending = new Map()  // id → { resolve, reject, timer }
    this._buf = ''
    this._status = 'stopped'   // 'stopped' | 'starting' | 'ready' | 'error'
    this._errorMsg = null
  }

  /**
   * Find the xcodebuildmcp binary.
   * Checks local node_modules/.bin first (npm dependency), then global npm/homebrew.
   */
  static _findBinary() {
    const { execSync } = require('child_process')
    const path = require('path')
    const fs = require('fs')

    // Local node_modules/.bin (preferred — bundled with the app)
    // In packaged app, resolve from the unpacked asar or app path
    const appRoot = process.resourcesPath
      ? path.join(process.resourcesPath, 'app.asar.unpacked')
      : __dirname
    const localBin = path.join(appRoot, 'node_modules', '.bin', 'xcodebuildmcp')

    const candidates = [
      localBin,
      '/opt/homebrew/bin/xcodebuildmcp',
      '/usr/local/bin/xcodebuildmcp',
      'xcodebuildmcp',
    ]
    // Also check npm global bin
    try {
      const npmBin = execSync('npm bin -g 2>/dev/null', { timeout: 3000 }).toString().trim()
      if (npmBin) candidates.push(`${npmBin}/xcodebuildmcp`)
    } catch { /* ignore */ }

    for (const c of candidates) {
      try {
        if (c === 'xcodebuildmcp') {
          execSync('which xcodebuildmcp', { timeout: 2000 })
          return c
        }
        if (fs.existsSync(c)) return c
      } catch { /* not found */ }
    }
    return null
  }

  /**
   * Start the MCP server subprocess and perform the JSON-RPC handshake.
   */
  async start() {
    if (this._status === 'ready') return { ok: true }
    if (this._status === 'starting') {
      // Wait for existing start to complete
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (this._status !== 'starting') {
            clearInterval(check)
            resolve(this._status === 'ready' ? { ok: true } : { ok: false, error: this._errorMsg })
          }
        }, 100)
      })
    }

    this._status = 'starting'
    const bin = XcodeMCPClient._findBinary()
    if (!bin) {
      this._status = 'error'
      this._errorMsg = 'xcodebuildmcp not installed. Run: npm install -g xcodebuildmcp@latest'
      return { ok: false, error: this._errorMsg }
    }

    return new Promise((resolve) => {
      try {
        this._proc = spawn(bin, ['mcp'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':'),
          },
        })
      } catch (err) {
        this._status = 'error'
        this._errorMsg = `Failed to spawn xcodebuildmcp: ${err.message}`
        return resolve({ ok: false, error: this._errorMsg })
      }

      this._proc.stdout.on('data', (chunk) => this._onData(chunk))
      this._proc.stderr.on('data', (d) => {
        // stderr is informational — log but don't fail
        const line = d.toString().trim()
        if (line) console.log(`[xcode-mcp] ${line}`)
      })
      this._proc.on('exit', (code) => {
        this._status = 'stopped'
        this._proc = null
        // Reject all pending calls
        for (const [, { reject: rej, timer }] of this._pending) {
          clearTimeout(timer)
          rej(new Error(`xcodebuildmcp process exited (code ${code})`))
        }
        this._pending.clear()
      })
      this._proc.on('error', (err) => {
        this._status = 'error'
        this._errorMsg = err.message
        resolve({ ok: false, error: err.message })
      })

      // Send MCP initialize request
      const initId = ++this._msgId
      const initMsg = JSON.stringify({
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'QwenCoderMacStudio', version: '1.0.0' },
        },
      })

      // Wait for initialize response
      const initTimer = setTimeout(() => {
        this._status = 'error'
        this._errorMsg = 'xcodebuildmcp initialize timed out'
        resolve({ ok: false, error: this._errorMsg })
      }, 10000)

      this._pending.set(initId, {
        resolve: (result) => {
          clearTimeout(initTimer)
          // Send initialized notification
          this._send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
          this._status = 'ready'
          this._ready = true
          resolve({ ok: true })
        },
        reject: (err) => {
          clearTimeout(initTimer)
          this._status = 'error'
          this._errorMsg = err.message
          resolve({ ok: false, error: err.message })
        },
        timer: null,
      })

      this._proc.stdin.write(initMsg + '\n')
    })
  }

  _send(msg) {
    if (!this._proc || !this._proc.stdin.writable) return
    this._proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  _onData(chunk) {
    this._buf += chunk.toString()
    const lines = this._buf.split('\n')
    this._buf = lines.pop()  // keep incomplete line
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed)
        if (msg.id !== undefined && this._pending.has(msg.id)) {
          const { resolve, reject, timer } = this._pending.get(msg.id)
          this._pending.delete(msg.id)
          if (timer) clearTimeout(timer)
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)))
          } else {
            resolve(msg.result)
          }
        }
      } catch { /* malformed line — ignore */ }
    }
  }

  /**
   * Call an MCP tool by its XcodeBuildMCP name.
   * @param {string} mcpToolName - e.g. 'buildForSimulator'
   * @param {object} args - Tool arguments (camelCase)
   * @param {number} timeoutMs
   * @returns {Promise<object>} Tool result
   */
  async callTool(mcpToolName, args, timeoutMs = 120000) {
    if (this._status !== 'ready') {
      const start = await this.start()
      if (!start.ok) throw new Error(start.error)
    }

    return new Promise((resolve, reject) => {
      const id = ++this._msgId
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`xcode tool '${mcpToolName}' timed out after ${timeoutMs / 1000}s`))
      }, timeoutMs)

      this._pending.set(id, { resolve, reject, timer })
      this._send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: mcpToolName, arguments: args || {} },
      })
    })
  }

  stop() {
    if (this._proc) {
      try { this._proc.kill('SIGTERM') } catch { /* ignore */ }
      this._proc = null
    }
    this._status = 'stopped'
    this._ready = false
  }

  getStatus() {
    return { status: this._status, error: this._errorMsg }
  }
}

// ── Singleton client ──────────────────────────────────────────────────────────
// One shared client per process — tools/call is stateless so sharing is safe.
let _client = null

function getClient() {
  if (!_client) _client = new XcodeMCPClient()
  return _client
}

/**
 * Execute an xcode_* tool call from the agent loop.
 *
 * @param {string} toolName - Our tool name, e.g. 'xcode_build_simulator'
 * @param {object} args - Tool arguments from the model
 * @param {string} cwd - Working directory (used for project auto-discovery)
 * @returns {Promise<{result?: string, error?: string}>}
 */
async function executeXcodeTool(toolName, args, cwd) {
  // xcode_setup_project is handled locally — no MCP call needed
  if (toolName === 'xcode_setup_project') {
    const result = await setupXcodeProject(cwd || process.cwd())
    return result.ok
      ? { result: result.message }
      : { error: result.message }
  }

  // xcode_open_simulator_window is handled locally — brings Simulator.app to the front
  if (toolName === 'xcode_open_simulator_window') {
    const result = openSimulatorWindow()
    return result.ok
      ? { result: result.message }
      : { error: result.message }
  }

  const mcpName = TOOL_NAME_MAP[toolName]
  if (!mcpName) return { error: `Unknown xcode tool: ${toolName}` }

  const client = getClient()
  const mappedArgs = _mapArgs(toolName, args)

  // For session_set_defaults: auto-discover project path if not provided
  if (mcpName === 'session_set_defaults' && !mappedArgs.projectPath && !mappedArgs.workspacePath && cwd) {
    const fs = require('fs')
    const path = require('path')
    const entries = fs.readdirSync(cwd).filter(e => e.endsWith('.xcworkspace') || e.endsWith('.xcodeproj'))
    const workspace = entries.find(e => e.endsWith('.xcworkspace'))
    const project = entries.find(e => e.endsWith('.xcodeproj'))
    if (workspace) mappedArgs.workspacePath = path.join(cwd, workspace)
    else if (project) mappedArgs.projectPath = path.join(cwd, project)
  }

  // For list_schemes: auto-discover project path if not provided
  if (mcpName === 'list_schemes' && !mappedArgs.projectPath && !mappedArgs.workspacePath && cwd) {
    const fs = require('fs')
    const path = require('path')
    const entries = fs.readdirSync(cwd).filter(e => e.endsWith('.xcworkspace') || e.endsWith('.xcodeproj'))
    const workspace = entries.find(e => e.endsWith('.xcworkspace'))
    const project = entries.find(e => e.endsWith('.xcodeproj'))
    if (workspace) mappedArgs.workspacePath = path.join(cwd, workspace)
    else if (project) mappedArgs.projectPath = path.join(cwd, project)
  }

  // discover_projs: default workspaceRoot to cwd
  if (mcpName === 'discover_projs' && !mappedArgs.workspaceRoot && cwd) {
    mappedArgs.workspaceRoot = cwd
  }

  try {
    const result = await client.callTool(mcpName, mappedArgs, 180000)

    // XcodeBuildMCP returns { content: [{ type: 'text', text: '...' }] }
    if (result && Array.isArray(result.content)) {
      const text = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n')
      return { result: text || '(no output)' }
    }
    return { result: JSON.stringify(result) }
  } catch (err) {
    if (err.message.includes('not installed') || err.message.includes('ENOENT')) {
      return { error: `XcodeBuildMCP not installed. Install with: npm install -g xcodebuildmcp@latest\nThen restart the app.\n\nFalling back: use bash with xcodebuild directly.` }
    }
    return { error: err.message }
  }
}

/**
 * Check if xcodebuildmcp is installed.
 */
function isXcodeMCPAvailable() {
  return !!XcodeMCPClient._findBinary()
}

/**
 * Ensure xcode-select points to the full Xcode.app, not CommandLineTools.
 * CommandLineTools doesn't have xcodebuild's full simulator support.
 * Returns { ok, fixed, message }.
 */
function ensureXcodePath() {
  const { execSync } = require('child_process')
  try {
    const current = execSync('xcode-select -p', { timeout: 5000 }).toString().trim()
    if (current.includes('CommandLineTools') && !current.includes('Xcode.app')) {
      // Try to find Xcode.app and switch to it
      const { execFileSync } = require('child_process')
      const fs = require('fs')
      const xcodePath = '/Applications/Xcode.app/Contents/Developer'
      if (fs.existsSync(xcodePath)) {
        try {
          execFileSync('sudo', ['-n', 'xcode-select', '-s', xcodePath], { timeout: 5000 })
          return { ok: true, fixed: true, message: `Switched xcode-select to ${xcodePath}` }
        } catch {
          // sudo -n failed (needs password) — return instructions for the user, not the agent.
          // Mark this as a USER_ACTION_REQUIRED so the agent surfaces it and stops retrying.
          return {
            ok: false, fixed: false, requiresUserAction: true,
            message: `xcode-select points to CommandLineTools instead of Xcode.app.\n\nUSER_ACTION_REQUIRED: Run this once in your terminal (requires your password):\n  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer\n\nThe agent cannot run this — it requires interactive sudo. Please run it manually and retry.`,
          }
        }
      }
      return {
        ok: false, fixed: false,
        message: `xcode-select points to CommandLineTools but Xcode.app not found at /Applications/Xcode.app. Install Xcode from the App Store.`,
      }
    }
    return { ok: true, fixed: false, message: `xcode-select: ${current}` }
  } catch (e) {
    return { ok: false, fixed: false, message: `xcode-select check failed: ${e.message}` }
  }
}

/**
 * Auto-discover and configure an Xcode project in the given directory.
 * Detects whether it's an iOS or macOS project and configures accordingly.
 * For macOS: uses xcodebuild directly (xcodebuildmcp doesn't support macOS builds).
 * For iOS: configures xcodebuildmcp session with scheme + simulator.
 *
 * Returns { ok, projectPath, workspacePath, scheme, platform, simulator, message }.
 */
async function setupXcodeProject(cwd) {
  const fs = require('fs')
  const path = require('path')
  const { execSync } = require('child_process')

  // 1. Check xcode-select
  const xcodeCheck = ensureXcodePath()
  if (!xcodeCheck.ok) {
    return { ok: false, message: xcodeCheck.message }
  }

  // 2. Find project/workspace — search up to 3 levels deep
  function findXcodeProject(dir, depth = 0) {
    if (depth > 3) return null
    try {
      const entries = fs.readdirSync(dir)
      const workspace = entries.find(e => e.endsWith('.xcworkspace') && !e.includes('.xcodeproj'))
      if (workspace) return { type: 'workspace', path: path.join(dir, workspace) }
      const project = entries.find(e => e.endsWith('.xcodeproj'))
      if (project) return { type: 'project', path: path.join(dir, project) }
      const SKIP = new Set(['.git', 'node_modules', 'build', 'DerivedData', '.build', 'Pods'])
      for (const entry of entries) {
        if (SKIP.has(entry) || entry.startsWith('.')) continue
        const sub = path.join(dir, entry)
        try {
          if (fs.statSync(sub).isDirectory()) {
            const found = findXcodeProject(sub, depth + 1)
            if (found) return found
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return null
  }

  const found = findXcodeProject(cwd)
  if (!found) {
    return { ok: false, message: `No .xcodeproj or .xcworkspace found in ${cwd} (searched 3 levels deep)` }
  }

  const projectPath = found.type === 'project' ? found.path : undefined
  const workspacePath = found.type === 'workspace' ? found.path : undefined
  const projectArg = workspacePath ? `-workspace "${workspacePath}"` : `-project "${projectPath}"`

  // 3. List schemes and detect platform
  let scheme = null
  let platform = null  // null until positively detected — never assume iOS
  try {
    const schemesOut = execSync(
      `xcodebuild ${projectArg} -list 2>/dev/null`,
      { timeout: 30000, encoding: 'utf-8', cwd }
    )
    const schemeMatch = schemesOut.match(/Schemes:\s*\n([\s\S]*?)(?:\n\n|\nBuild Configurations:|\nTargets:|$)/)
    if (schemeMatch) {
      const schemes = schemeMatch[1].split('\n').map(s => s.trim()).filter(Boolean)
      const projName = path.basename(projectPath || workspacePath, path.extname(projectPath || workspacePath))
      scheme = schemes.find(s => s === projName)
        || schemes.find(s => !s.toLowerCase().includes('test') && !s.toLowerCase().includes('ui'))
        || schemes[0]
    }

    // Detect platform from xcodebuild -showBuildSettings (most reliable when targets exist)
    if (scheme) {
      try {
        const settingsOut = execSync(
          `xcodebuild ${projectArg} -scheme "${scheme}" -showBuildSettings 2>/dev/null | grep -E "SDKROOT|SUPPORTED_PLATFORMS|PLATFORM_NAME"`,
          { timeout: 20000, encoding: 'utf-8', cwd }
        )
        if (/macosx|macos/i.test(settingsOut) && !/iphoneos|iphonesimulator/i.test(settingsOut)) {
          platform = 'macOS'
        } else if (/iphoneos|iphonesimulator/i.test(settingsOut)) {
          platform = 'iOS'
        }
        // if settingsOut is empty (no targets), platform stays null → falls through to pbxproj
      } catch { /* showBuildSettings failed — fall through to pbxproj detection */ }
    }

    // ── Fallback: read project.pbxproj directly ──────────────────────────────
    // Runs when showBuildSettings fails (no targets) OR returns ambiguous output.
    if (!platform) {
      try {
        const pbxprojPath = path.join(projectPath || workspacePath, 'project.pbxproj')
        const pbx = fs.readFileSync(pbxprojPath, 'utf-8')
        if (/SDKROOT\s*=\s*macosx\b/i.test(pbx) || /SUPPORTED_PLATFORMS\s*=\s*macosx\b/i.test(pbx)) {
          platform = 'macOS'
        } else if (/SDKROOT\s*=\s*(iphoneos|iphonesimulator)\b/i.test(pbx) ||
                   /SUPPORTED_PLATFORMS\s*=\s*(iphoneos|iphonesimulator)\b/i.test(pbx)) {
          platform = 'iOS'
        } else if (/MACOSX_DEPLOYMENT_TARGET/.test(pbx) && !/IPHONEOS_DEPLOYMENT_TARGET/.test(pbx)) {
          platform = 'macOS'  // only macOS deployment target — definitely macOS
        } else if (/IPHONEOS_DEPLOYMENT_TARGET/.test(pbx) && !/MACOSX_DEPLOYMENT_TARGET/.test(pbx)) {
          platform = 'iOS'    // only iOS deployment target — definitely iOS
        }
      } catch { /* pbxproj unreadable */ }
    }

    // ── Fallback: grep Swift source files for platform-specific APIs ─────────
    if (!platform) {
      try {
        const projSourceDir = path.dirname(projectPath || workspacePath)
        const macMarkers = execSync(
          `grep -rl "NSApplicationDelegateAdaptor\\|import AppKit\\|\\.windowStyle\\|\\.windowToolbarStyle\\|NSApp\\b" "${projSourceDir}" --include="*.swift" 2>/dev/null | head -1`,
          { timeout: 5000, encoding: 'utf-8', cwd }
        ).trim()
        if (macMarkers) {
          platform = 'macOS'
        } else {
          const iosMarkers = execSync(
            `grep -rl "UIApplicationDelegateAdaptor\\|import UIKit\\|UIViewController\\|UINavigationController" "${projSourceDir}" --include="*.swift" 2>/dev/null | head -1`,
            { timeout: 5000, encoding: 'utf-8', cwd }
          ).trim()
          if (iosMarkers) platform = 'iOS'
        }
      } catch { /* grep failed */ }
    }

    // ── Absolute last resort ─────────────────────────────────────────────────
    // Prefer macOS over iOS when truly ambiguous — iOS projects almost always
    // have IPHONEOS_DEPLOYMENT_TARGET explicitly set in the pbxproj.
    if (!platform) {
      try {
        const pbxprojPath = path.join(projectPath || workspacePath, 'project.pbxproj')
        const pbx = fs.readFileSync(pbxprojPath, 'utf-8')
        platform = /MACOSX_DEPLOYMENT_TARGET/.test(pbx) ? 'macOS' : 'iOS'
      } catch {
        platform = 'iOS'
      }
    }
  } catch (e) {
    return { ok: false, message: `Failed to list schemes: ${e.message}\n\nMake sure Xcode is installed and xcode-select points to Xcode.app:\n  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` }
  }

  if (!scheme) {
    return { ok: false, message: `No schemes found in ${found.path}` }
  }

  const projDisplay = path.basename(workspacePath || projectPath)

  if (platform === 'macOS') {
    // macOS: xcodebuildmcp doesn't support macOS builds — use xcodebuild directly via bash.
    // Store config in a simple JSON file so subsequent calls can read it.
    const configPath = path.join(cwd, '.xcodebuildmcp', 'macos-config.json')
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, JSON.stringify({
        platform: 'macOS',
        scheme,
        projectPath: projectPath || null,
        workspacePath: workspacePath || null,
        projectArg,
      }, null, 2))
    } catch { /* non-fatal */ }

    // Kill any stale xcodebuildmcp session — it may have iOS defaults from a
    // previous run. Restarting ensures the next iOS project gets a clean slate.
    if (_client) {
      _client.stop()
      _client = null
    }

    // Check if the project has targets — a missing target means project.pbxproj
    // needs to be regenerated with generate_xcode_project before building.
    let hasTargets = true
    try {
      const listOut = execSync(
        `xcodebuild ${projectArg} -list 2>&1`,
        { timeout: 15000, encoding: 'utf-8', cwd }
      )
      if (/There are no targets in project/.test(listOut) || /Supported platforms for the buildables in the current scheme is empty/.test(listOut)) {
        hasTargets = false
      }
    } catch { /* non-fatal */ }

    const noTargetsWarning = hasTargets ? '' : (() => {
      const projDirAbs = path.dirname(projectPath || workspacePath)
      const relFromCwd = path.relative(cwd, projDirAbs) || '.'
      const projArg = relFromCwd === '.' ? '' : `"project_dir": "${relFromCwd}", `
      return (
        `\n\n⚠️  WARNING: The project has no targets configured — xcodebuild will fail.\n` +
        `The project.pbxproj is missing target definitions. Fix this first:\n` +
        `  generate_xcode_project({"product_name": "${scheme}", ${projArg}"platform": "macos", "deployment_target": "14.0"})\n` +
        `This regenerates project.pbxproj from the Swift source files. Source_dir auto-discovers if omitted. Run it before attempting to build.`
      )
    })()

    return {
      ok: true,
      projectPath,
      workspacePath,
      scheme,
      platform: 'macOS',
      hasTargets,
      message: `✅ macOS project configured:\n  Project: ${projDisplay}\n  Scheme: ${scheme}\n  Platform: macOS (builds run directly, no simulator)\n\n` +
        `To build:  bash({command: "xcodebuild ${projectArg} -scheme \\"${scheme}\\" -configuration Debug build 2>&1 | tail -50"})\n` +
        `To run:    bash({command: "xcodebuild ${projectArg} -scheme \\"${scheme}\\" -configuration Debug build && open \\"$(xcodebuild ${projectArg} -scheme \\"${scheme}\\" -showBuildSettings 2>/dev/null | grep BUILT_PRODUCTS_DIR | head -1 | awk '{print $3}')/${scheme}.app\\""})\n` +
        `To test:   bash({command: "xcodebuild ${projectArg} -scheme \\"${scheme}\\" -destination \\"platform=macOS\\" test 2>&1 | tail -80"})` +
        noTargetsWarning,
    }
  }

  // iOS: configure xcodebuildmcp session
  let simulatorName = 'iPhone 16'
  try {
    const simsOut = execSync('xcrun simctl list devices available --json 2>/dev/null', { timeout: 10000, encoding: 'utf-8' })
    const simsData = JSON.parse(simsOut)
    const allDevices = Object.values(simsData.devices || {}).flat()
    const iphones = allDevices.filter(d => d.name.startsWith('iPhone') && d.isAvailable !== false)
    const preferred = iphones.find(d => /iPhone 1[67]/.test(d.name)) || iphones[iphones.length - 1]
    if (preferred) simulatorName = preferred.name
  } catch { /* use default */ }

  const client = getClient()
  const setArgs = { scheme, simulatorName, simulatorPlatform: 'iOS Simulator' }
  if (workspacePath) setArgs.workspacePath = workspacePath
  else setArgs.projectPath = projectPath

  try {
    await client.callTool('session_set_defaults', setArgs, 30000)
  } catch (e) {
    return { ok: false, message: `session_set_defaults failed: ${e.message}` }
  }

  return {
    ok: true,
    projectPath,
    workspacePath,
    scheme,
    platform: 'iOS',
    simulator: simulatorName,
    message: `✅ iOS project configured:\n  Project: ${projDisplay}\n  Scheme: ${scheme}\n  Simulator: ${simulatorName}\n\nReady to build. Use xcode_build_run_simulator() to build and launch.`,
  }
}

/**
 * Open the Simulator.app window so the booted sim is visible.
 * `simctl boot` alone is headless — you need `open -a Simulator` to show the window.
 * Idempotent: safe to call even if Simulator is already running.
 */
function openSimulatorWindow() {
  const { execSync } = require('child_process')
  try {
    execSync('open -a Simulator', { timeout: 5000 })
    return { ok: true, message: '✅ Simulator.app window opened (or already visible).' }
  } catch (err) {
    return { ok: false, message: `Failed to open Simulator.app: ${err.message}` }
  }
}

/**
 * Gracefully stop the MCP server subprocess on app exit.
 */
function shutdown() {
  if (_client) {
    _client.stop()
    _client = null
  }
}

module.exports = {
  XCODE_TOOL_DEFS,
  executeXcodeTool,
  isXcodeMCPAvailable,
  getClient,
  shutdown,
  setupXcodeProject,
  ensureXcodePath,
  openSimulatorWindow,
}
