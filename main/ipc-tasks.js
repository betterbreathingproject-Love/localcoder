'use strict'

const fsp = require('fs/promises')
const { parseTaskGraph } = require('../task-graph')
const { Orchestrator } = require('../orchestrator')
const { sinkBus } = require('../direct-bridge')
const compactor = require('../compactor')
const { astSearch, getSupportedPatterns, getSearchStatus } = require('../ast-search')
const { initSpec, getSpecPhase, advancePhase, getSpecArtifacts, listSpecs, deleteSpec } = require('../spec-workflow')
const { generateSteeringDocs } = require('../steering-generator')

// ── validation ────────────────────────────────────────────────────────────────
function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0 }

// ── IPC registration ──────────────────────────────────────────────────────────
function register(ipcMain, { getMainWindow, getCurrentProject, getAgentPool, getLspManager, findPython, getCalibrationProfile }) {
  let orchestratorInstance = null
  let _agentEventHandler = null  // track so we can remove it before creating a new orchestrator

  // ── helper: tear down the current orchestrator cleanly ──────────────────
  async function _teardownOrchestrator() {
    if (_agentEventHandler) {
      getAgentPool().off('agent-event', _agentEventHandler)
      _agentEventHandler = null
    }
    if (orchestratorInstance) {
      orchestratorInstance.removeAllListeners()
      // Fire-and-forget abort — don't block the caller. The 10s timeout
      // inside cancelAll() was causing the new orchestrator to wait before
      // it could start, making Build feel unresponsive.
      orchestratorInstance.abort().catch(() => {})
      orchestratorInstance = null
    }
  }

  // ── compactor ───────────────────────────────────────────────────────────
  ipcMain.handle('compactor-status', async () => {
    const py = findPython()
    return compactor.getStatus(py)
  })

  ipcMain.handle('compactor-compress-messages', async (_, messages, options) => {
    if (!Array.isArray(messages)) return { error: 'messages must be an array' }
    const py = findPython()
    return compactor.compressMessages(py, messages, options)
  })

  ipcMain.handle('compactor-compress-text', async (_, text, contentType) => {
    if (typeof text !== 'string') return { error: 'text must be a string' }
    const py = findPython()
    return compactor.compressText(py, text, contentType)
  })

  // ── task graph ──────────────────────────────────────────────────────────
  ipcMain.handle('task-graph-parse', async (_, filePath) => {
    if (!isNonEmptyString(filePath)) return { error: 'filePath is required' }
    try {
      const md = await fsp.readFile(filePath, 'utf-8')
      const graph = parseTaskGraph(md)
      const nodes = {}
      for (const [id, node] of graph.nodes) nodes[id] = node
      return { nodes, startNodeId: graph.startNodeId, errors: graph.errors }
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('task-graph-execute', async (_, filePath, explicitProjectDir) => {
    if (!isNonEmptyString(filePath)) return { error: 'filePath is required' }
    try {
      const md = await fsp.readFile(filePath, 'utf-8')
      const graph = parseTaskGraph(md)

      // Read spec context (requirements + design) if this is a spec tasks.md
      let specContext = ''
      const specDir = require('path').dirname(filePath)
      let targetProjectDir = null
      try {
        const p = require('path')
        const fs = require('fs')
        const reqPath = p.join(specDir, 'requirements.md')
        const designPath = p.join(specDir, 'design.md')
        const configPath = p.join(specDir, '.config.maccoder')
        if (fs.existsSync(reqPath)) {
          specContext += '## Requirements\n\n' + fs.readFileSync(reqPath, 'utf-8') + '\n\n'
        }
        if (fs.existsSync(designPath)) {
          specContext += '## Design\n\n' + fs.readFileSync(designPath, 'utf-8') + '\n\n'
        }
        // Read targetProjectDir from spec config — this is the project being built,
        // which may differ from the spec storage location when the spec was created
        // while a different project was open in the UI.
        if (fs.existsSync(configPath)) {
          const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
          if (cfg.targetProjectDir) targetProjectDir = cfg.targetProjectDir.trim()
        }
      } catch (_) { /* spec context is optional */ }

      // Derive project directory: prefer explicit param from renderer, then config, then path walk
      const projectDir = (explicitProjectDir || targetProjectDir || (() => {
        const p = require('path')
        return p.resolve(specDir, '..', '..', '..')
      })()).trim()  // trim trailing spaces/newlines that can sneak in from file paths
      console.log('[orchestrator] projectDir:', projectDir, '(explicit:', !!explicitProjectDir, 'config:', !!targetProjectDir, ')')

      // Abort any previously running orchestrator before starting a new one.
      // Without this, two orchestrators can run concurrently, both dispatching
      // tasks to the same agent pool and corrupting each other's state.
      await _teardownOrchestrator()

      orchestratorInstance = new Orchestrator({
        taskGraph: graph,
        agentPool: getAgentPool(),
        tasksFilePath: filePath,
        specContext,
        lspManager: getLspManager ? getLspManager() : null,
        projectDir,
        getCalibrationProfile: getCalibrationProfile || null,
      })
      orchestratorInstance.on('task-status-event', (evt) => {
        getMainWindow()?.webContents.send('task-status-event', evt)
        sinkBus.emit('task-status-event', evt)
      })

      // Forward agent streaming events (tool calls, tokens) to renderer.
      // Store the handler reference so it can be removed on teardown.
      _agentEventHandler = (evt) => {
        getMainWindow()?.webContents.send('orchestrator-agent-event', evt)
      }
      getAgentPool().on('agent-event', _agentEventHandler)

      orchestratorInstance.on('task-error', (evt) => {
        console.error('[orchestrator] Task error:', evt.nodeId, evt.error)
        getMainWindow()?.webContents.send('task-status-event', { nodeId: evt.nodeId, status: 'failed', error: evt.error })
        // Do NOT send orchestrator-completed here — the orchestrator continues running
        // after a failure (retries or cascades to next tasks). Only 'completed' event
        // should trigger the final UI teardown.
      })
      orchestratorInstance.on('task-skipped', (evt) => {
        console.log('[orchestrator] Task skipped:', evt.nodeId, evt.reason)
        getMainWindow()?.webContents.send('task-status-event', { nodeId: evt.nodeId, status: 'skipped', reason: evt.reason })
      })
      orchestratorInstance.on('completed', () => {
        console.log('[orchestrator] All tasks completed')
        if (_agentEventHandler) {
          getAgentPool().off('agent-event', _agentEventHandler)
          _agentEventHandler = null
        }
        getMainWindow()?.webContents.send('orchestrator-completed')
        sinkBus.emit('orchestrator-completed')
      })
      orchestratorInstance.start().catch(err => {
        console.error('[orchestrator] Start error:', err)
        if (_agentEventHandler) {
          getAgentPool().off('agent-event', _agentEventHandler)
          _agentEventHandler = null
        }
        getMainWindow()?.webContents.send('task-status-event', { nodeId: 'orchestrator', status: 'failed', error: err.message })
        getMainWindow()?.webContents.send('orchestrator-completed')
      })
      return { ok: true }
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('task-graph-pause', async () => {
    try {
      if (orchestratorInstance) await orchestratorInstance.pause()
      return { ok: true }
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('task-graph-abort', async () => {
    try {
      if (orchestratorInstance) {
        await orchestratorInstance.abort()
      }
      // Also cancel any running pool tasks directly (belt-and-suspenders)
      getAgentPool().cancelAll()
      // Notify renderer that execution has stopped so listeners clean up
      getMainWindow()?.webContents.send('orchestrator-completed')
      // Tear down the instance so it can't fire stale events (non-blocking)
      _teardownOrchestrator()
      return { ok: true }
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('task-graph-inject', async (_, message) => {
    if (!isNonEmptyString(message)) return { error: 'message is required' }
    try {
      if (orchestratorInstance) {
        orchestratorInstance.inject(message)
      }
      return { ok: true }
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('task-graph-resume', async () => {
    try {
      if (orchestratorInstance) await orchestratorInstance.resume()
      return { ok: true }
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('task-graph-status', async () => {
    try {
      if (!orchestratorInstance) return { state: 'idle', graph: null }
      const status = orchestratorInstance.getStatus()
      const nodes = {}
      for (const [id, node] of status.graph.nodes) nodes[id] = node
      return { state: status.state, graph: { nodes, startNodeId: status.graph.startNodeId, errors: status.graph.errors } }
    } catch (e) { return { error: e.message } }
  })

  // ── background tasks ────────────────────────────────────────────────────
  ipcMain.handle('bg-task-list', async () => {
    try { return getAgentPool().getBackgroundTasks() }
    catch (e) { return { error: e.message } }
  })

  ipcMain.handle('bg-task-cancel', async (_, taskId) => {
    if (!isNonEmptyString(taskId)) return { error: 'taskId is required' }
    try { await getAgentPool().cancel(taskId); return { ok: true } }
    catch (e) { return { error: e.message } }
  })

  ipcMain.handle('bg-task-output', async (_, taskId) => {
    if (!isNonEmptyString(taskId)) return { error: 'taskId is required' }
    try {
      const tasks = getAgentPool().getBackgroundTasks()
      const task = tasks.find(t => t.id === taskId)
      return task ? (task.output || '') : ''
    } catch (e) { return { error: e.message } }
  })

  // ── AST search ──────────────────────────────────────────────────────────
  ipcMain.handle('ast-search', async (_, pattern, cwd) => {
    if (!pattern) return { error: 'pattern is required' }
    try { return astSearch(pattern, cwd || getCurrentProject()) }
    catch (e) { return { error: e.message } }
  })

  ipcMain.handle('ast-patterns', async () => {
    try { return getSupportedPatterns() }
    catch (e) { return { error: e.message } }
  })

  ipcMain.handle('ast-search-status', async () => {
    try { return getSearchStatus() }
    catch (e) { return { error: e.message } }
  })

  // ── spec workflow ───────────────────────────────────────────────────────
  ipcMain.handle('spec-init', async (_, featureName, targetProjectDir) => {
    if (!isNonEmptyString(featureName)) return { error: 'featureName is required' }
    const project = getCurrentProject()
    if (!project) return { error: 'No project open' }
    try { return initSpec(featureName, project, targetProjectDir || project) }
    catch (e) { return { error: e.message } }
  })

  ipcMain.handle('spec-phase', async (_, specDir) => {
    if (!isNonEmptyString(specDir)) return { error: 'specDir is required' }
    try { return getSpecPhase(specDir) }
    catch (e) { return { error: e.message } }
  })

  ipcMain.handle('spec-advance', async (_, specDir) => {
    if (!isNonEmptyString(specDir)) return { error: 'specDir is required' }
    try { return advancePhase(specDir) }
    catch (e) { return { error: e.message } }
  })

  // ── spec artifacts (used by renderer for spec workflow) ─────────────────
  ipcMain.handle('spec-artifacts', async (_, specDir) => {
    if (!isNonEmptyString(specDir)) return { error: 'specDir is required' }
    try { return getSpecArtifacts(specDir) }
    catch (e) { return { error: e.message } }
  })

  ipcMain.handle('spec-save-artifact', async (_, specDir, phase, content) => {
    if (!isNonEmptyString(specDir) || !isNonEmptyString(phase)) return { error: 'specDir and phase are required' }
    if (typeof content !== 'string') return { error: 'content must be a string' }
    const path = require('path')
    const filePath = path.join(specDir, `${phase}.md`)
    try {
      await fsp.writeFile(filePath, content, 'utf-8')
      return { ok: true }
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('spec-config', async (_, specDir) => {
    if (!isNonEmptyString(specDir)) return { error: 'specDir is required' }
    const path = require('path')
    const configPath = path.join(specDir, '.config.maccoder')
    try {
      const raw = await fsp.readFile(configPath, 'utf-8')
      return JSON.parse(raw)
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('spec-save-config', async (_, specDir, updates) => {
    if (!isNonEmptyString(specDir)) return { error: 'specDir is required' }
    if (!updates || typeof updates !== 'object') return { error: 'updates must be an object' }
    const path = require('path')
    const fs = require('fs')
    const configPath = path.join(specDir, '.config.maccoder')
    try {
      let cfg = {}
      if (fs.existsSync(configPath)) {
        cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      }
      Object.assign(cfg, updates, { lastModified: Date.now() })
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8')
      return { ok: true }
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('spec-list', async () => {
    const project = getCurrentProject()
    if (!project) return []
    try { return listSpecs(project) }
    catch { return [] }
  })

  ipcMain.handle('spec-delete', async (_, specName) => {
    if (!isNonEmptyString(specName)) return { error: 'specName is required' }
    const project = getCurrentProject()
    if (!project) return { error: 'No project open' }
    try { return deleteSpec(specName, project) }
    catch (e) { return { error: e.message } }
  })

  // ── steering docs ───────────────────────────────────────────────────────
  ipcMain.handle('steering-generate', async (_, { projectDir } = {}) => {
    if (!isNonEmptyString(projectDir)) return { error: 'projectDir is required' }
    const win = getMainWindow()
    try {
      win?.webContents.send('steering-progress', { stage: 'starting', message: 'Starting steering doc generation' })
      win?.webContents.send('steering-progress', { stage: 'analyzing', message: 'Analyzing project structure' })
      const result = await generateSteeringDocs(projectDir, getAgentPool())
      win?.webContents.send('steering-progress', { stage: 'complete', message: 'Steering doc generation complete' })
      return { ok: true, docsGenerated: result.docsGenerated }
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('steering-status', async (_, { projectDir } = {}) => {
    const dir = projectDir || getCurrentProject()
    if (!isNonEmptyString(dir)) return { error: 'projectDir is required' }
    const path = require('path')
    const fs = require('fs')
    const steeringDir = path.join(dir, '.maccoder', 'steering')
    try {
      if (!fs.existsSync(steeringDir)) return { exists: false, docCount: 0 }
      const entries = await fsp.readdir(steeringDir)
      const mdFiles = entries.filter(f => f.endsWith('.md'))
      return { exists: mdFiles.length > 0, docCount: mdFiles.length }
    } catch (e) { return { exists: false, docCount: 0 } }
  })
}

module.exports = { register }
