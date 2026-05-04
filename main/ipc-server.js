'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const calibrator = require('../calibrator')
const config = require('../config')

// ── calibration state ─────────────────────────────────────────────────────────
let _calibrationProfile = null
let _calibrating = false

// ── calibration cache (persisted to disk, keyed by model ID) ─────────────────
// Profiles are stored in ~/.qwencoder/calibration/<modelKey>.json
// so calibration only runs once per model, not on every server restart.

function _calibrationCacheDir() {
  return path.join(os.homedir(), '.qwencoder', 'calibration')
}

function _modelKey(modelId) {
  // Sanitize model path to a safe filename key
  return (modelId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80)
}

function _loadCachedProfile(modelId) {
  try {
    const file = path.join(_calibrationCacheDir(), _modelKey(modelId) + '.json')
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
      // Validate it has the required fields and the new truncation budgets.
      // If truncation fields are missing, the profile was created before the
      // calibrator was updated — force a fresh benchmark.
      if (data && data.maxInputTokens && data.maxTurns && data.readFileTruncate) {
        console.log(`[calibration] Loaded cached profile for ${_modelKey(modelId)}`)
        return data
      }
      // Stale profile — delete and re-benchmark
      console.log(`[calibration] Stale cached profile for ${_modelKey(modelId)} — missing new fields, will re-benchmark`)
      try { fs.unlinkSync(file) } catch {}
    }
  } catch (err) {
    console.warn(`[calibration] Failed to load cached profile: ${err.message}`)
  }
  return null
}

function _saveCachedProfile(modelId, profile) {
  try {
    const dir = _calibrationCacheDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, _modelKey(modelId) + '.json')
    fs.writeFileSync(file, JSON.stringify({ ...profile, modelId, cachedAt: Date.now() }, null, 2))
    console.log(`[calibration] Saved profile for ${_modelKey(modelId)}`)
  } catch (err) {
    console.warn(`[calibration] Failed to save profile: ${err.message}`)
  }
}

// ── validation helpers ────────────────────────────────────────────────────────
function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0 }
function isValidPort(v) { return Number.isInteger(v) && v > 0 && v < 65536 }

// ── python discovery ──────────────────────────────────────────────────────────
function findPython() {
  for (const p of [
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3',
    '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3',
  ]) {
    try { if (p === 'python3' || fs.existsSync(p)) return p } catch {}
  }
  return 'python3'
}

/**
 * Pre-approve the Python executable in the macOS Application Firewall so that
 * spawning a new Python process (e.g. after a crash restart) does not trigger
 * the "python3 wants to accept incoming network connections" popup.
 *
 * socketfilterfw --add is idempotent — safe to call on every launch.
 * Requires no elevated privileges for the current user's firewall rules.
 */
function suppressFirewallPopup(pyPath) {
  if (process.platform !== 'darwin') return
  const { execFile } = require('child_process')
  const fwTool = '/usr/libexec/ApplicationFirewall/socketfilterfw'
  if (!fs.existsSync(fwTool)) return
  // --add registers the executable; --unblockapp allows incoming connections
  execFile(fwTool, ['--add', pyPath], { timeout: 5000 }, () => {})
  execFile(fwTool, ['--unblockapp', pyPath], { timeout: 5000 }, () => {})
}

function getServerScript(appDir) {
  const packed = path.join(process.resourcesPath || '', 'server.py')
  const dev = path.join(appDir, 'server.py')
  try {
    if (fs.existsSync(packed)) return packed
  } catch {}
  return dev
}

// ── server lifecycle ──────────────────────────────────────────────────────────
let serverProcess = null
let _serverStopping = false
let _lastLoadedModelPath = null  // track last loaded model for post-crash reload
let _lastServerPort = 8090       // track port for graceful unload on shutdown
let _crashRestartTimer = null    // debounce crash restarts
// Ring buffer of last 50 stderr lines — written to crash.log on unexpected exit
const _lastStderr = []
const _STDERR_RING_SIZE = 50

/**
 * Record the last successfully loaded model path so it can be reloaded
 * automatically after a crash restart.
 */
function setLastLoadedModel(modelPath) {
  _lastLoadedModelPath = modelPath
}

function startServer(port, appDir, mainWindow) {
  if (serverProcess) return
  _serverStopping = false
  _lastServerPort = port
  killStaleServer(port)
  const py = findPython()
  // Pre-approve Python in the macOS firewall so crash restarts don't trigger
  // the "python3 wants to accept incoming network connections" popup.
  suppressFirewallPopup(py)
  const script = getServerScript(appDir)
  console.log(`[main] Starting server: ${py} ${script} --port ${port}`)
  serverProcess = spawn(py, [script, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Allow Metal to use more unified memory before triggering OOM
      PYTORCH_MPS_HIGH_WATERMARK_RATIO: '0.0',
      // Reduce MLX memory pool fragmentation
      MLX_METAL_PREALLOCATE: '0',
    },
  })
  serverProcess.stdout.on('data', d => {
    mainWindow?.webContents.send('server-log', d.toString().trim())
  })
  serverProcess.stderr.on('data', d => {
    const line = d.toString().trim()
    // Keep a rolling window of recent stderr for crash diagnosis
    _lastStderr.push(line)
    if (_lastStderr.length > _STDERR_RING_SIZE) _lastStderr.shift()
    mainWindow?.webContents.send('server-log', line)
  })
  serverProcess.on('exit', (code, signal) => {
    serverProcess = null
    // Treat any unexpected exit as a crash — including clean exit (code 0) when
    // we didn't ask for it. SIGTERM from the OS or a race in stopServer() can
    // produce code=0 with _serverStopping=false, which previously left the server
    // dead with no restart. Only skip restart when we explicitly stopped it.
    const isCrash = !_serverStopping
    console.log(`[main] Server exited — code: ${code}, signal: ${signal}, stopping: ${_serverStopping}, crash: ${isCrash}`)
    mainWindow?.webContents.send('server-status', { running: false })

    if (isCrash) {
      // Write a crash log with timestamp and last stderr lines for diagnosis
      try {
        const logDir = path.join(require('os').homedir(), '.qwencoder')
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
        const logPath = path.join(logDir, 'crash.log')
        const entry = `\n--- CRASH ${new Date().toISOString()} signal=${signal} code=${code} ---\n${_lastStderr.join('\n')}\n`
        fs.appendFileSync(logPath, entry, 'utf-8')
        console.log(`[main] Crash log written to ${logPath}`)
      } catch { /* non-fatal */ }

      // Debounce: cancel any pending restart before scheduling a new one
      if (_crashRestartTimer) { clearTimeout(_crashRestartTimer); _crashRestartTimer = null }

      const reason = signal || (code !== 0 ? `exit code ${code}` : 'unexpected exit')
      // Hard crashes (SIGSEGV/SIGABRT/SIGBUS) need longer cooldown for GPU memory release
      const isHardCrash = signal === 'SIGSEGV' || signal === 'SIGABRT' || signal === 'SIGBUS'
      const isPortConflict = _lastStderr.some(l => l.includes('address already in use'))
      const restartDelay = isPortConflict ? 8000 : isHardCrash ? 6000 : 2000
      console.log(`[main] Server exited unexpectedly (${reason}), restarting in ${restartDelay}ms...`)
      mainWindow?.webContents.send('server-log', `⚠️ Server exited (${reason}) — restarting in ${restartDelay / 1000}s...`)
      mainWindow?.webContents.send('server-crashed', { reason, willRestart: true })

      // Wait for Metal/GPU memory to be fully released before restarting.
      // A SIGSEGV from MLX leaves GPU memory in an undefined state — starting
      // too quickly causes an immediate second crash.
      _crashRestartTimer = setTimeout(async () => {
        _crashRestartTimer = null
        if (_serverStopping) return

        // Kill any zombie process still holding the port
        killStaleServer(port)

        mainWindow?.webContents.send('server-log', '🔄 Restarting server...')
        startServer(port, appDir, mainWindow)

        // Wait for the server to be ready, then reload the last model
        const ok = await waitForServer(`http://127.0.0.1:${port}`)
        if (ok && _lastLoadedModelPath) {
          mainWindow?.webContents.send('server-log', `🔄 Reloading model: ${_lastLoadedModelPath.split('/').pop()}...`)
          mainWindow?.webContents.send('server-crashed', { reason, willRestart: false, reloadingModel: true })
          _reloadModel(port, _lastLoadedModelPath, mainWindow, appDir)
        } else if (ok) {
          mainWindow?.webContents.send('server-status', { running: true })
        }
      }, restartDelay)
    }
  })
}

/**
 * Reload a model after a crash restart. Fires calibration and fast-model
 * load on success, same as the normal load-model IPC handler.
 */
async function _reloadModel(port, modelPath, mainWindow, appDir) {
  const http = require('http')
  const body = JSON.stringify({ model_path: modelPath })
  try {
    const result = await new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/admin/load', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let d = ''; res.on('data', c => d += c)
        res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve({ status: 'ok' }) } })
        res.on('error', () => resolve({ error: 'Response error' }))
      })
      req.on('error', err => resolve({ error: err.message }))
      req.setTimeout(120000, () => { req.destroy(); resolve({ error: 'Model load timed out' }) })
      req.write(body); req.end()
    })

    if (result.error) {
      console.error(`[main] Post-crash model reload failed: ${result.error}`)
      mainWindow?.webContents.send('server-log', `❌ Model reload failed: ${result.error}`)
      mainWindow?.webContents.send('server-status', { running: true })
    } else {
      const modelName = modelPath.split('/').pop()
      console.log(`[main] Post-crash model reload succeeded: ${modelName}`)
      mainWindow?.webContents.send('server-log', `✅ Model reloaded: ${modelName}`)
      mainWindow?.webContents.send('server-status', { running: true, reloaded: true, modelId: result.model_id || modelName })

      // Re-run calibration and reload fast model using user's saved preference
      runCalibration(`http://127.0.0.1:${port}`, port, mainWindow, modelPath)
      const config = require('../config')
      const memClient = require('../memory-client.js')
      const projects = require('../projects.js')
      const appSettings = projects.getAppSettings ? projects.getAppSettings() : {}
      const fastModelPath = appSettings.lastFastModelPath || config.DEFAULT_FAST_MODEL
      memClient._httpRequest('POST', '/memory/extractor/load', { model_path: fastModelPath }, 60000)
        .then(r => {
          if (r && !r.error) {
            const fastModelName = fastModelPath.split('/').pop()
            mainWindow?.webContents.send('fast-model-status', { loaded: true, modelPath: fastModelPath, modelName: fastModelName })
          }
        })
        .catch(() => {})
    }
  } catch (err) {
    console.error(`[main] Post-crash model reload error: ${err.message}`)
    mainWindow?.webContents.send('server-status', { running: true })
  }
}

/**
 * Stop the server process.
 * @param {object} [opts]
 * @param {boolean} [opts.graceful] - If true, send /admin/unload before SIGTERM
 *   so the model is cleanly released from Metal memory. Use only on app shutdown,
 *   not on restart (where the delay would cause a port conflict).
 */
function stopServer({ graceful = false } = {}) {
  _serverStopping = true
  if (serverProcess) {
    const proc = serverProcess
    serverProcess = null
    if (graceful) {
      // Ask the server to unload the model and free Metal memory before killing.
      // Fire-and-forget — if the HTTP call fails we still send SIGTERM after the timeout.
      const req = http.request({
        hostname: '127.0.0.1', port: _lastServerPort || 8090,
        path: '/admin/unload', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 0 },
      }, (res) => { res.resume() })
      req.on('error', () => {})
      req.setTimeout(3000, () => { req.destroy() })
      req.end()
      // Give the unload request a moment to complete, then terminate
      setTimeout(() => {
        try { proc.kill('SIGTERM') } catch {}
        setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 2000)
      }, 1500)
    } else {
      // Fast path for restarts — kill immediately to avoid port conflicts
      try { proc.kill('SIGTERM') } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 2000)
    }
  }
}

/**
 * Restart the server (stop then start). Resets the _serverStopping flag
 * so auto-restart logic works correctly after the new process is spawned.
 */
function restartServer(port, appDir, mainWindow) {
  stopServer()
  // Give the old process time to release the port before starting fresh
  setTimeout(() => {
    _serverStopping = false
    startServer(port, appDir, mainWindow)
  }, 1500)
}

/**
 * Kill any existing process on the target port before starting.
 * Prevents "address already in use" from stale processes.
 */
function killStaleServer(port) {
  try {
    const { execSync } = require('child_process')
    const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf-8', timeout: 3000 }).trim()
    if (pids) {
      for (const pid of pids.split('\n')) {
        try { process.kill(Number(pid), 'SIGKILL') } catch {}
      }
      console.log(`[main] Killed stale process(es) on port ${port}: ${pids.replace(/\n/g, ', ')}`)
      // Wait for the OS to release the socket after SIGKILL.
      // Without this, the new server may fail with EADDRINUSE.
      try { execSync('sleep 1', { timeout: 3000 }) } catch {}
    }
  } catch {
    // lsof returns non-zero when no process found — that's fine
  }
}

function waitForServer(serverUrl) {
  return new Promise((resolve) => {
    let attempts = 0
    const maxAttempts = 30
    const check = () => {
      if (attempts >= maxAttempts) return resolve(false)
      attempts++
      const req = http.get(`${serverUrl}/admin/status`, r => {
        // Drain the response body so the socket is freed
        r.resume()
        if (r.statusCode === 200) resolve(true)
        else setTimeout(check, 500)
      })
      req.on('error', () => setTimeout(check, 500))
      // Prevent the request from hanging indefinitely on a single attempt
      req.setTimeout(3000, () => { req.destroy(); setTimeout(check, 500) })
    }
    check()
  })
}

// ── calibration ───────────────────────────────────────────────────────────────
async function runCalibration(serverUrl, serverPort, mainWindow, modelId) {
  // Check disk cache first — skip benchmarking if we already have a profile
  // for this model. Calibration only needs to run once per model.
  const cached = _loadCachedProfile(modelId)
  if (cached) {
    _calibrationProfile = cached
    mainWindow?.webContents.send('calibration-complete', {
      modelId,
      profile: _calibrationProfile,
      fromCache: true,
    })
    console.log(`[calibration] Using cached profile for ${modelId} — skipping benchmark`)
    return _calibrationProfile
  }

  _calibrating = true
  mainWindow?.webContents.send('calibration-status', { status: 'calibrating' })

  try {
    const metrics = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: serverPort,
        path: '/admin/benchmark', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        let d = ''
        res.on('data', c => d += c)
        res.on('end', () => {
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(d)) } catch { reject(new Error('Invalid benchmark response')) }
          } else {
            reject(new Error(`Benchmark failed: HTTP ${res.statusCode}`))
          }
        })
      })
      req.on('error', reject)
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Benchmark timed out')) })
      req.end()
    })

    _calibrationProfile = calibrator.computeProfile(metrics, 'balanced')
    // Persist to disk so future loads of this model skip the benchmark
    _saveCachedProfile(modelId, _calibrationProfile)
    mainWindow?.webContents.send('calibration-complete', {
      modelId,
      profile: _calibrationProfile,
    })
  } catch (err) {
    console.log(`[main] Calibration failed: ${err.message}, using defaults`)
    _calibrationProfile = calibrator.defaultProfile()
    mainWindow?.webContents.send('calibration-complete', {
      modelId,
      profile: _calibrationProfile,
      fallback: true,
    })
  } finally {
    _calibrating = false
  }
}

function getCalibrationProfile() {
  return _calibrationProfile
}

function setCalibrationProfile(profile) {
  _calibrationProfile = profile
}

function isCalibrating() {
  return _calibrating
}

function clearCalibration(modelId) {
  _calibrationProfile = null
  // Also clear the disk cache for this model so next load re-benchmarks
  if (modelId) {
    try {
      const file = path.join(_calibrationCacheDir(), _modelKey(modelId) + '.json')
      if (fs.existsSync(file)) fs.unlinkSync(file)
      console.log(`[calibration] Cleared cached profile for ${modelId}`)
    } catch (err) {
      console.warn(`[calibration] Failed to clear cache: ${err.message}`)
    }
  }
}

// ── IPC registration ──────────────────────────────────────────────────────────
function register(ipcMain, { getServerUrl, getServerPort, getMainWindow, appDir }) {
  const serverUrl = getServerUrl
  const serverPort = getServerPort

  ipcMain.handle('server-start', async () => {
    startServer(serverPort(), appDir, getMainWindow())
    const ok = await waitForServer(serverUrl())
    return { ok }
  })

  ipcMain.handle('server-stop', () => { stopServer(); return { ok: true } })

  ipcMain.handle('server-restart', async () => {
    restartServer(serverPort(), appDir, getMainWindow())
    const ok = await waitForServer(serverUrl())
    return { ok }
  })

  // Force a fresh calibration benchmark, clearing the disk cache for this model
  ipcMain.handle('recalibrate', async (_, modelId) => {
    clearCalibration(modelId)
    runCalibration(serverUrl(), serverPort(), getMainWindow(), modelId)
    return { ok: true }
  })

  ipcMain.handle('server-status', async () => {
    return new Promise(r => {
      const req = http.get(`${serverUrl()}/admin/status`, res => {
        let b = ''; res.on('data', d => b += d)
        res.on('end', () => { try { r({ running: true, ...JSON.parse(b) }) } catch { r({ running: true }) } })
        res.on('error', () => r({ running: false }))
      })
      req.on('error', () => r({ running: false }))
      req.setTimeout(5000, () => { req.destroy(); r({ running: false }) })
    })
  })

  ipcMain.handle('load-model', async (_, modelPath) => {
    if (!isNonEmptyString(modelPath)) return { error: 'modelPath must be a non-empty string' }

    const result = await new Promise((resolve) => {
      const body = JSON.stringify({ model_path: modelPath })
      const req = http.request({
        hostname: '127.0.0.1', port: serverPort(), path: '/admin/load', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let d = ''; res.on('data', c => d += c)
        res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve({ status: 'ok' }) } })
        res.on('error', () => resolve({ error: 'Response error' }))
      })
      req.on('error', err => resolve({ error: `Server not reachable: ${err.code || err.message}` }))
      req.setTimeout(120000, () => { req.destroy(); resolve({ error: 'Model load timed out' }) })
      req.write(body); req.end()
    })

    // Trigger calibration and auto-load extraction model after successful model load
    if (!result.error) {
      _lastLoadedModelPath = modelPath  // remember for post-crash reload
      runCalibration(serverUrl(), serverPort(), getMainWindow(), modelPath)

      // Auto-load the fast extraction model (fire-and-forget).
      // Use the user's saved fast model preference; fall back to DEFAULT_FAST_MODEL.
      // This enables all fast-assist features: todo bootstrap, error diagnosis,
      // file section extraction, search ranking, memory extraction, etc.
      const memClient = require('../memory-client.js')
      const projects = require('../projects.js')
      const appSettings = projects.getAppSettings ? projects.getAppSettings() : {}
      const fastModelPath = appSettings.lastFastModelPath || config.DEFAULT_FAST_MODEL
      memClient._httpRequest('POST', '/memory/extractor/load', { model_path: fastModelPath }, 60000)
        .then(r => {
          if (r && !r.error) {
            const modelName = fastModelPath.split('/').pop()
            console.log(`[main] Fast assist model loaded: ${fastModelPath}`)
            getMainWindow()?.webContents.send('server-log', `⚡ Fast assist model ready (${modelName})`)
            getMainWindow()?.webContents.send('fast-model-status', { loaded: true, modelPath: fastModelPath, modelName })
            // Persist the successfully loaded fast model path
            projects.saveAppSettings({ lastFastModelPath: fastModelPath })
          } else {
            console.log(`[main] Fast assist model load failed: ${r?.error || 'no response'}`)
            getMainWindow()?.webContents.send('fast-model-status', { loaded: false, error: r?.error || 'load failed' })
          }
        })
        .catch(err => {
          console.log(`[main] Fast assist model load error: ${err.message}`)
          getMainWindow()?.webContents.send('fast-model-status', { loaded: false, error: err.message })
        })
    }

    return result
  })

  ipcMain.handle('unload-model', async () => {
    clearCalibration()
    getMainWindow()?.webContents.send('calibration-status', { status: 'unavailable' })
    return { ok: true }
  })

  ipcMain.handle('get-server-url', () => serverUrl())

  // ── Fast model chat reply ─────────────────────────────────────────────────
  ipcMain.handle('assist-chat-reply', async (event, userMessage, agentRole) => {
    try {
      const memClient = require('../memory-client.js')
      const result = await memClient._httpRequest('POST', '/memory/assist', {
        task_type: 'chat_reply',
        payload: { user_message: userMessage || '', agent_role: agentRole || 'general' }
      }, 12000)
      if (!result || result.degraded) return null
      return result.result || null
    } catch (_) { return null }
  })

  // ── Memory extraction model IPC handlers ─────────────────────────────────
  ipcMain.handle('memory-extractor-load', async (event, modelPath) => {
    try {
      const memClient = require('../memory-client.js')
      const result = await memClient._httpRequest('POST', '/memory/extractor/load', { model_path: modelPath }, 30000)
      if (result && !result.error) {
        // Persist user's choice so it auto-loads next time
        const projects = require('../projects.js')
        projects.saveAppSettings({ lastFastModelPath: modelPath })
        const modelName = modelPath.split('/').pop()
        getMainWindow()?.webContents.send('fast-model-status', { loaded: true, modelPath, modelName })
      }
      return result || { error: 'No response from memory backend' }
    } catch (err) {
      return { error: err.message || 'Failed to load extraction model' }
    }
  })

  ipcMain.handle('memory-extractor-unload', async () => {
    try {
      const memClient = require('../memory-client.js')
      const result = await memClient._httpRequest('POST', '/memory/extractor/unload', {}, 10000)
      return result || { ok: true }
    } catch (err) {
      return { error: err.message || 'Failed to unload extraction model' }
    }
  })

  ipcMain.handle('memory-status', async () => {
    try {
      const memClient = require('../memory-client.js')
      return await memClient.getStatus()
    } catch (err) {
      return null
    }
  })

  // ── Memory bank — archive viewer, KG query, stats ─────────────────────────
  ipcMain.handle('memory-archive-search', async (_, query, limit, projectId) => {
    try {
      const memClient = require('../memory-client.js')
      return await memClient.archiveSearch(query || '', { limit: limit || 50, projectId: projectId || null })
    } catch (_) { return [] }
  })

  ipcMain.handle('memory-archive-events', async (_, limit, projectId) => {
    try {
      const memClient = require('../memory-client.js')
      let url = `/memory/archive/events?limit=${limit || 50}`
      if (projectId) url += `&project_id=${encodeURIComponent(projectId)}`
      const result = await memClient._httpRequest('GET', url, null, 5000)
      return Array.isArray(result) ? result : (result?.events || [])
    } catch (_) { return [] }
  })

  ipcMain.handle('memory-kg-query', async (_, entity) => {
    try {
      const memClient = require('../memory-client.js')
      return await memClient.kgQueryEntity(entity || '')
    } catch (_) { return [] }
  })

  ipcMain.handle('memory-stats', async (_, projectId) => {
    try {
      const memClient = require('../memory-client.js')
      let url = '/memory/stats'
      if (projectId) url += `?project_id=${encodeURIComponent(projectId)}`
      const result = await memClient._httpRequest('GET', url, null, 5000)
      return result || null
    } catch (_) { return null }
  })

  // ── Speculative decoding ──────────────────────────────────────────────────
  // Enable: pass { enabled: true, draftModelPath: '/path/to/0.8B', numDraftTokens: 4 }
  // Disable: pass { enabled: false }
  ipcMain.handle('speculative-set', async (_, opts) => {
    const body = JSON.stringify({
      enabled: !!opts.enabled,
      draft_model_path: opts.draftModelPath || null,
      num_draft_tokens: opts.numDraftTokens || null,
    })
    return new Promise(resolve => {
      const req = http.request({
        hostname: '127.0.0.1', port: serverPort(), path: '/admin/speculative', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let d = ''; res.on('data', c => d += c)
        res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve({ status: 'ok' }) } })
        res.on('error', () => resolve({ error: 'Response error' }))
      })
      req.on('error', err => resolve({ error: err.message }))
      req.setTimeout(90000, () => { req.destroy(); resolve({ error: 'Draft model load timed out' }) })
      req.write(body); req.end()
    })
  })

  // ── KV cache quantization ─────────────────────────────────────────────────
  // bits: 4 | 8 | null (null = disable, full fp16)
  ipcMain.handle('kv-cache-set', async (_, bits) => {
    const body = JSON.stringify({ bits: bits ?? null })
    return new Promise(resolve => {
      const req = http.request({
        hostname: '127.0.0.1', port: serverPort(), path: '/admin/kv-cache', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let d = ''; res.on('data', c => d += c)
        res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve({ status: 'ok' }) } })
        res.on('error', () => resolve({ error: 'Response error' }))
      })
      req.on('error', err => resolve({ error: err.message }))
      req.setTimeout(5000, () => { req.destroy(); resolve({ error: 'Request timed out' }) })
      req.write(body); req.end()
    })
  })

  // ── Prefix cache ──────────────────────────────────────────────────────────
  // Build: pass { systemPrompt: '...' }
  // Rebuild: pass { systemPrompt: '...', rebuild: true }
  // Toggle: pass { enabled: true/false }
  // Status: call prefixCacheStatus()
  ipcMain.handle('prefix-cache-set', async (_, opts) => {
    const body = JSON.stringify({
      enabled: opts.enabled ?? null,
      system_prompt: opts.systemPrompt ?? null,
      rebuild: opts.rebuild ?? false,
    })
    return new Promise(resolve => {
      const req = http.request({
        hostname: '127.0.0.1', port: serverPort(), path: '/admin/prefix-cache', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let d = ''; res.on('data', c => d += c)
        res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve({ status: 'ok' }) } })
        res.on('error', () => resolve({ error: 'Response error' }))
      })
      req.on('error', err => resolve({ error: err.message }))
      req.setTimeout(60000, () => { req.destroy(); resolve({ error: 'Prefix cache build timed out' }) })
      req.write(body); req.end()
    })
  })

  ipcMain.handle('prefix-cache-status', async () => {
    return new Promise(resolve => {
      const req = http.get(`${serverUrl()}/admin/prefix-cache`, res => {
        let d = ''; res.on('data', c => d += c)
        res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve(null) } })
        res.on('error', () => resolve(null))
      })
      req.on('error', () => resolve(null))
      req.setTimeout(5000, () => { req.destroy(); resolve(null) })
    })
  })
}

module.exports = { register, startServer, stopServer, restartServer, waitForServer, killStaleServer, findPython, runCalibration, getCalibrationProfile, setCalibrationProfile, isCalibrating, clearCalibration, setLastLoadedModel }
