'use strict'

const { EventEmitter } = require('node:events')
const { WebSocketServer } = require('ws')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const projects = require('./projects')

/**
 * Serves the Telegram Mini App HTML and provides a REST API bridge
 * to the RemoteJobController for real-time communication.
 */
class MiniAppServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.jobController - RemoteJobController instance
   * @param {number} [opts.port=3847] - HTTP/WS port
   * @param {function} [opts.onRunJob] - Callback to actually run an agent job: (prompt) => void
   * @param {function} [opts.onStopJob] - Callback to stop the running agent job: () => void
   */
  constructor({ jobController, port = 3847, onRunJob, onStopJob, bridgeStateGetter }) {
    super()
    this._controller = jobController
    this._port = port
    this._onRunJob = onRunJob || null
    this._onStopJob = onStopJob || null
    this._bridgeStateGetter = bridgeStateGetter || null
    this._server = null
    this._wss = null
    this._clients = new Set()
    this._logs = []
  }

  /**
   * Start the HTTP + WebSocket server.
   * @returns {{ port: number, url: string }}
   */
  start() {
    // In packaged app, HTML is in extraResources (outside asar).
    let htmlPath = path.join(__dirname, 'telegram-miniapp.html')
    if (process.resourcesPath) {
      const packed = path.join(process.resourcesPath, 'telegram-miniapp.html')
      try { if (fs.existsSync(packed)) htmlPath = packed } catch {}
    }

    this._server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${this._port}`)
      const pathname = url.pathname

      // ── Static HTML ──
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        fs.createReadStream(htmlPath).pipe(res)
        return
      }

      // ── REST API ──
      if (pathname.startsWith('/api/')) {
        this._handleApi(req, res, pathname)
        return
      }

      res.writeHead(404)
      res.end('Not found')
    })

    this._wss = new WebSocketServer({ server: this._server, path: '/miniapp' })

    this._wss.on('connection', (ws) => {
      this._clients.add(ws)
      // Send current state on connect
      this._sendTo(ws, {
        type: 'status',
        state: this._controller.getJobState(),
        jobId: this._controller.getJobId(),
      })
      // Send recent logs
      for (const log of this._logs.slice(-30)) {
        this._sendTo(ws, log)
      }

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          this._handleClientMessage(msg)
        } catch { /* ignore malformed */ }
      })

      ws.on('close', () => this._clients.delete(ws))
    })

    // Wire up controller events
    this._wireController()

    this._server.listen(this._port, () => {
      this.emit('listening', { port: this._port })
    })

    return { port: this._port, url: `http://localhost:${this._port}` }
  }

  /**
   * Parse JSON body from a request.
   * @param {http.IncomingMessage} req
   * @returns {Promise<object>}
   */
  _parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')) }
        catch { reject(new Error('Invalid JSON')) }
      })
      req.on('error', reject)
    })
  }

  /**
   * Handle REST API requests for projects and sessions.
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} pathname
   */
  _handleApi(req, res, pathname) {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // GET /api/projects — list all projects
    if (req.method === 'GET' && pathname === '/api/projects') {
      const list = projects.listProjects()
      res.writeHead(200)
      res.end(JSON.stringify(list))
      return
    }

    // GET /api/projects/:id/sessions — list sessions for a project
    const sessionsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/)
    if (req.method === 'GET' && sessionsMatch) {
      const projectId = sessionsMatch[1]
      const sessions = projects.listSessions(projectId)
      res.writeHead(200)
      res.end(JSON.stringify(sessions))
      return
    }

    // GET /api/projects/:id/sessions/:sid/messages — get session messages
    const messagesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/messages$/)
    if (req.method === 'GET' && messagesMatch) {
      const [, projectId, sessionId] = messagesMatch
      const messages = projects.getSessionMessages(projectId, sessionId)
      res.writeHead(200)
      res.end(JSON.stringify(messages))
      return
    }

    // POST /api/projects/:id/sessions — create a new session
    if (req.method === 'POST' && sessionsMatch) {
      this._parseBody(req).then((body) => {
        const projectId = sessionsMatch[1]
        const session = projects.createSession(projectId, body.name || 'New Session', body.type)
        res.writeHead(201)
        res.end(JSON.stringify(session))
      }).catch(() => { res.writeHead(400); res.end('{"error":"Invalid body"}') })
      return
    }

    // POST /api/projects/:id/sessions/:sid/run — run agent on a session
    const runMatch = pathname.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/run$/)
    if (req.method === 'POST' && runMatch) {
      this._parseBody(req).then((body) => {
        if (!body.prompt) { res.writeHead(400); res.end('{"error":"prompt required"}'); return }
        const [, projectId, sessionId] = runMatch
        // Append user message to session
        projects.appendSessionMessage(projectId, sessionId, { role: 'user', content: body.prompt, ts: Date.now() })
        // Trigger the job via onRunJob callback or controller
        if (this._onRunJob) {
          this._onRunJob(body.prompt)
        } else {
          this._controller.handleCommand('run', body.prompt)
        }
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, jobId: this._controller.getJobId() }))
      }).catch(() => { res.writeHead(400); res.end('{"error":"Invalid body"}') })
      return
    }

    // GET /api/projects/:id — get project details
    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/)
    if (req.method === 'GET' && projectMatch) {
      const project = projects.openProject(projectMatch[1])
      if (project) {
        res.writeHead(200)
        res.end(JSON.stringify(project))
      } else {
        res.writeHead(404)
        res.end('{"error":"Not found"}')
      }
      return
    }

    // GET /api/status — agent status
    // Returns the controller state, but also checks the shared bridge for
    // jobs started from the main UI that the controller doesn't know about.
    if (req.method === 'GET' && pathname === '/api/status') {
      let jobState = this._controller.getJobState()
      let jobId = this._controller.getJobId()

      // If the controller thinks it's idle but the bridge is running,
      // a job was started from the main app UI — reflect that here.
      if (jobState === 'idle' && this._bridgeStateGetter) {
        const bridgeRunning = this._bridgeStateGetter()
        if (bridgeRunning) {
          jobState = 'running'
          jobId = jobId || 'main_app'
        }
      }

      res.writeHead(200)
      res.end(JSON.stringify({
        type: 'status',
        state: jobState,
        jobId,
        logs: this._logs.slice(-50),
      }))
      return
    }

    // POST /api/cmd — command endpoint (REST-based control)
    if (req.method === 'POST' && pathname === '/api/cmd') {
      this._parseBody(req).then((msg) => {
        this._handleClientMessage(msg)
        // Return current status as response
        const response = {
          type: 'status',
          state: this._controller.getJobState(),
          jobId: this._controller.getJobId(),
          logs: this._logs.slice(-30),
        }
        res.writeHead(200)
        res.end(JSON.stringify(response))
      }).catch(() => { res.writeHead(400); res.end('{"error":"Invalid body"}') })
      return
    }

    res.writeHead(404)
    res.end('{"error":"Not found"}')
  }

  /**
   * Stop the server.
   */
  stop() {
    for (const ws of this._clients) {
      ws.close()
    }
    this._clients.clear()
    if (this._wss) { this._wss.close(); this._wss = null }
    if (this._server) { this._server.close(); this._server = null }
  }

  /**
   * Get the mini app URL for Telegram Web App buttons.
   * @returns {string}
   */
  getUrl() {
    return `http://localhost:${this._port}`
  }

  /**
   * Broadcast a message to all connected clients.
   * @param {object} msg
   */
  _broadcast(msg) {
    const data = JSON.stringify(msg)
    for (const ws of this._clients) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(data)
      }
    }
  }

  /**
   * Send a message to a single client.
   * @param {WebSocket} ws
   * @param {object} msg
   */
  _sendTo(ws, msg) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(msg))
    }
  }

  /**
   * Handle incoming messages from the mini app client.
   * @param {object} msg
   */
  _handleClientMessage(msg) {
    switch (msg.type) {
      case 'run':
        if (msg.prompt) {
          // Use the onRunJob callback if available (triggers real agent)
          if (this._onRunJob) {
            this._onRunJob(msg.prompt)
            // Log it
            const log = { type: 'log', text: `Job started: ${msg.prompt}`, logType: 'info', time: Date.now() }
            this._logs.push(log)
            if (this._logs.length > 200) this._logs.shift()
          } else {
            this._controller.handleCommand('run', msg.prompt)
          }
        }
        break
      case 'stop':
        if (this._onStopJob) {
          this._onStopJob()
        } else {
          this._controller.handleCommand('stop', '')
        }
        break
      case 'status':
        // no-op for REST polling, status is returned in response
        break
      case 'screenshot':
        this._controller.handleCommand('screenshot', '')
        break
    }
  }

  /**
   * Wire RemoteJobController events to WebSocket broadcasts.
   *
   * The controller uses CallbackSink which emits 'agent-event' with
   * { taskId, channel, data } — we translate those into typed WS messages.
   * We also handle the direct 'agent:*' events emitted by the stub controller
   * in main.js for the shared-bridge path.
   */
  _wireController() {
    const ctrl = this._controller

    // ── CallbackSink path: emits 'agent-event' with channel + data ──
    ctrl.on('agent-event', ({ channel, data }) => {
      if (!data) return
      if (channel === 'qwen-event') {
        this._handleQwenEvent(data)
      }
    })

    // ── Direct event path: emitted by stub controller or explicit emits ──
    ctrl.on('agent:message', (data) => {
      const log = { type: 'log', text: data.text || data.content || '', logType: 'info', time: Date.now() }
      this._appendLog(log)
      this._broadcast(log)
    })

    ctrl.on('agent:tool_use', (data) => {
      const msg = { type: 'tool_use', tool: data.name || data.tool || 'unknown', summary: data.summary || '', time: Date.now() }
      this._appendLog(msg)
      this._broadcast(msg)
    })

    ctrl.on('agent:done', () => {
      this._broadcast({ type: 'job_completed', jobId: ctrl.getJobId() })
    })

    ctrl.on('agent:error', (data) => {
      this._broadcast({ type: 'job_failed', jobId: ctrl.getJobId(), error: data.message || 'Unknown error' })
    })

    ctrl.on('agent:screenshot', (data) => {
      this._broadcast({ type: 'screenshot', data: data.url || data.base64 || null })
    })

    ctrl.on('agent:input_request', (data) => {
      this._broadcast({ type: 'input_request', question: data.question || '' })
    })

    // ── State polling fallback — catches state changes from the shared-bridge path ──
    const prevState = { value: ctrl.getJobState() }
    setInterval(() => {
      const current = ctrl.getJobState()
      if (current !== prevState.value) {
        prevState.value = current
        if (current === 'running') {
          this._broadcast({ type: 'job_started', jobId: ctrl.getJobId(), prompt: '' })
        } else if (current === 'completed') {
          this._broadcast({ type: 'job_completed', jobId: ctrl.getJobId() })
        } else if (current === 'failed') {
          this._broadcast({ type: 'job_failed', jobId: ctrl.getJobId(), error: 'Job failed' })
        }
      }
    }, 2000)
  }

  /**
   * Translate a qwen-event data object into a typed log/broadcast message.
   * Called from both the agent-event listener and the main.js logHandler.
   * @param {object} data
   */
  _handleQwenEvent(data) {
    if (!data) return
    let log = null

    if (data.type === 'assistant' || data.type === 'text') {
      const text = data.content || data.text || ''
      if (text) log = { type: 'log', text, logType: 'info', time: Date.now() }
    } else if (data.type === 'tool_call' || data.type === 'tool-start') {
      const input = typeof data.input === 'string' ? data.input : JSON.stringify(data.input || '')
      log = { type: 'log', text: `🔧 ${data.name || 'tool'}: ${input.substring(0, 80)}`, logType: 'tool', time: Date.now() }
    } else if (data.type === 'tool_result' || data.type === 'tool-end') {
      log = { type: 'log', text: `✓ ${data.name || 'tool'} done`, logType: 'result', time: Date.now() }
    } else if (data.type === 'done' || data.type === 'finish') {
      log = { type: 'log', text: '✅ Job completed', logType: 'result', time: Date.now() }
      this._appendLog(log)
      this._broadcast(log)
      this._broadcast({ type: 'job_completed', jobId: this._controller.getJobId() })
      return
    } else if (data.type === 'error') {
      log = { type: 'log', text: `❌ ${data.error || 'Error'}`, logType: 'error', time: Date.now() }
      this._appendLog(log)
      this._broadcast(log)
      this._broadcast({ type: 'job_failed', jobId: this._controller.getJobId(), error: data.error || 'Error' })
      return
    } else if (data.type === 'result') {
      const text = data.result || data.content || ''
      if (text && text !== '__TASK_COMPLETE__') {
        log = { type: 'log', text, logType: 'result', time: Date.now() }
      }
    }

    if (log) {
      this._appendLog(log)
      this._broadcast(log)
    }
  }

  /**
   * Append a log entry, capping at 200 entries.
   * @param {object} entry
   */
  _appendLog(entry) {
    this._logs.push(entry)
    if (this._logs.length > 200) this._logs.shift()
  }
}

module.exports = { MiniAppServer }
