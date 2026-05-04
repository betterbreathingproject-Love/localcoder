'use strict'

const { EventEmitter } = require('node:events')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { sinkBus } = require('./direct-bridge')

class RemoteJobController extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.telegramBot - TelegramBot instance
   * @param {number|string} opts.chatId - Paired Telegram chat ID
   * @param {object} opts.recordingManager - RecordingManager instance
   */
  constructor({ telegramBot, chatId, recordingManager, miniAppUrl, sharedBridge, mainWindow, cwdGetter, specRunner }) {
    super()
    this._bot = telegramBot
    this._chatId = chatId
    this._recordingManager = recordingManager
    this._miniAppUrlGetter = typeof miniAppUrl === 'function' ? miniAppUrl : null
    this._miniAppUrl = typeof miniAppUrl === 'function' ? miniAppUrl() : (miniAppUrl || null)
    this._sharedBridge = sharedBridge || null
    this._mainWindow = mainWindow || null
    this._cwdGetter = typeof cwdGetter === 'function' ? cwdGetter : null
    this._specRunner = specRunner || null
    this._state = 'idle'  // 'idle' | 'running' | 'completed' | 'failed'
    this._jobId = null
    this._bridge = null
    this._inputRequester = null
    this._lastStatusUpdate = 0
    this._statusInterval = null
    this._telegramEventHandler = null
  }

  /**
   * Return the current job state.
   * @returns {'idle' | 'running' | 'completed' | 'failed'}
   */
  getJobState() {
    return this._state
  }

  /**
   * Return the current job ID (null when idle).
   * @returns {string|null}
   */
  getJobId() {
    return this._jobId
  }

  /**
   * Start a new agent job with the given prompt.
   * Creates a recording-enabled DirectBridge, wires InputRequester,
   * sends confirmation, runs the agent loop, and delivers the video on completion.
   * @param {string} prompt
   */
  async runJob(prompt) {
    if (this._state === 'running') {
      await this._bot.sendMessage(this._chatId, 'A job is already running. Use /stop to cancel it first.')
      return
    }

    this._jobId = `job_${Date.now()}`
    this._state = 'running'
    this._lastStatusUpdate = Date.now()

    // Generate recording directory
    const recDir = this._recordingManager.getRecordingDir(this._jobId)

    // Send confirmation (Req 5.3)
    await this._bot.sendMessage(this._chatId, `Job started: ${this._jobId}\nPrompt: ${prompt}`)

    // Use shared bridge if available — shows in main app chat AND mirrors to Telegram
    if (this._sharedBridge && this._mainWindow) {
      return this._runWithSharedBridge(prompt)
    }

    // Fallback: create own bridge (no main window available)
    return this._runWithOwnBridge(prompt)
  }

  /**
   * Run using the shared bridge — output appears in the main app chat
   * and is mirrored to Telegram.
   * @private
   */
  async _runWithSharedBridge(prompt) {
    // Mirror qwen-event from the main window to Telegram
    // Note: final results are mirrored by the persistent listener in main.js,
    // so here we only forward intermediate status like tool activity.
    this._telegramEventHandler = (data) => {
      if (!this._bot || this._state !== 'running') return
      // Mirror error results to Telegram (persistent listener only mirrors success)
      if (data.type === 'result' && data.is_error) {
        const text = data.result || data.error || 'Agent error'
        this._bot.sendMessage(this._chatId, `⚠️ ${text}`).catch(() => {})
      }
    }
    sinkBus.on('qwen-event', this._telegramEventHandler)

    // Set up periodic status updates (Req 5.4 — ≥30s apart)
    this._statusInterval = setInterval(() => {
      if (this._state === 'running' && Date.now() - this._lastStatusUpdate >= 30000) {
        this._lastStatusUpdate = Date.now()
        this._bot.sendMessage(this._chatId, `Job ${this._jobId} still running...`).catch(() => {})
      }
    }, 30000)

    this._bridge = this._sharedBridge

    try {
      await this._sharedBridge.run({
        prompt,
        cwd: (this._cwdGetter ? this._cwdGetter() : null) || process.cwd(),
        permissionMode: 'auto-edit',
        model: 'default',
      })

      this._cleanupTelegramHandler()
      this._clearStatusInterval()
      this._state = 'completed'

      await this._sendRecordingOrNotify()
    } catch (err) {
      this._cleanupTelegramHandler()
      this._clearStatusInterval()
      this._state = 'failed'
      await this._bot.sendMessage(this._chatId, `Job ${this._jobId} failed: ${err.message}`)
    }
  }

  /**
   * Fallback: run with a dedicated bridge (no main window).
   * @private
   */
  async _runWithOwnBridge(prompt) {
    try {
      const { DirectBridge, InputRequester, CallbackSink } = require('./direct-bridge')

      this._inputRequester = new InputRequester(this._bot, this._chatId)

      // Sink that emits events for observability
      const sink = new CallbackSink(this, this._jobId)

      // Create bridge with telegram forwarder for screenshot forwarding (Req 7.1)
      this._bridge = new DirectBridge(sink, {
        telegramForwarder: {
          sendPhoto: (filePath, caption) => this._bot.sendPhoto(this._chatId, filePath, caption),
        },
      })

      // Set up periodic status updates (Req 5.4 — ≥30s apart)
      this._statusInterval = setInterval(() => {
        if (this._state === 'running' && Date.now() - this._lastStatusUpdate >= 30000) {
          this._lastStatusUpdate = Date.now()
          this._bot.sendMessage(this._chatId, `Job ${this._jobId} still running...`).catch(() => {})
        }
      }, 30000)

      // Run the agent loop with recording enabled
      await this._bridge.run({
        prompt,
        cwd: process.cwd(),
        permissionMode: 'auto',
        model: 'default',
      })

      this._clearStatusInterval()
      this._state = 'completed'

      // Send recording if available (Req 5.5)
      await this._sendRecordingOrNotify()
    } catch (err) {
      this._clearStatusInterval()
      this._state = 'failed'
      // Req 5.6
      await this._bot.sendMessage(this._chatId, `Job ${this._jobId} failed: ${err.message}`)
    }
  }

  /**
   * Dispatch a Telegram command to the appropriate handler.
   * @param {string} command - Command name without leading slash
   * @param {string} args - Arguments string after the command
   */
  async handleCommand(command, args) {
    switch (command) {
      case 'run': {
        if (!args || !args.trim()) {
          await this._bot.sendMessage(this._chatId, 'Usage: /run <prompt>')
          return
        }
        // Req 6.5 — reject /run while input request is pending
        if (this._inputRequester && this._inputRequester.hasPendingRequest()) {
          await this._bot.sendMessage(this._chatId, 'Agent is waiting for your reply. Please respond to the pending question first.')
          return
        }
        // Fire and forget — don't await so the command handler returns immediately
        this.runJob(args.trim())
        break
      }
      case 'status': {
        // Req 5.7
        const state = this.getJobState()
        if (state === 'idle') {
          await this._bot.sendMessage(this._chatId, 'Status: idle — no job running.')
        } else {
          await this._bot.sendMessage(this._chatId, `Status: ${state} — Job ID: ${this._jobId}`)
        }
        break
      }
      case 'stop': {
        // Req 5.8
        if (this._state !== 'running') {
          await this._bot.sendMessage(this._chatId, 'No job is currently running.')
          return
        }
        if (this._bridge) {
          await this._bridge.interrupt()
        }
        this._cleanupTelegramHandler()
        this._clearStatusInterval()
        this._state = 'idle'
        await this._bot.sendMessage(this._chatId, `Job ${this._jobId} stopped.`)
        break
      }
      case 'screenshot': {
        // Req 7.2, 7.3
        if (this._state !== 'running') {
          await this._bot.sendMessage(this._chatId, 'No browser session is active.')
          return
        }
        if (this._bridge && this._bridge._browserInstance) {
          try {
            const result = await this._bridge._browserInstance.execute('browser_screenshot', {})
            const content = result.result || ''
            const b64Match = content.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)
            if (b64Match) {
              const tmpPath = path.join(os.tmpdir(), `screenshot_${Date.now()}.png`)
              fs.writeFileSync(tmpPath, Buffer.from(b64Match[1], 'base64'))
              await this._bot.sendPhoto(this._chatId, tmpPath, 'Manual screenshot')
              return
            }
          } catch { /* fall through to no-session message */ }
        }
        await this._bot.sendMessage(this._chatId, 'No browser session is active.')
        break
      }
      case 'app': {
        // Req: Send a Web App button so the user can open the Mini App
        const url = this._miniAppUrlGetter ? this._miniAppUrlGetter() : this._miniAppUrl
        if (url) {
          await this._bot.sendWebAppButton(
            this._chatId,
            '🖥 Open the QwenCoder Agent dashboard:',
            '⚡ Open Mini App',
            url
          )
        } else {
          await this._bot.sendMessage(this._chatId, 'Mini App is not available. Start the mini app server first.')
        }
        break
      }
      case 'inject': {
        // /inject <message> — inject a prompt into the running agent
        if (!args || !args.trim()) {
          await this._bot.sendMessage(this._chatId, 'Usage: /inject <message>')
          return
        }
        const bridge = this._sharedBridge || this._bridge
        if (bridge && typeof bridge.inject === 'function') {
          bridge.inject(args.trim())
          await this._bot.sendMessage(this._chatId, `💬 Injected: ${args.trim().slice(0, 100)}`)
        } else {
          await this._bot.sendMessage(this._chatId, 'No agent is running to inject into.')
        }
        break
      }
      case 'spec': {
        // /spec [name] — list available specs or run a specific spec by name
        if (!this._specRunner) {
          await this._bot.sendMessage(this._chatId, 'Spec execution not available (no specRunner configured).')
          return
        }
        if (!args || !args.trim()) {
          // List available specs
          const specs = this._specRunner.listSpecs ? this._specRunner.listSpecs() : []
          if (specs.length === 0) {
            await this._bot.sendMessage(this._chatId, 'No specs found. Create a spec in the app first.')
          } else {
            const list = specs.map((s, i) => `${i + 1}. ${s.name}`).join('\n')
            await this._bot.sendMessage(this._chatId, `Available specs:\n${list}\n\nUse /spec <name> to run one.`)
          }
          return
        }
        // Run the named spec
        const specName = args.trim()
        this._jobId = `spec_${Date.now()}`
        this._state = 'running'
        await this._bot.sendMessage(this._chatId, `Starting spec: ${specName}`)
        this._specRunner.runSpec(specName).then(() => {
          this._state = 'completed'
          this._bot.sendMessage(this._chatId, `Spec "${specName}" completed.`).catch(() => {})
        }).catch((err) => {
          this._state = 'failed'
          this._bot.sendMessage(this._chatId, `Spec "${specName}" failed: ${err.message}`).catch(() => {})
        })
        break
      }
      case 'help': {
        const helpText = [
          '📋 Available commands:',
          '/run <prompt> — run an agent job',
          '/stop — stop the current job',
          '/status — check job status',
          '/inject <message> — send a message to the running agent',
          '/spec — list available specs',
          '/spec <name> — run a spec',
          '/screenshot — take a browser screenshot',
          '/app — open the mini app',
          '',
          '💬 Plain text messages reply to agent questions (ask_user).',
        ].join('\n')
        await this._bot.sendMessage(this._chatId, helpText)
        break
      }
      default:
        await this._bot.sendMessage(this._chatId, `Unknown command: /${command}\n\nSend /help for available commands.`)
    }
  }

  /**
   * Attempt to send the recording video to Telegram, or a text notification.
   * @private
   */
  async _sendRecordingOrNotify() {
    const recordingPath = this._bridge?._browserInstance?.getRecordingPath?.()
    if (!recordingPath) {
      const res = await this._bot.sendMessage(this._chatId, `Job ${this._jobId} completed.`)
      if (res.error) this.emit('telegram-unavailable', { reason: res.error, recordingPath: null })
      return
    }

    const validation = this._recordingManager.validateRecording(recordingPath)
    if (!validation.ok) {
      const res = await this._bot.sendMessage(this._chatId, `Job ${this._jobId} completed. Recording unavailable.`)
      if (res.error) this.emit('telegram-unavailable', { reason: res.error, recordingPath: null })
      return
    }

    const sizeCheck = this._recordingManager.checkSizeLimit(recordingPath)
    if (sizeCheck.withinLimit) {
      const res = await this._bot.sendVideo(this._chatId, recordingPath, `Job ${this._jobId} completed`)
      if (res.error) this.emit('telegram-unavailable', { reason: res.error, recordingPath })
    } else {
      const sizeMB = (sizeCheck.sizeBytes / 1024 / 1024).toFixed(1)
      const res = await this._bot.sendMessage(
        this._chatId,
        `Job ${this._jobId} completed. Recording too large to send (${sizeMB} MB > 50 MB limit).`
      )
      if (res.error) this.emit('telegram-unavailable', { reason: res.error, recordingPath })
    }
  }

  /**
   * Remove the Telegram event handler from the main window.
   * @private
   */
  _cleanupTelegramHandler() {
    if (this._telegramEventHandler) {
      sinkBus.off('qwen-event', this._telegramEventHandler)
      this._telegramEventHandler = null
    }
  }

  /**
   * Clear the periodic status update interval.
   * @private
   */
  _clearStatusInterval() {
    if (this._statusInterval) {
      clearInterval(this._statusInterval)
      this._statusInterval = null
    }
  }
}

module.exports = { RemoteJobController }
