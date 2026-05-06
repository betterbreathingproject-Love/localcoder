'use strict'

/**
 * chrome-devtools-mcp.js — Chrome DevTools MCP integration.
 *
 * Spawns chrome-devtools-mcp as a stdio MCP server subprocess and exposes
 * its tools to the agent loop. Lets the agent see console errors, network
 * failures, DOM state, and performance traces from a live browser.
 *
 * Install: npx chrome-devtools-mcp@latest (auto-downloads on first use)
 *
 * Gracefully degrades: if npx/node is unavailable, all tool calls return
 * a helpful error and the agent falls back to Playwright screenshots.
 */

const { EventEmitter } = require('node:events')
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

// ── Tool definitions exposed to the agent ────────────────────────────────────

const DEVTOOLS_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'devtools_console_logs',
      description: 'Get console messages (errors, warnings, logs) from the browser. Use this to see JavaScript errors, failed assertions, and debug output from a running web page.',
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
      name: 'devtools_network_errors',
      description: 'Get failed network requests (4xx, 5xx, CORS errors, timeouts) from the browser. Use to diagnose missing resources, API failures, or CORS issues.',
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
      name: 'devtools_navigate',
      description: 'Navigate the browser to a URL and wait for the page to load. Opens Chrome if not already running.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to (e.g. http://localhost:8080)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'devtools_screenshot',
      description: 'Take a screenshot of the current browser tab. Returns a description of what is visible. Use to verify visual changes or debug layout issues.',
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
      name: 'devtools_evaluate',
      description: 'Execute a JavaScript expression in the browser console and return the result. Use for inspecting runtime state, checking variable values, or running quick tests.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'JavaScript expression to evaluate in the page context' },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'devtools_get_styles',
      description: 'Get computed CSS styles for a DOM element. Use to debug layout/styling issues.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the element to inspect' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'devtools_performance_trace',
      description: 'Record a performance trace for a specified duration. Returns key metrics (LCP, FCP, long tasks, layout shifts). Use to diagnose slow page loads or jank.',
      parameters: {
        type: 'object',
        properties: {
          duration_ms: { type: 'number', description: 'How long to record in milliseconds (default: 3000)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'devtools_click',
      description: 'Click an element on the page by CSS selector. Use to interact with the page for testing.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the element to click' },
        },
        required: ['selector'],
      },
    },
  },
]

// ── Map agent-facing tool names to Chrome DevTools MCP tool names ─────────────

const TOOL_NAME_MAP = {
  devtools_console_logs: 'console_get_logs',
  devtools_network_errors: 'network_get_failed_requests',
  devtools_navigate: 'navigate',
  devtools_screenshot: 'screenshot',
  devtools_evaluate: 'javascript_evaluate',
  devtools_get_styles: 'css_get_computed_styles',
  devtools_performance_trace: 'performance_start_trace',
  devtools_click: 'interaction_click',
}

// ── ChromeDevToolsMCPClient ───────────────────────────────────────────────────

class ChromeDevToolsMCPClient extends EventEmitter {
  constructor() {
    super()
    this._proc = null
    this._ready = false
    this._msgId = 0
    this._pending = new Map()
    this._buf = ''
    this._status = 'stopped'  // 'stopped' | 'starting' | 'ready' | 'error'
    this._errorMsg = null
  }

  /**
   * Find npx binary for launching chrome-devtools-mcp.
   */
  static _findNpx() {
    const candidates = [
      '/opt/homebrew/bin/npx',
      '/usr/local/bin/npx',
      '/usr/bin/npx',
    ]
    // Check npm global bin
    try {
      const npmBin = execSync('npm bin -g 2>/dev/null', { timeout: 3000 }).toString().trim()
      if (npmBin) candidates.unshift(`${npmBin}/../npx`)
    } catch { /* ignore */ }

    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c
      } catch { /* not found */ }
    }
    // Fallback: just use 'npx' and hope it's on PATH
    try {
      execSync('which npx', { timeout: 2000 })
      return 'npx'
    } catch { /* not found */ }
    return null
  }

  /**
   * Start the MCP server subprocess and perform the JSON-RPC handshake.
   */
  async start() {
    if (this._status === 'ready') return { ok: true }
    if (this._status === 'starting') {
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
    const npx = ChromeDevToolsMCPClient._findNpx()
    if (!npx) {
      this._status = 'error'
      this._errorMsg = 'npx not found. Install Node.js to use Chrome DevTools MCP.'
      return { ok: false, error: this._errorMsg }
    }

    return new Promise((resolve) => {
      try {
        this._proc = spawn(npx, ['chrome-devtools-mcp@latest'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':'),
          },
        })
      } catch (err) {
        this._status = 'error'
        this._errorMsg = `Failed to spawn chrome-devtools-mcp: ${err.message}`
        return resolve({ ok: false, error: this._errorMsg })
      }

      this._proc.stdout.on('data', (chunk) => this._onData(chunk))
      this._proc.stderr.on('data', (d) => {
        const line = d.toString().trim()
        if (line) console.log(`[chrome-devtools-mcp] ${line}`)
      })
      this._proc.on('exit', (code) => {
        this._status = 'stopped'
        this._proc = null
        for (const [, { reject: rej, timer }] of this._pending) {
          clearTimeout(timer)
          rej(new Error(`chrome-devtools-mcp process exited (code ${code})`))
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

      const initTimer = setTimeout(() => {
        this._status = 'error'
        this._errorMsg = 'chrome-devtools-mcp initialize timed out (15s)'
        resolve({ ok: false, error: this._errorMsg })
      }, 15000)

      this._pending.set(initId, {
        resolve: (_result) => {
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
    this._buf = lines.pop()
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
   * Call an MCP tool.
   * @param {string} toolName - MCP tool name (e.g. 'console_get_logs')
   * @param {object} args - Tool arguments
   * @param {number} timeoutMs - Timeout (default 30s)
   * @returns {Promise<object>} Tool result
   */
  async callTool(toolName, args, timeoutMs = 30000) {
    if (this._status !== 'ready') {
      const start = await this.start()
      if (!start.ok) throw new Error(start.error)
    }

    return new Promise((resolve, reject) => {
      const id = ++this._msgId
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`devtools tool '${toolName}' timed out after ${timeoutMs / 1000}s`))
      }, timeoutMs)

      this._pending.set(id, { resolve, reject, timer })
      this._send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: toolName, arguments: args || {} },
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

// ── Singleton instance ────────────────────────────────────────────────────────

let _client = null

function getClient() {
  if (!_client) _client = new ChromeDevToolsMCPClient()
  return _client
}

/**
 * Execute a devtools_* tool call.
 * Lazily starts the MCP server on first use.
 *
 * @param {string} name - Agent-facing tool name (e.g. 'devtools_console_logs')
 * @param {object} args - Tool arguments
 * @returns {Promise<{result?: string, error?: string}>}
 */
async function executeDevToolsTool(name, args) {
  const mcpToolName = TOOL_NAME_MAP[name]
  if (!mcpToolName) {
    return { error: `Unknown devtools tool: ${name}` }
  }

  const client = getClient()
  try {
    const result = await client.callTool(mcpToolName, args || {})
    // MCP response format: { content: [{ type: "text", text: "..." }] }
    if (result && result.content && Array.isArray(result.content)) {
      const text = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n')
      return { result: text || '(no output)' }
    }
    return { result: JSON.stringify(result) }
  } catch (err) {
    return { error: `DevTools MCP error: ${err.message}` }
  }
}

/**
 * Check if Chrome DevTools MCP is available (npx exists).
 */
function isDevToolsAvailable() {
  return ChromeDevToolsMCPClient._findNpx() !== null
}

/**
 * Stop the MCP server if running.
 */
function stopDevTools() {
  if (_client) {
    _client.stop()
    _client = null
  }
}

module.exports = {
  DEVTOOLS_TOOL_DEFS,
  executeDevToolsTool,
  isDevToolsAvailable,
  stopDevTools,
  ChromeDevToolsMCPClient,
}
