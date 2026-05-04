// QwenCoder Mac Studio — renderer
let allModels=[], selectedModel=null, loadedModelId=null, imageB64=null, isGenerating=false
let currentFile=null, currentProject=null
let attachedImgs = [] // [{name, b64}]
let activeProjectId = null
let _orchestratorRunning = false  // true while task graph / spec orchestrator is executing
let activeSessionId = null
let activeSessionType = 'vibe'
let conversationHistory = [] // [{role, content, ts}]
let projectSettings = null  // context settings for active project
let compactorInstalled = false

// Sanitize a project path — trim whitespace to prevent trailing-space issues
// from file pickers (e.g. "photo ranker " vs "photo ranker")
function sanitizePath(p) { return typeof p === 'string' ? p.trim() : p }
let currentLspStatus = 'stopped' // track LSP status globally
let permMode = 'auto-edit' // 'auto-edit' or 'default'
let agentRole = 'general' // current agent role for vibe mode
let currentTodos = [] // persisted todo list for active session
let _lastCompactionStats = null

// ── fast assistant block renderer ─────────────────────────────────────────────
// Renders a collapsible block showing what the fast (0.8B) model did, similar
// to how tool-blocks show main-model tool activity.
const _FAST_ASSIST_ICONS = {
  vision: '👁️', extract_section: '✂️', fetch_summarize: '🌍',
  git_summarize: '🔀', rank_search: '🔎', error_diagnose: '🩺',
  todo_bootstrap: '📋', todo_watch: '👀', tool_validate: '✅',
}
function renderFastAssistBlock(ev) {
  const task = ev.task || 'assist'
  const icon = _FAST_ASSIST_ICONS[task] || '⚡'
  const label = (ev.label || '⚡ Fast Assistant').replace(/^⚡ Fast Assistant — ?/, '')
  const detail = ev.detail || ''
  const id = 'fa-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
  return `<details class="fast-assist-block" id="${id}">
    <summary class="fast-assist-header">
      <span class="fast-assist-icon">${icon}</span>
      <span class="fast-assist-badge">⚡ Fast</span>
      <span class="fast-assist-label">${esc(label)}</span>
      ${detail ? `<span class="fast-assist-detail">${esc(detail)}</span>` : ''}
    </summary>
  </details>`
}

// ── toast notifications ───────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 5000) {
  let container = document.getElementById('toast-container')
  if (!container) {
    container = document.createElement('div')
    container.id = 'toast-container'
    container.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;'
    document.body.appendChild(container)
  }
  const toast = document.createElement('div')
  const bg = type === 'error' ? 'var(--red, #e74c3c)' : 'var(--green, #2ecc71)'
  toast.style.cssText = `background:${bg};color:#fff;padding:12px 20px;border-radius:8px;font-size:13px;max-width:400px;pointer-events:auto;opacity:0;transition:opacity 0.3s;box-shadow:0 4px 12px rgba(0,0,0,0.3);`
  toast.textContent = message
  container.appendChild(toast)
  requestAnimationFrame(() => { toast.style.opacity = '1' })
  setTimeout(() => {
    toast.style.opacity = '0'
    setTimeout(() => toast.remove(), 300)
  }, duration)
}

// ── init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  // Inject undo panel into DOM
  _initUndoPanel()

  // Show startup overlay immediately — will be dismissed once model loads or skipped
  _initStartupOverlay()

  // Guard: only run autoLoadLastModel once the server is up and models are known.
  // Don't lock out retries if models weren't available yet on the first attempt.
  let _autoLoadRan = false
  async function _tryAutoLoad() {
    if (_autoLoadRan) return
    // Don't mark as ran if models aren't available yet — the onServerStatus
    // handler will call us again once the server is up and models are scanned.
    if (!allModels.length) return
    _autoLoadRan = true
    await autoLoadLastModel()
  }

  window.app.onServerStatus(s => {
    setServerStatus(s.running)
    if (s.running) {
      _setStartupStage('server-ready')
      refreshStatus().then(() => _tryAutoLoad())
    }
    // After a crash restart, the model was reloaded automatically — update UI
    if (s.running && s.reloaded && s.modelId) {
      setLoadedModel(s.modelId)
      appendMsg('system', `✅ Server recovered — model reloaded: ${_formatModelName(s.modelId)}`)
    }
  })

  // Show a visible banner when the server crashes and is recovering
  window.app.onServerCrashed?.((s) => {
    if (s.willRestart) {
      appendMsg('system', `⚠️ MLX server crashed (${s.reason || 'unknown'}) — restarting in 5s and reloading model...`)
      setServerStatus(false)
    }
  })

  // Refresh extraction model section when the background fast-model load completes
  window.app.onFastModelStatus?.((s) => {
    if (s.loaded) {
      _extractionModelStatus = { loaded: true, modelName: s.modelName || s.modelPath?.split('/').pop() || null, memoryGb: null }
    } else {
      _extractionModelStatus = { loaded: false, modelName: null, memoryGb: null }
    }
    _renderExtractionModelSection()
    // Refresh from server to get accurate memoryGb
    refreshExtractionModelStatus()
  })
  await refreshStatus()
  await _tryAutoLoad()

  // drag-drop images onto agent input
  const inputWrap = document.querySelector('.input-wrap')
  if (inputWrap) {
    inputWrap.addEventListener('dragover', e => { e.preventDefault(); inputWrap.style.borderColor='var(--green)' })
    inputWrap.addEventListener('dragleave', () => inputWrap.style.borderColor='')
    inputWrap.addEventListener('drop', e => {
      e.preventDefault(); inputWrap.style.borderColor=''
      for (const f of e.dataTransfer.files) { if (f.type.startsWith('image/')) addImageFile(f) }
    })
  }
  // paste images into agent
  document.addEventListener('paste', e => {
    if (document.querySelector('.ed-tab.active')?.dataset?.tab !== 'agent') return
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) { addImageFile(item.getAsFile()); e.preventDefault() }
    }
  })

  const dz = document.getElementById('dropZone')
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.style.borderColor='var(--accent)' })
  dz.addEventListener('dragleave', () => dz.style.borderColor='')
  dz.addEventListener('drop', e => { e.preventDefault(); dz.style.borderColor=''; const f=e.dataTransfer.files[0]; if(f?.type.startsWith('image/')) readImageFile(f) })
  currentProject = sanitizePath(await window.app.getProject())
  if (currentProject) startFileWatcher(currentProject)
  await loadProjectList()
  await loadContextSettings()
  await loadApiKeys()
  await loadOpenRouterSettings()
  await restoreActiveSpec()
  checkCompactor()
  // Auto-load preview for current project
  if (currentProject && typeof autoUpdateCenterPreview === 'function') autoUpdateCenterPreview()
  checkSearchEngine()
  refreshTelegramStatus()
  refreshWelcomeProjectBar()
  initLspStatus()
  initCalibrationStatus()
  refreshSteeringDocs()
  loadAutoLoadSetting()
  loadAgentRoles()

  // Listen for telegram-unavailable events from the main process
  window.app.onTelegramUnavailable?.(({ reason, recordingPath }) => {
    const msg = recordingPath
      ? `Could not send video to Telegram: ${reason}`
      : `Telegram send failed: ${reason}`
    showToast(msg, 'error', 8000)
  })
})

// ── panels ────────────────────────────────────────────────────────────────────
function showPanel(name, btn) {
  document.querySelectorAll('.ab-btn').forEach(b => b.classList.remove('active'))
  document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('active'))
  btn.classList.add('active')
  document.getElementById('sp-'+name).classList.add('active')
  if(name==='git' && currentProject) refreshGit()
  if(name==='tasks') loadTaskGraph()
  if(name==='specs') loadSpecPanel()
}
function switchMainTab(name, btn) {
  document.querySelectorAll('.ed-tab').forEach(t => t.classList.remove('active'))
  document.querySelectorAll('.center-content .main-panel').forEach(p => p.classList.remove('active'))
  btn.classList.add('active')
  document.getElementById('mt-'+name).classList.add('active')
  if (name === 'agents') loadAgentRoles()
}

// ── permission mode toggle ────────────────────────────────────────────────────
function togglePermMode() {
  const btn = document.getElementById('permToggle')
  if (permMode === 'auto-edit') {
    permMode = 'default'
    btn.textContent = '🔒 Ask'
    btn.className = 'perm-toggle ask'
    btn.title = 'Agent will ask before making changes'
  } else {
    permMode = 'auto-edit'
    btn.textContent = '🔓 Auto'
    btn.className = 'perm-toggle auto'
    btn.title = 'Agent auto-approves all changes'
  }
}

// ── agent role picker ─────────────────────────────────────────────────────────
const ROLE_DESCRIPTIONS = {
  'general': 'Full toolset — code, search, browse, LSP diagnostics',
  'implementation': 'Focused on writing code — LSP diagnostics, definitions, code actions',
  'explore': 'Read-only exploration — symbols, hover, definitions, references',
  'context-gather': 'Gather context — symbols, definitions, references, type info',
  'code-search': 'Search-focused — symbols, references, workspace search, call hierarchy',
  'chat': 'Direct conversational response — no tools, no file writes',
}

// Role icon map — kept in sync with BUILTIN_ROLES icons in main.js.
// Custom roles fall back to '🤖' via the || operator at use sites.
const ROLE_ICONS = { implementation: '🔨', explore: '🔍', 'context-gather': '📚', 'code-search': '🔎', general: '⚡', debug: '🐛', tester: '🧪', requirements: '📋', design: '📐', chat: '💬' }

function changeAgentRole(role) {
  agentRole = role
  const sel = document.getElementById('roleSelect')
  if (sel) sel.title = ROLE_DESCRIPTIONS[role] || 'Agent role'
}

// ── server ────────────────────────────────────────────────────────────────────
async function refreshStatus() {
  const s = await window.app.serverStatus()
  setServerStatus(s.running)
  if (s.running) {
    _setStartupStage('server-ready')
    if (s.models) renderModels(s.models)
    if (s.loaded) setLoadedModel(s.loaded)
  }
}

async function autoLoadLastModel() {
  if (loadedModelId) { dismissStartupOverlay(); return }  // already loaded
  if (!allModels.length) {
    // Server not ready yet or no models — stay on overlay, don't dismiss
    // The onServerStatus handler will call us again once the server is up
    return
  }
  try {
    const appSettings = await window.app.getAppSettings()

    // Respect the auto-load setting (default true)
    if (appSettings.autoLoadOnStartup === false) {
      _setStartupStage('no-model')
      return
    }

    // Prefer saved last model, then fall back to the 35B default by name match
    const targetPath = appSettings.lastModelPath ||
      allModels.find(m => m.path && m.path.includes('Qwen3.6-35B-A3B-MLX-8bit'))?.path ||
      allModels[0]?.path
    if (!targetPath) { _setStartupStage('no-model'); return }
    const match = allModels.find(m => m.path === targetPath) || allModels[0]
    if (!match) { _setStartupStage('no-model'); return }

    const modelName = _formatModelName(match.id)
    _setStartupStage('loading-model', modelName)

    const r = await window.app.loadModel(match.path)
    if (r && r.error) {
      _setStartupStage('error', r.error)
      appendMsg('system', `⚠️ Auto-load failed: ${r.error}`)
    } else {
      setLoadedModel(r.model_id || match.id)
      window.app.saveAppSettings({ lastModelPath: match.path })
      _setStartupStage('done', modelName)
    }
  } catch (err) {
    _setStartupStage('error', err.message || 'Unknown error')
    appendMsg('system', `⚠️ Auto-load failed: ${err.message || 'Unknown error'}`)
  }
}
function setServerStatus(r) {
  document.getElementById('statusDot').className = 'status-dot'+(r?' online':'')
  document.getElementById('statusText').textContent = r?'Server running':'Starting...'
  if(r) setTimeout(refreshStatus, 8000)
}

// ── models ────────────────────────────────────────────────────────────────────
function renderModels(models) {
  allModels = models
  // Update sidebar model list (if present)
  const l = document.getElementById('modelList')
  if (l) {
    if(!models.length) { l.innerHTML='<div class="model-empty">No models</div>' }
    else {
      l.innerHTML = models.map(m => {
        const name = _formatModelName(m.id)
        const cls = m.id===loadedModelId ? 'model-card loaded' : (selectedModel?.id===m.id ? 'model-card selected' : 'model-card')
        return `<div class="${cls}" id="card-${CSS.escape(m.id)}" onclick="selectModel('${m.id}','${m.path}')">
          <div class="model-card-name">${esc(name)}</div>
          <div class="model-card-meta"><span class="badge ${m.vision?'badge-vision':'badge-text'}">${m.vision?'👁 Vision':'💬 Text'}</span><span class="badge badge-type">${esc(m.model_type)}</span></div></div>`
      }).join('')
    }
  }
  // Update the chat model switcher
  _renderModelSwitcher(models)
  // Update extraction model dropdown
  populateExtractionModelList(models)
  // Refresh extraction model status
  refreshExtractionModelStatus()
}

function _formatModelName(id) {
  // Turn "qwen3-vl-lmstudio-community-Qwen3-30B-A3B-MLX-4bit" into "Qwen3 30B A3B MLX 4bit"
  // Strip the qwen3-vl- prefix the server adds, then clean up
  let name = id.replace(/^qwen3-vl-/, '')
  // Remove common org prefixes
  name = name.replace(/^(lmstudio-community|mlx-community|bartowski|unsloth)-?/i, '')
  // Replace hyphens with spaces for readability
  name = name.replace(/-/g, ' ')
  return name || id
}

function _renderModelSwitcher(models) {
  const list = document.getElementById('modelSwitcherList')
  const nameEl = document.getElementById('modelSwitcherName')
  if (!list) return

  // Update current model display
  if (loadedModelId) {
    nameEl.textContent = _formatModelName(loadedModelId)
    nameEl.style.color = ''
  } else {
    nameEl.textContent = 'No model loaded'
    nameEl.style.color = 'var(--muted)'
  }

  if (!models.length) { list.innerHTML = '<div class="ms-empty">No models found in ~/.lmstudio/models/</div>'; return }

  list.innerHTML = models.map((m, i) => {
    const name = _formatModelName(m.id)
    const isLoaded = m.id === loadedModelId
    const icon = m.vision ? '👁️' : '💬'
    const cls = isLoaded ? 'ms-item active' : 'ms-item'
    // Show the original path segments for context
    const pathDisplay = m.id.replace(/^qwen3-vl-/, '').replace(/-/g, '/')
    return `<div class="${cls}" data-ms-idx="${i}">
      <div class="ms-item-icon">${icon}</div>
      <div class="ms-item-info">
        <div class="ms-item-name">${esc(name)}</div>
        <div class="ms-item-path">${esc(pathDisplay)}</div>
        <div class="ms-item-badges">
          <span class="badge ${m.vision?'badge-vision':'badge-text'}">${m.vision?'Vision':'Text'}</span>
          <span class="badge badge-type">${esc(m.model_type)}</span>
        </div>
      </div>
      ${isLoaded ? '<div class="ms-item-check">✓</div>' : ''}
    </div>`
  }).join('')

  // Use event delegation instead of inline onclick to avoid string escaping issues
  list.onclick = (e) => {
    const item = e.target.closest('[data-ms-idx]')
    if (!item) return
    const idx = parseInt(item.dataset.msIdx, 10)
    const m = models[idx]
    if (m) switchModelFromSwitcher(m.id, m.path)
  }
}

function toggleModelSwitcher() {
  const bar = document.getElementById('modelSwitcherBar')
  let dd = document.getElementById('modelSwitcherDropdown')
  if (!bar || !dd) return

  const isOpen = dd.style.display === 'flex'
  if (isOpen) {
    dd.style.display = 'none'
    bar.classList.remove('open')
    return
  }

  // Move dropdown to body on first open so it escapes overflow:hidden containers
  if (dd.parentNode !== document.body) {
    dd.parentNode.removeChild(dd)
    document.body.appendChild(dd)
  }

  // Position dropdown below the switcher button
  const btn = document.getElementById('modelSwitcherBtn')
  if (!btn) return
  const rect = btn.getBoundingClientRect()
  dd.style.position = 'fixed'
  dd.style.top = Math.round(rect.bottom + 4) + 'px'
  dd.style.left = Math.round(rect.left) + 'px'
  dd.style.width = Math.max(rect.width, 300) + 'px'
  dd.style.display = 'flex'
  dd.style.flexDirection = 'column'
  bar.classList.add('open')

  // Close on outside click
  function closer(e) {
    if (dd.contains(e.target) || bar.contains(e.target)) return
    dd.style.display = 'none'
    bar.classList.remove('open')
    document.removeEventListener('mousedown', closer, true)
  }
  requestAnimationFrame(() => {
    document.addEventListener('mousedown', closer, true)
  })
}

async function switchModelFromSwitcher(id, modelPath) {
  if (id === loadedModelId) {
    // Already loaded, just close
    document.getElementById('modelSwitcherDropdown').style.display = 'none'
    document.getElementById('modelSwitcherBar').classList.remove('open')
    return
  }
  // Show loading state
  const nameEl = document.getElementById('modelSwitcherName')
  const prevText = nameEl.textContent
  const modelName = _formatModelName(id)
  nameEl.innerHTML = '<span class="model-loading-spinner"></span> Loading ' + esc(modelName) + '...'
  // Mark the clicked item as loading
  document.querySelectorAll('.ms-item').forEach(el => el.classList.remove('loading'))
  const idx = allModels.findIndex(m => m.id === id)
  const targetItem = idx >= 0 ? document.querySelector(`.ms-item[data-ms-idx="${idx}"]`) : null
  if (targetItem) targetItem.classList.add('loading')

  // Show the loading overlay in the chat area
  _showModelLoadingOverlay(modelName)
  document.getElementById('modelSwitcherBtn').classList.add('loading')

  try {
    const r = await window.app.loadModel(modelPath)
    if (r && r.error) {
      nameEl.textContent = prevText
      if (targetItem) targetItem.classList.remove('loading')
      document.getElementById('modelSwitcherBtn').classList.remove('loading')
      _hideModelLoadingOverlay()
      appendMsg('system', `⚠️ Failed to load model: ${r.error}`)
    } else {
      setLoadedModel(r.model_id || id)
      window.app.saveAppSettings({ lastModelPath: modelPath })
      document.getElementById('modelSwitcherBtn').classList.remove('loading')
      _hideModelLoadingOverlay()
      appendMsg('system', `✅ Model loaded: ${modelName}`)
    }
  } catch (err) {
    nameEl.textContent = prevText
    if (targetItem) targetItem.classList.remove('loading')
    document.getElementById('modelSwitcherBtn').classList.remove('loading')
    _hideModelLoadingOverlay()
    appendMsg('system', `⚠️ Failed to load model: ${err.message || 'Unknown error'}`)
  }
  document.getElementById('modelSwitcherDropdown').style.display = 'none'
  document.getElementById('modelSwitcherBar').classList.remove('open')
}

function selectModel(id, path) {
  selectedModel={id,path}
  document.querySelectorAll('.model-card').forEach(c => { c.className = c.id==='card-'+CSS.escape(loadedModelId)?'model-card loaded':(c.id==='card-'+CSS.escape(id)?'model-card selected':'model-card') })
  const b=document.getElementById('loadBtn'), t=document.getElementById('loadBtnText')
  if (b && t) { b.disabled=id===loadedModelId; t.textContent=id===loadedModelId?'Already loaded':`Load ${_formatModelName(id)}` }
}
async function loadSelected() {
  if(!selectedModel) return
  const b=document.getElementById('loadBtn'), t=document.getElementById('loadBtnText')
  const modelName = _formatModelName(selectedModel.id)
  if (b) b.disabled=true
  if (t) t.innerHTML='<span class="spinner"></span> Loading...'
  _showModelLoadingOverlay(modelName)
  try {
    const r=await window.app.loadModel(selectedModel.path)
    setLoadedModel(r.model_id||selectedModel.id)
    window.app.saveAppSettings({ lastModelPath: selectedModel.path })
    if (t) t.textContent='Already loaded'
    _hideModelLoadingOverlay()
    appendMsg('system', `✅ Model loaded: ${modelName}`)
  }
  catch {
    if (t) t.textContent='Failed'
    if (b) b.disabled=false
    _hideModelLoadingOverlay()
    appendMsg('system', `⚠️ Failed to load model: ${modelName}`)
  }
}
function setLoadedModel(id) {
  loadedModelId=id
  const lmn = document.getElementById('loadedModelName')
  if (lmn) lmn.textContent = id ? _formatModelName(id) : 'None'
  const fmi = document.getElementById('f-modelid')
  if (fmi) fmi.textContent=id||'—'
  renderModels(allModels)
  if (!id && typeof clearCalibrationUI === 'function') clearCalibrationUI()
}

// ── model loading overlay ─────────────────────────────────────────────────────
let _modelLoadTimer = null
function _showModelLoadingOverlay(modelName) {
  // Remove any existing overlay
  _hideModelLoadingOverlay()
  const out = document.getElementById('agentOutput')
  if (!out) return
  // Show overlay on top of the build picker or chat
  const overlay = document.createElement('div')
  overlay.id = 'modelLoadingOverlay'
  overlay.className = 'model-loading-overlay'
  overlay.innerHTML = `
    <div class="model-loading-card">
      <div class="model-loading-icon">
        <div class="model-loading-ring"></div>
        <span class="model-loading-emoji">🤖</span>
      </div>
      <div class="model-loading-title">Loading Model</div>
      <div class="model-loading-name">${esc(modelName)}</div>
      <div class="model-loading-hint" id="modelLoadingHint">Initializing...</div>
      <div class="model-loading-bar"><div class="model-loading-bar-fill" id="modelLoadingBarFill"></div></div>
    </div>`
  out.appendChild(overlay)

  // Animate the hint text through stages
  let stage = 0
  const hints = ['Initializing...', 'Loading weights into memory...', 'Preparing inference engine...', 'Almost ready...']
  _modelLoadTimer = setInterval(() => {
    stage++
    const hint = document.getElementById('modelLoadingHint')
    if (hint && stage < hints.length) hint.textContent = hints[stage]
  }, 3000)
}

function _hideModelLoadingOverlay() {
  if (_modelLoadTimer) { clearInterval(_modelLoadTimer); _modelLoadTimer = null }
  const overlay = document.getElementById('modelLoadingOverlay')
  if (overlay) {
    overlay.classList.add('fade-out')
    setTimeout(() => overlay.remove(), 300)
  }
}

// ── file undo panel ───────────────────────────────────────────────────────────

function _initUndoPanel() {
  const panel = document.createElement('div')
  panel.id = 'undo-panel'
  panel.innerHTML = `
    <div class="undo-panel-header">
      <span class="undo-panel-title">↩ File Undo History</span>
      <button class="undo-panel-close" onclick="toggleUndoPanel()" title="Close">✕</button>
    </div>
    <div class="undo-panel-body" id="undo-panel-body">
      <div class="undo-panel-empty">No file changes recorded yet.<br>Changes made by the agent will appear here.</div>
    </div>
    <div class="undo-panel-footer">
      <span class="undo-panel-count" id="undo-panel-count">0 operations</span>
      <button class="undo-clear-btn" onclick="clearUndoHistory()">Clear all</button>
    </div>
  `
  document.body.appendChild(panel)
}

function toggleUndoPanel() {
  const panel = document.getElementById('undo-panel')
  if (!panel) return
  const isOpen = panel.classList.contains('open')
  if (isOpen) {
    panel.classList.remove('open')
  } else {
    panel.classList.add('open')
    refreshUndoPanel()
  }
}

async function refreshUndoPanel() {
  if (!activeSessionId) return
  const body = document.getElementById('undo-panel-body')
  const countEl = document.getElementById('undo-panel-count')
  if (!body) return

  try {
    const entries = await window.app.undoList(activeSessionId)
    if (!entries || entries.length === 0) {
      body.innerHTML = '<div class="undo-panel-empty">No file changes recorded yet.<br>Changes made by the agent will appear here.</div>'
      if (countEl) countEl.textContent = '0 operations'
      return
    }

    if (countEl) countEl.textContent = `${entries.length} operation${entries.length !== 1 ? 's' : ''}`

    body.innerHTML = entries.map(e => {
      const fileName = e.filePath.split('/').pop()
      const dirPart = e.filePath.split('/').slice(-2, -1)[0] || ''
      const icon = e.tool === 'write_file' ? '📝' : '✏️'
      const label = e.isNew ? 'Created' : e.tool === 'write_file' ? 'Overwritten' : 'Edited'
      const time = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const sizeInfo = e.isNew ? 'new file' : `${(e.beforeSize/1024).toFixed(1)}KB → ${(e.afterSize/1024).toFixed(1)}KB`
      return `
        <div class="undo-entry">
          <span class="undo-entry-icon">${icon}</span>
          <div class="undo-entry-info">
            <div class="undo-entry-file" title="${esc(e.filePath)}">${esc(fileName)}</div>
            <div class="undo-entry-meta">${esc(dirPart)} · ${label} · ${time} · ${sizeInfo}</div>
          </div>
          <button class="undo-entry-restore" onclick="applyUndo(${e.index})" title="Restore this file to its previous state">↩ Undo</button>
        </div>
      `
    }).join('')
  } catch (err) {
    body.innerHTML = `<div class="undo-panel-empty">Error loading undo history: ${esc(err.message)}</div>`
  }
}

async function applyUndo(index) {
  if (!activeSessionId) return showToast('No active session', 'error')
  try {
    const result = await window.app.undoApply(activeSessionId, index)
    if (result.ok) {
      const fileName = result.filePath.split('/').pop()
      showToast(`↩ Restored ${fileName} (${result.restored})`, 'info')
      refreshUndoPanel()
      // Refresh file tree
      if (currentProject) renderFileTree(currentProject, document.getElementById('fileTree'))
    } else {
      showToast(`Undo failed: ${result.error}`, 'error')
    }
  } catch (err) {
    showToast(`Undo error: ${err.message}`, 'error')
  }
}

async function clearUndoHistory() {
  if (!activeSessionId) return
  await window.app.undoClear(activeSessionId)
  refreshUndoPanel()
  updateUndoToggleBtn(0)
}

function updateUndoToggleBtn(count) {
  const btn = document.getElementById('undo-toggle-btn')
  if (!btn) return
  const badge = btn.querySelector('.undo-count-badge')
  if (badge) badge.textContent = count
  btn.style.display = count > 0 ? '' : 'none'
}

// ── startup overlay ───────────────────────────────────────────────────────────
let _startupOverlayDismissed = false
let _startupSkipTimer = null

function _initStartupOverlay() {
  // Show skip button after 5s so user isn't trapped if server is slow
  _startupSkipTimer = setTimeout(() => {
    const btn = document.getElementById('startupSkipBtn')
    if (btn) btn.style.display = ''
  }, 5000)
}

// stage: 'starting' | 'server-ready' | 'loading-model' | 'done'
function _setStartupStage(stage, modelName) {
  if (_startupOverlayDismissed) return
  const stageEl = document.getElementById('startupStage')
  const hintEl = document.getElementById('startupHint')
  const modelEl = document.getElementById('startupModelName')
  const barFill = document.getElementById('startupBarFill')
  if (!stageEl) return

  if (stage === 'server-ready') {
    stageEl.textContent = 'Server ready'
    if (hintEl) hintEl.textContent = 'Checking for last used model...'
  } else if (stage === 'loading-model') {
    stageEl.textContent = 'Loading model'
    if (modelName && modelEl) modelEl.textContent = modelName
    if (hintEl) hintEl.textContent = 'Loading weights into memory...'
    // Cycle through loading hints
    const hints = [
      'Loading weights into memory...',
      'Preparing MLX inference engine...',
      'Warming up on Apple Silicon...',
      'Almost ready...',
    ]
    let hi = 0
    const hintTimer = setInterval(() => {
      hi++
      if (!hintEl || hi >= hints.length) { clearInterval(hintTimer); return }
      hintEl.style.opacity = '0'
      setTimeout(() => {
        if (hintEl) { hintEl.textContent = hints[hi]; hintEl.style.opacity = '1' }
      }, 200)
    }, 3500)
  } else if (stage === 'done') {
    stageEl.textContent = 'Ready'
    if (hintEl) hintEl.textContent = modelName ? `${modelName} loaded` : 'Model loaded'
    if (barFill) barFill.classList.add('done')
    // Dismiss after a short success pause
    setTimeout(() => dismissStartupOverlay(), 800)
  } else if (stage === 'no-model') {
    stageEl.textContent = 'Ready'
    if (hintEl) hintEl.textContent = 'Select a model to get started'
    if (barFill) barFill.classList.add('done')
    setTimeout(() => dismissStartupOverlay(), 600)
  } else if (stage === 'error') {
    stageEl.textContent = 'Load failed'
    if (hintEl) hintEl.textContent = modelName || 'Could not load model'
    setTimeout(() => dismissStartupOverlay(), 1500)
  }
}

function dismissStartupOverlay() {
  if (_startupOverlayDismissed) return
  _startupOverlayDismissed = true
  if (_startupSkipTimer) { clearTimeout(_startupSkipTimer); _startupSkipTimer = null }
  const overlay = document.getElementById('startupOverlay')
  if (!overlay) return
  overlay.classList.add('dismissing')
  setTimeout(() => overlay.remove(), 420)
}

// ── startup settings ──────────────────────────────────────────────────────────
async function loadAutoLoadSetting() {
  try {
    const s = await window.app.getAppSettings()
    const enabled = s.autoLoadOnStartup !== false // default true
    const cb = document.getElementById('as-autoLoad')
    if (cb) cb.checked = enabled
    const nameEl = document.getElementById('as-lastModelName')
    if (nameEl && s.lastModelPath) {
      // Show just the model folder name, not the full path
      const parts = s.lastModelPath.split('/')
      nameEl.textContent = parts[parts.length - 1] || s.lastModelPath
    }
  } catch { /* ignore */ }
}

async function saveAutoLoadSetting(enabled) {
  await window.app.saveAppSettings({ autoLoadOnStartup: enabled })
}

// ── macOS permissions ─────────────────────────────────────────────────────────

// Permission metadata: id, label, description, required, usedBy
const PERMISSION_META = [
  {
    id: 'accessibility',
    icon: '🖱️',
    label: 'Accessibility',
    description: 'Lets agents control the mouse and keyboard for desktop automation tasks.',
    required: false,
    usedBy: 'Desktop automation (mouse_click, keyboard_type, keyboard_press)',
  },
  {
    id: 'screenRecording',
    icon: '🖥️',
    label: 'Screen Recording',
    description: 'Lets agents capture screenshots of your desktop to see what\'s on screen.',
    required: false,
    usedBy: 'Desktop automation (desktop_screenshot)',
  },
  {
    id: 'microphone',
    icon: '🎙️',
    label: 'Microphone',
    description: 'Required for voice input features (future). Not used in the current release.',
    required: false,
    usedBy: 'Voice input (not yet active)',
  },
  {
    id: 'camera',
    icon: '📷',
    label: 'Camera',
    description: 'Required for webcam-based vision analysis (future). Not used in the current release.',
    required: false,
    usedBy: 'Webcam vision (not yet active)',
  },
  {
    id: 'fullDiskAccess',
    icon: '💾',
    label: 'Full Disk Access',
    description: 'Allows reading files outside your home folder. Useful when working on projects in protected locations.',
    required: false,
    usedBy: 'File read/write tools (read_file, write_file)',
  },
]

const PERM_STATUS_LABEL = {
  'granted':        { text: 'Granted',       color: 'var(--green)' },
  'denied':         { text: 'Denied',        color: 'var(--red)' },
  'not-determined': { text: 'Not set',       color: 'var(--orange)' },
  'restricted':     { text: 'Restricted',    color: 'var(--red)' },
  'unknown':        { text: 'Unknown',       color: 'var(--muted)' },
}

async function loadPermissionsSettings() {
  const list = document.getElementById('permissionsList')
  if (!list) return

  // Show loading state
  list.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:4px 0;">Checking…</div>'

  let statuses = {}
  try {
    statuses = await window.setup.checkPermissions()
  } catch (_) {}

  list.innerHTML = ''
  PERMISSION_META.forEach(perm => {
    const raw = statuses[perm.id] || 'unknown'
    const { text: statusText, color: statusColor } = PERM_STATUS_LABEL[raw] || PERM_STATUS_LABEL['unknown']
    const isGranted = raw === 'granted'

    const row = document.createElement('div')
    row.style.cssText = `
      display:flex; align-items:flex-start; gap:10px;
      padding:8px 10px; border-radius:8px; margin-bottom:4px;
      background:var(--surface); border:1px solid var(--border);
      cursor:pointer; transition:border-color .15s;
    `
    row.title = `Open System Settings → ${perm.label}`
    row.innerHTML = `
      <span style="font-size:16px;flex-shrink:0;margin-top:1px;">${perm.icon}</span>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
          <span style="font-size:12px;font-weight:600;color:var(--text);">${perm.label}</span>
          <span style="font-size:10px;font-weight:600;color:${statusColor};flex-shrink:0;">${statusText}</span>
        </div>
        <div style="font-size:10px;color:var(--muted);line-height:1.4;margin-top:2px;">${perm.description}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px;opacity:0.7;">Used by: ${perm.usedBy}</div>
      </div>
      ${!isGranted ? `<span style="font-size:10px;color:var(--accent2);flex-shrink:0;margin-top:2px;">Open →</span>` : ''}
    `
    row.addEventListener('mouseenter', () => { row.style.borderColor = 'rgba(255,255,255,0.15)' })
    row.addEventListener('mouseleave', () => { row.style.borderColor = 'var(--border)' })
    row.addEventListener('click', () => {
      window.setup.openSystemPrefs(perm.id).catch(() => {})
    })
    list.appendChild(row)
  })
}

// ── files ─────────────────────────────────────────────────────────────────────
async function openProject() {
  const p = await window.app.openFolder()
  if(!p) return
  currentProject = sanitizePath(p)
  await renderFileTree(currentProject, document.getElementById('fileTree'))
  startFileWatcher(currentProject)
  if (typeof autoUpdateCenterPreview === 'function') autoUpdateCenterPreview()
}

// ── file watcher for auto-refresh ─────────────────────────────────────────────
let _lastWatchedDir = null
function startFileWatcher(dir) {
  if (!dir) return
  if (_lastWatchedDir === dir) return // already watching
  _lastWatchedDir = dir
  window.app.offFilesChanged()
  window.app.watchProject(dir)
  window.app.onFilesChanged((ev) => {
    // Refresh the file tree
    if (currentProject) {
      renderFileTree(currentProject, document.getElementById('fileTree'))
    }
    // Auto-refresh center preview when HTML files change
    if (ev.filename && /\.(html?|css|js|svg)$/i.test(ev.filename) && _centerPreviewFile) {
      refreshCenterPreview()
    }
    // Auto-refresh live preview if an HTML file changed and preview is open
    if (previewOpen && ev.filename && /\.(html?|svg)$/i.test(ev.filename)) {
      autoRefreshLivePreview(ev)
    }
    // Auto-reload task graph when tasks.md changes on disk (e.g. from orchestrator persistence)
    if (currentTasksPath && ev.filename && ev.filename.endsWith('tasks.md')) {
      // Debounce: only reload if we're not mid-execution (status events handle that)
      // This catches external edits and post-execution persistence
      loadTaskGraph(currentTasksPath).catch(() => {})
    }
  })
}

async function autoRefreshLivePreview(ev) {
  // If we have a current file open that matches, re-read and refresh
  if (currentFile && ev.filename && currentFile.endsWith(ev.filename)) {
    const content = await window.app.readFile(currentFile)
    if (content !== null) {
      document.getElementById('editorArea').value = content
      refreshPreview()
    }
  }
}
async function renderFileTree(dir, container) {
  const entries = await window.app.readDir(dir)
  if(!entries.length) { container.innerHTML='<div class="model-empty">Empty</div>'; return }
  container.innerHTML = entries.map(e =>
    e.isDir
      ? `<div class="ft-item dir" onclick="toggleDir(this,'${e.path.replace(/'/g,"\\'")}')">📁 ${e.name}</div><div class="ft-children" style="display:none;padding-left:12px"></div>`
      : `<div class="ft-item file" onclick="openFile('${e.path.replace(/'/g,"\\'")}','${e.name}')">${fileIcon(e.name)} ${e.name}</div>`
  ).join('')
}
async function toggleDir(el, path) {
  const children = el.nextElementSibling
  if(children.style.display==='none') { children.style.display='block'; await renderFileTree(path, children) }
  else children.style.display='none'
}
function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase()
  const map = {js:'📜',ts:'📘',py:'🐍',html:'🌐',css:'🎨',json:'📋',md:'📝',sh:'⚡',swift:'🦅',rs:'🦀',go:'🐹',rb:'💎',java:'☕',c:'⚙️',cpp:'⚙️',h:'⚙️'}
  return map[ext]||'📄'
}
async function openFile(path, name) {
  const content = await window.app.readFile(path)
  if(content===null) return
  currentFile = path
  document.getElementById('editorFileName').textContent = name
  document.getElementById('editorArea').value = content
  document.getElementById('saveBtn').style.display = 'inline-block'
  updatePreviewToggle()
  switchMainTab('editor', document.querySelector('[data-tab="editor"]'))
  // Fetch symbols when LSP is ready
  if (currentLspStatus === 'ready') {
    fetchAndRenderSymbols(path)
  }
}
async function saveFile() {
  if(!currentFile) return
  const r = await window.app.writeFile(currentFile, document.getElementById('editorArea').value)
  if(r.ok) { const b=document.getElementById('saveBtn'); b.textContent='Saved!'; setTimeout(()=>b.textContent='Save',1000) }
}

// ── git ───────────────────────────────────────────────────────────────────────
async function refreshGit() {
  if(!currentProject) return
  const s = await window.app.gitStatus(currentProject)
  document.getElementById('gitBranch').textContent = s.branch ? `⎇ ${s.branch}` : 'Not a git repo'
  const stMap = {M:'st-m',A:'st-a',D:'st-d','??':'st-a'}
  document.getElementById('gitChanges').innerHTML = s.files.length
    ? s.files.map(f => `<div class="git-file"><span class="st ${stMap[f.status]||'st-u'}">${f.status}</span><span>${f.file}</span></div>`).join('')
    : '<div class="model-empty">Clean</div>'
  const log = await window.app.gitLog(currentProject)
  document.getElementById('gitLog').innerHTML = log.map(c => `<div class="git-commit"><span class="hash">${c.hash}</span>${c.message}</div>`).join('')
}

// ── projects ──────────────────────────────────────────────────────────────────
async function loadProjectList() {
  const projects = await window.app.listProjects()
  const sel = document.getElementById('projectSelect')
  if (!sel) return
  sel.innerHTML = '<option value="">— No project —</option>' +
    projects.map(p => `<option value="${p.id}" ${p.id===activeProjectId?'selected':''}>${p.name}</option>`).join('')
}

async function newProject() {
  const dir = await window.app.openFolder()
  if (!dir) return
  const name = dir.split('/').pop()
  const p = await window.app.createProject(name, dir)
  activeProjectId = p.id
  currentProject = sanitizePath(p.directory)
  await loadProjectList()
  await renderFileTree(dir, document.getElementById('fileTree'))
  startFileWatcher(dir)
  document.getElementById('projectPath').textContent = dir
  conversationHistory = []
  clearChatOutput()
  appendMsg('system', `📁 Project "${p.name}" created`)
  await loadContextSettings()
  await loadSessions()
}

async function switchProject(id) {
  if (!id) {
    activeProjectId=null; activeSessionId=null; currentProject=null; conversationHistory=[]
    clearChatOutput(); document.getElementById('projectPath').textContent=''
    renderSessionSelect([]); updateSessionInfo()
    window.app.unwatchProject(); _lastWatchedDir = null
    _centerPreviewFile = null // clear preview
    const frame = document.getElementById('previewCenterFrame')
    if (frame) { frame.style.display = 'none'; frame.removeAttribute('src'); frame.removeAttribute('srcdoc') }
    const empty = document.getElementById('previewCenterEmpty')
    if (empty) empty.style.display = ''
    await loadContextSettings(); return
  }
  const p = await window.app.openProjectById(id)
  if (!p) return
  activeProjectId = p.id
  currentProject = sanitizePath(p.directory)
  document.getElementById('projectPath').textContent = p.directory
  await renderFileTree(p.directory, document.getElementById('fileTree'))
  startFileWatcher(p.directory)
  await loadContextSettings()
  await restoreActiveSpec()
  await loadSessions(p.activeSession)
  refreshWelcomeProjectBar()
  refreshSteeringDocs()
  // Auto-load preview for new project
  if (typeof autoUpdateCenterPreview === 'function') autoUpdateCenterPreview()
}

// ── sessions ──────────────────────────────────────────────────────────────────
async function loadSessions(preferredId) {
  if (!activeProjectId) { renderSessionSelect([]); updateSessionInfo(); return }
  const sessions = await window.app.listSessions(activeProjectId)
  renderSessionSelect(sessions)
  // pick preferred or first
  const target = preferredId && sessions.find(s => s.id === preferredId) ? preferredId : sessions[0]?.id
  if (target) {
    activeSessionId = target
    const sess = sessions.find(s => s.id === target)
    activeSessionType = (sess && sess.type) || 'vibe'
    document.getElementById('sessionSelect').value = target
    conversationHistory = await window.app.getSessionMsgs(activeProjectId, target)
    await restoreChatFromSnapshot()
    await restoreTodos()
    await restoreWorkflowState()
  } else {
    activeSessionId = null; activeSessionType = 'vibe'; conversationHistory = []; clearChatOutput()
  }
  updateSessionInfo()
}

function renderSessionSelect(sessions) {
  const sel = document.getElementById('sessionSelect')
  if (!sel) return
  sel.innerHTML = sessions.map(s => {
    const icon = (s.type || 'vibe') === 'spec' ? '📋' : '💬'
    return `<option value="${s.id}" ${s.id===activeSessionId?'selected':''}>${icon} ${s.name} (${s.messageCount || 0})</option>`
  }).join('') || '<option value="">No sessions</option>'
}

async function switchSession(id) {
  if (!id || !activeProjectId) return
  // Save current session's chat snapshot and workflow state before switching
  await saveChatSnapshot()
  await saveWorkflowState()

  // Tear down any in-flight agent event listeners from the previous session.
  // Without this, stale onQwenEvent handlers keep firing into the new session's
  // DOM, causing the old status to flash/fight with the new session's UI.
  window.app.offQwenEvents()
  window.app.offOrchestratorEvents?.()
  window.app.offOrchestratorCompleted()
  if (isGenerating) {
    finishGeneration()
  }

  activeSessionId = id
  const sessions = await window.app.listSessions(activeProjectId)
  const sess = sessions.find(s => s.id === id)
  activeSessionType = (sess && sess.type) || 'vibe'
  conversationHistory = await window.app.getSessionMsgs(activeProjectId, id)
  // Reset agent stats bar from previous session to prevent visual overlap
  const statsBar = document.getElementById('agentStats')
  if (statsBar) { statsBar.style.display = 'none'; statsBar.innerHTML = '' }
  await restoreChatFromSnapshot()
  await restoreTodos()
  await restoreWorkflowState()
  updateSessionInfo()
}

async function newSession(sessionType) {
  if (!activeProjectId) { appendMsg('system', '⚠️ Select a project first.'); return }
  // Save current session's chat snapshot and workflow state before creating new one
  await saveChatSnapshot()
  await saveWorkflowState()

  // Tear down stale agent event listeners from the previous session
  window.app.offQwenEvents()
  window.app.offOrchestratorEvents?.()
  window.app.offOrchestratorCompleted()
  if (isGenerating) {
    finishGeneration()
  }

  const sessions = await window.app.listSessions(activeProjectId)
  const type = sessionType || 'vibe'
  const prefix = type === 'spec' ? 'Spec' : 'Vibe'
  const count = sessions.filter(s => (s.type || 'vibe') === type).length
  const name = `${prefix} ${count + 1}`
  const sess = await window.app.createSession(activeProjectId, name, type)
  activeSessionId = sess.id
  activeSessionType = type
  conversationHistory = []
  clearChatOutput()
  await loadSessions(sess.id)
  appendMsg('system', `💬 New ${type} session: ${name}`)
  if (type === 'spec') {
    showInlineSpecWorkflow()
  }
}

async function startSessionWithType(type) {
  if (!activeProjectId) { appendMsg('system', '⚠️ Select a project first.'); return }
  await newSession(type)
}

// ── welcome page project selector ─────────────────────────────────────────────
async function welcomePickProject() {
  const dir = await window.app.openFolder()
  if (!dir) return
  const name = dir.split('/').pop()
  const p = await window.app.createProject(name, dir)
  activeProjectId = p.id
  currentProject = sanitizePath(p.directory)
  await loadProjectList()
  await renderFileTree(dir, document.getElementById('fileTree'))
  startFileWatcher(dir)
  document.getElementById('projectPath').textContent = dir
  await loadContextSettings()
  await loadSessions()
  refreshWelcomeProjectBar()
}

async function welcomeSwitchProject(id) {
  if (!id) return
  await switchProject(id)
  refreshWelcomeProjectBar()
}

async function refreshWelcomeProjectBar() {
  const sel = document.getElementById('welcomeProjectSelect')
  const pathEl = document.getElementById('welcomeProjectPath')
  if (!sel) return
  const projects = await window.app.listProjects()
  sel.innerHTML = '<option value="">— Select a project —</option>' +
    projects.map(p => `<option value="${p.id}" ${p.id === activeProjectId ? 'selected' : ''}>${p.name}</option>`).join('')
  if (pathEl) {
    pathEl.textContent = currentProject || ''
  }
}

async function renameCurrentSession() {
  if (!activeProjectId || !activeSessionId) return
  const sel = document.getElementById('sessionSelect')
  const current = sel.options[sel.selectedIndex]?.text?.replace(/\s*\(\d+\)$/, '') || 'Session'
  const name = prompt('Session name:', current)
  if (!name) return
  await window.app.renameSession(activeProjectId, activeSessionId, name)
  await loadSessions(activeSessionId)
}

async function deleteCurrentSession() {
  if (!activeProjectId || !activeSessionId) return
  if (!confirm('Delete this session and its history?')) return
  await window.app.deleteSession(activeProjectId, activeSessionId)
  activeSessionId = null
  await loadSessions()
}

function updateSessionInfo() {
  const el = document.getElementById('sessionInfo')
  if (!el) return
  if (!activeSessionId) { el.textContent = ''; return }
  const count = conversationHistory.length
  el.textContent = `${count} msg${count !== 1 ? 's' : ''}`
  // update compact button state
  const btn = document.getElementById('compactBtn')
  if (btn) {
    if (!compactorInstalled) {
      btn.className = 'compact-btn missing'
      btn.title = 'claw-compactor not installed'
    } else {
      btn.className = 'compact-btn'
      btn.title = 'Compress conversation with claw-compactor'
    }
  }
}

function clearChatOutput() {
  // Reset the persistent todo panel
  const todoPanel = document.getElementById('todoPanel')
  if (todoPanel) { todoPanel.style.display = 'none'; todoPanel.classList.remove('collapsed') }
  const todoPanelBody = document.getElementById('todoPanelBody')
  if (todoPanelBody) todoPanelBody.innerHTML = ''
  currentTodos = []

  // Clear persisted snapshot and todos for this session
  if (activeProjectId && activeSessionId) {
    window.app.saveSessionSnapshot(activeProjectId, activeSessionId, null)
    window.app.saveSessionTodos(activeProjectId, activeSessionId, [])
  }

  // Reset the stats bar
  const statsBar = document.getElementById('agentStats')
  if (statsBar) { statsBar.style.display = 'none'; statsBar.innerHTML = '' }

  const specResumeHtml = currentSpecDir ? `
        <button class="build-card build-card-spec" onclick="showInlineSpecWorkflow()">
          <span class="build-card-icon">📐</span>
          <span class="build-card-label">Resume Spec</span>
          <span class="build-card-desc">Continue working on "${currentSpecName || 'spec'}"</span>
        </button>` : `
        <button class="build-card build-card-spec" onclick="openSpecPanel()">
          <span class="build-card-icon">📐</span>
          <span class="build-card-label">Spec</span>
          <span class="build-card-desc">Plan first. AI generates requirements, design, and tasks before you code.</span>
        </button>`

  document.getElementById('agentOutput').innerHTML = `
    <div class="build-picker">
      <div class="build-picker-icon">✦</div>
      <div class="build-picker-title">Let's build</div>
      <div class="build-picker-subtitle">Plan, search, or build anything</div>
      <div class="build-picker-project" id="welcomeProjectBar">
        <div class="bp-project-row" id="welcomeProjectRow">
          <span class="bp-project-icon">📁</span>
          <select id="welcomeProjectSelect" class="bp-project-select" onchange="welcomeSwitchProject(this.value)">
            <option value="">— Select a project —</option>
          </select>
          <button class="bp-project-btn" onclick="welcomePickProject()" title="Open folder">Open Folder</button>
        </div>
        <div class="bp-project-path" id="welcomeProjectPath"></div>
      </div>
      <div class="build-picker-cards">
        <button class="build-card build-card-vibe" onclick="startSessionWithType('vibe')">
          <span class="build-card-icon">💬</span>
          <span class="build-card-label">Vibe</span>
          <span class="build-card-desc">Chat and build. Jump straight in and iterate.</span>
        </button>
        ${specResumeHtml}
      </div>
    </div>`
  refreshWelcomeProjectBar()
}

function restoreChat() {
  const out = document.getElementById('agentOutput')
  out.innerHTML = ''
  if (!conversationHistory.length) { clearChatOutput(); return }
  for (const msg of conversationHistory) {
    if (msg.role === 'user') appendMsg('user', esc(msg.content))
    else if (msg.role === 'assistant') {
      out.insertAdjacentHTML('beforeend', `<div class="msg-block"><div class="msg-text">${renderMd(msg.content)}</div></div>`)
    }
  }
  scrollOutput()
}

/** Save the current chat HTML + todo state as a snapshot for the active session */
async function saveChatSnapshot() {
  if (!activeProjectId || !activeSessionId) return
  const out = document.getElementById('agentOutput')
  if (!out) return
  // Don't snapshot the empty "Let's build" picker
  if (out.querySelector('.build-picker')) return
  // Clone the output so we can strip open thinking blocks without mutating the live DOM
  const clone = out.cloneNode(true)
  clone.querySelectorAll('details.msg-thinking').forEach(el => el.removeAttribute('open'))
  const snapshot = clone.innerHTML
  if (snapshot) {
    await window.app.saveSessionSnapshot(activeProjectId, activeSessionId, snapshot)
  }
  // Also persist workflow state alongside the snapshot
  await saveWorkflowState()
}

/** Restore chat from a rich HTML snapshot, falling back to plain message replay */
async function restoreChatFromSnapshot() {
  if (!activeProjectId || !activeSessionId) {
    restoreChat()
    return
  }
  const snapshot = await window.app.getSessionSnapshot(activeProjectId, activeSessionId)
  if (snapshot) {
    const out = document.getElementById('agentOutput')
    out.innerHTML = snapshot
    // Always collapse thinking blocks on restore — they can be huge and
    // the user can expand them manually if needed.
    out.querySelectorAll('details.msg-thinking').forEach(el => el.removeAttribute('open'))
    scrollOutput()
  } else {
    restoreChat()
  }
}

/** Restore persisted todos for the active session */
async function restoreTodos() {
  if (!activeProjectId || !activeSessionId) return
  const todos = await window.app.getSessionTodos(activeProjectId, activeSessionId)
  currentTodos = todos || []
  if (currentTodos.length > 0) {
    updateTodoPanel(currentTodos, 'restored')
  } else {
    const todoPanel = document.getElementById('todoPanel')
    if (todoPanel) { todoPanel.style.display = 'none' }
    const todoPanelBody = document.getElementById('todoPanelBody')
    if (todoPanelBody) todoPanelBody.innerHTML = ''
  }
}

/** Save the current spec + task graph state for the active session */
async function saveWorkflowState() {
  if (!activeProjectId || !activeSessionId) return
  const state = {
    specDir: currentSpecDir || null,
    specName: currentSpecName || null,
    tasksPath: currentTasksPath || null,
  }
  await window.app.saveSessionWorkflowState(activeProjectId, activeSessionId, state)
}

/** Restore spec + task graph state for the active session */
async function restoreWorkflowState() {
  if (!activeProjectId || !activeSessionId) {
    currentTaskGraph = null
    currentTasksPath = null
    renderTaskGraph({ nodes: {} })
    return
  }
  const state = await window.app.getSessionWorkflowState(activeProjectId, activeSessionId)
  if (state) {
    // Restore spec context
    if (state.specDir) {
      currentSpecDir = state.specDir
      currentSpecName = state.specName || null
    } else {
      currentSpecDir = null
      currentSpecName = null
    }
    // Restore task graph from persisted tasks.md path
    if (state.tasksPath) {
      currentTasksPath = state.tasksPath
      try {
        await loadTaskGraph(state.tasksPath)
      } catch (_) {
        // Task file may have been deleted — clear gracefully
        currentTaskGraph = null
        currentTasksPath = null
      }
    } else if (state.specDir) {
      // No explicit tasksPath but we have a spec — try loading its tasks.md
      const specTasksPath = state.specDir + '/tasks.md'
      try {
        await loadTaskGraph(specTasksPath)
      } catch (_) {
        currentTaskGraph = null
        currentTasksPath = null
      }
    } else {
      currentTaskGraph = null
      currentTasksPath = null
      document.getElementById('taskNodeList').innerHTML = '<div class="model-empty" id="taskGraphEmpty">No task graph loaded. Open a Tasks.md file or start a spec workflow.</div>'
    }
  } else {
    // No workflow state — clear task graph sidebar
    currentTaskGraph = null
    currentTasksPath = null
    document.getElementById('taskNodeList').innerHTML = '<div class="model-empty" id="taskGraphEmpty">No task graph loaded. Open a Tasks.md file or start a spec workflow.</div>'
  }
}

async function saveToHistory(role, content) {
  if (!activeProjectId || !activeSessionId) return
  await window.app.appendSessionMsg(activeProjectId, activeSessionId, { role, content })
  conversationHistory = await window.app.getSessionMsgs(activeProjectId, activeSessionId)
  updateSessionInfo()
}

// ── copy ──────────────────────────────────────────────────────────────────────
function copy(id,btn){copyText(document.getElementById(id).textContent,btn)}
function copyText(t,btn){navigator.clipboard.writeText(t).then(()=>{const o=btn.textContent;btn.textContent='✓';setTimeout(()=>btn.textContent=o,1000)})}

// ── image attachments ──────────────────────────────────────────────────────────
function addImageFile(file) {
  const reader = new FileReader()
  reader.onload = ev => {
    attachedImgs.push({ name: file.name, b64: ev.target.result })
    renderAttachedImages()
  }
  reader.readAsDataURL(file)
}
function attachImages(e) { for (const f of e.target.files) { if (f.type.startsWith('image/')) addImageFile(f) } }
function removeAttachedImg(idx) { attachedImgs.splice(idx, 1); renderAttachedImages() }
function renderAttachedImages() {
  const c = document.getElementById('attachedImages')
  c.innerHTML = attachedImgs.map((img, i) =>
    `<div class="attached-img"><img src="${img.b64}"><button class="remove-img" onclick="removeAttachedImg(${i})">×</button></div>`
  ).join('')
}

// ── agent: streaming generation ───────────────────────────────────────────────
const THINK_OPEN=/<think>/i, THINK_CLOSE=/<\/think>/i

function sendAgent() {
  const prompt = document.getElementById('agentPrompt').value.trim()
  if(!prompt) return

  // ── orchestrator injection mode ──────────────────────────────────────────
  // When the task graph / spec orchestrator is running, the main chat input
  // acts as a live injection channel rather than starting a new agent session.
  // This check must come BEFORE the isGenerating guard — orchestrator sets
  // isGenerating=true, which would otherwise block injection entirely.
  if (_orchestratorRunning) {
    document.getElementById('agentPrompt').value = ''
    _resetSendBtn()  // revert button back to Stop immediately after send
    window.app.taskGraphInject(prompt).then(result => {
      if (result?.error) {
        appendMsg('system', `⚠️ Inject failed: ${result.error}`)
      } else {
        appendMsg('user', esc(prompt))
        appendMsg('system', `💬 Injected into running agents — they'll see this at the next turn boundary.`)
      }
    })
    return
  }

  if(isGenerating) return

  // ── slash command interception (Task 10.7) ──
  if (prompt.startsWith('/')) {
    const parsed = parseSlashCommand(prompt)
    if (parsed && SLASH_COMMANDS.has(parsed.command)) {
      document.getElementById('agentPrompt').value = ''
      hideSlashAutocomplete()
      SLASH_COMMANDS.get(parsed.command)(parsed.args)
      return
    } else if (parsed) {
      document.getElementById('agentPrompt').value = ''
      hideSlashAutocomplete()
      appendMsg('system', `⚠️ Unknown command: /${esc(parsed.command)}`)
      SLASH_COMMANDS.get('help')('')
      return
    }
  }

  if(!loadedModelId) { appendMsg('system','⚠️ Load a model first.'); return }

  // auto-create session if none
  if (!activeSessionId && activeProjectId) {
    newSession(activeSessionType || 'vibe').then(() => {
      sendAgentMode(prompt)
    })
    return
  }

  sendAgentMode(prompt)
}

// ── agent mode (Qwen Code SDK with tools) ─────────────────────────────────────
async function sendAgentMode(prompt, opts = {}) {
  if (!currentProject) {
    appendMsg('system', '📁 Agent mode needs a project folder. Opening picker...')
    const p = await window.app.openFolder()
    if (!p) { appendMsg('system', '⚠️ No folder selected. Agent cancelled.'); return }
    currentProject = sanitizePath(p)
    await renderFileTree(currentProject, document.getElementById('fileTree'))
    startFileWatcher(currentProject)
    showPanel('files', document.querySelector('[data-panel="files"]'))
    appendMsg('system', `📁 Working directory: ${currentProject}`)
  }

  isGenerating = true
  const btn = document.getElementById('sendBtn')
  btn.disabled=false; btn.innerHTML='<span class="spinner"></span>Stop'; btn.className='btn-send btn-stop'
  btn.onclick = () => { window.app.qwenInterrupt() }

  const out = document.getElementById('agentOutput')
  if(out.querySelector('.agent-welcome') || out.querySelector('.build-picker')) out.innerHTML = ''

  if (!opts.skipUserMsg) {
    appendMsg('user', esc(prompt))
  }
  // Save a compact version to history for spec prompts (avoid storing massive task lists)
  const historyContent = (opts.historyLabel) ? opts.historyLabel : prompt
  saveToHistory('user', historyContent)
  document.getElementById('agentPrompt').value = ''

  // show attached images in the user message bubble
  if (attachedImgs.length > 0) {
    const lastUserMsg = document.querySelector('#agentOutput .msg-user:last-child')
    if (lastUserMsg) {
      const imgHtml = attachedImgs.map(img => `<img class="agent-img-in-chat" src="${img.b64}" style="max-width:200px;max-height:200px;border-radius:8px;margin-top:6px;margin-right:6px;">`).join('')
      lastUserMsg.insertAdjacentHTML('beforeend', `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">${imgHtml}</div>`)
    }
  }

  const respId = 'resp-'+Date.now()
  out.insertAdjacentHTML('beforeend', `<div class="msg-block" id="${respId}">
    <div class="msg-system" id="${respId}-status" style="display:none"></div>
    <div id="${respId}-fast"></div>
    <div id="${respId}-tools"></div>
    <details class="msg-thinking" id="${respId}-think" style="display:none">
      <summary>🧠 Thinking</summary>
      <div class="msg-thinking-body" id="${respId}-think-body"></div>
    </details>
    <div class="msg-text" id="${respId}-text"></div>
    <div class="msg-activity" id="${respId}-activity">🤖 Agent starting in ${esc(currentProject)}... <span class="activity-dot">●</span></div>
  </div>`)
  scrollOutput()

  // Fast model instant acknowledgement — fire immediately, don't await the agent
  // Shows a short reply from the 0.8B while the 35B loads context and starts its loop
  // Skip when images are attached — the vision path uses the fast model directly
  if (attachedImgs.length === 0) {
    window.app.assistChatReply(prompt, agentRole || 'general').then(reply => {
    if (!reply) return
    // Don't show the fast reply if the agent already finished (e.g. server was down)
    if (agentFinished) return
    const fastEl = document.getElementById(respId + '-fast')
    if (fastEl) {
      fastEl.insertAdjacentHTML('beforeend', `<div class="fast-reply-badge"><span class="fast-reply-icon">⚡</span><span class="fast-reply-model">Fast Assistant</span><span class="fast-reply-text">${esc(reply)}</span></div>`)
      scrollOutput()
    }
  }).catch(() => {})
  }

  let lastText = '', lastThinking = '', tokenCount = 0, startTime = null
  let agentFinished = false
  let lastToolName = ''
  let _bootstrapShown = false  // track whether bootstrap todos have been shown
  let inputTokens = 0, outputTokens = 0
  let serverTps = null // real tk/s from server, used when available
  _TksEstimator.reset() // reset sliding-window estimator for new run
  let allTextSegments = [] // accumulates text across all turns (text→tool→text→...)
  _lastCompactionStats = null // reset so stale stats don't persist across runs
  window._rawCount = 0
  window._rawToolCalls = null
  window.app.offQwenEvents()
  updateStatusBar('initializing', { progress: -1, activity: 'Starting agent...' })
  updateAgentStatsBar({ state: 'initializing', progress: -1, activity: 'Starting agent...' })

  // ── Crash-safe session persistence ───────────────────────────────────────
  // Save the in-progress assistant response every 15s so a crash doesn't
  // lose the full generation. The final save on session-end overwrites this.
  let _autoSaveTimer = null
  function _startAutoSave() {
    if (_autoSaveTimer) return
    _autoSaveTimer = setInterval(() => {
      if (!activeProjectId || !activeSessionId) return
      const partial = allTextSegments.filter(Boolean).join('\n\n')
      if (partial && partial.length > 50) {
        // Save as a draft — prefixed so it's identifiable if the session ends abruptly
        window.app.appendSessionMsg(activeProjectId, activeSessionId, {
          role: 'assistant',
          content: partial,
          draft: true,
          ts: Date.now(),
        }).catch(() => {})
      }
    }, 15000)
  }
  function _stopAutoSave() {
    if (_autoSaveTimer) { clearInterval(_autoSaveTimer); _autoSaveTimer = null }
  }
  _startAutoSave()

  // Helper: update the bottom activity line in the chat (always visible)
  function setActivity(html) {
    const el = document.getElementById(respId + '-activity')
    if (el) { el.innerHTML = html; el.classList.remove('hidden') }
    scrollOutput()
  }
  function hideActivity() {
    const el = document.getElementById(respId + '-activity')
    if (el) el.classList.add('hidden')
  }

  let _agentToolCount = 0
  let _promptProgress = -1
  let _promptProgressTimer = null

  // Simulated prompt-eval progress: smoothly animates from 0→90% while waiting
  // for the first token, then jumps to 100% when generation starts.
  function startPromptProgress() {
    // Always stop any existing timer first to reset cleanly
    if (_promptProgressTimer) { clearInterval(_promptProgressTimer); _promptProgressTimer = null }
    _promptProgress = 0
    let elapsed = 0
    // Immediately show 0% so the UI resets visually
    updateStatusBar('prompt-eval')
    updateAgentStatsBar({ state: 'prompt-eval', inputTokens, outputTokens: tokenCount, progress: 0, toolCount: _agentToolCount, activity: 'Evaluating prompt...' })
    _promptProgressTimer = setInterval(() => {
      elapsed += 200
      // Asymptotic curve: approaches 90% but never reaches it
      _promptProgress = 90 * (1 - Math.exp(-elapsed / 8000))
      updateStatusBar('prompt-eval')
      updateAgentStatsBar({ state: 'prompt-eval', inputTokens, outputTokens: tokenCount, progress: _promptProgress, toolCount: _agentToolCount, activity: 'Evaluating prompt...' })
    }, 200)
  }
  function stopPromptProgress() {
    if (_promptProgressTimer) { clearInterval(_promptProgressTimer); _promptProgressTimer = null }
    _promptProgress = null
  }

  // Debounced markdown rendering — avoids O(n²) re-render on every delta
  // Debounced markdown rendering — avoids O(n²) re-render on every delta
  let _mdRenderTimer = null
  let _mdDirty = false
  function scheduleRender() {
    _mdDirty = true
    if (_mdRenderTimer) return // already scheduled
    _mdRenderTimer = requestAnimationFrame(() => {
      _mdRenderTimer = null
      if (_mdDirty) {
        _mdDirty = false
        document.getElementById(respId+'-text').innerHTML = renderMd(lastText, true) + '<span class="cursor">▌</span>'
        scrollOutput()
      }
    })
  }

  // Debounced scroll for tool preview — avoids excessive scrolling during fast streaming
  let _toolPreviewScrollTimer = null
  function _scheduleToolPreviewScroll() {
    if (_toolPreviewScrollTimer) return
    _toolPreviewScrollTimer = requestAnimationFrame(() => {
      _toolPreviewScrollTimer = null
      scrollOutput()
    })
  }

  window.app.onQwenEvent(ev => {
    if (typeof terminalHandleAgentEvent === 'function') terminalHandleAgentEvent(ev)
    if (agentFinished && ev.type !== 'session-end') return
    switch(ev.type) {
      case 'agent-type':
        if (ev.agentType && ev.agentType !== 'general') {
          _currentAgentType = ev.agentType
          const sel = document.getElementById('roleSelect')
          if (sel && sel.value === 'general') {
            sel.value = ev.agentType
            sel.style.outline = '1px solid var(--accent, #7c6af7)'
            setTimeout(() => { sel.style.outline = '' }, 2000)
          }
        }
        break
      case 'routing-decision':
        if (ev.source === 'small model' || ev.source === 'keyword' || ev.source === 'todo') {
          const roleIcons = ROLE_ICONS
          const label = ev.source === 'keyword' ? '⚡ Fast routed'
            : ev.source === 'todo' ? '⚡ Todo routed'
            : '🤖 Fast model routed'
          const icon = roleIcons[ev.agentType] || '⚡'
          // Insert into the current response block's tools area so it's visible inline
          const toolsEl = document.getElementById(respId + '-tools')
          const html = `<div class="msg-system" style="color:var(--accent,#7c6af7);font-size:11px;padding:2px 8px">${label} → ${icon} ${ev.agentType}</div>`
          if (toolsEl) toolsEl.insertAdjacentHTML('afterbegin', html)
          else appendMsg('system', `<span style="color:var(--accent,#7c6af7);font-size:11px">${label} → ${icon} ${ev.agentType}</span>`)
        }
        break
      case 'fast-assist': {
        const fastEl = document.getElementById(respId + '-fast')
        if (fastEl) fastEl.insertAdjacentHTML('beforeend', renderFastAssistBlock(ev))
        else appendMsg('system', `<span style="color:var(--accent,#7c6af7);font-size:11px">${ev.label || '⚡ Fast Assistant'}</span>`)
        break
      }
      case 'todo-bootstrap': {
        // Fast-assist generated an initial todo list before the main model's first turn.
        // Only show it if the main model hasn't already called update_todos.
        if (!_bootstrapShown && Array.isArray(ev.todos) && ev.todos.length > 0) {
          _bootstrapShown = true
          const mapped = ev.todos.map(t => ({
            id: t.id,
            content: t.content || t.title || t.text || '',
            status: t.status === 'done' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
          }))
          updateTodoPanel(mapped, 'running')
        }
        break
      }
      case 'todo-watch': {
        // Fast-assist inferred a status update from a completed tool call.
        if (Array.isArray(ev.todos) && ev.todos.length > 0) {
          const mapped = ev.todos.map(t => ({
            id: t.id,
            content: t.content || t.title || t.text || '',
            status: t.status === 'done' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
          }))
          updateTodoPanel(mapped, 'running')
        }
        break
      }
      case 'agent-notes': {
        // Agent wrote persistent thinking notes — update the memory bank panel live
        if (typeof ev.notes === 'string') {
          _memRenderNotes(ev.notes, ev.turn)
        }
        break
      }
      case 'user-injection': {
        // A mid-run user message was injected into the agent's turn loop.
        // Show it as a user bubble so the conversation stays readable.
        if (ev.content) {
          const out = document.getElementById('agentOutput')
          out.insertAdjacentHTML('beforeend',
            `<div class="msg-user" style="opacity:0.85;border-left:2px solid var(--blue)">
              <div class="msg-user-label" style="color:var(--blue)">You (injected)</div>
              ${esc(ev.content)}
            </div>`)
          scrollOutput()
        }
        break
      }
      case 'ask-user': {
        // Agent is asking the user a question — render a question card with
        // clickable option chips and a custom "Other…" input.
        renderAskUserCard(ev.question || '', ev.options || [], respId)
        stopPromptProgress()
        setActivity('💬 Waiting for your reply… <span class="activity-dot">●</span>')
        break
      }
      case 'session-start':
        setActivity('🤖 Agent running in ' + esc(ev.cwd||'.') + ' <span class="activity-dot">●</span>')
        startPromptProgress()
        break
      case 'text-delta':
        lastText = ev.text
        if (!startTime) startTime = Date.now()
        stopPromptProgress()
        tokenCount++ // each text-delta ≈ 1 token
        // Keep the latest segment in allTextSegments (last entry = current turn)
        if (allTextSegments.length === 0) allTextSegments.push(ev.text)
        else allTextSegments[allTextSegments.length - 1] = ev.text
        // Extract <think> content from text-delta and route to thinking box
        const thinkContent = extractThinking(lastText)
        if (thinkContent) {
          const thinkEl2 = document.getElementById(respId+'-think')
          thinkEl2.style.display = ''
          document.getElementById(respId+'-think-body').textContent = thinkContent + '▌'
        }
        scheduleRender()
        { const tks = serverTps
          setActivity(`✍️ Generating — ${outputTokens || tokenCount} tokens${tks ? ' · ' + tks + ' tk/s' : ''} <span class="activity-dot">●</span>`)
          updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: outputTokens || tokenCount, tks, toolCount: _agentToolCount, activity: 'Writing response...' })
        }
        break
      case 'thinking-delta':
        lastThinking = ev.text
        stopPromptProgress()
        const thinkEl = document.getElementById(respId+'-think')
        thinkEl.style.display = ''
        document.getElementById(respId+'-think-body').textContent = lastThinking + '▌'
        setActivity('🧠 Reasoning <span class="activity-dot">●</span>')
        updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: tokenCount, activity: 'Reasoning...' })
        break
      case 'tool-delta': {
        // Live streaming preview of tool call arguments as they're generated
        stopPromptProgress()
        const toolName = ev.name || ''
        const args = ev.argumentsSoFar || ''

        // Show what the agent is generating in the status line and stats bar
        const WRITE_TOOLS = ['write_file', 'edit_file', 'create_file']
        const isWriteTool = WRITE_TOOLS.includes(toolName)

        // Extract file path from partial args for a more specific status
        let toolFile = ''
        const pathMatch = args.match(/"(?:path|file_path)"\s*:\s*"([^"]+)"/)
        if (pathMatch) toolFile = pathMatch[1].split('/').pop()

        const activityLabel = isWriteTool && toolFile
          ? `Writing ${toolFile}...`
          : isWriteTool ? `Writing code via ${toolName}...`
          : toolName === 'bash' ? 'Preparing command...'
          : `Preparing ${toolName}...`

        // Show live file name + size in the chat activity line
        { const sizeInfo = isWriteTool && args.length > 100 ? ` · ${(args.length / 1024).toFixed(1)}KB` : ''
          setActivity(`⚡ ${esc(activityLabel)}${sizeInfo} <span class="activity-dot">●</span>`)
        }
        updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: outputTokens || tokenCount, tks: serverTps, toolCount: _agentToolCount, activity: activityLabel })

        // Update or create the streaming tool preview block
        const previewId = respId + '-tool-preview'
        let previewEl = document.getElementById(previewId)
        if (!previewEl) {
          document.getElementById(respId+'-tools').insertAdjacentHTML('beforeend',
            `<div class="tool-block tool-preview running" id="${previewId}">
              <div class="tool-header">
                <span class="tool-icon">⚡</span>
                <div class="tool-header-info">
                  <span class="tool-name">${esc(_toolDisplayName(toolName))}</span>
                  <span class="tool-name-raw">${esc(toolName)}</span>
                </div>
                <span class="tool-status running"><span class="tool-spinner"></span> Generating…</span>
              </div>
              <div class="tool-preview-file"></div>
              <div class="tool-preview-body"></div>
            </div>`)
          previewEl = document.getElementById(previewId)
        }

        // Parse partial args to extract file path and content for write tools
        if (isWriteTool && args.length > 10) {
          const fileEl = previewEl.querySelector('.tool-preview-file')
          const bodyEl = previewEl.querySelector('.tool-preview-body')

          // Try to extract path from partial JSON: {"path":"some/file.js","content":"...
          const pathMatch = args.match(/"path"\s*:\s*"([^"]*)"/)
          if (pathMatch && fileEl) {
            fileEl.textContent = '📄 ' + pathMatch[1]
            fileEl.style.display = 'block'
          }

          // Extract content being written — show as live code preview
          const contentStart = args.indexOf('"content"')
          if (contentStart !== -1) {
            // Find the start of the content value (after "content":" )
            const valStart = args.indexOf(':"', contentStart + 9)
            if (valStart !== -1) {
              let raw = args.slice(valStart + 2)
              // Unescape basic JSON escapes for display
              raw = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
              // Trim trailing incomplete escape or quote
              if (raw.endsWith('\\')) raw = raw.slice(0, -1)
              // Strip trailing JSON closure: "} or just "
              if (raw.endsWith('"}')) raw = raw.slice(0, -2)
              else if (raw.endsWith('"')) raw = raw.slice(0, -1)

              if (bodyEl) {
                // Detect language from file extension for syntax hint
                const ext = (pathMatch?.[1] || '').split('.').pop() || ''
                const lineCount = raw.split('\n').length
                const lines = raw.split('\n').map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`).join('\n')
                bodyEl.innerHTML = `<div class="tool-preview-lang">${esc(ext)} · ${lineCount} lines</div><pre><code>${lines}</code></pre><span class="cursor">▌</span>`
                bodyEl.style.display = 'block'
              }
            }
          }
        } else if (toolName === 'bash' && args.length > 5) {
          const bodyEl = previewEl.querySelector('.tool-preview-body')
          const cmdMatch = args.match(/"command"\s*:\s*"([^"]*(?:\\.[^"]*)*)/)
          if (cmdMatch && bodyEl) {
            let cmd = cmdMatch[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
            bodyEl.innerHTML = `<pre><code>$ ${esc(cmd)}</code></pre><span class="cursor">▌</span>`
            bodyEl.style.display = 'block'
          }
        } else if ((toolName === 'read_file' || toolName === 'read_files') && args.length > 5) {
          const bodyEl = previewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const pMatch = args.match(/"path"\s*:\s*"([^"]*)"/) || args.match(/"paths"\s*:\s*\["([^"]*)"/)
            if (pMatch) { bodyEl.innerHTML = `<pre><code style="color:var(--muted)">📖 ${esc(pMatch[1])}</code></pre>`; bodyEl.style.display = 'block' }
          }
        } else if (toolName === 'list_dir' && args.length > 5) {
          const bodyEl = previewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const pMatch = args.match(/"path"\s*:\s*"([^"]*)"/)
            if (pMatch) { bodyEl.innerHTML = `<pre><code style="color:var(--muted)">📁 ${esc(pMatch[1])}</code></pre>`; bodyEl.style.display = 'block' }
          }
        } else if ((toolName === 'search_files' || toolName === 'grep_search') && args.length > 5) {
          const bodyEl = previewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const pMatch = args.match(/"pattern"\s*:\s*"([^"]*)"/) || args.match(/"query"\s*:\s*"([^"]*)"/)
            if (pMatch) { bodyEl.innerHTML = `<pre><code style="color:var(--muted)">🔍 ${esc(pMatch[1])}</code></pre>`; bodyEl.style.display = 'block' }
          }
        } else if (toolName === 'web_search' && args.length > 5) {
          const bodyEl = previewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const qMatch = args.match(/"query"\s*:\s*"([^"]*)"/)
            if (qMatch) { bodyEl.innerHTML = `<pre><code style="color:var(--muted)">🔎 ${esc(qMatch[1])}</code></pre>`; bodyEl.style.display = 'block' }
          }
        } else if (toolName === 'web_fetch' && args.length > 5) {
          const bodyEl = previewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const uMatch = args.match(/"url"\s*:\s*"([^"]*)"/)
            if (uMatch) { bodyEl.innerHTML = `<pre><code style="color:var(--muted)">🌍 ${esc(uMatch[1])}</code></pre>`; bodyEl.style.display = 'block' }
          }
        } else if (toolName === 'browser_navigate' && args.length > 5) {
          const bodyEl = previewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const uMatch = args.match(/"url"\s*:\s*"([^"]*)"/)
            if (uMatch) { bodyEl.innerHTML = `<pre><code style="color:var(--muted)">🌐 ${esc(uMatch[1])}</code></pre>`; bodyEl.style.display = 'block' }
          }
        } else if (toolName === 'ask_user' && args.length > 5) {
          const bodyEl = previewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const qMatch = args.match(/"question"\s*:\s*"([^"]*(?:\\.[^"]*)*)/)
            if (qMatch) {
              let q = qMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
              bodyEl.innerHTML = `<pre><code style="color:var(--yellow)">❓ ${esc(q)}</code></pre><span class="cursor">▌</span>`
              bodyEl.style.display = 'block'
            }
          }
        } else if (toolName === 'task_complete' && args.length > 5) {
          const bodyEl = previewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const sMatch = args.match(/"summary"\s*:\s*"([^"]*(?:\\.[^"]*)*)/)
            if (sMatch) {
              let s = sMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
              bodyEl.innerHTML = `<pre><code style="color:var(--green)">✅ ${esc(s)}</code></pre><span class="cursor">▌</span>`
              bodyEl.style.display = 'block'
            }
          }
        }

        _scheduleToolPreviewScroll()
        break
      }
      case 'tool-use':
        lastToolName = ev.name || ''
        _agentToolCount++
        stopPromptProgress()
        // Start a new text segment for the next turn after this tool call
        allTextSegments.push('')

        // Route update_todos to the todo panel instead of showing a tool block
        if (ev.name === 'update_todos' && ev.input?.todos) {
          // Map status values to what updateTodoPanel expects
          const mapped = ev.input.todos.map(t => ({
            id: t.id,
            content: t.content || t.title || t.text || '',
            status: t.status === 'done' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
          }))
          _bootstrapShown = true  // main model has set todos — suppress any pending bootstrap
          updateTodoPanel(mapped, 'running')
          // Remove the streaming preview now that we've handled the tool
          const _prevRemove = document.getElementById(respId + '-tool-preview')
          if (_prevRemove) _prevRemove.remove()
          document.getElementById(respId+'-status').textContent = `📋 Updated todo list`
          updateStatusBar('tool', { toolName: ev.name, activity: 'Updating progress...' })
          updateAgentStatsBar({ state: 'tool', toolName: ev.name, inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: 'Updating progress...' })
          scrollOutput()
          break
        }

        // Route edit_todos — apply surgical mutations to the existing todo list
        if (ev.name === 'edit_todos') {
          _bootstrapShown = true
          applyTodoEdits(ev.input)
          const _prevRemove2 = document.getElementById(respId + '-tool-preview')
          if (_prevRemove2) _prevRemove2.remove()
          document.getElementById(respId+'-status').textContent = `📋 Updated todo list`
          updateStatusBar('tool', { toolName: ev.name, activity: 'Updating progress...' })
          updateAgentStatsBar({ state: 'tool', toolName: ev.name, inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: 'Updating progress...' })
          scrollOutput()
          break
        }

        // Replace the streaming preview with the real tool block in a single DOM operation
        // to avoid the visual flash where content disappears between preview removal and
        // real block insertion.
        const _streamingPreview = document.getElementById(respId + '-tool-preview')
        if (_streamingPreview) {
          _streamingPreview.insertAdjacentHTML('beforebegin', renderToolUse(ev.name, ev.input, 'running'))
          _streamingPreview.remove()
        } else {
          document.getElementById(respId+'-tools').insertAdjacentHTML('beforeend', renderToolUse(ev.name, ev.input, 'running'))
        }
        // Capture the ID of the just-inserted tool block so tool-result can find it
        // reliably even if LSP/system messages are inserted after it.
        const _justInsertedTool = document.getElementById(respId+'-tools').querySelector('.tool-block:last-child')
        if (_justInsertedTool) _justInsertedTool.dataset.toolSeq = String(_agentToolCount)
        setActivity(`🔧 ${esc(activity)} <span class="activity-dot">●</span>`)
        // Show specific activity based on tool type
        const toolActivity = {
          'read_file': `Reading ${ev.input?.path?.split('/').pop() || 'file'}...`,
          'write_file': `Writing ${ev.input?.path?.split('/').pop() || 'file'}...`,
          'edit_file': `Editing ${ev.input?.path?.split('/').pop() || 'file'}...`,
          'bash': 'Running command...',
          'list_dir': 'Listing directory...',
          'search_files': `Searching for "${(ev.input?.pattern || '').slice(0, 30)}"...`,
          'browser_navigate': `Navigating to ${(ev.input?.url || '').slice(0, 40)}...`,
          'browser_screenshot': 'Taking screenshot...',
          'browser_click': 'Clicking element...',
          'web_search': `Searching: ${(ev.input?.query || '').slice(0, 30)}...`,
          'web_fetch': 'Fetching page...',
        }
        const activity = toolActivity[ev.name] || `Running ${ev.name}...`
        updateAgentStatsBar({ state: 'tool', toolName: ev.name, inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity })
        scrollOutput()
        break
      case 'tool-result': {
        // Skip rendering tool-result for update_todos/edit_todos — handled by the todo panel
        if (lastToolName === 'update_todos' || lastToolName === 'edit_todos') {
          setActivity('📋 Updated progress <span class="activity-dot">●</span>')
          updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: 'Thinking about next step...' })
          break
        }
        const toolsDiv = document.getElementById(respId+'-tools')
        // Find by tool sequence number — more reliable than :last-child since
        // LSP/system messages may be inserted between tool-use and tool-result.
        const lastTool = toolsDiv.querySelector(`.tool-block[data-tool-seq="${_agentToolCount}"]`)
          || toolsDiv.querySelector('.tool-block.running:last-of-type')
          || toolsDiv.querySelector('.tool-block:last-child')

        if (lastTool) {
          const newStatus = ev.is_error ? 'error' : 'done'
          lastTool.className = lastTool.className.replace(/\b(running|done|error)\b/g, '').trim() + ' ' + newStatus
          const statusEl = lastTool.querySelector('.tool-status')
          if (statusEl) {
            statusEl.className = 'tool-status ' + newStatus
            statusEl.innerHTML = (ev.is_error ? '✗ Error' : '✓ Done')
          }
          const todoStatus = lastTool.querySelector('.todo-status')
          if (todoStatus) {
            todoStatus.className = 'todo-status ' + (ev.is_error ? 'todo-status-error' : 'todo-status-done')
            todoStatus.textContent = ev.is_error ? '✗ Error' : '✓ Done'
          } else {
            lastTool.insertAdjacentHTML('beforeend', renderToolResult(ev.content, ev.is_error))
            // Animate the result body: it starts at natural height (streaming visible),
            // then collapses to the 200px scroll box with a smooth transition.
            const resultBody = lastTool.querySelector('.tool-result-body')
            if (resultBody) {
              const naturalH = resultBody.scrollHeight
              if (naturalH > 200) {
                resultBody.style.maxHeight = naturalH + 'px'
                requestAnimationFrame(() => {
                  resultBody.style.maxHeight = '200px'
                  resultBody.style.overflowY = 'auto'
                })
              }
            }
          }
        }
        const FILE_TOOLS = ['write_file', 'edit_file', 'create_file', 'bash', 'str_replace_editor']
        if (!ev.is_error && FILE_TOOLS.some(t => lastToolName.includes(t))) {
          if (currentProject) renderFileTree(currentProject, document.getElementById('fileTree'))
          // Auto-refresh center preview when HTML files are written
          if (typeof autoUpdateCenterPreview === 'function') autoUpdateCenterPreview()
        }
        // Add inline undo button for write_file / edit_file
        if (!ev.is_error && (lastToolName === 'write_file' || lastToolName === 'edit_file') && lastTool) {
          const undoBtn = document.createElement('button')
          undoBtn.className = 'undo-btn'
          undoBtn.innerHTML = '↩ Undo this change'
          undoBtn.title = 'Restore this file to its state before the agent changed it'
          undoBtn.onclick = async () => {
            undoBtn.disabled = true
            undoBtn.textContent = 'Restoring...'
            const entries = await window.app.undoList(activeSessionId)
            if (entries && entries.length > 0) {
              await applyUndo(0)
              undoBtn.textContent = '✓ Restored'
              undoBtn.style.color = 'var(--green)'
            } else {
              undoBtn.textContent = '✗ Nothing to undo'
              undoBtn.disabled = false
            }
          }
          lastTool.appendChild(undoBtn)
          // Update the undo toggle button count
          window.app.undoList(activeSessionId).then(entries => updateUndoToggleBtn(entries?.length || 0))
        }
        document.getElementById(respId+'-status').innerHTML = `🤖 ${lastToolName ? esc(lastToolName) + ' done — ' : ''}deciding next step <span class="activity-dot">●</span>`
        setActivity(`🤖 ${lastToolName ? esc(lastToolName) + ' done — ' : ''}deciding next step <span class="activity-dot">●</span>`)
        // Restart prompt progress — the server is now processing the tool
        // result and deciding what to do next. This is a real wait period.
        startPromptProgress()
        updateAgentStatsBar({ state: 'prompt-eval', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, progress: 0, activity: 'Processing tool result...' })
        scrollOutput()
        break
      }
      case 'assistant': {
        let html = ''
        for (const block of (ev.blocks || [])) {
          if (block.type === 'text') {
            html += renderMd(block.text)
            allTextSegments.push(block.text)
          }
          else if (block.type === 'thinking') { document.getElementById(respId+'-think').style.display = ''; document.getElementById(respId+'-think-body').textContent = block.text }
          else if (block.type === 'tool_use') document.getElementById(respId+'-tools').insertAdjacentHTML('beforeend', renderToolUse(block.name, block.input, 'done'))
          else if (block.type === 'tool_result') { const td = document.getElementById(respId+'-tools'); const lt = td.querySelector('.tool-block:last-child'); if (lt) lt.insertAdjacentHTML('beforeend', renderToolResult(block.content, block.is_error)) }
        }
        if (html) document.getElementById(respId+'-text').innerHTML = html
        if (ev.usage) {
          inputTokens = ev.usage.input_tokens || inputTokens
          outputTokens = ev.usage.output_tokens || outputTokens || tokenCount
        }
        updateStatusBar('processing', { activity: 'Processing response...' })
        updateAgentStatsBar({ state: 'processing', inputTokens, outputTokens, toolCount: _agentToolCount, activity: 'Processing response...' })
        scrollOutput()
        break
      }
      case 'lsp-activity': {
        // Show LSP activity in the status line and flash the LSP chip
        const lspChip = document.getElementById('lspChip')
        const lspDot = document.getElementById('lspDot')
        const action = ev.action || ''
        const filePath = ev.path ? ev.path.split('/').pop() : ''

        // Flash the LSP dot to indicate activity
        if (lspDot) {
          lspDot.style.background = 'var(--accent2)'
          lspDot.style.boxShadow = '0 0 6px var(--accent2)'
          setTimeout(() => {
            // Restore to current status color
            const colors = { ready: 'var(--green)', starting: '#f5a623', degraded: '#f5a623', error: 'var(--red)', stopped: 'var(--muted)' }
            lspDot.style.background = colors[currentLspStatus] || 'var(--muted)'
            lspDot.style.boxShadow = ''
          }, 800)
        }

        if (action === 'speculative-check') {
          setActivity(`🔬 LSP: validating ${filePath} before write... <span class="activity-dot">●</span>`)
        } else if (action === 'speculative-ok') {
          const toolsEl = document.getElementById(respId+'-tools')
          if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--green)">✅ LSP validated ${filePath} — no new errors</div>`)
        } else if (action === 'speculative-warn') {
          const toolsEl = document.getElementById(respId+'-tools')
          if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--yellow)">⚠️ LSP found ${ev.count} issue${ev.count > 1 ? 's' : ''} in ${filePath}</div>`)
        } else if (action === 'diagnostics-check') {
          setActivity(`🔬 LSP: checking ${filePath} for errors... <span class="activity-dot">●</span>`)
        } else if (action === 'diagnostics-ok') {
          const toolsEl = document.getElementById(respId+'-tools')
          if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--green)">✅ LSP: ${filePath} — clean</div>`)
        } else if (action === 'diagnostics-errors') {
          const toolsEl = document.getElementById(respId+'-tools')
          if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--red)">⚠️ LSP: ${filePath} — ${ev.count} error${ev.count > 1 ? 's' : ''} found</div>`)
        } else if (action === 'session-diagnostics') {
          const toolsEl = document.getElementById(respId+'-tools')
          if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--accent2)">📋 LSP: ${ev.count} existing error${ev.count > 1 ? 's' : ''} in project — agent is aware</div>`)
        }
        break
      }
      case 'memory-extract': {
        // Show a subtle notification when the extraction model processes a turn
        const toolsEl = document.getElementById(respId+'-tools')
        if (toolsEl && ev.message) {
          toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--muted);font-size:10px;opacity:0.7">${esc(ev.message)}</div>`)
        }
        break
      }
      case 'bash-waiting': {
        // Command has been running silently for >60s — show a waiting notice
        const remaining = ev.timeoutSecs - ev.elapsedSecs
        const waitMsg = `⏳ Still running (${ev.elapsedSecs}s, no output) — <code>${esc(ev.command)}</code> — timeout in ${remaining}s`
        setActivity(waitMsg + ' <span class="activity-dot">●</span>')
        const toolsEl2 = document.getElementById(respId+'-tools')
        if (toolsEl2) {
          // Update or create a waiting notice — replace previous one if it exists
          let waitEl = toolsEl2.querySelector('.bash-waiting-notice')
          if (!waitEl) {
            toolsEl2.insertAdjacentHTML('beforeend', `<div class="bash-waiting-notice msg-system" style="color:var(--yellow);font-size:11px">${waitMsg}</div>`)
          } else {
            waitEl.innerHTML = waitMsg
          }
        }
        break
      }
      case 'system':
        if (ev.subtype === 'debug') {
          setActivity(`🔍 ${esc(ev.data)} <span class="activity-dot">●</span>`)
          // Show retries and important debug info inline in chat
          if (ev.data && (ev.data.includes('retrying') || ev.data.includes('Trimmed') || ev.data.includes('Repetition'))) {
            const toolsEl = document.getElementById(respId+'-tools')
            if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--muted)">🔍 ${esc(ev.data)}</div>`)
          }
        } else {
          setActivity(ev.subtype === 'init' ? '🤖 Agent initialized <span class="activity-dot">●</span>' : `⚙️ ${esc(ev.subtype)} <span class="activity-dot">●</span>`)
        }
        updateAgentStatsBar({ state: 'processing', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: ev.subtype === 'debug' ? ev.data : ev.subtype })
        scrollOutput()
        break
      case 'compaction-stats':
        // Only update the badge for conversation-level compaction, not per-tool-result compressions
        if (!ev.data.source || ev.data.source !== 'tool-result') {
          _lastCompactionStats = ev.data
        } else if (!_lastCompactionStats) {
          _lastCompactionStats = ev.data
        }
        updateAgentStatsBar({ state: 'processing', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: 'Compressed context' })
        break
      case 'usage':
        if (ev.usage) {
          inputTokens = ev.usage.input_tokens || ev.usage.prompt_tokens || inputTokens
          outputTokens = ev.usage.output_tokens || ev.usage.completion_tokens || outputTokens
        }
        updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens })
        break
      case 'result':
        hideActivity()
        document.getElementById(respId+'-status').textContent = ev.is_error ? `❌ ${ev.subtype}: ${ev.result||'error'}` : '✅ Done'
        document.getElementById(respId+'-status').style.display = ''
        if (!agentFinished && !window._pendingTasksExecute) {
          agentFinished = true
          stopPromptProgress()
          updateStatusBar('idle')
          updateAgentStatsBar({ state: 'done', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount })
          finishGeneration()
        }
        break
      case 'tasks-file-written':
        // The agent wrote a tasks.md / todo.md file — remember it for orchestrator
        if (ev.path && currentProject) {
          window._pendingTasksExecute = ev.path
        }
        break
      case 'session-end':
        document.getElementById(respId+'-status').textContent = '✅ Agent finished'
        _stopAutoSave()  // stop crash-safe auto-save — we're about to do the real save
        // Reset role dropdown back to general so next message starts fresh
        _currentAgentType = null
        { const sel = document.getElementById('roleSelect'); if (sel) sel.value = 'general' }
        // Combine all text segments from every turn (text→tool→text→...)
        const fullText = allTextSegments.filter(Boolean).join('\n\n')
        const textEl = document.getElementById(respId+'-text')
        if (textEl) textEl.innerHTML = renderMd(fullText)
        // If the agent's text ends with a numbered list (looks like options),
        // inject clickable quick-reply chips so the user can respond easily.
        if (textEl) _injectQuickReplyChips(textEl, fullText)
        // Finalize thinking box with extracted content
        const finalThink = extractThinking(fullText)
        const tb = document.getElementById(respId+'-think-body')
        if (finalThink && tb) {
          document.getElementById(respId+'-think').style.display = ''
          tb.textContent = finalThink
        } else if (tb && tb.textContent.endsWith('▌')) {
          tb.textContent = tb.textContent.slice(0,-1)
        }
        if (fullText) saveToHistory('assistant', fullText)
        if (currentProject) renderFileTree(currentProject, document.getElementById('fileTree'))
        showPreviewButton(respId)
        saveChatSnapshot()

        // If the agent wrote a tasks file, parse it and trigger the orchestrator
        if (window._pendingTasksExecute) {
          const tasksPath = window._pendingTasksExecute
          window._pendingTasksExecute = null
          console.log('[orchestrator] Triggering execution for:', tasksPath)

          // Wrap in async IIFE — parse must complete before execute starts
          ;(async () => {
          // Parse FIRST, then execute — avoid race where status events fire before graph is loaded
          let parsed = null
          try {
            parsed = await window.app.taskGraphParse(tasksPath)
          } catch (_) { /* best-effort */ }

          if (parsed && parsed.nodes) {
            currentTaskGraph = parsed
            currentTasksPath = tasksPath
            renderTaskGraph(parsed)
            saveWorkflowState() // persist task graph path for session restore
            // Do NOT seed the todo panel from the full task graph — the task graph
            // panel already shows all nodes. The todo panel will be populated with
            // the current task's subtasks when the agent starts (via todo-bootstrap).
          }

          agentFinished = false
          isGenerating = true
          const btn = document.getElementById('sendBtn')
          btn.disabled = false; btn.innerHTML = '<span class="spinner"></span>Stop'; btn.className = 'btn-send btn-stop'
          btn.onclick = () => { taskGraphAbort() }

          // Sync task graph sidebar buttons to show running state
          document.getElementById('tgRunBtn').style.display = 'none'
          document.getElementById('tgPauseBtn').style.display = 'inline-block'
          document.getElementById('tgAbortBtn').style.display = 'inline-block'
          document.getElementById('tgInjectBar').style.display = 'block'
          _orchestratorRunning = true
          document.getElementById('agentPrompt').placeholder = '💬 Agents running — type here to inject context or refine objectives. ⌘↵ to send'

          // Switch to tasks panel in sidebar so user can see progress
          showPanel('tasks', document.querySelector('[data-panel="tasks"]'))

          const orchId = 'resp-orch-' + Date.now()
          const out = document.getElementById('agentOutput')
          out.insertAdjacentHTML('beforeend', `<div class="msg-block" id="${orchId}">
            <div class="msg-system" id="${orchId}-status">🚀 Orchestrator: executing tasks...</div>
            <div id="${orchId}-tasks"></div>
            <div class="msg-activity" id="${orchId}-activity">🚀 Starting orchestrator... <span class="activity-dot">●</span></div>
          </div>`)
          scrollOutput()

          window.app.offQwenEvents()
          window.app.offOrchestratorEvents?.()
          window.app.offOrchestratorCompleted()  // clear any stale listener from a previous run
          let orchToolName = ''
          let orchTaskBlockId = null
          let orchTaskText = ''
          let orchTaskCount = 0
          let _orchStartTime = Date.now()

          // Helper: update the orchestrator-level activity line
          function setOrchActivity(html) {
            const el = document.getElementById(orchId + '-activity')
            if (el) { el.innerHTML = html; el.classList.remove('hidden') }
          }

          function newOrchTaskBlock(label) {
            orchTaskCount++
            orchTaskText = ''
            _orchStartTime = Date.now()
            orchTaskBlockId = orchId + '-task-' + orchTaskCount
            const tasksDiv = document.getElementById(orchId + '-tasks')
            tasksDiv.insertAdjacentHTML('beforeend', `<div class="msg-block" id="${orchTaskBlockId}" style="margin:6px 0;padding:8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg3)">
              <div class="msg-system" id="${orchTaskBlockId}-status" style="font-weight:600">${label}</div>
              <div id="${orchTaskBlockId}-fast"></div>
              <div id="${orchTaskBlockId}-tools"></div>
              <details class="msg-thinking" id="${orchTaskBlockId}-think" style="display:none">
                <summary>🧠 Thinking</summary>
                <div class="msg-thinking-body" id="${orchTaskBlockId}-think-body"></div>
              </details>
              <div class="msg-text" id="${orchTaskBlockId}-text"></div>
              <div class="msg-activity" id="${orchTaskBlockId}-activity">🤖 Agent starting... <span class="activity-dot">●</span></div>
            </div>`)
            scrollOutput()
          }

          // ── Bridge orchestrator-agent-event → qwen-event handler ──────────
          // During coding tasks, DirectBridge uses CallbackSink which routes all
          // events through orchestrator-agent-event instead of qwen-event IPC.
          window.app.onOrchestratorEvent(evt => {
            if (evt && evt.channel === 'qwen-event' && evt.data) {
              _orchQwenEventHandler2(evt.data)
            }
          })

          function _orchQwenEventHandler2(ev) {
            if (typeof terminalHandleAgentEvent === 'function') terminalHandleAgentEvent(ev)
            switch (ev.type) {
              case 'agent-type':
                if (ev.agentType && ev.agentType !== 'general') {
                  _currentAgentType = ev.agentType
                  const sel = document.getElementById('roleSelect')
                  if (sel && sel.value === 'general') {
                    sel.value = ev.agentType
                    sel.style.outline = '1px solid var(--accent, #7c6af7)'
                    setTimeout(() => { sel.style.outline = '' }, 2000)
                  }
                }
                break
              case 'routing-decision':
                if (ev.source === 'small model' || ev.source === 'keyword' || ev.source === 'todo') {
                  const roleIcons = ROLE_ICONS
                  const label = ev.source === 'keyword' ? '⚡ Fast routed'
                    : ev.source === 'todo' ? '⚡ Todo routed'
                    : '🤖 Fast model routed'
                  const icon = roleIcons[ev.agentType] || '⚡'
                  const toolsEl = orchTaskBlockId ? document.getElementById(orchTaskBlockId + '-tools') : null
                  const html = `<div class="msg-system" style="color:var(--accent,#7c6af7);font-size:11px;padding:2px 8px">${label} → ${icon} ${ev.agentType}</div>`
                  if (toolsEl) toolsEl.insertAdjacentHTML('afterbegin', html)
                  else appendMsg('system', `<span style="color:var(--accent,#7c6af7);font-size:11px">${label} → ${icon} ${ev.agentType}</span>`)
                }
                break
              case 'fast-assist': {
                const fastEl2 = orchTaskBlockId ? document.getElementById(orchTaskBlockId + '-fast') : null
                if (fastEl2) fastEl2.insertAdjacentHTML('beforeend', renderFastAssistBlock(ev))
                else appendMsg('system', `<span style="color:var(--accent,#7c6af7);font-size:11px">${ev.label || '⚡ Fast Assistant'}</span>`)
                break
              }
              case 'todo-bootstrap': {
                // Orchestrator seeded todos from tasks.md subtasks — show them in the panel
                if (Array.isArray(ev.todos) && ev.todos.length > 0) {
                  const mapped = ev.todos.map(t => ({
                    id: t.id,
                    content: t.content || t.title || t.text || '',
                    status: t.status === 'done' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
                  }))
                  updateTodoPanel(mapped, 'running')
                }
                break
              }
              case 'todo-watch': {
                if (Array.isArray(ev.todos) && ev.todos.length > 0) {
                  const mapped = ev.todos.map(t => ({
                    id: t.id,
                    content: t.content || t.title || t.text || '',
                    status: t.status === 'done' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
                  }))
                  updateTodoPanel(mapped, 'running')
                }
                break
              }
              case 'user-injection': {
                if (ev.content) {
                  const out = document.getElementById('agentOutput')
                  out.insertAdjacentHTML('beforeend',
                    `<div class="msg-user" style="opacity:0.85;border-left:2px solid var(--blue)">
                      <div class="msg-user-label" style="color:var(--blue)">You (injected)</div>
                      ${esc(ev.content)}
                    </div>`)
                  scrollOutput()
                }
                break
              }
              case 'session-start': {
                // Find the current in-progress task from the todo panel or task graph
                const activeTask = currentTodos.find(t => t.status === 'in_progress')
                // Use _currentAgentType which is set by onTaskStatusEvent (fires before session-start)
                const agentType = _currentAgentType
                const agentBadge = agentType && agentType !== 'general' ? ` <span class="orch-agent-badge">${agentType}</span>` : ''
                const taskLabel = activeTask ? `🔧 Task ${activeTask.id}: ${activeTask.content}${agentBadge}` : '🔧 Working on task...'
                newOrchTaskBlock(taskLabel)
                document.getElementById(orchId + '-status').textContent = `🚀 Orchestrator: task ${orchTaskCount}...`
                // Start prompt progress for this task
                startPromptProgress()
                setOrchActivity(`📊 Task ${orchTaskCount}: evaluating prompt... <span class="activity-dot">●</span>`)
                updateAgentStatsBar({ state: 'prompt-eval', inputTokens, outputTokens: tokenCount, progress: 0, toolCount: _agentToolCount, agentType, activity: activeTask ? `Task ${activeTask.id}: Evaluating prompt...` : 'Evaluating prompt...' })
                // Clear todo panel so stale subtasks from the previous task don't linger.
                currentTodos = []
                const todoPanelBody2 = document.getElementById('todoPanelBody')
                if (todoPanelBody2) todoPanelBody2.innerHTML = ''
                break
              }
              case 'text-delta': {
                if (!orchTaskBlockId) newOrchTaskBlock('🔧 Working...')
                stopPromptProgress()
                orchTaskText = ev.text
                // Strip thinking tags from display
                let displayText = orchTaskText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
                // Strip tool call XML that leaks into text stream (model outputting raw tool XML)
                displayText = displayText.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim()
                displayText = displayText.replace(/<function[\s\S]*?<\/function>/gi, '').trim()
                displayText = displayText.replace(/><function=[^>]*>[\s\S]*?<\/tool_call>/gi, '').trim()
                // If still inside an unclosed <think> tag, don't show the thinking content
                const openThink = orchTaskText.lastIndexOf('<think>')
                const closeThink = orchTaskText.lastIndexOf('</think>')
                if (openThink > closeThink) {
                  displayText = orchTaskText.slice(0, openThink).trim()
                  // Show thinking in the thinking box
                  const thinkContent = orchTaskText.slice(openThink + 7)
                  const thinkEl = document.getElementById(orchTaskBlockId + '-think')
                  if (thinkEl) { thinkEl.style.display = ''; document.getElementById(orchTaskBlockId + '-think-body').textContent = thinkContent + '▌' }
                }
                const textEl = document.getElementById(orchTaskBlockId + '-text')
                if (textEl && displayText) textEl.innerHTML = renderMd(displayText, true) + '<span class="cursor">▌</span>'
                tokenCount++
                { const tks = serverTps || _TksEstimator.rate()
                  const actEl = document.getElementById(orchTaskBlockId + '-activity')
                  if (actEl) { actEl.innerHTML = `✍️ Generating — ${tokenCount} tokens${tks ? ' · ' + tks + ' tk/s' : ''} <span class="activity-dot">●</span>`; actEl.classList.remove('hidden') }
                  setOrchActivity(`✍️ Task ${orchTaskCount}: generating — ${tokenCount} tokens${tks ? ' · ' + tks + ' tk/s' : ''} <span class="activity-dot">●</span>`)
                }
                updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, agentType: _currentAgentType, activity: 'Writing response...' })
                scrollOutput()
                break
              }
              case 'tool-use':
                if (!orchTaskBlockId) newOrchTaskBlock('🔧 Working...')
                stopPromptProgress()
                orchToolName = ev.name || ''
                _agentToolCount++
                // Route update_todos to the todo panel — always update regardless of task graph state.
                // The task graph panel (left sidebar) and todo panel (right) are independent.
                if (ev.name === 'update_todos' && ev.input?.todos) {
                  const mapped = ev.input.todos.map(t => ({
                    id: t.id,
                    content: t.content || t.title || t.text || '',
                    status: t.status === 'done' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
                  }))
                  updateTodoPanel(mapped, 'running')
                  updateAgentStatsBar({ state: 'tool', toolName: ev.name, inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, activity: 'Updating progress...' })
                  scrollOutput()
                  break
                }
                // Route edit_todos — surgical mutations to the existing list
                if (ev.name === 'edit_todos') {
                  applyTodoEdits(ev.input)
                  updateAgentStatsBar({ state: 'tool', toolName: ev.name, inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, activity: 'Updating progress...' })
                  scrollOutput()
                  break
                }
                document.getElementById(orchTaskBlockId + '-tools').insertAdjacentHTML('beforeend', renderToolUse(ev.name, ev.input, 'running'))
                // Capture the ID of the just-inserted tool block for reliable lookup in tool-result
                const _orchJustInserted = document.getElementById(orchTaskBlockId + '-tools').querySelector('.tool-block:last-child')
                if (_orchJustInserted) _orchJustInserted.dataset.toolSeq = String(_agentToolCount)
                document.getElementById(orchTaskBlockId + '-status').textContent = `🔧 Using tool: ${ev.name}`
                { const actEl = document.getElementById(orchTaskBlockId + '-activity')
                  if (actEl) { actEl.innerHTML = `⚡ ${esc(ev.name || 'tool')} <span class="activity-dot">●</span>`; actEl.classList.remove('hidden') }
                  setOrchActivity(`🔧 Task ${orchTaskCount}: running ${esc(ev.name || 'tool')} <span class="activity-dot">●</span>`)
                }
                updateAgentStatsBar({ state: 'tool', toolName: ev.name, inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, agentType: _currentAgentType, activity: `Running ${ev.name}...` })
                scrollOutput()
                break
              case 'tool-result': {
                if (!orchTaskBlockId) break
                // Skip rendering tool-result for update_todos/edit_todos
                if (orchToolName === 'update_todos' || orchToolName === 'edit_todos') {
                  updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, activity: 'Thinking about next step...' })
                  break
                }
                const toolsDiv = document.getElementById(orchTaskBlockId + '-tools')
                const lastTool = toolsDiv?.querySelector(`.tool-block[data-tool-seq="${_agentToolCount}"]`)
                  || toolsDiv?.querySelector('.tool-block.running:last-of-type')
                  || toolsDiv?.querySelector('.tool-block:last-child')
                if (lastTool) {
                  const newStatus = ev.is_error ? 'error' : 'done'
                  lastTool.className = lastTool.className.replace(/\b(running|done|error)\b/g, '').trim() + ' ' + newStatus
                  const statusEl = lastTool.querySelector('.tool-status')
                  if (statusEl) { statusEl.className = 'tool-status ' + newStatus; statusEl.innerHTML = ev.is_error ? '✗ Error' : '✓ Done' }
                  lastTool.insertAdjacentHTML('beforeend', renderToolResult(ev.content, ev.is_error))
                  const resultBody = lastTool.querySelector('.tool-result-body')
                  if (resultBody) {
                    const naturalH = resultBody.scrollHeight
                    if (naturalH > 200) {
                      resultBody.style.maxHeight = naturalH + 'px'
                      requestAnimationFrame(() => { resultBody.style.maxHeight = '200px'; resultBody.style.overflowY = 'auto' })
                    }
                  }
                }
                const FILE_TOOLS = ['write_file', 'edit_file', 'create_file', 'bash']
                if (!ev.is_error && FILE_TOOLS.some(t => orchToolName.includes(t))) {
                  if (currentProject) renderFileTree(currentProject, document.getElementById('fileTree'))
                  if (typeof autoUpdateCenterPreview === 'function') autoUpdateCenterPreview()
                }
                updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, agentType: _currentAgentType, activity: 'Thinking about next step...' })
                { const actEl = document.getElementById(orchTaskBlockId + '-activity')
                  if (actEl) { actEl.innerHTML = `🧠 Thinking about next step... <span class="activity-dot">●</span>`; actEl.classList.remove('hidden') }
                }
                startPromptProgress()
                scrollOutput()
                break
              }
              case 'result':
                if (orchTaskBlockId && ev.result && !ev.is_error) {
                  const textEl = document.getElementById(orchTaskBlockId + '-text')
                  if (textEl) {
                    let cleanResult = ev.result.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
                    textEl.innerHTML = renderMd(cleanResult)
                  }
                }
                break
              case 'raw-stream': {
                const sev = ev.event; if (!sev) break
                if (sev.usage) {
                  inputTokens = sev.usage.prompt_tokens || inputTokens
                  outputTokens = sev.usage.completion_tokens || outputTokens
                  const genTps = sev.x_stats?.generation_tps
                  const promptTps = sev.x_stats?.prompt_tps
                  if (genTps) { serverTps = genTps; _TksEstimator.setServer(genTps) }
                  updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens, tks: genTps, promptTps, peakMemory: sev.x_stats?.peak_memory_gb, toolCount: _agentToolCount, agentType: _currentAgentType })
                }
                break
              }
              case 'lsp-activity': {
                const lspDot = document.getElementById('lspDot')
                const action = ev.action || ''
                const filePath = ev.path ? ev.path.split('/').pop() : ''
                if (lspDot) {
                  lspDot.style.background = 'var(--accent2)'
                  lspDot.style.boxShadow = '0 0 6px var(--accent2)'
                  setTimeout(() => {
                    const colors = { ready: 'var(--green)', starting: '#f5a623', degraded: '#f5a623', error: 'var(--red)', stopped: 'var(--muted)' }
                    lspDot.style.background = colors[currentLspStatus] || 'var(--muted)'
                    lspDot.style.boxShadow = ''
                  }, 800)
                }
                if (orchTaskBlockId) {
                  const toolsEl = document.getElementById(orchTaskBlockId + '-tools')
                  if (action === 'speculative-check') {
                    setOrchActivity(`🔬 LSP: validating ${filePath}... <span class="activity-dot">●</span>`)
                  } else if (action === 'speculative-ok' && toolsEl) {
                    toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--green)">✅ LSP validated ${filePath} — no new errors</div>`)
                  } else if (action === 'speculative-warn' && toolsEl) {
                    toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--yellow)">⚠️ LSP found ${ev.count} issue${ev.count > 1 ? 's' : ''} in ${filePath}</div>`)
                  } else if (action === 'diagnostics-check') {
                    setOrchActivity(`🔬 LSP: checking ${filePath}... <span class="activity-dot">●</span>`)
                  } else if (action === 'diagnostics-ok' && toolsEl) {
                    toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--green)">✅ LSP: ${filePath} — clean</div>`)
                  } else if (action === 'diagnostics-errors' && toolsEl) {
                    toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--red)">⚠️ LSP: ${filePath} — ${ev.count} error${ev.count > 1 ? 's' : ''} found</div>`)
                  } else if (action === 'session-diagnostics' && toolsEl) {
                    toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--accent2)">📋 LSP: ${ev.count} existing error${ev.count > 1 ? 's' : ''} in project</div>`)
                  }
                }
                break
              }
              case 'memory-extract': {
                if (orchTaskBlockId && ev.message) {
                  const toolsEl = document.getElementById(orchTaskBlockId + '-tools')
                  if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--muted);font-size:10px;opacity:0.7">${esc(ev.message)}</div>`)
                }
                break
              }
              case 'bash-waiting': {
                const remaining = ev.timeoutSecs - ev.elapsedSecs
                const waitMsg = `⏳ Still running (${ev.elapsedSecs}s, no output) — <code>${esc(ev.command)}</code> — timeout in ${remaining}s`
                setOrchActivity(waitMsg + ' <span class="activity-dot">●</span>')
                if (orchTaskBlockId) {
                  const toolsEl = document.getElementById(orchTaskBlockId + '-tools')
                  if (toolsEl) {
                    let waitEl = toolsEl.querySelector('.bash-waiting-notice')
                    if (!waitEl) {
                      toolsEl.insertAdjacentHTML('beforeend', `<div class="bash-waiting-notice msg-system" style="color:var(--yellow);font-size:11px">${waitMsg}</div>`)
                    } else {
                      waitEl.innerHTML = waitMsg
                    }
                  }
                }
                break
              }
              case 'system':
                if (ev.subtype === 'debug') {
                  setOrchActivity(`🔍 ${esc(ev.data)} <span class="activity-dot">●</span>`)
                  if (ev.data && (ev.data.includes('retrying') || ev.data.includes('Trimmed') || ev.data.includes('Repetition'))) {
                    if (orchTaskBlockId) {
                      const toolsEl = document.getElementById(orchTaskBlockId + '-tools')
                      if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--muted)">🔍 ${esc(ev.data)}</div>`)
                    }
                  }
                }
                updateAgentStatsBar({ state: 'processing', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: ev.subtype === 'debug' ? ev.data : ev.subtype })
                scrollOutput()
                break
              case 'compaction-stats':
                if (!ev.data.source || ev.data.source !== 'tool-result') {
                  _lastCompactionStats = ev.data
                } else if (!_lastCompactionStats) {
                  _lastCompactionStats = ev.data
                }
                updateAgentStatsBar({ state: 'processing', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: 'Compressed context' })
                break
              case 'usage':
                if (ev.usage) {
                  inputTokens = ev.usage.input_tokens || ev.usage.prompt_tokens || inputTokens
                  outputTokens = ev.usage.output_tokens || ev.usage.completion_tokens || outputTokens
                }
                updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens })
                break
              case 'session-end':
                // Finalize current task block and prepare for next
                stopPromptProgress()
                if (orchTaskBlockId) {
                  const statusEl = document.getElementById(orchTaskBlockId + '-status')
                  if (statusEl) statusEl.textContent = '✅ Task completed'
                  // Finalize thinking box
                  const tb = document.getElementById(orchTaskBlockId + '-think-body')
                  if (tb && tb.textContent.endsWith('▌')) tb.textContent = tb.textContent.slice(0, -1)
                  // Hide the task-level activity line
                  const actEl = document.getElementById(orchTaskBlockId + '-activity')
                  if (actEl) actEl.classList.add('hidden')
                }
                orchTaskBlockId = null
                orchTaskText = ''
                _orchStartTime = Date.now()
                document.getElementById(orchId + '-status').textContent = '🚀 Orchestrator: moving to next task...'
                setOrchActivity(`🚀 Moving to next task... <span class="activity-dot">●</span>`)
                scrollOutput()
                break
              case 'error':
                appendMsg('system', '❌ Task error: ' + ev.error)
                break
            }
          }

          // Also wire the same handler to the direct qwen-event channel
          window.app.onQwenEvent(_orchQwenEventHandler2)

          window.app.onOrchestratorCompleted(() => {
            window.app.offOrchestratorCompleted()
            window.app.offQwenEvents()
            window.app.offOrchestratorEvents?.()
            stopPromptProgress()
            // Use task graph node statuses — currentTodos is the chat todo list and
            // is empty at the start of a spec run, making [].every(...) vacuously true.
            const graphNodes = currentTaskGraph ? Object.values(currentTaskGraph.nodes) : []
            const allDone = graphNodes.length > 0
              ? graphNodes.every(n => n.status === 'completed' || n.status === 'skipped' || n.status === 'failed')
              : false
            const anyFailed = graphNodes.some(n => n.status === 'failed')
            document.getElementById(orchId + '-status').textContent = allDone
              ? (anyFailed ? '✅ Done (some tasks failed)' : '✅ All tasks completed')
              : '⚠️ Orchestrator stopped'
            // Hide the orchestrator-level activity line
            const orchActEl = document.getElementById(orchId + '-activity')
            if (orchActEl) orchActEl.classList.add('hidden')
            if (allDone && !anyFailed) appendMsg('system', '🎉 All tasks completed!')
            else if (allDone && anyFailed) appendMsg('system', '✅ Done — some tasks failed and were skipped.')
            if (currentProject) renderFileTree(currentProject, document.getElementById('fileTree'))
            saveChatSnapshot()
            agentFinished = true
            isGenerating = false
            updateStatusBar('idle')
            updateAgentStatsBar({ state: 'done', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount })
            finishGeneration()

            // Reset task graph sidebar buttons
            document.getElementById('tgRunBtn').style.display = 'inline-block'
            document.getElementById('tgPauseBtn').style.display = 'none'
            document.getElementById('tgResumeBtn').style.display = 'none'
            document.getElementById('tgAbortBtn').style.display = 'none'
            document.getElementById('tgInjectBar').style.display = 'none'
            _orchestratorRunning = false
            document.getElementById('agentPrompt').placeholder = 'Ask anything... drop images here. ⌘↵ to send'

            // Refresh task graph to show final statuses
            if (currentTasksPath) loadTaskGraph(currentTasksPath).catch(() => {})
          })

          window.app.taskGraphExecute(tasksPath, currentProject).then(r => {
            console.log('[orchestrator] Result:', r)
            if (r.error) appendMsg('system', `⚠️ Orchestrator error: ${r.error}`)
          }).catch(err => {
            console.error('[orchestrator] Error:', err)
            appendMsg('system', `⚠️ Orchestrator failed: ${err.message}`)
          })
          })() // end async IIFE
        }

        if (!agentFinished) {
          agentFinished = true
          updateStatusBar('idle')
          updateAgentStatsBar({ state: 'done', inputTokens, outputTokens: outputTokens || tokenCount })
          finishGeneration()
        }
        break
      case 'error':
        appendMsg('system', '❌ ' + ev.error)
        if (!agentFinished) {
          agentFinished = true
          updateStatusBar('idle')
          updateAgentStatsBar({ state: 'done', inputTokens, outputTokens: tokenCount })
          finishGeneration()
        }
        break
      case 'raw-stream': {
        const sev = ev.event; if (!sev) break
        if (!startTime) startTime = Date.now()
        // Handle prompt processing progress
        if (sev.x_progress) {
          if (sev.x_progress.stage === 'processing') {
            // Server confirmed prompt processing — simulated progress handles the animation
            if (!_promptProgressTimer) startPromptProgress()
          } else if (sev.x_progress.stage === 'done') {
            stopPromptProgress()
          }
          break
        }
        if (sev.choices?.[0]?.delta?.content) {
          stopPromptProgress()
          if (!startTime) startTime = Date.now()
          const content = sev.choices[0].delta.content
          lastText += content
          // Keep allTextSegments in sync for raw-stream path
          if (allTextSegments.length === 0) allTextSegments.push(content)
          else allTextSegments[allTextSegments.length - 1] = lastText
          // Check for <think> tags in accumulated text
          const thinkInText = extractThinking(lastText)
          if (thinkInText) {
            document.getElementById(respId+'-think').style.display = ''
            document.getElementById(respId+'-think-body').textContent = thinkInText + '▌'
          }
          scheduleRender()
          tokenCount++ // each SSE chunk ≈ 1 token
          updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: outputTokens || tokenCount, tks: serverTps, toolCount: _agentToolCount, activity: 'Writing response...' })
        }
        // Handle OpenAI-compatible tool_calls streaming deltas
        if (sev.choices?.[0]?.delta?.tool_calls) {
          stopPromptProgress()
          for (const tc of sev.choices[0].delta.tool_calls) {
            const idx = tc.index ?? 0
            // Initialize accumulator for this tool call index
            if (!window._rawToolCalls) window._rawToolCalls = {}
            if (!window._rawToolCalls[idx]) {
              window._rawToolCalls[idx] = { id: '', name: '', arguments: '' }
            }
            const acc = window._rawToolCalls[idx]
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name = tc.function.name
            if (tc.function?.arguments) acc.arguments += tc.function.arguments
            // When we have a name and this is the first chunk, show the tool block
            if (acc.name && !acc._shown) {
              acc._shown = true
              _agentToolCount++
              lastToolName = acc.name
              allTextSegments.push('')
              document.getElementById(respId+'-tools').insertAdjacentHTML('beforeend', renderToolUse(acc.name, acc.arguments || '{}', 'running'))
              document.getElementById(respId+'-status').textContent = `🔧 Using tool: ${acc.name}`
              updateAgentStatsBar({ state: 'tool', toolName: acc.name, inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, activity: `Running ${acc.name}...` })
              scrollOutput()
            }
          }
        }
        // Handle OpenAI-compatible finish_reason for tool_calls
        if (sev.choices?.[0]?.finish_reason === 'tool_calls' || sev.choices?.[0]?.finish_reason === 'stop') {
          if (window._rawToolCalls) {
            // Update tool blocks with final parsed arguments
            for (const idx of Object.keys(window._rawToolCalls)) {
              const acc = window._rawToolCalls[idx]
              if (acc.name && acc._shown) {
                let parsedInput = acc.arguments
                try { parsedInput = JSON.parse(acc.arguments) } catch {}
                // Update the last tool block with final input
                const toolsDiv = document.getElementById(respId+'-tools')
                const lastTool = toolsDiv.querySelector('.tool-block:last-child')
                if (lastTool) {
                  const bodyRaw = lastTool.querySelector('.tool-body-raw')
                  if (bodyRaw) bodyRaw.textContent = typeof parsedInput === 'string' ? parsedInput : JSON.stringify(parsedInput, null, 2)
                }
              }
            }
            window._rawToolCalls = null
          }
        }
        if (sev.type === 'content_block_delta' && sev.delta?.text) {
          stopPromptProgress()
          if (!startTime) startTime = Date.now()
          const deltaText = sev.delta.text
          lastText += deltaText
          // Keep allTextSegments in sync for content_block_delta path
          if (allTextSegments.length === 0) allTextSegments.push(deltaText)
          else allTextSegments[allTextSegments.length - 1] = lastText
          const thinkInText2 = extractThinking(lastText)
          if (thinkInText2) {
            document.getElementById(respId+'-think').style.display = ''
            document.getElementById(respId+'-think-body').textContent = thinkInText2 + '▌'
          }
          scheduleRender()
          tokenCount++ // each content_block_delta ≈ 1 token
          updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: outputTokens || tokenCount, tks: serverTps, toolCount: _agentToolCount, activity: 'Writing response...' })
        } else if (sev.type === 'content_block_delta' && sev.delta?.thinking) {
          stopPromptProgress()
          lastThinking += sev.delta.thinking
          document.getElementById(respId+'-think').style.display = ''
          document.getElementById(respId+'-think-body').textContent = lastThinking + '▌'
          updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: 'Reasoning...' })
        } else if (sev.usage) {
          inputTokens = sev.usage.prompt_tokens || inputTokens
          outputTokens = sev.usage.completion_tokens || outputTokens || tokenCount
          const genTps = sev.x_stats?.generation_tps
          const promptTps = sev.x_stats?.prompt_tps
          if (genTps) { serverTps = genTps; _TksEstimator.setServer(genTps) } // lock in the server's real tps
          updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens, tks: genTps, promptTps, peakMemory: sev.x_stats?.peak_memory_gb, toolCount: _agentToolCount })
        }
        break
      }
    }
  })

  // include attached images if any
  const sentImages = [...attachedImgs]
  if (sentImages.length > 0) {
    attachedImgs = []
    renderAttachedImages()
  }

  // Send conversation history so the agent has multi-turn context
  const maxHist = (projectSettings?.maxHistoryMessages || 40)
  const historyForAgent = conversationHistory.slice(-maxHist).map(m => ({ role: m.role, content: m.content }))

  window.app.qwenRun({
    prompt,
    cwd: currentProject || undefined,
    permissionMode: permMode,
    agentRole: agentRole,
    model: loadedModelId,
    images: sentImages.length > 0 ? sentImages : undefined,
    conversationHistory: historyForAgent.length > 0 ? historyForAgent : undefined,
    samplingParams: getSamplingParams(),
    taskGraphPath: currentTasksPath || undefined,
  })
}

function finishGeneration() {
  isGenerating = false
  const btn = document.getElementById('sendBtn')
  btn.disabled=false; btn.textContent='Send ↵'; btn.className='btn-send'; btn.onclick=sendAgent
  updateStatusBar('idle')
  // Reset the agent stats bar so it doesn't linger into the next session
  updateAgentStatsBar({ state: 'idle' })
}

/**
 * Revert the send button back to "Stop" state during orchestrator mode.
 * Called after an injection is sent so the button correctly shows Stop again.
 */
function _resetSendBtn() {
  if (!_orchestratorRunning) return
  const btn = document.getElementById('sendBtn')
  btn.disabled = false
  btn.innerHTML = '<span class="spinner"></span>Stop'
  btn.className = 'btn-send btn-stop'
  btn.onclick = () => { taskGraphAbort() }
  document.getElementById('agentPrompt').placeholder = '💬 Agents running — type here to inject context or refine objectives. ⌘↵ to send'
}

function appendMsg(role, text) {
  const out = document.getElementById('agentOutput')
  if(role==='user') out.insertAdjacentHTML('beforeend', `<div class="msg-user"><div class="msg-user-label">You</div>${text}</div>`)
  else if(role==='system') out.insertAdjacentHTML('beforeend', `<div class="msg-system">${text}</div>`)
  scrollOutput()
}

// ── ask_user question card ────────────────────────────────────────────────────
// Renders a question from the agent with clickable option chips + custom input.
// Parses numbered/bulleted lists out of the question text into option chips.
function renderAskUserCard(question, options, respId) {
  const out = document.getElementById('agentOutput')
  const cardId = 'ask-user-' + Date.now()

  // Normalise options — the model may send a JSON string, an array, or nothing
  let parsedOptions = []
  if (Array.isArray(options) && options.length) {
    parsedOptions = options.filter(o => typeof o === 'string' && o.trim())
  } else if (typeof options === 'string' && options.trim()) {
    // Model sent options as a JSON string — try to parse it
    try {
      const parsed = JSON.parse(options)
      if (Array.isArray(parsed)) parsedOptions = parsed.filter(o => typeof o === 'string' && o.trim())
    } catch { /* not JSON — ignore */ }
  }

  // If no options provided, try to parse numbered/bulleted lists from the question text.
  // Matches: "1. Option", "- Option", "* Option"
  let cleanQuestion = question
  if (!parsedOptions.length) {
    const lines = question.split('\n')
    const optionLines = []
    const nonOptionLines = []
    for (const line of lines) {
      const m = line.match(/^\s*(?:\d+[\.\)]\s+|\*\s+|-\s+)(.+)$/)
      if (m) optionLines.push(m[1].trim())
      else nonOptionLines.push(line)
    }
    if (optionLines.length >= 2) {
      parsedOptions = optionLines
      cleanQuestion = nonOptionLines.join('\n').trim()
    }
  }

  // Strip trailing "Or something totally different?" filler from question
  cleanQuestion = cleanQuestion.replace(/\n?Or something (totally )?different\??$/i, '').trim()

  // Guard: if any "option" is a single character, something went wrong — discard
  if (parsedOptions.some(o => o.length <= 1)) parsedOptions = []

  // Always add "Other…" as the last option when there are choices
  if (parsedOptions.length > 0) {
    const hasOther = parsedOptions.some(o => /^other/i.test(o.trim()))
    if (!hasOther) parsedOptions.push('Other…')
  }

  const chipsHtml = parsedOptions.map((opt, idx) => {
    const isOther = /^other/i.test(opt.trim())
    return `<button class="ask-user-chip${isOther ? ' ask-user-chip-other' : ''}" data-card="${cardId}" data-idx="${idx}" onclick="window._askUserPickIdx(this)">${esc(opt)}</button>`
  }).join('')

  const html = `<div class="ask-user-card" id="${cardId}">
    <div class="ask-user-eyebrow">
      <span class="ask-user-eyebrow-dot"></span>
      <span>Agent is asking</span>
    </div>
    <div class="ask-user-question">${esc(cleanQuestion)}</div>
    ${parsedOptions.length > 0 ? `<div class="ask-user-chips" id="${cardId}-chips">${chipsHtml}</div>` : ''}
    <div class="ask-user-custom" id="${cardId}-custom" style="display:none">
      <div class="ask-user-input-row">
        <textarea class="ask-user-textarea" id="${cardId}-input" placeholder="Type your answer… (Enter to send)" rows="2" autofocus></textarea>
        <button class="ask-user-send" data-card="${cardId}" onclick="window._askUserSendById(this.dataset.card)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
      <div class="ask-user-hint">Shift+Enter for new line</div>
    </div>
    ${parsedOptions.length === 0 ? `<div class="ask-user-chips"><button class="ask-user-chip ask-user-chip-other" data-card="${cardId}" onclick="window._askUserShowCustom(this.dataset.card)">Reply…</button></div>` : ''}
  </div>`

  out.insertAdjacentHTML('beforeend', html)
  // Store options by cardId so _askUserPickIdx can look them up
  window._askUserOptions[cardId] = parsedOptions
  scrollOutput()

  // Auto-focus textarea if no chips (open-ended question)
  setTimeout(() => {
    const ta = document.getElementById(cardId + '-input')
    if (ta) {
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window._askUserSendById(cardId) }
      })
      if (parsedOptions.length === 0) {
        window._askUserShowCustom(cardId)
      }
    }
  }, 50)
}

// Store option text by cardId so data-idx can look it up safely
window._askUserOptions = {}

/**
 * Scan the agent's final text for a numbered list that looks like options
 * the user should pick from. If found, inject clickable quick-reply chips
 * below the text so the user can respond with one click.
 *
 * Only triggers when the text ends with question-like language,
 * to avoid false positives on numbered bug fixes, steps, explanations, etc.
 */
function _injectQuickReplyChips(textEl, rawText) {
  // The question/prompt must be near the END of the text (last ~300 chars)
  const tail = rawText.slice(-400)
  const hasQuestion = tail.includes('?') ||
    /which (one|option|approach|direction|style|type)/i.test(tail) ||
    /what (kind|type|style|do you|would you)/i.test(tail) ||
    /pick|choose|prefer|decide|select|interested in/i.test(tail.toLowerCase())
  if (!hasQuestion) return

  // Collect ALL numbered items from the text
  const lines = rawText.split('\n')
  const allNumbered = []
  let currentGroup = []
  let lastNum = 0
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)[\.\)]\s+\*{0,2}(.+?)\*{0,2}\s*(?:[-–—:]\s*.+)?$/)
    if (m) {
      const num = parseInt(m[1], 10)
      const text = m[2].replace(/\*{1,2}/g, '').trim()
      // New sequence resets the group
      if (num <= lastNum && currentGroup.length >= 2) {
        allNumbered.push([...currentGroup])
        currentGroup = []
      }
      currentGroup.push(text)
      lastNum = num
    }
  }
  if (currentGroup.length >= 2) allNumbered.push(currentGroup)

  // No numbered groups found
  if (allNumbered.length === 0) return

  // Use the FIRST group if it has short items (likely the main choices),
  // otherwise use the last group (likely follow-up questions).
  // Prefer the group whose items are shortest on average — those are the "pick one" options.
  let bestGroup = allNumbered[0]
  let bestAvg = bestGroup.reduce((s, o) => s + o.length, 0) / bestGroup.length
  for (const group of allNumbered) {
    const avg = group.reduce((s, o) => s + o.length, 0) / group.length
    if (avg < bestAvg) { bestGroup = group; bestAvg = avg }
  }

  const numbered = bestGroup
  // Sanity checks
  if (numbered.length < 2 || numbered.length > 12) return
  if (numbered.some(o => o.length > 100)) return
  // Skip if items look like code steps or instructions
  if (numbered.some(o => /[\\`$]/.test(o) || /^(run|install|create|open|add|import|update)\b/i.test(o))) return

  const cardId = 'qr-' + Date.now()
  const options = [...numbered, 'Other…']
  window._askUserOptions[cardId] = options

  const chipsHtml = options.map((opt, idx) => {
    const isOther = /^other/i.test(opt.trim())
    return `<button class="ask-user-chip${isOther ? ' ask-user-chip-other' : ''}" data-card="${cardId}" data-idx="${idx}" onclick="window._quickReplyPick(this)">${esc(opt)}</button>`
  }).join('')

  textEl.insertAdjacentHTML('afterend',
    `<div class="ask-user-quick-reply" id="${cardId}">
      <div class="ask-user-eyebrow" style="margin-bottom:8px">
        <span>Quick reply</span>
      </div>
      <div class="ask-user-chips" id="${cardId}-chips">${chipsHtml}</div>
      <div class="ask-user-custom" id="${cardId}-custom" style="display:none">
        <div class="ask-user-input-row">
          <textarea class="ask-user-textarea" id="${cardId}-input" placeholder="Type your answer… (Enter to send)" rows="2"></textarea>
          <button class="ask-user-send" data-card="${cardId}" onclick="window._quickReplySend(this.dataset.card)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
      </div>
    </div>`)

  // Set up Enter key for the textarea
  setTimeout(() => {
    const ta = document.getElementById(cardId + '-input')
    if (ta) ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window._quickReplySend(cardId) }
    })
  }, 50)
  scrollOutput()
}

// Quick-reply chip clicked — send as a new user message
window._quickReplyPick = function(btn) {
  const cardId = btn.dataset.card
  const idx = parseInt(btn.dataset.idx, 10)
  const options = window._askUserOptions[cardId] || []
  const option = options[idx]
  if (option === undefined) return
  if (/^other/i.test(option.trim())) {
    window._askUserShowCustom(cardId)
    return
  }
  // Remove the quick-reply card and send as a new prompt
  const card = document.getElementById(cardId)
  if (card) card.remove()
  _sendQuickReply(option)
}

window._quickReplySend = function(cardId) {
  const ta = document.getElementById(cardId + '-input')
  const reply = ta ? ta.value.trim() : ''
  if (!reply) { if (ta) ta.focus(); return }
  const card = document.getElementById(cardId)
  if (card) card.remove()
  _sendQuickReply(reply)
}

function _sendQuickReply(text) {
  // Put the text in the prompt input and trigger send via sendAgentMode
  const input = document.getElementById('agentPrompt')
  if (input) input.value = text
  if (typeof sendAgentMode === 'function') {
    sendAgentMode(text)
  }
}

window._askUserShowCustom = function(cardId) {
  const customEl = document.getElementById(cardId + '-custom')
  if (customEl) {
    customEl.style.display = 'block'
    customEl.classList.add('ask-user-custom-visible')
    const ta = document.getElementById(cardId + '-input')
    if (ta) { ta.focus(); ta.select() }
    scrollOutput()
  }
}

// Called from chip onclick via data-idx — avoids any quoting issues
window._askUserPickIdx = function(btn) {
  const cardId = btn.dataset.card
  const idx = parseInt(btn.dataset.idx, 10)
  const options = window._askUserOptions[cardId] || []
  const option = options[idx]
  if (option === undefined) return
  window._askUserPick(cardId, option)
}

window._askUserPick = function(cardId, option) {
  if (/^other/i.test(option.trim())) {
    // Highlight the Other chip and show the textarea
    const chipsEl = document.getElementById(cardId + '-chips')
    if (chipsEl) {
      chipsEl.querySelectorAll('.ask-user-chip').forEach(b => b.classList.remove('ask-user-chip-selected'))
      const btn = [...chipsEl.querySelectorAll('.ask-user-chip')].find(b => /^other/i.test(b.textContent.trim()))
      if (btn) btn.classList.add('ask-user-chip-selected')
    }
    window._askUserShowCustom(cardId)
    return
  }
  // Highlight selected chip briefly then submit
  const chipsEl = document.getElementById(cardId + '-chips')
  if (chipsEl) {
    chipsEl.querySelectorAll('.ask-user-chip').forEach(b => {
      b.classList.remove('ask-user-chip-selected')
      b.disabled = true
    })
    const btn = [...chipsEl.querySelectorAll('.ask-user-chip')].find(b => b.textContent.trim() === option)
    if (btn) btn.classList.add('ask-user-chip-selected')
  }
  setTimeout(() => _submitAskUserReply(cardId, option), 180)
}

window._askUserSendById = function(cardId) {
  const ta = document.getElementById(cardId + '-input')
  const reply = ta ? ta.value.trim() : ''
  if (!reply) { if (ta) ta.focus(); return }
  _submitAskUserReply(cardId, reply)
}

// Keep old name for keyboard handler compatibility
window._askUserSend = window._askUserSendById

function _submitAskUserReply(cardId, reply) {
  const card = document.getElementById(cardId)
  if (!card) return
  // Replace card with a compact "you replied" bubble
  card.outerHTML = `<div class="msg-user ask-user-replied">
    <div class="msg-user-label">You</div>
    ${esc(reply)}
  </div>`
  scrollOutput()
  try {
    if (window.app && typeof window.app.askUserReply === 'function') {
      window.app.askUserReply(reply).catch(err => console.error('[ask_user] IPC reply failed:', err))
    } else {
      console.error('[ask_user] window.app.askUserReply not available')
    }
  } catch (err) {
    console.error('[ask_user] Failed to send reply:', err)
  }
}

function scrollOutput() {
  const o = document.getElementById('agentOutput')
  // Only auto-scroll if the user is near the bottom (within 150px).
  // If they've scrolled up to read earlier messages, don't yank them down.
  const distanceFromBottom = o.scrollHeight - o.scrollTop - o.clientHeight
  if (distanceFromBottom < 150) {
    o.scrollTop = o.scrollHeight
  }
}

// ── vision ────────────────────────────────────────────────────────────────────
function loadImage(e){const f=e.target.files[0];if(f)readImageFile(f)}
function readImageFile(file){const r=new FileReader();r.onload=ev=>{imageB64=ev.target.result;const i=document.getElementById('imgPreview');i.src=imageB64;i.style.display='block';document.getElementById('dropHint').style.display='none';document.getElementById('dropZone').classList.add('has-image')};r.readAsDataURL(file)}
async function sendVision(){
  if(isGenerating)return;const p=document.getElementById('visionPrompt').value.trim();if(!p)return
  if(!loadedModelId){document.getElementById('visionOutput').innerHTML='<span style="color:var(--red)">⚠️ Load a model first.</span>';return}
  const btn=document.getElementById('sendVisionBtn');btn.disabled=true;btn.innerHTML='<span class="spinner"></span>Asking...';isGenerating=true
  document.getElementById('visionOutput').innerHTML='<div class="output-placeholder">Generating...</div>'
  const content=imageB64?[{type:'text',text:p},{type:'image_url',image_url:{url:imageB64}}]:p
  try{const r=await window.app.chat({messages:[{role:'user',content}],max_tokens:512})
    if(r.error) { document.getElementById('visionOutput').innerHTML=`<span style="color:var(--red)">⚠️ ${r.error}</span>` }
    else {
      const t=r.choices?.[0]?.message?.content||JSON.stringify(r)
      let html=renderMd(t)
      if(r.usage) html+=`<div class="vision-stats">${r.usage.prompt_tokens} prompt · ${r.usage.completion_tokens||r.usage.generation_tokens||0} gen · ${r.usage.generation_tps||'—'} tk/s · ${r.usage.peak_memory_gb||'—'} GB</div>`
      document.getElementById('visionOutput').innerHTML=html
    }
  }catch(e){document.getElementById('visionOutput').innerHTML=`<span style="color:var(--red)">❌ ${e.message}</span>`}
  btn.disabled=false;btn.textContent='Ask ↵';isGenerating=false
}

// ── markdown (loaded from lib/markdown.js) ─────────────────────────────────────

function copyCodeBlock(id, btn) {
  const el = document.getElementById(id)
  if (!el) return
  const text = el.textContent.replace(/^\d+/gm, '').trim()
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!'; btn.classList.add('copied')
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied') }, 1500)
  })
}

async function saveCodeToFile(id, lang, btn) {
  const el = document.getElementById(id)
  if (!el) return
  if (!currentProject) { const p = await window.app.openFolder(); if(p) currentProject=p; else return }
  const text = el.textContent.replace(/^\d+/gm, '').trim()
  const ext = {html:'html',css:'css',js:'js',ts:'ts',py:'py',json:'json',sh:'sh',swift:'swift',go:'go',rs:'rs'}[lang] || 'txt'
  const filepath = currentProject + '/generated.' + ext
  const r = await window.app.writeFile(filepath, text)
  if (r.ok) {
    btn.textContent = '✓ Saved!'; btn.classList.add('copied')
    setTimeout(() => { btn.textContent = '💾 Save'; btn.classList.remove('copied') }, 2000)
    if (document.getElementById('fileTree')) await renderFileTree(currentProject, document.getElementById('fileTree'))
  }
}

// ── context settings ──────────────────────────────────────────────────────────
async function loadContextSettings() {
  if (!activeProjectId) {
    projectSettings = await window.app.getDefaultSettings()
  } else {
    projectSettings = await window.app.getSettings(activeProjectId)
  }
  const el = (id) => document.getElementById(id)
  if (el('cs-maxTokens')) el('cs-maxTokens').value = projectSettings.maxContextTokens
  if (el('cs-maxFileTokens')) el('cs-maxFileTokens').value = projectSettings.maxFileTokens
  if (el('cs-maxHistory')) el('cs-maxHistory').value = projectSettings.maxHistoryMessages
  if (el('cs-ignore')) el('cs-ignore').value = (projectSettings.ignorePatterns || []).join(',')
  if (el('cs-autoCompact')) el('cs-autoCompact').checked = projectSettings.autoCompact !== false
  if (el('cs-compactThreshold')) el('cs-compactThreshold').value = projectSettings.compactThreshold || 30
  if (el('cs-keepRecent')) el('cs-keepRecent').value = projectSettings.compactKeepRecent || 10
  loadSamplingSettings()
}

async function saveContextSettings() {
  if (!activeProjectId) return
  const settings = {
    ...projectSettings,
    maxContextTokens: parseInt(document.getElementById('cs-maxTokens')?.value) || 8000,
    maxFileTokens: parseInt(document.getElementById('cs-maxFileTokens')?.value) || 2000,
    maxHistoryMessages: parseInt(document.getElementById('cs-maxHistory')?.value) || 40,
    ignorePatterns: (document.getElementById('cs-ignore')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
    autoCompact: document.getElementById('cs-autoCompact')?.checked !== false,
    compactThreshold: parseInt(document.getElementById('cs-compactThreshold')?.value) || 30,
    compactKeepRecent: parseInt(document.getElementById('cs-keepRecent')?.value) || 10,
  }
  projectSettings = await window.app.saveSettings(activeProjectId, settings)
}

// ── sampling settings ─────────────────────────────────────────────────────────
const SAMPLING_PRESETS = {
  recommended: { label: '⚡ Recommended (Coding)', temperature: 0.6, top_p: 0.9, repetition_penalty: 1.05 },
  qwen_official: { label: '🤖 Qwen Official (Thinking)', temperature: 0.6, top_p: 0.95, repetition_penalty: 1.0 },
  creative: { label: '🎨 Creative', temperature: 0.9, top_p: 0.95, repetition_penalty: 1.0 },
  precise: { label: '🎯 Precise / Deterministic', temperature: 0.2, top_p: 0.8, repetition_penalty: 1.1 },
  custom: { label: '✏️ Custom', temperature: null, top_p: null, repetition_penalty: null },
}

function getSamplingParams() {
  return {
    temperature: parseFloat(document.getElementById('sp-temperature')?.value) || 0.6,
    top_p: parseFloat(document.getElementById('sp-top-p')?.value) || 0.95,
    repetition_penalty: parseFloat(document.getElementById('sp-rep-penalty')?.value) || 1.0,
  }
}

function applySamplingPreset(presetKey) {
  const preset = SAMPLING_PRESETS[presetKey]
  if (!preset || presetKey === 'custom') return
  const tEl = document.getElementById('sp-temperature')
  const pEl = document.getElementById('sp-top-p')
  const rEl = document.getElementById('sp-rep-penalty')
  if (tEl) tEl.value = preset.temperature
  if (pEl) pEl.value = preset.top_p
  if (rEl) rEl.value = preset.repetition_penalty
  saveSamplingSettings()
}

function loadSamplingSettings() {
  const saved = projectSettings || {}
  const t = saved.samplingTemperature ?? 0.6
  const p = saved.samplingTopP ?? 0.95
  const r = saved.samplingRepPenalty ?? 1.05
  const preset = saved.samplingPreset || 'recommended'
  const tEl = document.getElementById('sp-temperature')
  const pEl = document.getElementById('sp-top-p')
  const rEl = document.getElementById('sp-rep-penalty')
  const selEl = document.getElementById('sp-preset')
  if (tEl) tEl.value = t
  if (pEl) pEl.value = p
  if (rEl) rEl.value = r
  if (selEl) selEl.value = preset
}

async function saveSamplingSettings() {
  if (!activeProjectId) return
  const presetEl = document.getElementById('sp-preset')
  const settings = {
    ...projectSettings,
    samplingTemperature: parseFloat(document.getElementById('sp-temperature')?.value) || 0.6,
    samplingTopP: parseFloat(document.getElementById('sp-top-p')?.value) || 0.95,
    samplingRepPenalty: parseFloat(document.getElementById('sp-rep-penalty')?.value) || 1.0,
    samplingPreset: presetEl?.value || 'recommended',
  }
  projectSettings = await window.app.saveSettings(activeProjectId, settings)
}

// ── API keys ──────────────────────────────────────────────────────────────────
async function loadApiKeys() {
  const keys = await window.app.getApiKeys()
  const el = document.getElementById('ak-brave')
  if (el && keys.brave) el.value = keys.brave
}

async function saveApiKeys() {
  const keys = {
    brave: document.getElementById('ak-brave')?.value?.trim() || '',
  }
  await window.app.saveApiKeys(keys)
}

// ── OpenRouter settings ───────────────────────────────────────────────────────
async function loadOpenRouterSettings() {
  try {
    const settings = await window.app.getAppSettings()
    const enabled = settings.provider === 'openrouter'
    const checkbox = document.getElementById('or-enabled')
    const fields = document.getElementById('or-fields')
    if (checkbox) checkbox.checked = enabled
    if (fields) fields.style.display = enabled ? '' : 'none'
    if (enabled) {
      const keyEl = document.getElementById('or-apikey')
      const modelEl = document.getElementById('or-model')
      if (keyEl && settings.openrouterApiKey) keyEl.value = settings.openrouterApiKey
      if (modelEl && settings.openrouterModel) modelEl.value = settings.openrouterModel
      _updateOpenRouterStatus(settings)
    }
    _updateOpenRouterBadge(settings)
  } catch (_) {}
}

async function saveOpenRouterSettings() {
  const enabled = document.getElementById('or-enabled')?.checked || false
  const apiKey = document.getElementById('or-apikey')?.value?.trim() || ''
  const model = document.getElementById('or-model')?.value?.trim() || ''

  // Show/hide the fields section
  const fields = document.getElementById('or-fields')
  if (fields) fields.style.display = enabled ? '' : 'none'

  const settings = {
    provider: enabled ? 'openrouter' : 'local',
    openrouterApiKey: apiKey,
    openrouterModel: model,
  }
  await window.app.saveAppSettings(settings)
  _updateOpenRouterStatus(settings)
  _updateOpenRouterBadge(settings)
}

function _updateOpenRouterStatus(settings) {
  const statusEl = document.getElementById('or-status')
  if (!statusEl) return
  if (!settings.openrouterApiKey) {
    statusEl.textContent = 'No API key set'
    statusEl.style.color = 'var(--muted)'
  } else if (!settings.openrouterModel) {
    statusEl.textContent = 'API key set — enter a model ID'
    statusEl.style.color = 'var(--yellow, #f5a623)'
  } else {
    statusEl.textContent = `Active — ${settings.openrouterModel}`
    statusEl.style.color = 'var(--green)'
  }
}

function _updateOpenRouterBadge(settings) {
  const badge = document.getElementById('openrouterBadge')
  const localBtn = document.getElementById('modelSwitcherBtn')
  if (!badge) return
  const isActive = settings.provider === 'openrouter' && settings.openrouterApiKey
  badge.style.display = isActive ? 'flex' : 'none'
  if (localBtn) localBtn.style.display = isActive ? 'none' : ''
  if (isActive) {
    const modelLabel = document.getElementById('openrouterBadgeModel')
    if (modelLabel) modelLabel.textContent = settings.openrouterModel || 'OpenRouter'
  }
}

// ── telegram bot ──────────────────────────────────────────────────────────────
async function telegramConnect() {
  const token = document.getElementById('tg-token').value.trim()
  if (!token) { alert('Enter a bot token first'); return }
  const btn = document.getElementById('tgConnectBtn')
  btn.textContent = '⏳ Connecting...'
  btn.disabled = true
  try {
    const res = await window.app.telegramStart(token)
    if (res.error) { alert('Failed: ' + res.error); return }
    await refreshTelegramStatus()
  } catch (e) { alert('Error: ' + e.message) }
  finally { btn.textContent = '⚡ Connect Bot'; btn.disabled = false }
}

async function telegramDisconnect() {
  await window.app.telegramStop()
  await refreshTelegramStatus()
  // Keep the token in the input so user can reconnect easily
}

async function telegramPair() {
  const res = await window.app.telegramPair()
  if (res.error) { alert(res.error); return }
  const link = document.getElementById('tgPairLink')
  link.textContent = res.qrDataUrl
  link.href = '#'
}

async function refreshTelegramStatus() {
  const status = await window.app.telegramStatus()
  const el = document.getElementById('tgStatus')
  const connectBtn = document.getElementById('tgConnectBtn')
  const disconnectBtn = document.getElementById('tgDisconnectBtn')
  const pairSection = document.getElementById('tgPairSection')
  const miniAppSection = document.getElementById('tgMiniAppSection')
  const tokenInput = document.getElementById('tg-token')

  // Pre-fill the token input if we have a saved token
  if (!tokenInput.value) {
    const saved = await window.app.telegramGetToken()
    if (saved.token) tokenInput.value = saved.token
  }

  if (status.connected) {
    el.innerHTML = `<span style="color:var(--green)">● Connected</span> @${status.bot_username}`
    connectBtn.style.display = 'none'
    disconnectBtn.style.display = 'inline-block'
    pairSection.style.display = 'block'
    miniAppSection.style.display = 'block'
    refreshMiniappStatus()
  } else {
    el.innerHTML = status.last_error
      ? `<span style="color:var(--red)">● Error:</span> ${status.last_error}`
      : '<span style="color:var(--muted)">● Disconnected</span>'
    connectBtn.style.display = 'inline-block'
    disconnectBtn.style.display = 'none'
    pairSection.style.display = 'none'
    miniAppSection.style.display = 'none'
  }
}

// ── mini app ──────────────────────────────────────────────────────────────────
async function miniappStart() {
  const btn = document.getElementById('miniappStartBtn')
  btn.textContent = '⏳ Starting...'
  btn.disabled = true
  try {
    const res = await window.app.miniappStart()
    if (res.error) { alert('Failed: ' + res.error); return }
    refreshMiniappStatus()
  } catch (e) { alert('Error: ' + e.message) }
  finally { btn.textContent = '🚀 Start Mini App'; btn.disabled = false }
}

async function miniappStop() {
  await window.app.miniappStop()
  refreshMiniappStatus()
}

async function refreshMiniappStatus() {
  const status = await window.app.miniappStatus()
  const statusEl = document.getElementById('miniappStatus')
  const startBtn = document.getElementById('miniappStartBtn')
  const stopBtn = document.getElementById('miniappStopBtn')
  const urlSection = document.getElementById('miniappUrlSection')
  const urlEl = document.getElementById('miniappUrl')

  if (status.running) {
    statusEl.innerHTML = '<span style="color:var(--green)">● Running</span>'
    startBtn.style.display = 'none'
    stopBtn.style.display = 'inline-block'
    if (status.publicUrl) {
      urlSection.style.display = 'block'
      urlEl.textContent = status.publicUrl
    } else {
      urlSection.style.display = 'block'
      urlEl.textContent = status.localUrl || 'http://localhost:3847'
    }
  } else {
    statusEl.innerHTML = '<span style="color:var(--muted)">● Not running</span>'
    startBtn.style.display = 'inline-block'
    stopBtn.style.display = 'none'
    urlSection.style.display = 'none'
  }
}

// ── compactor ─────────────────────────────────────────────────────────────────
async function checkCompactor() {
  const status = await window.app.compactorStatus()
  compactorInstalled = status.installed
  const btn = document.getElementById('compactBtn')
  const installBtn = document.getElementById('installCompactorBtn')
  if (status.installed) {
    if (btn) { btn.className = 'compact-btn'; btn.innerHTML = '🦞 Compact' }
    if (installBtn) installBtn.style.display = 'none'
    const statusEl = document.getElementById('compactorStatus')
    if (statusEl) statusEl.innerHTML = `<span class="compact-badge ok">🦞 v${status.version || '7+'}</span>`
  } else {
    if (btn) { btn.className = 'compact-btn missing'; btn.innerHTML = '🦞 Not installed' }
    if (installBtn) installBtn.style.display = 'inline-block'
    const statusEl = document.getElementById('compactorStatus')
    if (statusEl) statusEl.innerHTML = `<span class="compact-badge missing">Not installed</span>`
  }
  updateSessionInfo()
}

async function installCompactor() {
  const btn = document.getElementById('installCompactorBtn')
  btn.disabled = true; btn.textContent = '⏳ Installing...'
  appendMsg('system', '📦 Run in your terminal: pip install claw-compactor')
  btn.disabled = false; btn.textContent = '📦 Install claw-compactor'
}

function showCompactNotice(text) {
  const el = document.getElementById('compactNotice')
  const txt = document.getElementById('compactNoticeText')
  if (el && txt) { txt.textContent = text; el.style.display = 'flex' }
}

async function runCompactNow() {
  if (!activeProjectId || !activeSessionId) { appendMsg('system', '⚠️ Select a project and session first.'); return }
  if (!compactorInstalled) { appendMsg('system', '⚠️ claw-compactor not installed. Run: pip install claw-compactor'); return }

  const btn = document.getElementById('compactBtn')
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Compacting...'

  const history = await window.app.getSessionMsgs(activeProjectId, activeSessionId)
  if (history.length < 5) {
    btn.disabled = false; btn.innerHTML = '🦞 Compact'
    appendMsg('system', 'ℹ️ Not enough messages to compact.')
    return
  }

  const messages = history.map(m => ({ role: m.role, content: m.content }))
  const result = await window.app.compactMessages(messages)

  if (result.stats?.compressed) {
    const compacted = result.messages.map((m, i) => ({ ...m, ts: history[i]?.ts || Date.now() }))
    await window.app.setSessionMsgs(activeProjectId, activeSessionId, compacted)
    conversationHistory = await window.app.getSessionMsgs(activeProjectId, activeSessionId)
    updateSessionInfo()

    const pct = result.stats.reduction_pct
    const statsText = pct ? `🦞 Compressed ${pct.toFixed(1)}%` : `🦞 Compacted ${history.length} → ${compacted.length} messages`
    showCompactNotice(statsText)
    // refresh session list to update message counts
    const sessions = await window.app.listSessions(activeProjectId)
    renderSessionSelect(sessions)
  } else {
    appendMsg('system', `⚠️ Compaction: ${result.stats?.error || 'no change'}`)
  }

  btn.disabled = false; btn.innerHTML = '🦞 Compact'
}

async function maybeAutoCompact() {
  if (!activeProjectId || !activeSessionId || !projectSettings?.autoCompact || !compactorInstalled) return
  const history = await window.app.getSessionMsgs(activeProjectId, activeSessionId)
  if (history.length >= (projectSettings.compactThreshold || 30)) {
    await runCompactNow()
  }
}

// ── keyboard ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){const t=document.querySelector('.ed-tab.active')?.dataset?.tab;if(t==='agent')sendAgent();else if(t==='vision')sendVision()}
  if((e.metaKey||e.ctrlKey)&&e.key==='s'){e.preventDefault();if(currentFile)saveFile()}
})

// ── live preview ──────────────────────────────────────────────────────────────
let previewOpen = false

function previewCode(codeBlockId) {
  const el = document.getElementById(codeBlockId)
  if (!el) return
  const raw = el.innerText.replace(/^\d+\s*/gm, '')
  const code = raw.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
  switchMainTab('editor', document.querySelector('[data-tab="editor"]'))
  document.getElementById('editorArea').value = code
  document.getElementById('editorFileName').textContent = 'preview.html'
  document.getElementById('saveBtn').style.display = 'none'
  document.getElementById('previewToggle').style.display = 'inline-block'
  if (!previewOpen) togglePreview()
  refreshPreview()
}

function togglePreview() {
  previewOpen = !previewOpen
  const pane = document.getElementById('previewPane')
  const handle = document.getElementById('previewResizeHandle')
  const btn = document.getElementById('previewToggle')
  pane.style.display = previewOpen ? 'flex' : 'none'
  handle.style.display = previewOpen ? 'block' : 'none'
  btn.textContent = previewOpen ? 'Preview ◂' : 'Preview ▸'
  if (previewOpen) {
    setPreviewDevice(_currentPreviewDevice || 'responsive')
    refreshPreview()
  }
}

// ── preview device presets ─────────────────────────────────────────────────
const _previewDevices = {
  responsive: { w: null, h: null, label: 'Responsive' },
  desktop:    { w: 1440, h: 900, label: '1440 × 900' },
  laptop:     { w: 1280, h: 800, label: '1280 × 800' },
  tablet:     { w: 768,  h: 1024, label: '768 × 1024' },
  mobile:     { w: 375,  h: 667, label: '375 × 667' }
}
let _currentPreviewDevice = 'responsive'

function setPreviewDevice(name) {
  _currentPreviewDevice = name
  const dev = _previewDevices[name]
  const viewport = document.getElementById('previewViewport')
  const frame = document.getElementById('previewFrame')
  const label = document.getElementById('previewSizeLabel')

  // update active button
  document.querySelectorAll('.preview-device-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.device === name)
  })

  if (!dev.w) {
    // responsive — fill the viewport
    viewport.className = 'preview-viewport responsive'
    frame.style.width = '100%'
    frame.style.height = '100%'
    label.textContent = ''
  } else {
    viewport.className = 'preview-viewport device'
    frame.style.width = dev.w + 'px'
    frame.style.height = dev.h + 'px'
    label.textContent = dev.label
  }
}

// ── preview pane resize handle ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const handle = document.getElementById('previewResizeHandle')
  const pane = document.getElementById('previewPane')
  const split = document.querySelector('.editor-split')
  if (!handle || !pane || !split) return

  let dragging = false
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    dragging = true
    handle.classList.add('dragging')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  })
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const rect = split.getBoundingClientRect()
    const x = e.clientX - rect.left
    const total = rect.width
    const editorW = Math.max(200, Math.min(x, total - 220))
    const previewW = total - editorW - 5 // 5 = handle width
    pane.style.width = previewW + 'px'
    pane.style.flex = 'none'
  })
  document.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    handle.classList.remove('dragging')
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  })
})

function refreshPreview() {
  const frame = document.getElementById('previewFrame')
  // If previewing a real file on disk, use file:// URL so relative assets (JS, CSS) load correctly
  if (currentFile && /\.(html?|svg)$/i.test(currentFile)) {
    // Remove sandbox to allow file:// navigation and relative resource loading
    frame.removeAttribute('sandbox')
    frame.removeAttribute('srcdoc')
    frame.src = 'file://' + currentFile + '?t=' + Date.now()
  } else {
    // Inline preview for code blocks not saved to disk
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
    frame.removeAttribute('src')
    frame.srcdoc = document.getElementById('editorArea').value
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const editor = document.getElementById('editorArea')
  if (editor) {
    let debounce = null
    editor.addEventListener('input', () => {
      if (!previewOpen) return
      clearTimeout(debounce)
      debounce = setTimeout(async () => {
        // If editing a real file, save it first so the file:// preview picks up changes
        if (currentFile) {
          await window.app.writeFile(currentFile, editor.value)
        }
        refreshPreview()
      }, 400)
    })
  }
})

function updatePreviewToggle() {
  const name = (currentFile || '').toLowerCase()
  const btn = document.getElementById('previewToggle')
  btn.style.display = (name.endsWith('.html') || name.endsWith('.htm') || name.endsWith('.svg')) ? 'inline-block' : 'none'
}

async function showPreviewButton(respId) {
  if (!currentProject) return
  const entries = await window.app.readDir(currentProject)
  const htmlFile = entries.find(e => !e.isDir && e.name === 'index.html')
    || entries.find(e => !e.isDir && /\.html?$/i.test(e.name))
  if (!htmlFile) return
  // Auto-update center preview panel
  _centerPreviewFile = htmlFile.path
  refreshCenterPreview()
  const container = document.getElementById(respId)
  if (!container) return
  container.insertAdjacentHTML('beforeend',
    `<button class="btn-preview-chat" onclick="openLivePreviewFromChat('${htmlFile.path.replace(/'/g,"\\'")}','${htmlFile.name}')">▶ Preview ${htmlFile.name}</button>`)
}

async function openLivePreviewFromChat(filePath, fileName) {
  const content = await window.app.readFile(filePath)
  if (!content) return
  currentFile = filePath
  document.getElementById('editorFileName').textContent = fileName
  document.getElementById('editorArea').value = content
  document.getElementById('saveBtn').style.display = 'inline-block'
  document.getElementById('previewToggle').style.display = 'inline-block'
  switchMainTab('editor', document.querySelector('[data-tab="editor"]'))
  if (!previewOpen) togglePreview()
  refreshPreview()
}

// ── tool use rendering (loaded from lib/tools-render.js) ──────────────────────

// ── task graph panel ──────────────────────────────────────────────────────────
let currentTaskGraph = null
let selectedTaskNodeId = null
let currentTasksPath = null
let _currentAgentType = null

async function loadTaskGraph(filePath) {
  if (!currentProject) return
  const tasksPath = filePath || currentTasksPath || currentProject + '/tasks.md'
  const content = await window.app.readFile(tasksPath)
  if (!content) {
    document.getElementById('taskGraphEmpty').style.display = 'block'
    document.getElementById('taskNodeList').innerHTML = '<div class="model-empty" id="taskGraphEmpty">No task graph loaded. Open a Tasks.md file or start a spec workflow.</div>'
    return
  }
  const graph = await window.app.taskGraphParse(tasksPath)
  if (graph.error) {
    document.getElementById('taskNodeList').innerHTML = `<div class="model-empty" style="color:var(--red)">Error: ${esc(graph.error)}</div>`
    return
  }
  currentTaskGraph = graph
  currentTasksPath = tasksPath
  renderTaskGraph(graph)
  saveWorkflowState() // persist for session restore
}

function renderTaskGraph(graph) {
  if (!graph || !graph.nodes) return
  const container = document.getElementById('taskNodeList')
  const nodes = graph.nodes
  const ids = Object.keys(nodes).sort((a, b) => {
    const ap = a.split('.').map(Number), bp = b.split('.').map(Number)
    for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
      if ((ap[i]||0) !== (bp[i]||0)) return (ap[i]||0) - (bp[i]||0)
    }
    return 0
  })
  if (ids.length === 0) {
    container.innerHTML = '<div class="model-empty">Task graph is empty.</div>'
    return
  }

  // Only animate the most recently started in_progress node — animating all of them
  // simultaneously creates confusing visual noise when multiple nodes are in_progress.
  const inProgressIds = ids.filter(id => nodes[id].status === 'in_progress' && nodes[id]._startTime)
  const animatedNodeId = inProgressIds.reduce((latest, id) => {
    const t = nodes[id]._startTime || 0
    return t >= (nodes[latest]?._startTime || 0) ? id : latest
  }, inProgressIds[0])

  container.innerHTML = ids.map(id => {
    const node = nodes[id]
    const indent = (node.depth || 0) * 12
    // Stale in_progress nodes (loaded from disk, no live _startTime) render as not_started
    const isLiveInProgress = node.status === 'in_progress' && node._startTime
    const displayStatus = node.status === 'in_progress' && !node._startTime ? 'not_started' : node.status
    const agentTag = node.agentType && node.agentType !== 'general' ? `<span class="tg-node-agent">${esc(node.agentType)}</span>` : ''
    const elapsedTag = isLiveInProgress
      ? `<span class="tg-node-elapsed" data-start="${node._startTime}">0s</span>`
      : ''
    const activityTag = isLiveInProgress
      ? `<span class="tg-node-activity" data-node-id="${id}"></span>`
      : ''
    // Use animated dot only for the most recently started live in_progress node
    const dotClass = isLiveInProgress && id !== animatedNodeId
      ? 'in_progress static'
      : displayStatus
    return `<div class="tg-node status-${displayStatus}" data-node-id="${id}" style="padding-left:${8 + indent}px" onclick="showTaskDetail('${id}')">
      <span class="tg-node-dot ${dotClass}"></span>
      <span class="tg-node-id">${esc(id)}</span>
      <span class="tg-node-title">${esc(node.title)}</span>
      ${agentTag}${elapsedTag}${activityTag}
    </div>`
  }).join('')

  // Auto-scroll the active (in_progress) task into view
  const activeNode = container.querySelector('.status-in_progress')
  if (activeNode) activeNode.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function showTaskDetail(nodeId) {
  selectedTaskNodeId = nodeId
  const detail = document.getElementById('taskDetail')
  const content = document.getElementById('taskDetailContent')
  detail.style.display = 'block'
  if (!currentTaskGraph || !currentTaskGraph.nodes[nodeId]) {
    content.innerHTML = '<span style="color:var(--muted)">No data</span>'
    return
  }
  const node = currentTaskGraph.nodes[nodeId]
  const agentType = node.agentType || node.metadata?.agentType || 'general'
  content.innerHTML = `<div><strong>ID:</strong> ${esc(node.id)}</div>
    <div><strong>Title:</strong> ${esc(node.title)}</div>
    <div><strong>Status:</strong> <span class="tg-node-dot ${node.status}" style="display:inline-block;width:8px;height:8px;border-radius:50%;vertical-align:middle"></span> ${node.status}</div>
    <div><strong>Agent Type:</strong> ${agentType}</div>
    <div><strong>Dependencies:</strong> ${(node.dependencies||[]).join(', ') || 'none'}</div>`
}

async function taskGraphRun() {
  if (!currentProject) { appendMsg('system', '⚠️ Open a project first.'); return }
  const tasksPath = currentTasksPath || currentProject + '/tasks.md'

  // Ensure the task graph is loaded before execution so status events can update it
  if (!currentTaskGraph) {
    await loadTaskGraph(tasksPath)
    if (!currentTaskGraph) { appendMsg('system', '❌ No task graph found at ' + tasksPath); return }
  }

  const result = await window.app.taskGraphExecute(tasksPath, currentProject)
  if (result.error) { appendMsg('system', '❌ ' + result.error); return }
  document.getElementById('tgPauseBtn').style.display = 'inline-block'
  document.getElementById('tgAbortBtn').style.display = 'inline-block'
  document.getElementById('tgRunBtn').style.display = 'none'
  document.getElementById('tgInjectBar').style.display = 'block'
  _orchestratorRunning = true
  document.getElementById('agentPrompt').placeholder = '💬 Agents running — type here to inject context or refine objectives. ⌘↵ to send'

  // Listen for orchestrator completion to reload the final persisted state
  window.app.onOrchestratorCompleted(() => {
    window.app.offOrchestratorCompleted()
    if (currentTasksPath) loadTaskGraph(currentTasksPath).catch(() => {})
    document.getElementById('tgRunBtn').style.display = 'inline-block'
    document.getElementById('tgPauseBtn').style.display = 'none'
    document.getElementById('tgResumeBtn').style.display = 'none'
    document.getElementById('tgAbortBtn').style.display = 'none'
    document.getElementById('tgInjectBar').style.display = 'none'
    _orchestratorRunning = false
    document.getElementById('agentPrompt').placeholder = 'Ask anything... drop images here. ⌘↵ to send'
  })
}

async function taskGraphPause() {
  await window.app.taskGraphPause()
  document.getElementById('tgPauseBtn').style.display = 'none'
  document.getElementById('tgResumeBtn').style.display = 'inline-block'
}

async function taskGraphResume() {
  await window.app.taskGraphResume()
  document.getElementById('tgResumeBtn').style.display = 'none'
  document.getElementById('tgPauseBtn').style.display = 'inline-block'
}

async function taskGraphAbort() {
  await window.app.taskGraphAbort()
  document.getElementById('tgPauseBtn').style.display = 'none'
  document.getElementById('tgResumeBtn').style.display = 'none'
  document.getElementById('tgAbortBtn').style.display = 'none'
  document.getElementById('tgRunBtn').style.display = 'inline-block'
  document.getElementById('tgInjectBar').style.display = 'none'
  _orchestratorRunning = false
  document.getElementById('agentPrompt').placeholder = 'Ask anything... drop images here. ⌘↵ to send'
  appendMsg('system', '⏹ Task graph aborted.')
  finishGeneration()
}

async function taskGraphInject() {
  const input = document.getElementById('tgInjectInput')
  const msg = input?.value?.trim()
  if (!msg) return
  input.value = ''
  const result = await window.app.taskGraphInject(msg)
  if (result?.error) {
    appendMsg('system', `⚠️ Inject failed: ${result.error}`)
  } else {
    appendMsg('system', `💬 Injected: ${esc(msg)}`)
  }
}

async function openTasksMd() {
  const path = await window.app.openFile?.({ filters: [{ name: 'Markdown', extensions: ['md'] }] })
  if (!path) return
  const graph = await window.app.taskGraphParse(path)
  if (graph.error) { appendMsg('system', '❌ ' + graph.error); return }
  currentTaskGraph = graph
  renderTaskGraph(graph)
}

// Listen for task status events
if (window.app.onTaskStatusEvent) {
  window.app.onTaskStatusEvent(evt => {
    // Track the current agent type for the stats bar
    if (evt.agentType) _currentAgentType = evt.agentType
    if (evt.status === 'completed' || evt.status === 'failed') {
      // Clear agent type when task finishes (will be set again by next task)
      _currentAgentType = null
    }

    if (currentTaskGraph && currentTaskGraph.nodes) {
      if (currentTaskGraph.nodes[evt.nodeId]) {
        currentTaskGraph.nodes[evt.nodeId].status = evt.status
        if (evt.agentType) currentTaskGraph.nodes[evt.nodeId].agentType = evt.agentType
        // Record start time for elapsed timer
        if (evt.status === 'in_progress') {
          currentTaskGraph.nodes[evt.nodeId]._startTime = Date.now()
          // Clear the todo panel when a new task starts — the agent will
          // populate it with its subtasks via todo-bootstrap immediately after.
          // This fires before the agent runs so bootstrap always wins.
          currentTodos = []
          const _todoPanelBody = document.getElementById('todoPanelBody')
          if (_todoPanelBody) _todoPanelBody.innerHTML = ''
        }
        renderTaskGraph(currentTaskGraph)
        renderSpecTaskProgress() // sync spec panel
      } else {
        // Node not found — task graph may be stale, try reloading
        if (currentTasksPath) loadTaskGraph(currentTasksPath).catch(() => {})
      }
    }
    // Also update the todo panel to reflect task graph status.
    // Only update in-place if the panel already has todos (agent subtasks).
    // Do NOT seed from the full task graph — the task graph panel already
    // shows all nodes. The todo panel is for the current agent's subtasks only.
    const statusMap = { 'in_progress': 'in_progress', 'completed': 'completed', 'failed': 'pending', 'not_started': 'pending' }
    const todoStatus = statusMap[evt.status] || evt.status

    if (currentTodos.length > 0) {
      const updated = currentTodos.map(t =>
        String(t.id) === String(evt.nodeId) ? { ...t, status: todoStatus } : t
      )
      updateTodoPanel(updated, 'done')
    }
  })
}

// ── Elapsed timer for in-progress task nodes ──────────────────────────────────
setInterval(() => {
  const elapsedEls = document.querySelectorAll('.tg-node-elapsed')
  elapsedEls.forEach(el => {
    const start = parseInt(el.dataset.start, 10)
    if (!start) return
    const secs = Math.floor((Date.now() - start) / 1000)
    const mins = Math.floor(secs / 60)
    el.textContent = mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`
  })
}, 1000)

// ── Forward agent streaming events to active task activity indicator ──────────
if (window.app.onOrchestratorEvent) {
  window.app.onOrchestratorEvent(evt => {
    // evt.taskId, evt.channel, evt.data
    const taskId = evt.taskId
    if (!taskId) return
    const activityEl = document.querySelector(`.tg-node-activity[data-node-id="${taskId}"]`)
    if (!activityEl) return
    // Show the tool/channel name as a brief activity hint
    let hint = ''
    if (evt.channel === 'tool_use') {
      hint = `⚙ ${evt.data?.name || 'tool'}`
    } else if (evt.channel === 'tool_result') {
      hint = `✓ ${evt.data?.name || 'done'}`
    } else if (evt.channel === 'text' && evt.data) {
      // Show last ~40 chars of streamed text
      const text = typeof evt.data === 'string' ? evt.data : (evt.data.text || '')
      hint = text.slice(-40).replace(/\n/g, ' ')
    } else if (evt.channel) {
      hint = evt.channel
    }
    if (hint) activityEl.textContent = hint
  })
}


let currentSpecDir = null
let currentSpecName = null
let specGenerating = false

// ── spec task progress (in spec sidebar panel) ───────────────────────────────
function renderSpecTaskProgress() {
  const panel = document.getElementById('specTaskProgress')
  const list = document.getElementById('specTaskList')
  const countEl = document.getElementById('specTaskProgressCount')
  if (!panel || !list) return

  if (!currentTaskGraph || !currentTaskGraph.nodes) {
    panel.style.display = 'none'
    return
  }

  const nodes = currentTaskGraph.nodes
  const ids = Object.keys(nodes).sort((a, b) => {
    const ap = a.split('.').map(Number), bp = b.split('.').map(Number)
    for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
      if ((ap[i]||0) !== (bp[i]||0)) return (ap[i]||0) - (bp[i]||0)
    }
    return 0
  })

  if (ids.length === 0) { panel.style.display = 'none'; return }

  const completed = ids.filter(id => nodes[id].status === 'completed').length
  const total = ids.length
  if (countEl) countEl.textContent = `${completed}/${total}`

  panel.style.display = ''
  list.innerHTML = ids.map(id => {
    const node = nodes[id]
    const indent = (node.depth || 0) * 10
    const statusClass = node.status || 'not_started'
    return `<div class="spec-task-item ${statusClass}" style="padding-left:${6 + indent}px">
      <span class="st-dot ${statusClass}"></span>
      <span class="st-id">${esc(id)}</span>
      <span class="st-title">${esc(node.title)}</span>
    </div>`
  }).join('')
}

async function restoreActiveSpec() {
  if (!window.app.specList) return
  const specs = await window.app.specList()
  if (!specs || specs.length === 0) {
    currentSpecDir = null
    currentSpecName = null
    return
  }
  // Restore the most recently modified spec
  const latest = specs[0]
  currentSpecDir = latest.specDir
  currentSpecName = latest.name
}

function openSpecPanel() {
  // Open the sidebar spec panel AND show inline workflow in chat
  showPanel('specs', document.querySelector('[data-panel="specs"]'))
  showInlineSpecWorkflow()
}

async function showInlineSpecWorkflow() {
  const out = document.getElementById('agentOutput')
  // Clear the build picker if present
  const picker = out.querySelector('.build-picker')
  if (picker) picker.remove()
  // Remove any existing inline spec
  const existing = out.querySelector('.inline-spec-workflow')
  if (existing) existing.remove()

  // Fetch existing specs for the switcher
  let specs = []
  if (window.app.specList) {
    specs = await window.app.specList() || []
  }

  const specOptionsHtml = specs.map(s => {
    const selected = s.specDir === currentSpecDir ? 'selected' : ''
    const phase = s.currentPhase || 'requirements'
    return `<option value="${esc(s.specDir)}" data-name="${esc(s.name)}" ${selected}>${esc(s.name)} — ${phase}</option>`
  }).join('')

  const switcherHtml = specs.length > 0 ? `
    <div class="inline-spec-switcher" id="inlineSpecSwitcher">
      <select class="inline-spec-select" id="inlineSpecSelect">
        <option value="">— Select a spec —</option>
        ${specOptionsHtml}
      </select>
      <button class="inline-spec-new-btn" id="inlineSpecNewBtn">＋ New</button>
    </div>` : ''

  const html = `
  <div class="inline-spec-workflow" id="inlineSpecWorkflow">
    ${switcherHtml}

    <!-- create new spec -->
    <div class="inline-spec-create" id="inlineSpecCreate" ${currentSpecDir ? 'style="display:none"' : ''}>
      <div class="inline-spec-header">
        <span class="inline-spec-icon">📐</span>
        <span class="inline-spec-title">Create a Spec</span>
      </div>
      <div class="inline-spec-desc">Plan before you build. The AI will generate requirements, design, and tasks for you.</div>
      <input type="text" id="inlineSpecName" class="inline-spec-input" placeholder="feature-name">
      <textarea id="inlineSpecDescription" class="inline-spec-textarea" placeholder="Describe what you want to build..." rows="3"></textarea>
      <button class="inline-spec-btn" onclick="createInlineSpec()">📐 Create Spec</button>
    </div>

    <!-- active spec view -->
    <div class="inline-spec-active" id="inlineSpecActive" style="${currentSpecDir ? '' : 'display:none'}">
      <div class="inline-spec-name-bar">
        <span class="inline-spec-icon">📐</span>
        <span class="inline-spec-name" id="inlineSpecNameLabel">${currentSpecName || ''}</span>
        <button class="inline-spec-close" onclick="closeInlineSpec()" title="Close spec">✕</button>
      </div>

      <!-- phase stepper -->
      <div class="inline-spec-stepper" id="inlineSpecStepper">
        <div class="inline-spec-step" data-phase="requirements">
          <div class="inline-spec-step-dot" id="inlineStepDot-requirements"></div>
          <div class="inline-spec-step-info">
            <div class="inline-spec-step-label">Requirements</div>
            <div class="inline-spec-step-status" id="inlineStepStatus-requirements">Pending</div>
          </div>
          <button class="spec-gen-btn" id="inlineGenBtn-requirements" onclick="generateInlineSpecPhase('requirements')">✦ Generate</button>
        </div>
        <div class="inline-spec-step-line"></div>
        <div class="inline-spec-step" data-phase="design">
          <div class="inline-spec-step-dot" id="inlineStepDot-design"></div>
          <div class="inline-spec-step-info">
            <div class="inline-spec-step-label">Design</div>
            <div class="inline-spec-step-status" id="inlineStepStatus-design">Pending</div>
          </div>
          <button class="spec-gen-btn" id="inlineGenBtn-design" onclick="generateInlineSpecPhase('design')">✦ Generate</button>
        </div>
        <div class="inline-spec-step-line"></div>
        <div class="inline-spec-step" data-phase="tasks">
          <div class="inline-spec-step-dot" id="inlineStepDot-tasks"></div>
          <div class="inline-spec-step-info">
            <div class="inline-spec-step-label">Tasks</div>
            <div class="inline-spec-step-status" id="inlineStepStatus-tasks">Pending</div>
          </div>
          <button class="spec-gen-btn" id="inlineGenBtn-tasks" onclick="generateInlineSpecPhase('tasks')">✦ Generate</button>
        </div>
        <div class="inline-spec-step-line"></div>
        <div class="inline-spec-step" data-phase="implementation">
          <div class="inline-spec-step-dot" id="inlineStepDot-implementation"></div>
          <div class="inline-spec-step-info">
            <div class="inline-spec-step-label">Implementation</div>
            <div class="inline-spec-step-status" id="inlineStepStatus-implementation">Pending</div>
          </div>
          <button class="spec-gen-btn" id="inlineGenBtn-implementation" onclick="startInlineSpecImplementation()">▶ Build</button>
        </div>
      </div>

      <!-- artifact viewer -->
      <div class="inline-spec-artifact" id="inlineSpecArtifact">
        <div class="inline-spec-artifact-empty" id="inlineSpecArtifactEmpty">Select a phase above to view or generate its content.</div>
        <div class="inline-spec-artifact-content" id="inlineSpecArtifactContent" style="display:none">
          <div class="inline-spec-artifact-header" id="inlineSpecArtifactHeader"></div>
          <div class="inline-spec-artifact-body" id="inlineSpecArtifactBody"></div>
        </div>
      </div>
    </div>
  </div>`
  out.insertAdjacentHTML('afterbegin', html)

  // Wire up switcher events
  const selectEl = document.getElementById('inlineSpecSelect')
  if (selectEl) {
    selectEl.addEventListener('change', () => {
      const specDir = selectEl.value
      if (!specDir) return
      const opt = selectEl.selectedOptions[0]
      const name = opt?.dataset?.name || ''
      switchToSpec(specDir, name)
    })
  }
  const newBtn = document.getElementById('inlineSpecNewBtn')
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      currentSpecDir = null
      currentSpecName = null
      if (selectEl) selectEl.value = ''
      document.getElementById('inlineSpecCreate').style.display = ''
      document.getElementById('inlineSpecActive').style.display = 'none'
      // Clear artifact viewer and reset stepper
      const artifactContent = document.getElementById('inlineSpecArtifactContent')
      const artifactEmpty = document.getElementById('inlineSpecArtifactEmpty')
      if (artifactContent) artifactContent.style.display = 'none'
      if (artifactEmpty) artifactEmpty.style.display = ''
      // Clear any previous chat messages below the spec workflow
      const out = document.getElementById('agentOutput')
      const workflow = out.querySelector('.inline-spec-workflow')
      if (workflow) {
        while (workflow.nextSibling) workflow.nextSibling.remove()
      }
    })
  }

  scrollOutput()
  if (currentSpecDir) {
    await refreshInlineSpecStepper()
    // Load the task graph if this spec has tasks.md
    const specTasksPath = currentSpecDir + '/tasks.md'
    if (!currentTaskGraph || currentTasksPath !== specTasksPath) {
      try { await loadTaskGraph(specTasksPath) } catch (_) { /* tasks may not exist yet */ }
    }
  }
}

async function switchToSpec(specDir, name) {
  currentSpecDir = specDir
  currentSpecName = name
  document.getElementById('inlineSpecCreate').style.display = 'none'
  document.getElementById('inlineSpecActive').style.display = ''
  document.getElementById('inlineSpecNameLabel').textContent = name
  // Reset artifact viewer
  document.getElementById('inlineSpecArtifactContent').style.display = 'none'
  document.getElementById('inlineSpecArtifactEmpty').style.display = ''
  await refreshInlineSpecStepper()
  // Load the task graph if this spec has tasks.md
  const specTasksPath = specDir + '/tasks.md'
  try { await loadTaskGraph(specTasksPath) } catch (_) { /* tasks may not exist yet */ }
  saveWorkflowState() // persist spec context for session restore
}

async function refreshInlineSpecSwitcher() {
  const selectEl = document.getElementById('inlineSpecSelect')
  if (!selectEl || !window.app.specList) return
  const specs = await window.app.specList() || []
  selectEl.innerHTML = '<option value="">— Select a spec —</option>' +
    specs.map(s => {
      const selected = s.specDir === currentSpecDir ? 'selected' : ''
      const phase = s.currentPhase || 'requirements'
      return `<option value="${esc(s.specDir)}" data-name="${esc(s.name)}" ${selected}>${esc(s.name)} — ${phase}</option>`
    }).join('')
}

async function createInlineSpec() {
  const nameInput = document.getElementById('inlineSpecName')
  const descInput = document.getElementById('inlineSpecDescription')
  const name = (nameInput?.value || '').trim()
  const description = (descInput?.value || '').trim()
  if (!name) { appendMsg('system', '⚠️ Enter a feature name.'); return }
  if (!currentProject) { appendMsg('system', '⚠️ Open a project first.'); return }
  const result = await window.app.specInit(name, currentProject)
  if (result.error) { appendMsg('system', '❌ ' + result.error); return }
  currentSpecDir = result.specDir
  currentSpecName = result.featureName
  if (description) {
    await window.app.specSaveArtifact(currentSpecDir, 'requirements', `# ${name}\n\n## Description\n${description}\n`)
  }
  document.getElementById('inlineSpecCreate').style.display = 'none'
  document.getElementById('inlineSpecActive').style.display = ''
  document.getElementById('inlineSpecNameLabel').textContent = name
  await refreshInlineSpecStepper()
  // Update the switcher dropdown with the new spec
  await refreshInlineSpecSwitcher()
  saveWorkflowState() // persist spec context for session restore
  appendMsg('system', `📐 Spec "${name}" created. Generating requirements...`)
  // Auto-start generating requirements immediately
  generateInlineSpecPhase('requirements')
}

function closeInlineSpec() {
  currentSpecDir = null
  currentSpecName = null
  const workflow = document.getElementById('inlineSpecWorkflow')
  if (workflow) workflow.remove()
  saveWorkflowState() // persist cleared spec state
}

async function refreshInlineSpecStepper() {
  if (!currentSpecDir) return
  const artifacts = await window.app.specArtifacts(currentSpecDir)
  if (artifacts.error) return
  const config = await window.app.specConfig(currentSpecDir)
  const currentPhase = config.currentPhase || 'requirements'
  const phases = ['requirements', 'design', 'tasks', 'implementation']
  const currentIdx = phases.indexOf(currentPhase)

  for (const phase of phases) {
    const dot = document.getElementById('inlineStepDot-' + phase)
    const status = document.getElementById('inlineStepStatus-' + phase)
    const btn = document.getElementById('inlineGenBtn-' + phase)
    if (!dot || !status) continue
    const idx = phases.indexOf(phase)
    const hasArtifact = !!artifacts[phase]

    dot.className = 'inline-spec-step-dot'
    status.className = 'inline-spec-step-status'

    if (hasArtifact) {
      dot.classList.add('completed')
      status.classList.add('done')
      status.textContent = '✓ Generated'
      if (btn && phase !== 'implementation') { btn.textContent = '👁 View'; btn.disabled = false; btn.onclick = () => viewInlineSpecArtifact(phase) }
    } else if (idx === currentIdx) {
      dot.classList.add('active')
      status.textContent = 'Ready to generate'
      if (btn && phase !== 'implementation') { btn.textContent = '✦ Generate'; btn.disabled = false; btn.onclick = () => generateInlineSpecPhase(phase) }
    } else {
      status.textContent = idx < currentIdx ? 'Skipped' : 'Pending'
      if (btn && phase !== 'implementation') {
        // Enable the next phase after current, disable anything further out
        const canGenerate = idx <= currentIdx + 1
        btn.disabled = !canGenerate
        btn.textContent = '✦ Generate'
        btn.onclick = canGenerate ? () => generateInlineSpecPhase(phase) : null
      }
    }
  }

  const lines = document.querySelectorAll('.inline-spec-step-line')
  lines.forEach((line, i) => {
    line.className = 'inline-spec-step-line'
    if (artifacts[phases[i]]) line.classList.add('completed')
  })

  const implBtn = document.getElementById('inlineGenBtn-implementation')
  if (implBtn) {
    const ready = artifacts.requirements && artifacts.design && artifacts.tasks
    implBtn.disabled = !ready
  }
}

async function viewInlineSpecArtifact(phase) {
  if (!currentSpecDir) return
  const artifacts = await window.app.specArtifacts(currentSpecDir)
  if (artifacts.error || !artifacts[phase]) return
  const labels = { requirements: '📋 Requirements', design: '🏗 Design', tasks: '📝 Tasks' }
  document.getElementById('inlineSpecArtifactEmpty').style.display = 'none'
  document.getElementById('inlineSpecArtifactContent').style.display = ''
  const headerEl = document.getElementById('inlineSpecArtifactHeader')
  headerEl.innerHTML = `${labels[phase] || phase} <button class="btn-sm" id="inlineRegenBtn" style="margin-left:auto;font-size:9px;padding:2px 6px">✦ Regenerate</button>`
  document.getElementById('inlineRegenBtn').onclick = () => generateInlineSpecPhase(phase)
  document.getElementById('inlineSpecArtifactBody').innerHTML = renderMd(artifacts[phase])
}

// ── shared spec phase streaming core ─────────────────────────────────────────
// Used by both generateInlineSpecPhase and generateSpecPhase (sidebar).
// Returns the cleaned content string, or null on failure/interrupt.
async function _streamSpecPhase(phase, specRespId) {
  const phaseLabel = phase.charAt(0).toUpperCase() + phase.slice(1)

  // Switch Send button to Stop — same as vibe mode
  const sendBtn = document.getElementById('sendBtn')
  let _specInterrupted = false
  if (sendBtn) {
    sendBtn.disabled = false
    sendBtn.innerHTML = '<span class="spinner"></span>Stop'
    sendBtn.className = 'btn-send btn-stop'
    sendBtn.onclick = () => {
      _specInterrupted = true
      window.app.offStream()
      _finishSpecGeneration(specRespId, phaseLabel, null, true)
    }
  }

  // Fire fast assistant acknowledgement before main model starts — await to prevent
  // concurrent Metal inference (fire-and-forget caused SIGABRT).
  if (!_specInterrupted) {
    try {
      const reply = await window.app.assistChatReply(`Generate ${phaseLabel} for spec "${currentSpecName}"`, 'general')
      if (reply && !_specInterrupted) {
        const fastEl = document.getElementById(specRespId + '-fast')
        if (fastEl) {
          fastEl.insertAdjacentHTML('beforeend', `<div class="fast-reply-badge"><span class="fast-reply-icon">⚡</span><span class="fast-reply-model">Fast Assistant</span><span class="fast-reply-text">${esc(reply)}</span></div>`)
          scrollOutput()
        }
      }
    } catch (_) {}
  }

  const artifacts = await window.app.specArtifacts(currentSpecDir)
  let ctx = ''
  if (currentProject) {
    ctx = await window.app.buildContext(currentProject) || ''
  }

  let prompt
  const desc = artifacts.requirements?.match(/## Description\n([\s\S]*?)(?=\n##|\n$|$)/)?.[1]?.trim() || ''
  if (phase === 'requirements') {
    prompt = SPEC_PROMPTS.requirements(currentSpecName, desc, ctx)
  } else if (phase === 'design') {
    prompt = SPEC_PROMPTS.design(currentSpecName, artifacts.requirements || '', ctx)
  } else if (phase === 'tasks') {
    prompt = SPEC_PROMPTS.tasks(currentSpecName, artifacts.requirements || '', artifacts.design || '')
  }

  const content = await new Promise((resolve, reject) => {
    let accumulated = ''
    let tokenCount = 0
    let inputTokens = 0
    let outputTokens = 0
    let serverTps = null
    _TksEstimator.reset()
    let startTime = null

    // Debounced markdown rendering
    let _mdRenderTimer = null
    let _mdDirty = false
    function scheduleRender() {
      _mdDirty = true
      if (_mdRenderTimer) return
      _mdRenderTimer = requestAnimationFrame(() => {
        _mdRenderTimer = null
        if (_mdDirty) {
          _mdDirty = false
          const thinkContent = extractThinking(accumulated)
          if (thinkContent) {
            const thinkEl = document.getElementById(specRespId + '-think')
            if (thinkEl) thinkEl.style.display = ''
            const thinkBody = document.getElementById(specRespId + '-think-body')
            if (thinkBody) thinkBody.textContent = thinkContent + '▌'
          }
          let displayText = accumulated.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
          const openThink = accumulated.lastIndexOf('<think>')
          const closeThink = accumulated.lastIndexOf('</think>')
          if (openThink > closeThink) displayText = accumulated.slice(0, openThink).trim()
          const textEl = document.getElementById(specRespId + '-text')
          if (textEl && displayText) textEl.innerHTML = renderMd(displayText, true) + '<span class="cursor">▌</span>'
          // Update activity line and status header
          const actEl = document.getElementById(specRespId + '-activity')
          if (actEl) {
            const tks = serverTps || _TksEstimator.rate()
            actEl.innerHTML = `✍️ Generating ${phaseLabel} — ${outputTokens} tokens${tks ? ' · ' + tks + ' tk/s' : ''} <span class="activity-dot">●</span>`
            actEl.classList.remove('hidden')
          }
          const statusEl2 = document.getElementById(specRespId + '-status')
          if (statusEl2) {
            const tks = serverTps || _TksEstimator.rate()
            statusEl2.textContent = `📐 Generating ${phaseLabel}${tks ? ' · ' + tks + ' tk/s' : ''} — ${outputTokens} tokens`
          }
          scrollOutput()
        }
      })
    }

    // Simulated prompt-eval progress while waiting for first token
    let promptProgress = 0
    let promptElapsed = 0
    const promptTimer = setInterval(() => {
      promptElapsed += 200
      promptProgress = 90 * (1 - Math.exp(-promptElapsed / 6000))
      updateAgentStatsBar({ state: 'prompt-eval', inputTokens, outputTokens, progress: promptProgress, activity: `Spec ${phaseLabel}: evaluating prompt...` })
      const actEl = document.getElementById(specRespId + '-activity')
      if (actEl) { actEl.innerHTML = `📊 Processing prompt... ${Math.round(promptProgress)}% <span class="activity-dot">●</span>`; actEl.classList.remove('hidden') }
    }, 200)

    updateAgentStatsBar({ state: 'prompt-eval', progress: 0, activity: `Spec ${phaseLabel}: evaluating prompt...` })

    window.app.offStream()

    window.app.onStreamChunk((parsed) => {
      if (_specInterrupted) return
      if (!startTime) {
        startTime = Date.now()
        clearInterval(promptTimer)
      }
      const delta = parsed.choices?.[0]?.delta?.content
      if (delta) {
        accumulated += delta
        tokenCount++
        outputTokens = tokenCount
        updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens, tks: serverTps, activity: `Spec ${phaseLabel}: generating...` })
        scheduleRender()
      }
    })

    window.app.onStreamStats((stats) => {
      if (_specInterrupted) return
      inputTokens = stats.prompt_tokens || inputTokens
      outputTokens = stats.completion_tokens || outputTokens || tokenCount
      if (stats.generation_tps) { serverTps = stats.generation_tps; _TksEstimator.setServer(stats.generation_tps) }
      const promptTps = stats.prompt_tps || null
      const peakMemory = stats.peak_memory_gb || null
      updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens, tks: serverTps, promptTps, peakMemory, activity: `Spec ${phaseLabel}: generating...` })
    })

    window.app.onStreamDone(() => {
      clearInterval(promptTimer)
      window.app.offStream()
      resolve(accumulated)
    })

    window.app.onStreamError((err) => {
      clearInterval(promptTimer)
      window.app.offStream()
      reject(new Error(err))
    })

    window.app.chatStream({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    })
  })

  // Restore Send button
  if (sendBtn && !_specInterrupted) {
    sendBtn.disabled = false
    sendBtn.innerHTML = 'Send ↵'
    sendBtn.className = 'btn-send'
    sendBtn.onclick = () => sendAgent()
  }

  return _specInterrupted ? null : content
}

// Finalize a spec response block after streaming ends
function _finishSpecGeneration(specRespId, phaseLabel, content, interrupted) {
  const actEl = document.getElementById(specRespId + '-activity')
  if (actEl) actEl.classList.add('hidden')

  const thinkBody = document.getElementById(specRespId + '-think-body')
  if (thinkBody && thinkBody.textContent.endsWith('▌')) {
    thinkBody.textContent = thinkBody.textContent.slice(0, -1)
  }

  const textEl = document.getElementById(specRespId + '-text')
  if (textEl) {
    // Remove trailing cursor
    const cursor = textEl.querySelector('.cursor')
    if (cursor) cursor.remove()
  }

  if (interrupted) {
    const statusEl = document.getElementById(specRespId + '-status')
    if (statusEl) statusEl.textContent = `⏹ ${phaseLabel} generation stopped`
    updateAgentStatsBar({ state: 'done', activity: `Spec ${phaseLabel}: stopped` })
    // Restore Send button
    const sendBtn = document.getElementById('sendBtn')
    if (sendBtn) {
      sendBtn.disabled = false
      sendBtn.innerHTML = 'Send ↵'
      sendBtn.className = 'btn-send'
      sendBtn.onclick = () => sendAgent()
    }
  }
}

async function generateInlineSpecPhase(phase) {
  if (!currentSpecDir || !loadedModelId || specGenerating) return
  specGenerating = true

  // Disable ALL phase buttons during generation
  const allPhases = ['requirements', 'design', 'tasks', 'implementation']
  for (const p of allPhases) {
    const b = document.getElementById('inlineGenBtn-' + p)
    if (b) b.disabled = true
  }

  const btn = document.getElementById('inlineGenBtn-' + phase)
  const status = document.getElementById('inlineStepStatus-' + phase)
  const dot = document.getElementById('inlineStepDot-' + phase)
  if (btn) { btn.textContent = '⏳ Generating...'; btn.classList.add('generating') }
  if (status) { status.textContent = 'Generating...'; status.className = 'inline-spec-step-status generating' }
  if (dot) { dot.className = 'inline-spec-step-dot generating' }

  // Show agent stats bar immediately
  const phaseLabel = phase.charAt(0).toUpperCase() + phase.slice(1)
  updateAgentStatsBar({ state: 'initializing', activity: `Spec: preparing ${phaseLabel}...` })

  // Auto-collapse any previous spec phase blocks
  document.querySelectorAll('.spec-phase-block').forEach(el => {
    el.querySelectorAll('details[open]').forEach(d => d.removeAttribute('open'))
  })

  // Create a live chat message block — same structure as vibe response blocks
  const specRespId = 'spec-resp-' + Date.now()
  const out = document.getElementById('agentOutput')
  out.insertAdjacentHTML('beforeend', `<div class="msg-block spec-phase-block" id="${specRespId}">
    <div class="msg-system" id="${specRespId}-status">📐 Generating ${phaseLabel} for "${esc(currentSpecName)}"...</div>
    <div id="${specRespId}-fast"></div>
    <details class="msg-thinking" id="${specRespId}-think" style="display:none">
      <summary>🧠 Thinking</summary>
      <div class="msg-thinking-body" id="${specRespId}-think-body"></div>
    </details>
    <details class="spec-phase-output" id="${specRespId}-output">
      <summary>📄 ${phaseLabel} output</summary>
      <div class="msg-text" id="${specRespId}-text"></div>
    </details>
    <div class="msg-activity" id="${specRespId}-activity">📐 Preparing ${phaseLabel}... <span class="activity-dot">●</span></div>
  </div>`)
  scrollOutput()

  let content = null
  try {
    content = await _streamSpecPhase(phase, specRespId)
  } catch (e) {
    const statusEl = document.getElementById(specRespId + '-status')
    if (statusEl) statusEl.textContent = `❌ Error: ${e.message}`
    updateAgentStatsBar({ state: 'done', activity: 'Spec generation failed' })
    _finishSpecGeneration(specRespId, phaseLabel, null, false)
    if (btn) { btn.classList.remove('generating') }
    specGenerating = false
    await refreshInlineSpecStepper()
    return
  }

  _finishSpecGeneration(specRespId, phaseLabel, content, content === null)

  if (content === null) {
    // Interrupted — restore buttons
    if (btn) { btn.classList.remove('generating') }
    specGenerating = false
    await refreshInlineSpecStepper()
    return
  }

  const statusEl = document.getElementById(specRespId + '-status')
  const textEl = document.getElementById(specRespId + '-text')

  if (!content) {
    if (statusEl) statusEl.textContent = `❌ Spec ${phaseLabel} generation failed: empty response`
    appendMsg('system', `❌ Spec generation failed: empty response`)
    updateAgentStatsBar({ state: 'done', activity: 'Spec generation failed' })
  } else {
    // Strip <think> tags and preamble
    let cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    if (!/^#/m.test(cleaned.split('\n')[0]) && /^#/m.test(cleaned)) {
      cleaned = cleaned.slice(cleaned.search(/^#/m)).trim()
    }

    if (statusEl) statusEl.textContent = `✅ ${phaseLabel} generated for "${currentSpecName}"`
    if (textEl) textEl.innerHTML = renderMd(cleaned)
    // Open the output panel now that content is ready
    const outputEl = document.getElementById(specRespId + '-output')
    if (outputEl) outputEl.setAttribute('open', '')

    await window.app.specSaveArtifact(currentSpecDir, phase, cleaned)
    await window.app.specAdvance(currentSpecDir)
    updateAgentStatsBar({ state: 'done', activity: `Spec ${phaseLabel}: complete` })
    viewInlineSpecArtifact(phase)

    // If tasks were generated, load into task graph
    if (phase === 'tasks' && currentProject) {
      const tasksPath = currentProject + '/.maccoder/specs/' + currentSpecName + '/tasks.md'
      try {
        await loadTaskGraph(tasksPath)
        showPanel('tasks', document.querySelector('[data-panel="tasks"]'))
        appendMsg('system', `📋 Tasks loaded into task graph.`)
      } catch (e) { /* best-effort */ }
    }
  }

  if (btn) { btn.classList.remove('generating') }
  specGenerating = false
  await refreshInlineSpecStepper()
}

async function _launchOrchestrator(tasksPath, taskCount) {
  // Parse the task graph first
  let parsed = null
  try {
    parsed = await window.app.taskGraphParse(tasksPath)
  } catch (_) { /* best-effort */ }

  if (parsed && parsed.nodes) {
    currentTaskGraph = parsed
    currentTasksPath = tasksPath
    renderTaskGraph(parsed)
    saveWorkflowState()
    // Do NOT seed the todo panel from the full task graph — the task graph
    // panel already shows all nodes. The todo panel will be populated with
    // the current task's subtasks when the agent starts (via todo-bootstrap).
  }

  agentFinished = false
  isGenerating = true
  const btn = document.getElementById('sendBtn')
  btn.disabled = false; btn.innerHTML = '<span class="spinner"></span>Stop'; btn.className = 'btn-send btn-stop'
  btn.onclick = () => { taskGraphAbort() }

  // Sync task graph sidebar buttons
  document.getElementById('tgRunBtn').style.display = 'none'
  document.getElementById('tgPauseBtn').style.display = 'inline-block'
  document.getElementById('tgAbortBtn').style.display = 'inline-block'
  document.getElementById('tgInjectBar').style.display = 'block'
  _orchestratorRunning = true
  document.getElementById('agentPrompt').placeholder = '💬 Agents running — type here to inject context or refine objectives. ⌘↵ to send'

  // Switch to tasks panel in sidebar
  showPanel('tasks', document.querySelector('[data-panel="tasks"]'))

  const orchId = 'resp-orch-' + Date.now()
  const out = document.getElementById('agentOutput')
  out.insertAdjacentHTML('beforeend', `<div class="msg-block" id="${orchId}">
    <div class="msg-system" id="${orchId}-status">🚀 Orchestrator: executing ${taskCount || ''} tasks...</div>
    <div id="${orchId}-tasks"></div>
    <div class="msg-activity" id="${orchId}-activity">🚀 Starting orchestrator... <span class="activity-dot">●</span></div>
  </div>`)
  scrollOutput()

  window.app.offQwenEvents()
  window.app.offOrchestratorEvents?.()
  window.app.offOrchestratorCompleted()  // clear any stale listener from a previous run
  let orchToolName = ''
  let orchTaskBlockId = null
  let orchTaskText = ''
  let orchTaskCount = 0

  // Local state for stats — mirrors what sendAgentMode has as closures
  let inputTokens = 0, outputTokens = 0, tokenCount = 0, serverTps = null
  _TksEstimator.reset()
  let _agentToolCount = 0
  let _orchStartTime = Date.now()
  _agentStartTimestamp = Date.now()

  // Local prompt progress for orchestrator (same pattern as sendAgentMode)
  let _promptProgress = -1
  let _promptProgressTimer = null
  function startPromptProgress() {
    if (_promptProgressTimer) { clearInterval(_promptProgressTimer); _promptProgressTimer = null }
    _promptProgress = 0
    let elapsed = 0
    updateAgentStatsBar({ state: 'prompt-eval', inputTokens, outputTokens: tokenCount, progress: 0, toolCount: _agentToolCount, activity: 'Evaluating prompt...' })
    _promptProgressTimer = setInterval(() => {
      elapsed += 200
      _promptProgress = 90 * (1 - Math.exp(-elapsed / 8000))
      updateAgentStatsBar({ state: 'prompt-eval', inputTokens, outputTokens: tokenCount, progress: _promptProgress, toolCount: _agentToolCount, activity: 'Evaluating prompt...' })
    }, 200)
  }
  function stopPromptProgress() {
    if (_promptProgressTimer) { clearInterval(_promptProgressTimer); _promptProgressTimer = null }
    _promptProgress = null
  }

  // Helper: update the orchestrator-level activity line
  function setOrchActivity(html) {
    const el = document.getElementById(orchId + '-activity')
    if (el) { el.innerHTML = html; el.classList.remove('hidden') }
  }

  function newOrchTaskBlock(label) {
    orchTaskCount++
    orchTaskText = ''
    orchTaskBlockId = orchId + '-task-' + orchTaskCount
    const tasksDiv = document.getElementById(orchId + '-tasks')
    tasksDiv.insertAdjacentHTML('beforeend', `<div class="msg-block" id="${orchTaskBlockId}" style="margin:6px 0;padding:8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg3)">
      <div class="msg-system" id="${orchTaskBlockId}-status" style="font-weight:600">${label}</div>
      <div id="${orchTaskBlockId}-fast"></div>
      <div id="${orchTaskBlockId}-tools"></div>
      <details class="msg-thinking" id="${orchTaskBlockId}-think" style="display:none">
        <summary>🧠 Thinking</summary>
        <div class="msg-thinking-body" id="${orchTaskBlockId}-think-body"></div>
      </details>
      <div class="msg-text" id="${orchTaskBlockId}-text"></div>
      <div class="msg-activity" id="${orchTaskBlockId}-activity">🤖 Agent starting... <span class="activity-dot">●</span></div>
    </div>`)
    scrollOutput()
  }

  // ── Bridge orchestrator-agent-event → qwen-event handler ────────────────
  // During coding tasks, DirectBridge uses CallbackSink which routes all events
  // through orchestrator-agent-event (shape: { taskId, channel, data }) instead
  // of the qwen-event IPC channel. We unwrap them here so the same handler below
  // receives them regardless of which path the event took.
  window.app.onOrchestratorEvent(evt => {
    if (evt && evt.channel === 'qwen-event' && evt.data) {
      _orchQwenEventHandler(evt.data)
    }
  })

  function _orchQwenEventHandler(ev) {
    if (typeof terminalHandleAgentEvent === 'function') terminalHandleAgentEvent(ev)
    switch (ev.type) {
      case 'agent-type': {
        // Small model routed this prompt — set agent type before session-start fires
        if (ev.agentType && ev.agentType !== 'general') {
          _currentAgentType = ev.agentType
          // Update the dropdown to show what was auto-picked
          const sel = document.getElementById('roleSelect')
          if (sel && sel.value === 'general') {
            sel.value = ev.agentType
            // Flash it briefly so user notices the auto-selection
            sel.style.outline = '1px solid var(--accent, #7c6af7)'
            setTimeout(() => { sel.style.outline = '' }, 2000)
          }
        }
        break
      }
      case 'routing-decision': {
        const roleIcons = ROLE_ICONS
        const icon = roleIcons[ev.agentType] || '🤖'
        if (ev.source === 'small model' || ev.source === 'keyword' || ev.source === 'todo') {
          const label = ev.source === 'keyword' ? '⚡ Fast routed'
            : ev.source === 'todo' ? '⚡ Todo routed'
            : '🤖 Fast model routed'
          const toolsEl = orchTaskBlockId ? document.getElementById(orchTaskBlockId + '-tools') : null
          const html = `<div class="msg-system" style="color:var(--accent,#7c6af7);font-size:11px;padding:2px 8px">${label} → ${icon} ${ev.agentType}</div>`
          if (toolsEl) toolsEl.insertAdjacentHTML('afterbegin', html)
          else appendMsg('system', `<span style="color:var(--accent,#7c6af7);font-size:11px">${label} → ${icon} ${ev.agentType}</span>`)
        }
        break
      }
      case 'fast-assist': {
        const faOrcEl = orchTaskBlockId ? document.getElementById(orchTaskBlockId + '-fast') : null
        if (faOrcEl) faOrcEl.insertAdjacentHTML('beforeend', renderFastAssistBlock(ev))
        else appendMsg('system', `<span style="color:var(--accent,#7c6af7);font-size:11px">${ev.label || '⚡ Fast Assistant'}</span>`)
        break
      }
      case 'todo-bootstrap': {
        // Orchestrator seeded todos from tasks.md subtasks — show them in the panel
        if (Array.isArray(ev.todos) && ev.todos.length > 0) {
          const mapped = ev.todos.map(t => ({
            id: t.id,
            content: t.content || t.title || t.text || '',
            status: t.status === 'done' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
          }))
          updateTodoPanel(mapped, 'running')
        }
        break
      }
      case 'todo-watch': {
        if (Array.isArray(ev.todos) && ev.todos.length > 0) {
          const mapped = ev.todos.map(t => ({
            id: t.id,
            content: t.content || t.title || t.text || '',
            status: t.status === 'done' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
          }))
          updateTodoPanel(mapped, 'running')
        }
        break
      }
      case 'user-injection': {
        if (ev.content) {
          const out = document.getElementById('agentOutput')
          out.insertAdjacentHTML('beforeend',
            `<div class="msg-user" style="opacity:0.85;border-left:2px solid var(--blue)">
              <div class="msg-user-label" style="color:var(--blue)">You (injected)</div>
              ${esc(ev.content)}
            </div>`)
          scrollOutput()
        }
        break
      }
      case 'session-start': {
        const activeTask = currentTodos.find(t => t.status === 'in_progress')
        const agentType = _currentAgentType
        const agentBadge = agentType && agentType !== 'general' ? ` <span class="orch-agent-badge">${agentType}</span>` : ''
        const taskLabel = activeTask ? `🔧 Task ${activeTask.id}: ${activeTask.content}${agentBadge}` : '🔧 Working on task...'
        newOrchTaskBlock(taskLabel)
        document.getElementById(orchId + '-status').textContent = `🚀 Orchestrator: task ${orchTaskCount}...`
        startPromptProgress()
        setOrchActivity(`📊 Task ${orchTaskCount}: evaluating prompt... <span class="activity-dot">●</span>`)
        updateAgentStatsBar({ state: 'prompt-eval', inputTokens, outputTokens: tokenCount, progress: 0, toolCount: _agentToolCount, agentType, activity: activeTask ? `Task ${activeTask.id}: Evaluating prompt...` : 'Evaluating prompt...' })
        break
      }
      case 'text-delta': {
        if (!orchTaskBlockId) newOrchTaskBlock('🔧 Working...')
        stopPromptProgress()
        orchTaskText = ev.text
        let displayText = orchTaskText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
        // Strip tool call XML that leaks into text stream
        displayText = displayText.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim()
        displayText = displayText.replace(/<function[\s\S]*?<\/function>/gi, '').trim()
        displayText = displayText.replace(/><function=[^>]*>[\s\S]*?<\/tool_call>/gi, '').trim()
        const openThink = orchTaskText.lastIndexOf('<think>')
        const closeThink = orchTaskText.lastIndexOf('</think>')
        if (openThink > closeThink) {
          displayText = orchTaskText.slice(0, openThink).trim()
          const thinkContent = orchTaskText.slice(openThink + 7)
          const thinkEl = document.getElementById(orchTaskBlockId + '-think')
          if (thinkEl) { thinkEl.style.display = ''; document.getElementById(orchTaskBlockId + '-think-body').textContent = thinkContent + '▌' }
        }
        const textEl = document.getElementById(orchTaskBlockId + '-text')
        if (textEl && displayText) textEl.innerHTML = renderMd(displayText, true) + '<span class="cursor">▌</span>'
        tokenCount++
        { const tks = serverTps || _TksEstimator.rate()
          const actEl = document.getElementById(orchTaskBlockId + '-activity')
          if (actEl) { actEl.innerHTML = `✍️ Generating — ${tokenCount} tokens${tks ? ' · ' + tks + ' tk/s' : ''} <span class="activity-dot">●</span>`; actEl.classList.remove('hidden') }
          setOrchActivity(`✍️ Task ${orchTaskCount}: generating — ${tokenCount} tokens${tks ? ' · ' + tks + ' tk/s' : ''} <span class="activity-dot">●</span>`)
        }
        updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, agentType: _currentAgentType, activity: 'Writing response...' })
        scrollOutput()
        break
      }
      case 'tool-delta': {
        // ── Live streaming preview of tool call arguments during spec execution ──
        // Shows the actual file content being written in real-time so the user
        // can see what the agent is coding, not just a silent wait.
        if (!orchTaskBlockId) newOrchTaskBlock('🔧 Working...')
        stopPromptProgress()
        const tdToolName = ev.name || ''
        const tdArgs = ev.argumentsSoFar || ''

        const TD_WRITE_TOOLS = ['write_file', 'edit_file', 'create_file']
        const tdIsWrite = TD_WRITE_TOOLS.includes(tdToolName)

        let tdFile = ''
        const tdPathMatch = tdArgs.match(/"(?:path|file_path)"\s*:\s*"([^"]+)"/)
        if (tdPathMatch) tdFile = tdPathMatch[1].split('/').pop()

        const tdActivity = tdIsWrite && tdFile
          ? `Writing ${tdFile}...`
          : tdIsWrite ? `Writing code via ${tdToolName}...`
          : tdToolName === 'bash' ? 'Preparing command...'
          : `Preparing ${tdToolName}...`

        { const sizeInfo = tdIsWrite && tdArgs.length > 100 ? ` · ${(tdArgs.length / 1024).toFixed(1)}KB` : ''
          const actEl = document.getElementById(orchTaskBlockId + '-activity')
          if (actEl) { actEl.innerHTML = `⚡ ${esc(tdActivity)}${sizeInfo} <span class="activity-dot">●</span>`; actEl.classList.remove('hidden') }
          setOrchActivity(`⚡ Task ${orchTaskCount}: ${esc(tdActivity)}${sizeInfo} <span class="activity-dot">●</span>`)
        }
        updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, agentType: _currentAgentType, activity: tdActivity })

        // Create or update the streaming tool preview block
        const tdPreviewId = orchTaskBlockId + '-tool-preview'
        let tdPreviewEl = document.getElementById(tdPreviewId)
        if (!tdPreviewEl) {
          document.getElementById(orchTaskBlockId + '-tools').insertAdjacentHTML('beforeend',
            `<div class="tool-block tool-preview running" id="${tdPreviewId}">
              <div class="tool-header">
                <span class="tool-icon">⚡</span>
                <div class="tool-header-info">
                  <span class="tool-name">${esc(_toolDisplayName(tdToolName))}</span>
                  <span class="tool-name-raw">${esc(tdToolName)}</span>
                </div>
                <span class="tool-status running"><span class="tool-spinner"></span> Generating…</span>
              </div>
              <div class="tool-preview-file"></div>
              <div class="tool-preview-body"></div>
            </div>`)
          tdPreviewEl = document.getElementById(tdPreviewId)
        }

        // Parse partial args to show live file content preview
        if (tdIsWrite && tdArgs.length > 10 && tdPreviewEl) {
          const fileEl = tdPreviewEl.querySelector('.tool-preview-file')
          const bodyEl = tdPreviewEl.querySelector('.tool-preview-body')

          if (tdPathMatch && fileEl) {
            fileEl.textContent = '📄 ' + tdPathMatch[1]
            fileEl.style.display = 'block'
          }

          const contentStart = tdArgs.indexOf('"content"')
          if (contentStart !== -1) {
            const valStart = tdArgs.indexOf(':"', contentStart + 9)
            if (valStart !== -1 && bodyEl) {
              let raw = tdArgs.slice(valStart + 2)
              raw = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
              if (raw.endsWith('\\')) raw = raw.slice(0, -1)
              if (raw.endsWith('"}')) raw = raw.slice(0, -2)
              else if (raw.endsWith('"')) raw = raw.slice(0, -1)

              const ext = (tdPathMatch?.[1] || '').split('.').pop() || ''
              const lineCount = raw.split('\n').length
              const lines = raw.split('\n').map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`).join('\n')
              bodyEl.innerHTML = `<div class="tool-preview-lang">${esc(ext)} · ${lineCount} lines</div><pre><code>${lines}</code></pre><span class="cursor">▌</span>`
              bodyEl.style.display = 'block'
            }
          }
        } else if (tdToolName === 'bash' && tdArgs.length > 5 && tdPreviewEl) {
          const bodyEl = tdPreviewEl.querySelector('.tool-preview-body')
          const cmdMatch = tdArgs.match(/"command"\s*:\s*"([^"]*(?:\\.[^"]*)*)/)
          if (cmdMatch && bodyEl) {
            let cmd = cmdMatch[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
            bodyEl.innerHTML = `<pre><code>$ ${esc(cmd)}</code></pre><span class="cursor">▌</span>`
            bodyEl.style.display = 'block'
          }
        } else if (tdPreviewEl && (tdToolName === 'read_file' || tdToolName === 'read_files') && tdArgs.length > 5) {
          const bodyEl = tdPreviewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const pMatch = tdArgs.match(/"path"\s*:\s*"([^"]*)"/) || tdArgs.match(/"paths"\s*:\s*\["([^"]*)"/)
            if (pMatch) { bodyEl.innerHTML = `<pre><code style="color:var(--muted)">📖 ${esc(pMatch[1])}</code></pre>`; bodyEl.style.display = 'block' }
          }
        } else if (tdPreviewEl && tdToolName === 'list_dir' && tdArgs.length > 5) {
          const bodyEl = tdPreviewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const pMatch = tdArgs.match(/"path"\s*:\s*"([^"]*)"/)
            if (pMatch) { bodyEl.innerHTML = `<pre><code style="color:var(--muted)">📁 ${esc(pMatch[1])}</code></pre>`; bodyEl.style.display = 'block' }
          }
        } else if (tdPreviewEl && (tdToolName === 'search_files' || tdToolName === 'grep_search') && tdArgs.length > 5) {
          const bodyEl = tdPreviewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const pMatch = tdArgs.match(/"pattern"\s*:\s*"([^"]*)"/) || tdArgs.match(/"query"\s*:\s*"([^"]*)"/)
            if (pMatch) { bodyEl.innerHTML = `<pre><code style="color:var(--muted)">🔍 ${esc(pMatch[1])}</code></pre>`; bodyEl.style.display = 'block' }
          }
        } else if (tdPreviewEl && tdToolName === 'web_search' && tdArgs.length > 5) {
          const bodyEl = tdPreviewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const qMatch = tdArgs.match(/"query"\s*:\s*"([^"]*)"/)
            if (qMatch) { bodyEl.innerHTML = `<pre><code style="color:var(--muted)">🔎 ${esc(qMatch[1])}</code></pre>`; bodyEl.style.display = 'block' }
          }
        } else if (tdPreviewEl && tdToolName === 'web_fetch' && tdArgs.length > 5) {
          const bodyEl = tdPreviewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const uMatch = tdArgs.match(/"url"\s*:\s*"([^"]*)"/)
            if (uMatch) { bodyEl.innerHTML = `<pre><code style="color:var(--muted)">🌍 ${esc(uMatch[1])}</code></pre>`; bodyEl.style.display = 'block' }
          }
        } else if (tdPreviewEl && tdToolName === 'browser_navigate' && tdArgs.length > 5) {
          const bodyEl = tdPreviewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const uMatch = tdArgs.match(/"url"\s*:\s*"([^"]*)"/)
            if (uMatch) { bodyEl.innerHTML = `<pre><code style="color:var(--muted)">🌐 ${esc(uMatch[1])}</code></pre>`; bodyEl.style.display = 'block' }
          }
        } else if (tdPreviewEl && tdToolName === 'ask_user' && tdArgs.length > 5) {
          const bodyEl = tdPreviewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const qMatch = tdArgs.match(/"question"\s*:\s*"([^"]*(?:\\.[^"]*)*)/)
            if (qMatch) {
              let q = qMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
              bodyEl.innerHTML = `<pre><code style="color:var(--yellow)">❓ ${esc(q)}</code></pre><span class="cursor">▌</span>`
              bodyEl.style.display = 'block'
            }
          }
        } else if (tdPreviewEl && tdToolName === 'task_complete' && tdArgs.length > 5) {
          const bodyEl = tdPreviewEl.querySelector('.tool-preview-body')
          if (bodyEl) {
            const sMatch = tdArgs.match(/"summary"\s*:\s*"([^"]*(?:\\.[^"]*)*)/)
            if (sMatch) {
              let s = sMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
              bodyEl.innerHTML = `<pre><code style="color:var(--green)">✅ ${esc(s)}</code></pre><span class="cursor">▌</span>`
              bodyEl.style.display = 'block'
            }
          }
        }

        scrollOutput()
        break
      }
      case 'tool-use':
        if (!orchTaskBlockId) newOrchTaskBlock('🔧 Working...')
        stopPromptProgress()
        orchToolName = ev.name || ''
        _agentToolCount++
        // Route update_todos to the todo panel — always update regardless of task graph state.
        // The task graph panel (left sidebar) and todo panel (right) are independent.
        if (ev.name === 'update_todos' && ev.input?.todos) {
          { const prevPreview = orchTaskBlockId ? document.getElementById(orchTaskBlockId + '-tool-preview') : null
            if (prevPreview) prevPreview.remove()
          }
          const mapped = ev.input.todos.map(t => ({
            id: t.id,
            content: t.content || t.title || t.text || '',
            status: t.status === 'done' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
          }))
          updateTodoPanel(mapped, 'running')
          updateAgentStatsBar({ state: 'tool', toolName: ev.name, inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, activity: 'Updating progress...' })
          scrollOutput()
          break
        }
        // Route edit_todos — surgical mutations
        if (ev.name === 'edit_todos') {
          { const prevPreview = orchTaskBlockId ? document.getElementById(orchTaskBlockId + '-tool-preview') : null
            if (prevPreview) prevPreview.remove()
          }
          applyTodoEdits(ev.input)
          updateAgentStatsBar({ state: 'tool', toolName: ev.name, inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, activity: 'Updating progress...' })
          scrollOutput()
          break
        }
        // Replace the streaming preview with the real tool block in a single DOM operation
        // to avoid the visual flash where content disappears between preview removal and insertion.
        { const prevPreview = orchTaskBlockId ? document.getElementById(orchTaskBlockId + '-tool-preview') : null
          if (prevPreview) {
            prevPreview.insertAdjacentHTML('beforebegin', renderToolUse(ev.name, ev.input, 'running'))
            prevPreview.remove()
          } else {
            document.getElementById(orchTaskBlockId + '-tools').insertAdjacentHTML('beforeend', renderToolUse(ev.name, ev.input, 'running'))
          }
        }
        document.getElementById(orchTaskBlockId + '-status').textContent = `🔧 Using tool: ${ev.name}`
        { const actEl = document.getElementById(orchTaskBlockId + '-activity')
          if (actEl) { actEl.innerHTML = `⚡ ${esc(ev.name || 'tool')} <span class="activity-dot">●</span>`; actEl.classList.remove('hidden') }
          setOrchActivity(`🔧 Task ${orchTaskCount}: running ${esc(ev.name || 'tool')} <span class="activity-dot">●</span>`)
        }
        updateAgentStatsBar({ state: 'tool', toolName: ev.name, inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, agentType: _currentAgentType, activity: `Running ${ev.name}...` })
        scrollOutput()
        break
      case 'tool-result': {
        if (!orchTaskBlockId) break
        // Skip rendering tool-result for update_todos/edit_todos
        if (orchToolName === 'update_todos' || orchToolName === 'edit_todos') {
          updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, activity: 'Thinking about next step...' })
          break
        }
        const toolsDiv = document.getElementById(orchTaskBlockId + '-tools')
        const lastTool = toolsDiv?.querySelector('.tool-block:last-child')
        if (lastTool) {
          const newStatus = ev.is_error ? 'error' : 'done'
          lastTool.className = lastTool.className.replace(/\b(running|done|error)\b/g, '').trim() + ' ' + newStatus
          const statusEl = lastTool.querySelector('.tool-status')
          if (statusEl) { statusEl.className = 'tool-status ' + newStatus; statusEl.innerHTML = ev.is_error ? '✗ Error' : '✓ Done' }
          lastTool.insertAdjacentHTML('beforeend', renderToolResult(ev.content, ev.is_error))
          const resultBody = lastTool.querySelector('.tool-result-body')
          if (resultBody) {
            const naturalH = resultBody.scrollHeight
            if (naturalH > 200) {
              resultBody.style.maxHeight = naturalH + 'px'
              requestAnimationFrame(() => { resultBody.style.maxHeight = '200px'; resultBody.style.overflowY = 'auto' })
            }
          }
        }
        const FILE_TOOLS = ['write_file', 'edit_file', 'create_file', 'bash']
        if (!ev.is_error && FILE_TOOLS.some(t => orchToolName.includes(t))) {
          if (currentProject) renderFileTree(currentProject, document.getElementById('fileTree'))
          if (typeof autoUpdateCenterPreview === 'function') autoUpdateCenterPreview()
        }
        updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, agentType: _currentAgentType, activity: 'Thinking about next step...' })
        { const actEl = document.getElementById(orchTaskBlockId + '-activity')
          if (actEl) { actEl.innerHTML = `🧠 Thinking about next step... <span class="activity-dot">●</span>`; actEl.classList.remove('hidden') }
        }
        startPromptProgress()
        scrollOutput()
        break
      }
      case 'result':
        if (orchTaskBlockId && ev.result && !ev.is_error) {
          const textEl = document.getElementById(orchTaskBlockId + '-text')
          if (textEl) {
            let cleanResult = ev.result.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
            textEl.innerHTML = renderMd(cleanResult)
          }
        }
        break
      case 'raw-stream': {
        const sev = ev.event; if (!sev) break
        if (sev.usage) {
          inputTokens = sev.usage.prompt_tokens || inputTokens
          outputTokens = sev.usage.completion_tokens || outputTokens
          const genTps = sev.x_stats?.generation_tps
          const promptTps = sev.x_stats?.prompt_tps
          if (genTps) { serverTps = genTps; _TksEstimator.setServer(genTps) }
          updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens, tks: genTps, promptTps, peakMemory: sev.x_stats?.peak_memory_gb, toolCount: _agentToolCount, agentType: _currentAgentType })
        }
        break
      }
      case 'lsp-activity': {
        const lspDot = document.getElementById('lspDot')
        const action = ev.action || ''
        const filePath = ev.path ? ev.path.split('/').pop() : ''
        if (lspDot) {
          lspDot.style.background = 'var(--accent2)'
          lspDot.style.boxShadow = '0 0 6px var(--accent2)'
          setTimeout(() => {
            const colors = { ready: 'var(--green)', starting: '#f5a623', degraded: '#f5a623', error: 'var(--red)', stopped: 'var(--muted)' }
            lspDot.style.background = colors[currentLspStatus] || 'var(--muted)'
            lspDot.style.boxShadow = ''
          }, 800)
        }
        if (orchTaskBlockId) {
          const toolsEl = document.getElementById(orchTaskBlockId + '-tools')
          if (action === 'speculative-check') {
            setOrchActivity(`🔬 LSP: validating ${filePath}... <span class="activity-dot">●</span>`)
          } else if (action === 'speculative-ok' && toolsEl) {
            toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--green)">✅ LSP validated ${filePath} — no new errors</div>`)
          } else if (action === 'speculative-warn' && toolsEl) {
            toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--yellow)">⚠️ LSP found ${ev.count} issue${ev.count > 1 ? 's' : ''} in ${filePath}</div>`)
          } else if (action === 'diagnostics-check') {
            setOrchActivity(`🔬 LSP: checking ${filePath}... <span class="activity-dot">●</span>`)
          } else if (action === 'diagnostics-ok' && toolsEl) {
            toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--green)">✅ LSP: ${filePath} — clean</div>`)
          } else if (action === 'diagnostics-errors' && toolsEl) {
            toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--red)">⚠️ LSP: ${filePath} — ${ev.count} error${ev.count > 1 ? 's' : ''} found</div>`)
          } else if (action === 'session-diagnostics' && toolsEl) {
            toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--accent2)">📋 LSP: ${ev.count} existing error${ev.count > 1 ? 's' : ''} in project</div>`)
          }
        }
        break
      }
      case 'memory-extract': {
        if (orchTaskBlockId && ev.message) {
          const toolsEl = document.getElementById(orchTaskBlockId + '-tools')
          if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--muted);font-size:10px;opacity:0.7">${esc(ev.message)}</div>`)
        }
        break
      }
      case 'system':
        if (ev.subtype === 'debug') {
          setOrchActivity(`🔍 ${esc(ev.data)} <span class="activity-dot">●</span>`)
          if (ev.data && (ev.data.includes('retrying') || ev.data.includes('Trimmed') || ev.data.includes('Repetition'))) {
            if (orchTaskBlockId) {
              const toolsEl = document.getElementById(orchTaskBlockId + '-tools')
              if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--muted)">🔍 ${esc(ev.data)}</div>`)
            }
          }
        }
        updateAgentStatsBar({ state: 'processing', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: ev.subtype === 'debug' ? ev.data : ev.subtype })
        scrollOutput()
        break
      case 'compaction-stats':
        if (!ev.data.source || ev.data.source !== 'tool-result') {
          _lastCompactionStats = ev.data
        } else if (!_lastCompactionStats) {
          _lastCompactionStats = ev.data
        }
        updateAgentStatsBar({ state: 'processing', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: 'Compressed context' })
        break
      case 'usage':
        if (ev.usage) {
          inputTokens = ev.usage.input_tokens || ev.usage.prompt_tokens || inputTokens
          outputTokens = ev.usage.output_tokens || ev.usage.completion_tokens || outputTokens
        }
        updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens })
        break
      case 'session-end':
        stopPromptProgress()
        if (orchTaskBlockId) {
          const statusEl = document.getElementById(orchTaskBlockId + '-status')
          if (statusEl) statusEl.textContent = '✅ Task completed'
          const tb = document.getElementById(orchTaskBlockId + '-think-body')
          if (tb && tb.textContent.endsWith('▌')) tb.textContent = tb.textContent.slice(0, -1)
          // Hide the task-level activity line
          const actEl = document.getElementById(orchTaskBlockId + '-activity')
          if (actEl) actEl.classList.add('hidden')
        }
        orchTaskBlockId = null
        orchTaskText = ''
        _orchStartTime = Date.now() // reset for next task
        document.getElementById(orchId + '-status').textContent = '🚀 Orchestrator: moving to next task...'
        setOrchActivity(`🚀 Moving to next task... <span class="activity-dot">●</span>`)
        scrollOutput()
        break
      case 'error':
        appendMsg('system', '❌ Task error: ' + ev.error)
        break
    }
  }

  // Also wire the same handler to the direct qwen-event channel — this fires
  // when DirectBridge uses WindowSink (e.g. single-agent runs not via pool).
  window.app.onQwenEvent(_orchQwenEventHandler)

  window.app.onOrchestratorCompleted(() => {
    window.app.offOrchestratorCompleted()
    window.app.offQwenEvents()
    window.app.offOrchestratorEvents?.()
    stopPromptProgress()
    // Use task graph node statuses — currentTodos is the chat todo list and
    // is empty at the start of a spec run, making [].every(...) vacuously true.
    const graphNodes = currentTaskGraph ? Object.values(currentTaskGraph.nodes) : []
    const allDone = graphNodes.length > 0
      ? graphNodes.every(n => n.status === 'completed' || n.status === 'skipped' || n.status === 'failed')
      : false
    const anyFailed = graphNodes.some(n => n.status === 'failed')
    document.getElementById(orchId + '-status').textContent = allDone
      ? (anyFailed ? '✅ Done (some tasks failed)' : '✅ All tasks completed')
      : '⚠️ Orchestrator stopped'
    // Hide the orchestrator-level activity line
    const orchActEl = document.getElementById(orchId + '-activity')
    if (orchActEl) orchActEl.classList.add('hidden')
    if (allDone && !anyFailed) appendMsg('system', '🎉 All tasks completed!')
    else if (allDone && anyFailed) appendMsg('system', '✅ Done — some tasks failed and were skipped.')
    if (currentProject) renderFileTree(currentProject, document.getElementById('fileTree'))
    saveChatSnapshot()
    agentFinished = true
    isGenerating = false
    updateStatusBar('idle')
    updateAgentStatsBar({ state: 'done', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount })
    finishGeneration()

    document.getElementById('tgRunBtn').style.display = 'inline-block'
    document.getElementById('tgPauseBtn').style.display = 'none'
    document.getElementById('tgResumeBtn').style.display = 'none'
    document.getElementById('tgAbortBtn').style.display = 'none'
    document.getElementById('tgInjectBar').style.display = 'none'
    _orchestratorRunning = false
    document.getElementById('agentPrompt').placeholder = 'Ask anything... drop images here. ⌘↵ to send'

    if (currentTasksPath) loadTaskGraph(currentTasksPath).catch(() => {})
  })

  window.app.taskGraphExecute(tasksPath, currentProject).then(r => {
    console.log('[orchestrator] Result:', r)
    if (r.error) appendMsg('system', `⚠️ Orchestrator error: ${r.error}`)
  }).catch(err => {
    console.error('[orchestrator] Error:', err)
    appendMsg('system', `⚠️ Orchestrator failed: ${err.message}`)
  })
}

async function startInlineSpecImplementation() {
  if (!currentSpecDir || !currentProject) return
  if (isGenerating) return
  // Set isGenerating immediately to prevent double-launch from rapid clicks.
  // The async operations below (specArtifacts, loadTaskGraph) yield control,
  // so without this guard a second click can pass the isGenerating check above.
  isGenerating = true
  const artifacts = await window.app.specArtifacts(currentSpecDir)
  if (!artifacts.tasks) {
    isGenerating = false
    appendMsg('system', '⚠️ Generate tasks first.')
    return
  }

  // Ensure the spec config has targetProjectDir set — patch it if missing.
  // This handles specs created before this field was added.
  try {
    const cfg = await window.app.specConfig(currentSpecDir)
    if (!cfg.error && !cfg.targetProjectDir) {
      await window.app.specSaveConfig(currentSpecDir, { targetProjectDir: currentProject })
    }
  } catch (_) { /* best-effort */ }

  // Use the spec dir directly — works for .maccoder/specs/
  const tasksPath = currentSpecDir + '/tasks.md'
  try {
    await loadTaskGraph(tasksPath)
    renderSpecTaskProgress()
  } catch (e) { /* best-effort */ }

  // Count tasks for the summary
  const taskLines = artifacts.tasks.split('\n').filter(l => /^- \[[ x]\]/.test(l.trim()))
  const taskCount = taskLines.length

  // Show a clean formatted card in chat
  appendMsg('system', `📐 Starting implementation for "${currentSpecName}"...`)
  const out = document.getElementById('agentOutput')
  out.insertAdjacentHTML('beforeend', `<div class="msg-user">
    <div class="msg-user-label">Spec Implementation</div>
    <div style="margin:6px 0 4px;font-weight:600">📐 ${esc(currentSpecName)}</div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:6px">${taskCount} tasks · ${esc(currentProject)}</div>
    <details style="cursor:pointer">
      <summary style="font-size:11px;color:var(--accent2);user-select:none">View task list ▸</summary>
      <div style="font-size:11px;margin-top:6px;max-height:300px;overflow-y:auto;white-space:pre-wrap;color:var(--muted);font-family:'SF Mono',monospace">${esc(artifacts.tasks)}</div>
    </details>
  </div>`)
  scrollOutput()

  // Launch orchestrator directly — no chat agent intermediary
  _launchOrchestrator(tasksPath, taskCount)
}

async function createNewSpec() {
  const nameInput = document.getElementById('newSpecName')
  const descInput = document.getElementById('specDescription')
  const name = (nameInput?.value || '').trim()
  const description = (descInput?.value || '').trim()
  if (!name) { appendMsg('system', '⚠️ Enter a feature name.'); return }
  if (!currentProject) { appendMsg('system', '⚠️ Open a project first.'); return }
  const result = await window.app.specInit(name, currentProject)
  if (result.error) { appendMsg('system', '❌ ' + result.error); return }
  currentSpecDir = result.specDir
  currentSpecName = result.featureName
  // Save description as metadata
  if (description) {
    await window.app.specSaveArtifact(currentSpecDir, 'requirements', `# ${name}\n\n## Description\n${description}\n`)
  }
  nameInput.value = ''
  descInput.value = ''
  document.getElementById('specCreate').style.display = 'none'
  document.getElementById('specActive').style.display = 'flex'
  document.getElementById('specNameLabel').textContent = name
  await refreshSpecStepper()
  appendMsg('system', `📐 Spec "${name}" created. Generate requirements to get started.`)
}

function closeSpec() {
  currentSpecDir = null
  currentSpecName = null
  document.getElementById('specCreate').style.display = ''
  document.getElementById('specActive').style.display = 'none'
  document.getElementById('specArtifactContent').style.display = 'none'
  document.getElementById('specArtifactEmpty').style.display = ''
  saveWorkflowState() // persist cleared spec state
}

async function refreshSpecStepper() {
  if (!currentSpecDir) return
  const artifacts = await window.app.specArtifacts(currentSpecDir)
  if (artifacts.error) return
  const config = await window.app.specConfig(currentSpecDir)
  const currentPhase = config.currentPhase || 'requirements'
  const phases = ['requirements', 'design', 'tasks', 'implementation']
  const currentIdx = phases.indexOf(currentPhase)

  for (const phase of phases) {
    const dot = document.getElementById('stepDot-' + phase)
    const status = document.getElementById('stepStatus-' + phase)
    const btn = document.getElementById('genBtn-' + phase)
    const idx = phases.indexOf(phase)
    const hasArtifact = !!artifacts[phase]

    // Reset classes
    dot.className = 'spec-step-dot'
    status.className = 'spec-step-status'

    if (hasArtifact) {
      dot.classList.add('completed')
      status.classList.add('done')
      status.textContent = '✓ Generated'
      if (btn && phase !== 'implementation') { btn.textContent = '👁 View'; btn.disabled = false; btn.onclick = () => viewSpecArtifact(phase) }
    } else if (idx === currentIdx) {
      dot.classList.add('active')
      status.textContent = 'Ready to generate'
      if (btn && phase !== 'implementation') { btn.textContent = '✦ Generate'; btn.disabled = false; btn.onclick = () => generateSpecPhase(phase) }
    } else {
      status.textContent = idx < currentIdx ? 'Skipped' : 'Pending'
      if (btn && phase !== 'implementation') { btn.disabled = idx > currentIdx + 1 }
    }
  }

  // Update connecting lines
  const lines = document.querySelectorAll('.spec-step-line')
  lines.forEach((line, i) => {
    line.className = 'spec-step-line'
    if (artifacts[phases[i]]) line.classList.add('completed')
  })

  // Implementation button
  const implBtn = document.getElementById('genBtn-implementation')
  if (implBtn) {
    const ready = artifacts.requirements && artifacts.design && artifacts.tasks
    implBtn.disabled = !ready
  }
}

async function viewSpecArtifact(phase) {
  if (!currentSpecDir) return
  const artifacts = await window.app.specArtifacts(currentSpecDir)
  if (artifacts.error || !artifacts[phase]) return
  const labels = { requirements: '📋 Requirements', design: '🏗 Design', tasks: '📝 Tasks' }
  document.getElementById('specArtifactEmpty').style.display = 'none'
  document.getElementById('specArtifactContent').style.display = ''
  document.getElementById('specArtifactHeader').innerHTML = `${labels[phase] || phase} <button class="btn-sm" id="sidebarRegenBtn" style="margin-left:auto;font-size:9px;padding:2px 6px">✦ Regenerate</button>`
  document.getElementById('sidebarRegenBtn').onclick = () => generateSpecPhase(phase)
  document.getElementById('specArtifactBody').innerHTML = renderMd(artifacts[phase])
}

const SPEC_PROMPTS = {
  requirements: (name, desc, ctx) => `You are a senior product manager. Generate a detailed requirements document in markdown for a feature called "${name}".
${desc ? `\nFeature description: ${desc}` : ''}
${ctx ? `\nProject context:\n${ctx}` : ''}

Include:
- Overview and goals
- User stories (as a... I want... so that...)
- Functional requirements (numbered)
- Non-functional requirements (performance, security, accessibility)
- Acceptance criteria
- Out of scope items

IMPORTANT: Output ONLY the markdown document. Do NOT include any thinking process, reasoning steps, or preamble. Start directly with the markdown content.`,

  design: (name, requirements, ctx) => `You are a senior software architect. Generate a technical design document in markdown for a feature called "${name}".

Requirements document:
${requirements}
${ctx ? `\nProject context:\n${ctx}` : ''}

Include:
- Architecture overview
- Component design (with responsibilities)
- Data models / schemas
- API design (endpoints, request/response)
- Error handling strategy
- Testing strategy
- Dependencies and risks

IMPORTANT: Output ONLY the markdown document. Do NOT include any thinking process, reasoning steps, or preamble. Start directly with the markdown content.`,

  tasks: (name, requirements, design) => `You are a senior engineering lead. Generate an implementation task list in markdown for a feature called "${name}".

Requirements:
${requirements}

Design:
${design}

Generate a structured task list using this EXACT format (no other format):
- [ ] 1 Task title
  - [ ] 1.1 Subtask title
  - [ ] 1.2 Subtask title
  - dep: 1.1
- [ ] 2 Next task title
  - dep: 1

RULES:
- Use "- dep: <id>" lines to declare dependencies between tasks (things that must be done first)
- Top-level tasks should depend on the previous top-level task (e.g. task 2 depends on task 1)
- Subtasks within a group can depend on sibling subtasks
- Each task should be small enough to complete in 1-2 hours
- Include: Setup/scaffolding, Core implementation, Tests, Documentation
- Use action verbs that match these categories: "Explore/analyze" for exploration, "Gather context/find related" for context gathering, "Search/find/locate" for code search, "Design/architect/plan" for design, "Write requirements/spec" for requirements, "Implement/build/create/fix/add/refactor" for implementation

OUTPUT ONLY the markdown task list. No thinking, no reasoning, no preamble, no explanation. Start with "- [ ] 1" on the very first line.`,
}

async function generateSpecPhase(phase) {
  if (!currentSpecDir || !loadedModelId || specGenerating) return
  specGenerating = true

  const btn = document.getElementById('genBtn-' + phase)
  const status = document.getElementById('stepStatus-' + phase)
  const dot = document.getElementById('stepDot-' + phase)
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating...'; btn.classList.add('generating') }
  if (status) { status.textContent = 'Generating...'; status.className = 'spec-step-status generating' }
  if (dot) { dot.className = 'spec-step-dot generating' }

  const phaseLabel = phase.charAt(0).toUpperCase() + phase.slice(1)
  updateAgentStatsBar({ state: 'initializing', activity: `Spec: preparing ${phaseLabel}...` })

  // Auto-collapse any previous spec phase blocks
  document.querySelectorAll('.spec-phase-block').forEach(el => {
    el.querySelectorAll('details[open]').forEach(d => d.removeAttribute('open'))
  })

  // Create a live chat message block — same structure as vibe response blocks
  const specRespId = 'spec-side-resp-' + Date.now()
  const out = document.getElementById('agentOutput')
  out.insertAdjacentHTML('beforeend', `<div class="msg-block spec-phase-block" id="${specRespId}">
    <div class="msg-system" id="${specRespId}-status">📐 Generating ${phaseLabel} for "${esc(currentSpecName)}"...</div>
    <div id="${specRespId}-fast"></div>
    <details class="msg-thinking" id="${specRespId}-think" style="display:none">
      <summary>🧠 Thinking</summary>
      <div class="msg-thinking-body" id="${specRespId}-think-body"></div>
    </details>
    <details class="spec-phase-output" id="${specRespId}-output">
      <summary>📄 ${phaseLabel} output</summary>
      <div class="msg-text" id="${specRespId}-text"></div>
    </details>
    <div class="msg-activity" id="${specRespId}-activity">📐 Preparing ${phaseLabel}... <span class="activity-dot">●</span></div>
  </div>`)
  scrollOutput()

  let content = null
  try {
    content = await _streamSpecPhase(phase, specRespId)
  } catch (e) {
    const statusEl = document.getElementById(specRespId + '-status')
    if (statusEl) statusEl.textContent = `❌ Error: ${e.message}`
    updateAgentStatsBar({ state: 'done', activity: 'Spec generation failed' })
    _finishSpecGeneration(specRespId, phaseLabel, null, false)
    if (btn) { btn.classList.remove('generating') }
    specGenerating = false
    await refreshSpecStepper()
    return
  }

  _finishSpecGeneration(specRespId, phaseLabel, content, content === null)

  if (content === null) {
    if (btn) { btn.classList.remove('generating') }
    specGenerating = false
    await refreshSpecStepper()
    return
  }

  const statusEl = document.getElementById(specRespId + '-status')
  const textEl = document.getElementById(specRespId + '-text')

  if (!content) {
    if (statusEl) statusEl.textContent = `❌ Spec ${phaseLabel} generation failed: empty response`
    updateAgentStatsBar({ state: 'done', activity: 'Spec generation failed' })
  } else {
    let cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    if (!/^#/m.test(cleaned.split('\n')[0]) && /^#/m.test(cleaned)) {
      cleaned = cleaned.slice(cleaned.search(/^#/m)).trim()
    }

    if (statusEl) statusEl.textContent = `✅ ${phaseLabel} generated for "${currentSpecName}"`
    if (textEl) textEl.innerHTML = renderMd(cleaned)
    // Open the output panel now that content is ready
    const outputEl = document.getElementById(specRespId + '-output')
    if (outputEl) outputEl.setAttribute('open', '')

    await window.app.specSaveArtifact(currentSpecDir, phase, cleaned)
    await window.app.specAdvance(currentSpecDir)
    updateAgentStatsBar({ state: 'done', activity: `Spec ${phaseLabel}: complete` })
    viewSpecArtifact(phase)
  }

  if (btn) { btn.classList.remove('generating') }
  specGenerating = false
  await refreshSpecStepper()
}

async function startSpecImplementation() {
  if (!currentSpecDir || !currentProject) return
  if (isGenerating) return
  const artifacts = await window.app.specArtifacts(currentSpecDir)
  if (!artifacts.tasks) { appendMsg('system', '⚠️ Generate tasks first.'); return }

  // Switch to agent tab
  switchMainTab('agent', document.querySelector('[data-tab="agent"]'))

  // Use the spec dir directly — works for .maccoder/specs/
  const tasksPath = currentSpecDir + '/tasks.md'
  try {
    await loadTaskGraph(tasksPath)
    renderSpecTaskProgress()
  } catch (e) { /* best-effort */ }

  // Show spec panel with task progress visible
  showPanel('tasks', document.querySelector('[data-panel="tasks"]'))

  // Count tasks for the summary
  const taskLines = artifacts.tasks.split('\n').filter(l => /^- \[[ x]\]/.test(l.trim()))
  const taskCount = taskLines.length

  // Show a clean formatted card in chat
  appendMsg('system', `📐 Starting implementation for "${currentSpecName}"...`)
  const out = document.getElementById('agentOutput')
  out.insertAdjacentHTML('beforeend', `<div class="msg-user">
    <div class="msg-user-label">Spec Implementation</div>
    <div style="margin:6px 0 4px;font-weight:600">📐 ${esc(currentSpecName)}</div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:6px">${taskCount} tasks · ${esc(currentProject)}</div>
    <details style="cursor:pointer">
      <summary style="font-size:11px;color:var(--accent2);user-select:none">View task list ▸</summary>
      <div style="font-size:11px;margin-top:6px;max-height:300px;overflow-y:auto;white-space:pre-wrap;color:var(--muted);font-family:'SF Mono',monospace">${esc(artifacts.tasks)}</div>
    </details>
  </div>`)
  scrollOutput()

  // Launch orchestrator directly — no chat agent intermediary
  _launchOrchestrator(tasksPath, taskCount)
}

async function loadSpecPanel() {
  if (!currentProject) return
  if (currentSpecDir) {
    document.getElementById('specCreate').style.display = 'none'
    document.getElementById('specActive').style.display = 'flex'
    document.getElementById('specNameLabel').textContent = currentSpecName || 'Spec'
    await refreshSpecStepper()
    // Load the task graph if this spec has tasks
    const specTasksPath = currentSpecDir + '/tasks.md'
    if (!currentTaskGraph || currentTasksPath !== specTasksPath) {
      try { await loadTaskGraph(specTasksPath) } catch (_) { /* tasks may not exist yet */ }
    }
  }
}

// 10.2 — /spec command handler (updated)
async function handleSpecCommand(args) {
  if (args) {
    if (!currentProject) { appendMsg('system', '⚠️ Open a project first.'); return }
    const result = await window.app.specInit(args, currentProject)
    if (result.error) { appendMsg('system', '❌ ' + result.error); return }
    currentSpecDir = result.specDir
    currentSpecName = result.featureName
    showInlineSpecWorkflow()
    appendMsg('system', `📐 Spec "${esc(args)}" initialized.`)
  } else {
    if (!currentSpecDir) { appendMsg('system', 'ℹ️ No spec active. Use /spec <name> to start one.'); return }
    showInlineSpecWorkflow()
    const phase = await window.app.specPhase(currentSpecDir)
    if (phase.error) { appendMsg('system', '❌ ' + phase.error); return }
    appendMsg('system', `📐 Current spec: "${currentSpecName}" — phase: ${phase}`)
  }
}

// ── search engine status ──────────────────────────────────────────────────────
async function checkSearchEngine() {
  if (!window.app.astSearchStatus) return
  const status = await window.app.astSearchStatus()
  if (status.error) return
  const el = document.getElementById('searchEngineStatus')
  const hint = document.getElementById('searchInstallHint')
  if (!el) return
  const label = status.backend === 'ast-grep'
    ? `🔍 ast-grep ${status.version || ''}${status.bundled ? ' (bundled)' : ''}`
    : status.backend === 'ripgrep' ? `🔍 ripgrep ${status.version || ''}`
    : '🔍 built-in (basic)'
  el.textContent = label
  el.style.color = status.backend === 'ast-grep' ? 'var(--green)' : status.backend === 'ripgrep' ? 'var(--yellow)' : 'var(--muted)'
  if (hint) hint.style.display = status.backend !== 'ast-grep' ? 'flex' : 'none'
}

// Hook into panel switching to load data
const _origShowPanel = typeof showPanel === 'function' ? showPanel : null
window._showPanelOrig = _origShowPanel


// ── slash command system ──────────────────────────────────────────────────────

// 10.1.1 — parseSlashCommand(input): returns { command, args } or null
function parseSlashCommand(input) {
  if (!input || !input.startsWith('/')) return null
  const trimmed = input.slice(1).trim()
  if (!trimmed) return null
  const spaceIdx = trimmed.indexOf(' ')
  if (spaceIdx === -1) return { command: trimmed.toLowerCase(), args: '' }
  return { command: trimmed.slice(0, spaceIdx).toLowerCase(), args: trimmed.slice(spaceIdx + 1).trim() }
}

// 10.1.2 — SLASH_COMMANDS Map with registered command handlers
const SLASH_COMMANDS = new Map([
  ['spec',   handleSpecCommand],
  ['search', handleSearchCommand],
  ['tasks',  handleTasksCommand],
  ['help',   handleHelpCommand],
])

// Command descriptions for help and autocomplete
const SLASH_COMMAND_INFO = [
  { command: 'spec',   description: 'Manage spec workflows — /spec <name> or /spec' },
  { command: 'search', description: 'AST code search — /search <pattern>' },
  { command: 'tasks',  description: 'Task graph control — /tasks [run|pause|resume]' },
  { command: 'help',   description: 'Show all available commands' },
]

// /spec handler is defined above in the spec workflow section

// 10.3 — /search command handler
async function handleSearchCommand(args) {
  if (!args) { appendMsg('system', '⚠️ Usage: /search <pattern>'); return }
  if (!currentProject) { appendMsg('system', '⚠️ Open a project first.'); return }
  appendMsg('system', `🔍 Searching for: ${esc(args)}...`)
  try {
    const results = await window.app.astSearch({ pattern: args }, currentProject)
    if (results.error) { appendMsg('system', '❌ ' + results.error); return }
    if (!results.length) { appendMsg('system', 'ℹ️ No matches found.'); return }
    // 10.3.1 & 10.3.2 — render results inline with clickable file links
    const out = document.getElementById('agentOutput')
    const html = results.slice(0, 20).map(r =>
      `<div class="search-result-item" onclick="openFile('${r.file.replace(/'/g, "\\'")}','${r.file.split('/').pop()}')" style="cursor:pointer">
        <span class="search-result-file">${esc(r.file)}</span>
        <span class="search-result-lines">:${r.startLine}–${r.endLine}</span>
        <pre class="search-result-snippet">${esc(r.snippet || '')}</pre>
      </div>`
    ).join('')
    out.insertAdjacentHTML('beforeend',
      `<div class="msg-system">🔍 ${results.length} result${results.length !== 1 ? 's' : ''} for "${esc(args)}"</div>
       <div class="search-results-block">${html}</div>`)
    scrollOutput()
  } catch (e) {
    appendMsg('system', '❌ Search error: ' + e.message)
  }
}

// 10.4 — /tasks command handler
async function handleTasksCommand(args) {
  const sub = args.toLowerCase()
  if (sub === 'run') {
    // 10.4.2 — /tasks run
    await taskGraphRun()
    appendMsg('system', '▶ Task graph execution started.')
  } else if (sub === 'pause') {
    // 10.4.3 — /tasks pause
    await taskGraphPause()
    appendMsg('system', '⏸ Task graph paused.')
  } else if (sub === 'resume') {
    // 10.4.3 — /tasks resume
    await taskGraphResume()
    appendMsg('system', '▶ Task graph resumed.')
  } else {
    // 10.4.1 — /tasks (no args): switch to tasks panel, show status
    showPanel('tasks', document.querySelector('[data-panel="tasks"]'))
    if (currentTaskGraph && currentTaskGraph.nodes) {
      const nodes = Object.values(currentTaskGraph.nodes)
      const completed = nodes.filter(n => n.status === 'completed').length
      const inProgress = nodes.filter(n => n.status === 'in_progress').length
      const failed = nodes.filter(n => n.status === 'failed').length
      const total = nodes.length
      appendMsg('system', `📋 Task graph: ${total} tasks — ${completed} completed, ${inProgress} in progress, ${failed} failed, ${total - completed - inProgress - failed} remaining`)
    } else {
      appendMsg('system', '📋 No task graph loaded. Open a Tasks.md file.')
    }
  }
}

// 10.6 — /help command handler
function handleHelpCommand() {
  const lines = SLASH_COMMAND_INFO.map(c => `  /${c.command} — ${c.description}`)
  appendMsg('system', `📖 Available commands:\n${lines.join('\n')}`)
}

// ── slash command autocomplete (Task 10.8) ────────────────────────────────────
function initSlashAutocomplete() {
  const input = document.getElementById('agentPrompt')
  const dropdown = document.getElementById('slashAutocomplete')
  if (!input || !dropdown) return

  input.addEventListener('input', () => {
    const val = input.value

    // When orchestrator is running, switch the send button between
    // "Stop" (empty input) and "Inject ↵" (text typed) so the user
    // knows typing will inject rather than stop.
    if (_orchestratorRunning) {
      const btn = document.getElementById('sendBtn')
      if (val.trim()) {
        btn.innerHTML = 'Inject ↵'
        btn.className = 'btn-send'
        btn.onclick = sendAgent
      } else {
        btn.innerHTML = '<span class="spinner"></span>Stop'
        btn.className = 'btn-send btn-stop'
        btn.onclick = () => { taskGraphAbort() }
      }
    }

    if (val.startsWith('/')) {
      const typed = val.slice(1).toLowerCase()
      const matches = SLASH_COMMAND_INFO.filter(c => c.command.startsWith(typed))
      if (matches.length > 0 && !val.includes(' ')) {
        showSlashAutocomplete(matches)
      } else {
        hideSlashAutocomplete()
      }
    } else {
      hideSlashAutocomplete()
    }
  })

  input.addEventListener('keydown', e => {
    if (!dropdown || dropdown.style.display === 'none') return
    const items = dropdown.querySelectorAll('.slash-ac-item')
    const activeItem = dropdown.querySelector('.slash-ac-item.active')
    let activeIdx = Array.from(items).indexOf(activeItem)

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      activeIdx = (activeIdx + 1) % items.length
      items.forEach(i => i.classList.remove('active'))
      items[activeIdx].classList.add('active')
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      activeIdx = activeIdx <= 0 ? items.length - 1 : activeIdx - 1
      items.forEach(i => i.classList.remove('active'))
      items[activeIdx].classList.add('active')
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      if (activeItem) {
        e.preventDefault()
        selectSlashCommand(activeItem.dataset.command)
      }
    } else if (e.key === 'Escape') {
      hideSlashAutocomplete()
    }
  })

  // Hide on blur (with slight delay so click events fire)
  input.addEventListener('blur', () => setTimeout(hideSlashAutocomplete, 150))
}

function showSlashAutocomplete(matches) {
  const dropdown = document.getElementById('slashAutocomplete')
  if (!dropdown) return
  dropdown.innerHTML = matches.map((c, i) =>
    `<div class="slash-ac-item${i === 0 ? ' active' : ''}" data-command="${c.command}" onclick="selectSlashCommand('${c.command}')">
      <span class="slash-ac-cmd">/${c.command}</span>
      <span class="slash-ac-desc">${c.description}</span>
    </div>`
  ).join('')
  dropdown.style.display = 'block'
}

function hideSlashAutocomplete() {
  const dropdown = document.getElementById('slashAutocomplete')
  if (dropdown) dropdown.style.display = 'none'
}

function selectSlashCommand(command) {
  const input = document.getElementById('agentPrompt')
  if (!input) return
  input.value = '/' + command + ' '
  input.focus()
  hideSlashAutocomplete()
}

// Initialize autocomplete on DOM ready
document.addEventListener('DOMContentLoaded', initSlashAutocomplete)

// ── Sliding-window tk/s estimator ────────────────────────────────────────────
// Tracks only actual generation timestamps in a rolling window so pauses
// (tool calls, prompt-eval waits) don't drag the rate down.
const _TksEstimator = {
  _window: 3000,   // ms — rolling window size
  _times: [],      // ring buffer of token arrival timestamps
  _serverSample: null, // last authoritative server-reported tps
  _serverTs: 0,        // when that sample arrived

  reset() {
    this._times = []
    this._serverSample = null
    this._serverTs = 0
  },

  // Call on every generated token (or chunk)
  tick() {
    const now = Date.now()
    this._times.push(now)
    // Evict entries older than the window
    const cutoff = now - this._window
    let i = 0
    while (i < this._times.length && this._times[i] < cutoff) i++
    if (i > 0) this._times = this._times.slice(i)
  },

  // Lock in a server-reported tps value (authoritative)
  setServer(tps) {
    if (tps && tps > 0) {
      this._serverSample = tps
      this._serverTs = Date.now()
    }
  },

  // Returns display string like "42.3" or null when not enough data
  rate() {
    // Server sample is authoritative for 5 s after it arrives
    if (this._serverSample && (Date.now() - this._serverTs) < 5000) {
      return this._serverSample.toFixed(1)
    }
    // Need at least 2 timestamps to compute a rate
    if (this._times.length < 2) return null
    const span = (this._times[this._times.length - 1] - this._times[0]) / 1000
    if (span <= 0) return null
    return ((this._times.length - 1) / span).toFixed(1)
  },
}

// ── unified agent stats bar (above text input) ───────────────────────────────
let _agentStartTimestamp = null  // when the current agent run started
let _statsElapsedTimer = null    // rAF loop id for the elapsed chip

// Tick the elapsed chip every second without rebuilding the whole bar
function _tickElapsedChip() {
  if (!_agentStartTimestamp) return
  const el = document.getElementById('statChipElapsed')
  if (el) el.textContent = _formatElapsed(Date.now() - _agentStartTimestamp)
  _statsElapsedTimer = setTimeout(_tickElapsedChip, 1000)
}

function _stopElapsedTicker() {
  if (_statsElapsedTimer) { clearTimeout(_statsElapsedTimer); _statsElapsedTimer = null }
}

function updateAgentStatsBar(opts = {}) {
  const bar = document.getElementById('agentStats')
  if (!bar) return

  const { state, inputTokens, outputTokens, tks, promptTps, peakMemory, toolName,
          progress, activity, toolCount, agentType } = opts

  // Hide when truly idle
  if (state === 'idle' && !inputTokens && !outputTokens) {
    bar.style.display = 'none'
    _agentStartTimestamp = null
    _stopElapsedTicker()
    _TksEstimator.reset()
    return
  }
  bar.style.display = 'flex'

  // Track when agent started and kick off elapsed ticker
  if (state === 'initializing') {
    _agentStartTimestamp = Date.now()
    _stopElapsedTicker()
    _tickElapsedChip()
  }

  // Feed the estimator: tick on every generating update, lock in server value when present
  if (state === 'generating') {
    if (tks && typeof tks === 'number') {
      _TksEstimator.setServer(tks)
    } else {
      _TksEstimator.tick()
    }
  }

  // Resolve display tps: prefer server-locked value, fall back to sliding window
  const resolvedTks = (tks && typeof tks === 'number') ? tks.toFixed(1) : _TksEstimator.rate()

  // State indicator chip
  const stateMap = {
    initializing: { icon: '⚡', text: 'Initializing', cls: '' },
    'prompt-eval':{ icon: '📊', text: 'Processing prompt', cls: 'thinking' },
    thinking:     { icon: '🧠', text: 'Thinking', cls: 'thinking' },
    generating:   { icon: '✍️', text: 'Generating', cls: 'generating' },
    processing:   { icon: '⚙️', text: 'Processing', cls: 'processing' },
    tool:         { icon: '🔧', text: toolName || 'Tool', cls: 'tool' },
    done:         { icon: '✅', text: 'Done', cls: 'done' },
  }
  const s = stateMap[state] || stateMap.done

  // ── In-place update: patch only chips that exist, rebuild only on structure change ──
  // We track a "shape key" — if the set of visible chips changes we do a full rebuild,
  // otherwise we just update the text nodes to avoid layout thrash and flicker.
  const modelName = loadedModelId ? _formatModelName(loadedModelId) : null
  const effectiveAgentType = agentType || _currentAgentType
  const showAgent = !!(effectiveAgentType && effectiveAgentType !== 'general' && state !== 'done')
  const showProgress = progress != null
  const totalTokens = (inputTokens || 0) + (outputTokens || 0)
  const showContext = totalTokens > 0
  const showTools = !!(toolCount != null && toolCount > 0)
  const showMemory = peakMemory != null
  const showElapsed = !!_agentStartTimestamp
  const showCompaction = !!(
    _lastCompactionStats && _lastCompactionStats.reduction_pct
  )

  const shapeKey = [
    modelName ? 1 : 0, showAgent ? 1 : 0, showProgress ? 1 : 0,
    showContext ? 1 : 0, showTools ? 1 : 0, showMemory ? 1 : 0,
    showElapsed ? 1 : 0, showCompaction ? 1 : 0,
    state === 'tool' ? toolName : '',  // tool name changes chip text
  ].join(',')

  const prevShape = bar.dataset.shapeKey

  if (prevShape !== shapeKey) {
    // Full rebuild — structure changed
    bar.dataset.shapeKey = shapeKey
    let html = ''

    if (modelName) {
      html += `<div class="stat-chip model-chip"><span class="stat-label">Model</span><span class="stat-val">${modelName}</span></div>`
    }

    html += `<div class="stat-chip state-chip ${s.cls}" id="statChipState"><span class="stat-label">Status</span><span class="stat-val">${s.icon} ${s.text}</span></div>`

    if (showAgent) {
      html += `<div class="stat-chip agent-type-chip"><span class="stat-label">Agent</span><span class="stat-val">🤖 ${effectiveAgentType}</span></div>`
    }

    if (showProgress) {
      const pct = progress < 0 ? '...' : Math.round(progress) + '%'
      const fillClass = progress < 0 ? 'indeterminate' : ''
      const fillWidth = progress < 0 ? '' : `width:${Math.min(100, progress)}%`
      html += `<div class="stat-chip progress-chip"><span class="stat-label">Prompt</span><span class="stat-val" id="statChipProgressVal">${pct}</span><div class="progress-mini"><div class="progress-mini-fill ${fillClass}" id="statChipProgressFill" style="${fillWidth}"></div></div></div>`
    }

    const tksDisplay = resolvedTks ? ' · ' + resolvedTks + ' tk/s' : ''
    html += `<div class="stat-chip"><span class="stat-label">Input</span><span class="stat-val" id="statChipInput">${inputTokens || 0} tok${promptTps != null ? ' · ' + promptTps + ' tk/s' : ''}</span></div>`
    html += `<div class="stat-chip accent"><span class="stat-label">Output</span><span class="stat-val" id="statChipOutput">${outputTokens || 0} tok${tksDisplay}</span></div>`

    if (showContext) {
      const ctxWindow = (_calibrationProfile && _calibrationProfile.maxInputTokens)
        ? _calibrationProfile.maxInputTokens : 84000
      const ctxPct = Math.min(100, Math.round((totalTokens / ctxWindow) * 100))
      const ctxCls = ctxPct >= 85 ? 'ctx-danger' : ctxPct >= 60 ? 'ctx-warn' : 'ctx-ok'
      const ctxTooltip = `${totalTokens.toLocaleString()} / ${ctxWindow.toLocaleString()} tokens (${ctxPct}% used)`
      html += `<div class="stat-chip context-chip ${ctxCls}" id="statChipCtx" title="${ctxTooltip}"><span class="stat-label">Context</span><span class="stat-val" id="statChipCtxVal">${_formatTokenCount(totalTokens)} / ${_formatTokenCount(ctxWindow)}</span><div class="progress-mini"><div class="progress-mini-fill" id="statChipCtxFill" style="width:${ctxPct}%"></div></div></div>`
    }

    if (showTools) {
      html += `<div class="stat-chip"><span class="stat-label">Tools</span><span class="stat-val" id="statChipTools">🔧 ${toolCount}</span></div>`
    }

    if (showMemory) {
      html += `<div class="stat-chip"><span class="stat-label">Peak VRAM</span><span class="stat-val" id="statChipMemory">${peakMemory} GB</span></div>`
    }

    if (showElapsed) {
      const elapsed = Date.now() - _agentStartTimestamp
      html += `<div class="stat-chip"><span class="stat-label">Elapsed</span><span class="stat-val" id="statChipElapsed">${_formatElapsed(elapsed)}</span></div>`
    }

    if (showCompaction) {
      const pct = Math.round(_lastCompactionStats.reduction_pct)
      const engine = _lastCompactionStats.engine || 'builtin'
      const engineCls = engine === 'python' ? 'compaction-python' : 'compaction-builtin'
      const engineIcon = engine === 'python' ? '🐍' : '⚡'
      const origTok = _lastCompactionStats.original_tokens || '?'
      const compTok = _lastCompactionStats.compressed_tokens || '?'
      const stages = (_lastCompactionStats.stages_applied && _lastCompactionStats.stages_applied.length)
        ? _lastCompactionStats.stages_applied.join(', ') : 'N/A'
      const tooltip = `Original: ${origTok} tokens\nCompressed: ${compTok} tokens\nReduction: ${pct}%\nEngine: ${engine}\nStages: ${stages}`
      html += `<div class="stat-chip ${engineCls}" title="${tooltip}"><span class="stat-label">Compaction</span><span class="stat-val">${engineIcon} ${pct}% ↓</span></div>`
    }

    if (activity) {
      html += `<div class="agent-activity-log" id="statChipActivity"><span class="activity-step active">${activity}</span></div>`
    }

    bar.innerHTML = html
  } else {
    // In-place patch — only update text nodes, no layout recalc
    const stateEl = document.getElementById('statChipState')
    if (stateEl) {
      stateEl.className = `stat-chip state-chip ${s.cls}`
      const v = stateEl.querySelector('.stat-val')
      if (v) v.textContent = `${s.icon} ${s.text}`
    }

    if (showProgress) {
      const pv = document.getElementById('statChipProgressVal')
      const pf = document.getElementById('statChipProgressFill')
      if (pv) pv.textContent = progress < 0 ? '...' : Math.round(progress) + '%'
      if (pf) {
        pf.className = `progress-mini-fill${progress < 0 ? ' indeterminate' : ''}`
        pf.style.width = progress < 0 ? '' : Math.min(100, progress) + '%'
      }
    }

    const inputEl = document.getElementById('statChipInput')
    if (inputEl) inputEl.textContent = `${inputTokens || 0} tok${promptTps != null ? ' · ' + promptTps + ' tk/s' : ''}`

    const outputEl = document.getElementById('statChipOutput')
    if (outputEl) {
      const tksDisplay = resolvedTks ? ' · ' + resolvedTks + ' tk/s' : ''
      outputEl.textContent = `${outputTokens || 0} tok${tksDisplay}`
    }

    if (showContext) {
      const ctxWindow = (_calibrationProfile && _calibrationProfile.maxInputTokens)
        ? _calibrationProfile.maxInputTokens : 84000
      const ctxPct = Math.min(100, Math.round((totalTokens / ctxWindow) * 100))
      const ctxCls = ctxPct >= 85 ? 'ctx-danger' : ctxPct >= 60 ? 'ctx-warn' : 'ctx-ok'
      const ctxChip = document.getElementById('statChipCtx')
      if (ctxChip) {
        ctxChip.className = `stat-chip context-chip ${ctxCls}`
        ctxChip.title = `${totalTokens.toLocaleString()} / ${ctxWindow.toLocaleString()} tokens (${ctxPct}% used)`
      }
      const ctxVal = document.getElementById('statChipCtxVal')
      if (ctxVal) ctxVal.textContent = `${_formatTokenCount(totalTokens)} / ${_formatTokenCount(ctxWindow)}`
      const ctxFill = document.getElementById('statChipCtxFill')
      if (ctxFill) ctxFill.style.width = ctxPct + '%'
    }

    if (showTools) {
      const toolsEl = document.getElementById('statChipTools')
      if (toolsEl) toolsEl.textContent = `🔧 ${toolCount}`
    }

    if (showMemory) {
      const memEl = document.getElementById('statChipMemory')
      if (memEl) memEl.textContent = `${peakMemory} GB`
    }

    const actEl = document.getElementById('statChipActivity')
    if (actEl && activity) actEl.innerHTML = `<span class="activity-step active">${activity}</span>`
  }
}

// Format token count for compact display (e.g. 84000 → "84K")
function _formatTokenCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K'
  return String(n)
}

// Format elapsed milliseconds as human-readable duration
function _formatElapsed(ms) {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return secs + 's'
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  if (mins < 60) return mins + 'm ' + (remSecs > 0 ? remSecs + 's' : '')
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return hrs + 'h ' + remMins + 'm'
}

// ── persistent bottom status bar — REMOVED ───────────────────────────────────
// All status info is now in the unified chip bar (updateAgentStatsBar).
// This is a no-op stub so existing calls don't break.
function updateStatusBar() {}

// (status bar init removed — all status in chip bar now)

// ── LSP status indicator ──────────────────────────────────────────────────────

function setLspStatus({ status, servers = [], errorMessage = null }) {
  const chip = document.getElementById('lspChip')
  const dot  = document.getElementById('lspDot')
  const txt  = document.getElementById('lspText')
  if (!chip) return

  currentLspStatus = status

  // Always show the chip — gray when stopped/unavailable
  chip.style.display = 'inline-flex'

  const colors = {
    ready:    'var(--green)',
    starting: '#f5a623',
    degraded: '#f5a623',
    error:    'var(--red)',
    stopped:  'var(--muted)',
  }
  dot.style.background = colors[status] || 'var(--muted)'

  const tooltips = {
    ready:    `LSP ready — ${servers.map(s => s.name).join(', ') || 'no language servers'}`,
    starting: 'LSP starting...',
    degraded: 'LSP degraded — no language servers found on PATH',
    error:    `LSP error — ${errorMessage || 'check logs'}`,
    stopped:  'LSP not available — install agent-lsp binary',
  }
  chip.title = tooltips[status] || 'LSP unknown'

  // Show/hide symbol panel based on LSP status
  const symbolPanel = document.getElementById('symbolPanel')
  if (symbolPanel) {
    symbolPanel.style.display = status === 'ready' ? 'flex' : 'none'
  }
  // If LSP just became ready and we have a file open, fetch symbols
  if (status === 'ready' && currentFile) {
    fetchAndRenderSymbols(currentFile)
  }
}

async function initLspStatus() {
  if (!window.app.lspStatus) return // IPC not wired yet
  try {
    const s = await window.app.lspStatus()
    setLspStatus(s)
  } catch { /* ignore */ }

  window.app.onLspStatusChange(({ oldStatus, newStatus }) => {
    // Re-fetch full status to get server list
    window.app.lspStatus().then(setLspStatus).catch(() => {})
  })

  // Listen for push diagnostics from the LSP server
  if (window.app.onLspDiagnostics) {
    window.app.onLspDiagnostics(({ path: filePath, diagnostics }) => {
      const errors = diagnostics.filter(d => d.severity === 'error' || d.severity === 1)
      const warnings = diagnostics.filter(d => d.severity === 'warning' || d.severity === 2)
      const statusLine = document.getElementById('statusLine')
      const lspDot = document.getElementById('lspDot')

      // Flash the LSP chip on diagnostic updates
      if (lspDot && (errors.length > 0 || warnings.length > 0)) {
        lspDot.style.background = errors.length > 0 ? 'var(--red)' : '#f5a623'
        lspDot.style.boxShadow = `0 0 6px ${errors.length > 0 ? 'var(--red)' : '#f5a623'}`
        setTimeout(() => {
          const colors = { ready: 'var(--green)', starting: '#f5a623', degraded: '#f5a623', error: 'var(--red)', stopped: 'var(--muted)' }
          lspDot.style.background = colors[currentLspStatus] || 'var(--muted)'
          lspDot.style.boxShadow = ''
        }, 2000)
      }

      // Update status line with diagnostic info
      if (statusLine && filePath) {
        const shortPath = filePath.split('/').slice(-2).join('/')
        if (errors.length > 0) {
          statusLine.textContent = `⚠️ LSP: ${shortPath} — ${errors.length} error${errors.length > 1 ? 's' : ''}${warnings.length > 0 ? `, ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : ''}`
        } else if (warnings.length > 0) {
          statusLine.textContent = `⚡ LSP: ${shortPath} — ${warnings.length} warning${warnings.length > 1 ? 's' : ''}`
        }
      }

      // Store diagnostics for popover display
      if (!window._lspDiagnosticsMap) window._lspDiagnosticsMap = new Map()
      if (errors.length > 0 || warnings.length > 0) {
        window._lspDiagnosticsMap.set(filePath, { errors, warnings })
      } else {
        window._lspDiagnosticsMap.delete(filePath)
      }
    })
  }

  // Wire click handler for LSP status popover
  const chip = document.getElementById('lspChip')
  if (chip) chip.addEventListener('click', toggleLspPopover)
}

// ── LSP status popover ────────────────────────────────────────────────────────

let _lspPopoverOpen = false

async function toggleLspPopover() {
  const chip = document.getElementById('lspChip')
  if (!chip) return

  // Close if already open
  const existing = document.querySelector('.lsp-popover')
  if (existing) {
    existing.remove()
    _lspPopoverOpen = false
    return
  }

  // Fetch current status
  let data = { status: currentLspStatus, servers: [] }
  try {
    if (window.app.lspStatus) data = await window.app.lspStatus()
  } catch { /* use defaults */ }

  // Build popover content
  const pop = document.createElement('div')
  pop.className = 'lsp-popover'

  const statusLabel = {
    ready: '🟢 Ready', starting: '🟡 Starting', degraded: '🟡 Degraded',
    error: '🔴 Error', stopped: '⚪ Stopped',
  }
  pop.innerHTML = `<div class="lsp-popover-header">LSP — ${statusLabel[data.status] || data.status}</div>`

  if (data.servers && data.servers.length > 0) {
    for (const srv of data.servers) {
      const langs = (srv.languages || []).join(', ') || 'unknown'
      pop.innerHTML += `<div class="lsp-popover-item"><div><div class="lsp-popover-name">${esc(srv.name)}</div><div class="lsp-popover-langs">${esc(langs)}</div></div></div>`
    }
  } else if (data.status === 'error' && data.errorMessage) {
    pop.innerHTML += `<div class="lsp-popover-empty" style="color:var(--red)">Error: ${esc(data.errorMessage)}</div>`
  } else {
    pop.innerHTML += '<div class="lsp-popover-empty">No language servers active</div>'
  }

  // Show active diagnostics in the popover
  if (window._lspDiagnosticsMap && window._lspDiagnosticsMap.size > 0) {
    pop.innerHTML += '<div class="lsp-popover-header" style="margin-top:4px">Diagnostics</div>'
    for (const [fp, { errors, warnings }] of window._lspDiagnosticsMap) {
      const shortPath = fp.split('/').slice(-2).join('/')
      const counts = []
      if (errors.length > 0) counts.push(`${errors.length} error${errors.length > 1 ? 's' : ''}`)
      if (warnings.length > 0) counts.push(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`)
      pop.innerHTML += `<div class="lsp-popover-item"><div><div class="lsp-popover-name" style="color:${errors.length > 0 ? 'var(--red)' : '#f5a623'}">${esc(shortPath)}</div><div class="lsp-popover-langs">${esc(counts.join(', '))}</div></div></div>`
    }
  }

  document.body.appendChild(pop)
  // Position fixed relative to the chip
  const rect = chip.getBoundingClientRect()
  pop.style.top = (rect.bottom + 6) + 'px'
  pop.style.right = (window.innerWidth - rect.right) + 'px'
  _lspPopoverOpen = true

  // Close on outside click (delayed so the current click doesn't immediately close it)
  setTimeout(() => {
    const onOutside = (e) => {
      if (!pop.contains(e.target) && !chip.contains(e.target)) {
        pop.remove()
        _lspPopoverOpen = false
        document.removeEventListener('click', onOutside)
      }
    }
    document.addEventListener('click', onOutside)
  }, 0)
}

// ── Calibration status chip ────────────────────────────────────────────────────

let _calibrationProfile = null
let _calPopoverOpen = false

function setCalibrationStatus(status, profile) {
  const chip = document.getElementById('calChip')
  const dot  = document.getElementById('calDot')
  const txt  = document.getElementById('calText')
  if (!chip) return

  chip.style.display = 'inline-flex'

  const colors = {
    calibrating:  '#f5a623',
    ready:        'var(--green)',
    unavailable:  'var(--muted)',
  }
  dot.style.background = colors[status] || 'var(--muted)'

  const labels = {
    calibrating:  'Calibrating',
    ready:        'Calibrated',
    unavailable:  'Uncalibrated',
  }
  txt.textContent = labels[status] || 'Cal'

  const tooltips = {
    calibrating:  'Calibration in progress...',
    ready:        'Model calibrated — click for details',
    unavailable:  'No calibration data — load a model to calibrate',
  }
  chip.title = tooltips[status] || 'Calibration'

  if (profile) _calibrationProfile = profile
  if (status === 'unavailable') _calibrationProfile = null
}

function toggleCalPopover() {
  const chip = document.getElementById('calChip')
  if (!chip) return

  const existing = document.querySelector('.cal-popover')
  if (existing) {
    existing.remove()
    _calPopoverOpen = false
    return
  }
  if (!_calibrationProfile) return

  _calPopoverOpen = true
  const pop = document.createElement('div')
  pop.className = 'cal-popover'

  const p = _calibrationProfile
  const m = p.metrics || {}

  let html = '<div class="cal-popover-header">Calibration Profile</div>'
  const rows = [
    ['Gen TPS',       m.generation_tps != null ? m.generation_tps + ' tk/s' : '—'],
    ['Prompt TPS',    m.prompt_tps != null ? m.prompt_tps + ' tk/s' : '—'],
    ['Max Turns',     p.maxTurns],
    ['Timeout/Turn',  (p.timeoutPerTurn / 1000).toFixed(0) + 's'],
    ['Max Input',     p.maxInputTokens != null ? p.maxInputTokens.toLocaleString() + ' tok' : '—'],
    ['Compaction @',  p.compactionThreshold != null ? p.compactionThreshold.toLocaleString() + ' tok' : '—'],
  ]
  for (const [label, value] of rows) {
    html += `<div class="cal-popover-row"><span class="cal-popover-label">${label}</span><span class="cal-popover-value">${value}</span></div>`
  }
  pop.innerHTML = html

  const rect = chip.getBoundingClientRect()
  pop.style.top = (rect.bottom + 4) + 'px'
  pop.style.right = (window.innerWidth - rect.right) + 'px'
  document.body.appendChild(pop)

  setTimeout(() => {
    const close = (e) => {
      if (!pop.contains(e.target) && !chip.contains(e.target)) {
        pop.remove()
        _calPopoverOpen = false
        document.removeEventListener('click', close)
      }
    }
    document.addEventListener('click', close)
  }, 0)
}

async function initCalibrationStatus() {
  if (!window.app || !window.app.calibrationStatus) return

  try {
    const s = await window.app.calibrationStatus()
    setCalibrationStatus(s.status, s.profile)
    if (s.profile) renderCalibrationDashboard(s.profile)
  } catch { /* ignore */ }

  if (window.app.onCalibrationComplete) {
    window.app.onCalibrationComplete(({ modelId, profile, fallback, fromCache }) => {
      if (profile) profile.fromCache = fromCache || false
      setCalibrationStatus('ready', profile)
      renderCalibrationDashboard(profile)
    })
  }

  if (window.app.onCalibrationStatus) {
    window.app.onCalibrationStatus(({ status }) => {
      setCalibrationStatus(status, null)
    })
  }

  const chip = document.getElementById('calChip')
  if (chip) chip.addEventListener('click', toggleCalPopover)
}

function renderCalibrationDashboard(profile) {
  const content = document.getElementById('calibrationContent')
  const empty = document.getElementById('calibrationEmpty')
  if (!content) return

  if (!profile) {
    if (empty) empty.style.display = 'flex'
    return
  }
  if (empty) empty.style.display = 'none'

  const m = profile.metrics || {}
  const currentMode = profile.mode || 'balanced'

  const benchmarkChips = [
    { label: 'Generation TPS', value: m.generation_tps != null ? m.generation_tps + ' tk/s' : '—', accent: true },
    { label: 'Prompt TPS',     value: m.prompt_tps != null ? m.prompt_tps + ' tk/s' : '—', accent: true },
    { label: 'Peak Memory',    value: m.peak_memory_gb != null ? m.peak_memory_gb + ' GB' : '—' },
    { label: 'Available Memory', value: m.available_memory_gb != null ? m.available_memory_gb + ' GB' : '—' },
    { label: 'Context Window', value: m.context_window != null ? m.context_window.toLocaleString() + ' tok' : '—' },
  ]

  const settingsChips = [
    { label: 'Max Turns',            value: profile.maxTurns },
    { label: 'Timeout / Turn',       value: (profile.timeoutPerTurn / 1000).toFixed(0) + 's' },
    { label: 'Max Input Tokens',     value: profile.maxInputTokens?.toLocaleString() + ' tok' },
    { label: 'Compaction Threshold', value: profile.compactionThreshold?.toLocaleString() + ' tok' },
    { label: 'Pool Timeout',         value: (profile.poolTimeout / 1000).toFixed(0) + 's' },
  ]

  // Memory pressure info
  const pressurePct = profile.memoryPressure != null ? (profile.memoryPressure * 100).toFixed(0) + '%' : '—'
  const scalePct = profile.memoryScale != null ? (profile.memoryScale * 100).toFixed(0) + '%' : '—'

  function chipHtml(chips) {
    return chips.map(c => {
      const cls = c.accent ? 'stat-chip accent' : 'stat-chip'
      return `<div class="${cls}"><span class="stat-label">${c.label}</span><span class="stat-val">${c.value}</span></div>`
    }).join('')
  }

  const modeButtons = ['stable', 'balanced', 'heavy'].map(mode => {
    const labels = { stable: '🛡 Stable', balanced: '⚖️ Balanced', heavy: '🔥 Heavy' }
    const descs = {
      stable: 'Conservative — respects memory pressure',
      balanced: 'Default — halves memory pressure penalty',
      heavy: 'Full context — ignores memory pressure',
    }
    const active = mode === currentMode ? 'background:var(--accent);color:#fff;' : 'opacity:0.6;'
    return `<button class="btn-sm" style="font-size:11px;${active}" onclick="calibrationSetMode('${mode}')" title="${descs[mode]}">${labels[mode]}</button>`
  }).join(' ')

  content.innerHTML = `
    <div class="calibration-section">
      <div class="calibration-section-title">Benchmark Results
        ${profile.fromCache ? '<span style="font-size:10px;color:var(--muted);font-weight:normal;margin-left:6px">cached</span>' : ''}
      </div>
      <div class="calibration-grid">${chipHtml(benchmarkChips)}</div>
    </div>
    <div class="calibration-section">
      <div class="calibration-section-title">Computed Settings</div>
      <div class="calibration-grid">${chipHtml(settingsChips)}</div>
      <div style="margin-top:6px;font-size:10px;color:var(--muted)">
        Memory pressure: ${pressurePct} · Context scale: ${scalePct}
      </div>
    </div>
    <div class="calibration-section" style="margin-top:8px">
      <div class="calibration-section-title">Performance Mode</div>
      <div style="display:flex;gap:6px;margin-top:4px">${modeButtons}</div>
    </div>
    <div style="margin-top:10px">
      <button class="btn-sm" onclick="recalibrateNow()" style="font-size:11px;opacity:0.7">🔄 Recalibrate (force fresh benchmark)</button>
    </div>
    <div style="margin-top:8px;padding:8px 10px;background:rgba(255,200,50,0.08);border-radius:6px;font-size:10px;color:var(--muted);line-height:1.5">
      💡 <strong>Tip:</strong> Close other heavy apps (Chrome, Xcode, Simulator) before recalibrating for higher limits.
      The calibrator measures available memory and adjusts context budgets accordingly.
      Switch to <strong>Heavy</strong> mode for maximum context when QwenCoder is your primary app.
    </div>
  `
}

function clearCalibrationUI() {
  setCalibrationStatus('unavailable', null)
  renderCalibrationDashboard(null)
}

async function recalibrateNow() {
  if (isGenerating) { showToast('Stop the agent first before recalibrating', 'warning'); return }
  if (!loadedModelId) { showToast('Load a model first', 'warning'); return }
  if (!confirm('This will run a fresh benchmark and overwrite the cached calibration for this model. Continue?')) return
  setCalibrationStatus('calibrating', null)
  try {
    await window.app.recalibrate(loadedModelId)
    showToast('Recalibration started — results will appear shortly', 'info')
  } catch (err) {
    showToast('Recalibration failed: ' + err.message, 'error')
  }
}

async function calibrationSetMode(mode) {
  if (!window.app.calibrationSetMode) return
  try {
    const profile = await window.app.calibrationSetMode(mode)
    if (profile && !profile.error) {
      renderCalibrationDashboard(profile)
      showToast(`Switched to ${mode} mode`, 'info')
    } else {
      showToast(profile?.error || 'Failed to switch mode', 'error')
    }
  } catch (err) {
    showToast('Mode switch failed: ' + err.message, 'error')
  }
}

// ── Symbol panel ──────────────────────────────────────────────────────────────

const SYMBOL_KIND_ICONS = {
  function: 'ƒ', class: 'C', variable: 'v', method: 'm',
  property: 'p', interface: 'I', enum: 'E', constant: 'K',
}

function symbolKindIcon(kind) {
  const k = (kind || '').toLowerCase()
  return SYMBOL_KIND_ICONS[k] || '•'
}

async function fetchAndRenderSymbols(filePath) {
  const list = document.getElementById('symbolList')
  if (!list) return
  if (!window.app.lspSymbols) { list.innerHTML = ''; return }
  try {
    const result = await window.app.lspSymbols(filePath)
    const symbols = result?.symbols || result || []
    if (!Array.isArray(symbols) || symbols.length === 0) {
      list.innerHTML = '<div class="symbol-empty">No symbols</div>'
      return
    }
    list.innerHTML = renderSymbolTree(symbols)
  } catch {
    list.innerHTML = '<div class="symbol-empty">Failed to load symbols</div>'
  }
}

function renderSymbolTree(symbols) {
  if (!symbols || !symbols.length) return ''
  return '<ul class="symbol-ul">' + symbols.map(s => {
    const icon = symbolKindIcon(s.kind)
    const line = s.line != null ? s.line : (s.range?.start?.line != null ? s.range.start.line : '')
    const lineDisplay = line !== '' ? line + 1 : '' // 0-indexed to 1-indexed
    const children = s.children?.length ? renderSymbolTree(s.children) : ''
    return `<li class="symbol-item" data-line="${line}">
      <div class="symbol-row" onclick="scrollEditorToLine(${line})">
        <span class="symbol-kind symbol-kind-${icon}">${icon}</span>
        <span class="symbol-name">${esc(s.name)}</span>
        ${lineDisplay ? `<span class="symbol-line">:${lineDisplay}</span>` : ''}
      </div>${children}</li>`
  }).join('') + '</ul>'
}

function scrollEditorToLine(line) {
  if (line == null || line === '') return
  const editor = document.getElementById('editorArea')
  if (!editor) return
  // Switch to editor tab if not already there
  const edTab = document.querySelector('[data-tab="editor"]')
  if (edTab && !edTab.classList.contains('active')) {
    switchMainTab('editor', edTab)
  }
  const text = editor.value
  const lines = text.split('\n')
  // Calculate character offset for the target line
  let charOffset = 0
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    charOffset += lines[i].length + 1
  }
  editor.focus()
  editor.setSelectionRange(charOffset, charOffset)
  // Scroll the textarea so the line is visible
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 19.2
  const targetScroll = Math.max(0, line * lineHeight - editor.clientHeight / 3)
  editor.scrollTop = targetScroll
}

// ── Tools panel ───────────────────────────────────────────────────────────────

const AVAILABLE_TOOLS = [
  // ── File System ──────────────────────────────────────────────────────────────
  { name: 'read_file',    icon: '📄', category: 'file',   desc: 'Read file contents. Supports start_line/end_line for large files.' },
  { name: 'write_file',  icon: '✏️', category: 'file',   desc: 'Create or overwrite a file. Auto-snapshots before-state for undo.' },
  { name: 'edit_file',   icon: '🔧', category: 'file',   desc: 'Surgical find-and-replace. Matches exact string, replaces once.' },
  { name: 'list_dir',    icon: '📂', category: 'file',   desc: 'List files and directories. Returns full recursive tree from project root.' },
  // ── Shell ────────────────────────────────────────────────────────────────────
  { name: 'bash',        icon: '⚡', category: 'shell',  desc: 'Execute a shell command. 30s timeout; 5min for installs/builds.' },
  // ── Search ───────────────────────────────────────────────────────────────────
  { name: 'search_files', icon: '🔍', category: 'search', desc: 'Grep for a regex pattern across files. Returns matching lines with paths and line numbers.' },
  { name: 'web_search',  icon: '🌍', category: 'search', desc: 'Search the web via Brave Search API. Returns titles, URLs, and snippets.' },
  { name: 'web_fetch',   icon: '🔗', category: 'search', desc: 'Fetch and extract text content from a URL. Summarized by fast model if large.' },
  // ── Agent Control ────────────────────────────────────────────────────────────
  { name: 'update_todos',  icon: '📋', category: 'agent', desc: 'Set or replace the full todo/progress list. Call at the start of a task.' },
  { name: 'edit_todos',    icon: '✅', category: 'agent', desc: 'Surgically add, update, or remove individual todo items.' },
  { name: 'task_complete', icon: '🏁', category: 'agent', desc: 'Signal task completion with a summary. Must be called when done.' },
  { name: 'ask_user',      icon: '💬', category: 'agent', desc: 'Ask the user a question and wait for their reply.' },
  { name: 'rewind_context',icon: '↩️', category: 'agent', desc: 'Retrieve original uncompressed content for a previously compressed tool result.' },
  // ── Browser Automation (Playwright) ─────────────────────────────────────────
  { name: 'browser_navigate',      icon: '🌐', category: 'browser', desc: 'Navigate to a URL. Returns page title and visible text.' },
  { name: 'browser_screenshot',    icon: '📸', category: 'browser', desc: 'Screenshot the page or element. Auto-described by fast vision model.' },
  { name: 'browser_click',         icon: '👆', category: 'browser', desc: 'Click an element by CSS selector.' },
  { name: 'browser_type',          icon: '⌨️', category: 'browser', desc: 'Type text into an input field.' },
  { name: 'browser_get_text',      icon: '📝', category: 'browser', desc: 'Extract visible text from the page or a specific element.' },
  { name: 'browser_get_html',      icon: '🏷️', category: 'browser', desc: 'Get the HTML source of the page or element.' },
  { name: 'browser_evaluate',      icon: '🧪', category: 'browser', desc: 'Execute JavaScript in the browser context.' },
  { name: 'browser_wait_for',      icon: '⏳', category: 'browser', desc: 'Wait for an element to appear or navigation to complete.' },
  { name: 'browser_select_option', icon: '☑️', category: 'browser', desc: 'Select an option from a dropdown.' },
  { name: 'browser_close',         icon: '🚪', category: 'browser', desc: 'Close the browser and free resources.' },
  // ── Xcode / iOS / Swift ──────────────────────────────────────────────────────
  { name: 'xcode_setup_project',       icon: '🚀', category: 'xcode', desc: 'Auto-discover and configure the Xcode project in one step. Validates xcode-select, finds project/scheme/simulator automatically. Call this first.' },
  { name: 'xcode_discover_projects',   icon: '🔎', category: 'xcode', desc: 'Scan a directory to find .xcodeproj and .xcworkspace files.' },
  { name: 'xcode_set_defaults',        icon: '⚙️', category: 'xcode', desc: 'Configure session: project path, scheme, simulator. Call before build/test.' },
  { name: 'xcode_show_defaults',       icon: '📋', category: 'xcode', desc: 'Show current session defaults (project, scheme, simulator).' },
  { name: 'xcode_list_schemes',        icon: '📑', category: 'xcode', desc: 'List all available schemes in the Xcode project.' },
  { name: 'xcode_list_simulators',     icon: '📱', category: 'xcode', desc: 'List available iOS simulators.' },
  { name: 'xcode_boot_simulator',      icon: '🚀', category: 'xcode', desc: 'Boot a simulator by name or UDID.' },
  { name: 'xcode_build_simulator',     icon: '🔨', category: 'xcode', desc: 'Compile Swift code for simulator. Returns structured errors with file/line. Auto-runs after .swift edits.' },
  { name: 'xcode_build_run_simulator', icon: '▶️', category: 'xcode', desc: 'Build, install, and launch on simulator in one step. Auto-captures UI snapshot after launch.' },
  { name: 'xcode_test',                icon: '🧪', category: 'xcode', desc: 'Run XCTest suite. Returns pass/fail per test with failure details.' },
  { name: 'xcode_clean',              icon: '🧹', category: 'xcode', desc: 'Clean build products.' },
  { name: 'xcode_get_build_settings', icon: '🔩', category: 'xcode', desc: 'Get build settings: BUNDLE_ID, SWIFT_VERSION, DEPLOYMENT_TARGET, etc.' },
  { name: 'xcode_snapshot_ui',        icon: '🗺️', category: 'xcode', desc: 'Capture full UI view hierarchy with element coordinates. Powered by AXe accessibility APIs.' },
  { name: 'xcode_screenshot_simulator',icon: '📸', category: 'xcode', desc: 'Take a simulator screenshot. Auto-described by fast vision model.' },
  { name: 'xcode_start_log_capture',  icon: '📡', category: 'xcode', desc: 'Start capturing app console logs from the simulator.' },
  { name: 'xcode_stop_log_capture',   icon: '📋', category: 'xcode', desc: 'Stop log capture and return all captured logs.' },
  { name: 'xcode_get_coverage_report',icon: '📊', category: 'xcode', desc: 'Per-target code coverage from a test run xcresult bundle.' },
  { name: 'xcode_get_file_coverage',  icon: '🎯', category: 'xcode', desc: 'Function-level coverage + uncovered line ranges for a specific Swift file.' },
  { name: 'xcode_get_bundle_id',      icon: '🏷️', category: 'xcode', desc: 'Extract bundle identifier from a built .app bundle.' },
  { name: 'xcode_get_app_path',       icon: '📍', category: 'xcode', desc: 'Get the path to the built .app in simulator derived data.' },
  { name: 'xcode_record_video',       icon: '🎬', category: 'xcode', desc: 'Record a video of the simulator screen.' },
]

function renderToolsPanel() {
  const grid = document.getElementById('toolsGrid')
  if (!grid) return

  const categoryOrder = ['file', 'shell', 'search', 'agent', 'browser', 'xcode']
  const labels = {
    file:    '📁 File System',
    shell:   '⚡ Shell',
    search:  '🔍 Search & Web',
    agent:   '🤖 Agent Control',
    browser: '🌐 Browser Automation (Playwright)',
    xcode:   '🍎 Xcode / iOS / Swift (XcodeBuildMCP)',
  }
  const groups = {}
  for (const cat of categoryOrder) groups[cat] = []
  for (const t of AVAILABLE_TOOLS) {
    if (groups[t.category]) groups[t.category].push(t)
  }

  let html = ''
  for (const cat of categoryOrder) {
    const tools = groups[cat]
    if (tools.length === 0) continue
    html += `<div class="tools-section-label" style="grid-column:1/-1">${labels[cat]}</div>`
    for (const t of tools) {
      html += `<div class="tool-card">
        <div class="tool-card-header">
          <span class="tool-card-icon">${t.icon}</span>
          <span class="tool-card-name">${t.name}</span>
          <span class="tool-card-badge ${t.category}">${t.category}</span>
        </div>
        <div class="tool-card-desc">${t.desc}</div>
      </div>`
    }
  }

  grid.innerHTML = html
}

// Render on load
document.addEventListener('DOMContentLoaded', () => { renderToolsPanel() })

// ── Steering docs ─────────────────────────────────────────────────────────────

async function refreshSteeringDocs() {
  const statusEl = document.getElementById('steeringStatus')
  const listEl = document.getElementById('steeringDocList')
  if (!listEl) return

  if (!currentProject) {
    if (statusEl) statusEl.textContent = 'No project open'
    listEl.innerHTML = '<div class="model-empty" style="font-size:10px">Open a project first</div>'
    return
  }

  try {
    const result = await window.app.steeringList()
    const docs = result.docs || []

    if (statusEl) {
      statusEl.textContent = docs.length > 0 ? `${docs.length} doc${docs.length > 1 ? 's' : ''} loaded` : 'No docs'
      statusEl.style.color = docs.length > 0 ? 'var(--green)' : 'var(--muted)'
    }

    if (docs.length === 0) {
      listEl.innerHTML = '<div class="model-empty" style="font-size:10px">No steering docs found. Create one to customize agent behavior.</div>'
      return
    }

    let html = ''
    for (const doc of docs) {
      const badge = doc.autoGenerated ? '<span style="font-size:9px;color:var(--muted);margin-left:4px">auto</span>' : ''
      html += `<div class="steering-doc-item" style="padding:4px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:11px;font-weight:500;color:var(--text)">${esc(doc.name)}${badge}</div>
        ${doc.description ? `<div style="font-size:10px;color:var(--muted)">${esc(doc.description)}</div>` : ''}
      </div>`
    }
    listEl.innerHTML = html
  } catch (err) {
    if (statusEl) { statusEl.textContent = 'Error'; statusEl.style.color = 'var(--red)' }
    listEl.innerHTML = `<div class="model-empty" style="font-size:10px;color:var(--red)">Failed to load: ${esc(err.message)}</div>`
  }
}

async function createSteeringDoc() {
  if (!currentProject) {
    appendMsg('system', '📁 Open a project first to create steering docs.')
    return
  }

  const name = prompt('Steering doc name (e.g. "coding-standards"):')
  if (!name) return

  const description = prompt('Short description (optional):') || ''

  try {
    const result = await window.app.steeringCreate({
      name,
      description,
      body: `# ${name}\n\nAdd your project-specific instructions here. The agent will include this context in every conversation.\n`,
    })
    if (result.error) {
      appendMsg('system', `⚠️ Failed to create steering doc: ${result.error}`)
    } else {
      appendMsg('system', `📝 Created steering doc: ${name}`)
      refreshSteeringDocs()
      // Open the file in the editor if possible
      if (result.path && window.app.readFile) {
        const content = await window.app.readFile(result.path)
        if (content !== null) {
          document.getElementById('editorArea').value = content
          document.getElementById('editorFileName').textContent = result.path.split('/').pop()
          document.getElementById('saveBtn').style.display = ''
        }
      }
    }
  } catch (err) {
    appendMsg('system', `⚠️ Error creating steering doc: ${err.message}`)
  }
}

// Refresh steering docs when project changes
const _origSwitchProject = typeof switchProject === 'function' ? switchProject : null

// ── Extraction Model UI ───────────────────────────────────────────────────────

let _extractionModelStatus = null  // { loaded: bool, modelName: string|null, memoryGb: number|null }
let _extractionModelList = []      // Available models for extraction

/**
 * Refresh extraction model status from the memory backend.
 */
async function refreshExtractionModelStatus() {
  try {
    const status = await window.app.getMemoryStatus()
    if (status && status.extractionModel) {
      _extractionModelStatus = {
        loaded: true,
        modelName: status.extractionModel,
        memoryGb: status.extractionModelMemoryGb || null,
      }
    } else {
      _extractionModelStatus = { loaded: false, modelName: null, memoryGb: null }
    }
    _renderExtractionModelSection()
  } catch (_) {
    _extractionModelStatus = { loaded: false, modelName: null, memoryGb: null }
    _renderExtractionModelSection()
  }
}

/**
 * Render the Fast Vision Assistant bar and dropdown list.
 */
function _renderExtractionModelSection() {
  const nameEl = document.getElementById('fastModelName')
  const list = document.getElementById('fastModelList')
  if (!nameEl || !list) return

  const status = _extractionModelStatus
  const isLoaded = status && status.loaded

  // Update the bar display
  if (isLoaded) {
    const displayName = _formatModelName(status.modelName || 'Unknown')
    nameEl.textContent = displayName + (status.memoryGb ? ` · ${status.memoryGb.toFixed(1)}GB` : '')
    nameEl.classList.add('active')
  } else {
    nameEl.textContent = 'Not loaded'
    nameEl.classList.remove('active')
  }

  // Build the dropdown list
  let html = ''
  if (_extractionModelList.length > 0) {
    html = _extractionModelList.map((m, i) => {
      const name = _formatModelName(m.id)
      const isActive = isLoaded && status.modelName && (status.modelName === m.id || status.modelName.includes(m.id.split('-').pop()))
      const cls = isActive ? 'fm-item active' : 'fm-item'
      return `<div class="${cls}" data-fm-idx="${i}">
        <div class="fm-item-icon">${m.vision ? '👁️' : '⚡'}</div>
        <div class="fm-item-info">
          <div class="fm-item-name">${esc(name)}</div>
          <div class="fm-item-path">${esc(m.model_type || '')}</div>
        </div>
        ${isActive ? '<div class="fm-item-check">✓</div>' : ''}
      </div>`
    }).join('')
  } else {
    html = '<div style="padding:12px;text-align:center;color:var(--muted);font-size:11px">No small models found</div>'
  }

  // Add unload option if loaded
  if (isLoaded) {
    html += '<div class="fm-unload" onclick="unloadExtractionModel()">⏹ Unload Fast Assistant</div>'
  }

  list.innerHTML = html

  // Event delegation for model selection
  list.onclick = (e) => {
    const item = e.target.closest('[data-fm-idx]')
    if (!item) return
    const idx = parseInt(item.dataset.fmIdx, 10)
    const m = _extractionModelList[idx]
    if (m) loadExtractionModelFromSwitcher(m.path, m.id)
  }
}

/**
 * Toggle the fast model dropdown.
 */
function toggleFastModelSwitcher() {
  const bar = document.getElementById('fastModelBar')
  let dd = document.getElementById('fastModelDropdown')
  if (!bar || !dd) return

  const isOpen = dd.style.display === 'flex'
  if (isOpen) {
    dd.style.display = 'none'
    bar.classList.remove('open')
    return
  }

  // Move to body on first open to escape overflow:hidden
  if (dd.parentNode !== document.body) {
    dd.parentNode.removeChild(dd)
    document.body.appendChild(dd)
  }

  // Position below the fast model button
  const btn = document.getElementById('fastModelBtn')
  if (!btn) return
  const rect = btn.getBoundingClientRect()
  dd.style.position = 'fixed'
  dd.style.top = Math.round(rect.bottom + 4) + 'px'
  dd.style.left = Math.round(rect.left) + 'px'
  dd.style.width = Math.max(rect.width, 280) + 'px'
  dd.style.display = 'flex'
  dd.style.flexDirection = 'column'
  bar.classList.add('open')

  function closer(e) {
    if (dd.contains(e.target) || bar.contains(e.target)) return
    dd.style.display = 'none'
    bar.classList.remove('open')
    document.removeEventListener('mousedown', closer, true)
  }
  requestAnimationFrame(() => {
    document.addEventListener('mousedown', closer, true)
  })
}

/**
 * Load a fast model from the switcher dropdown.
 */
async function loadExtractionModelFromSwitcher(modelPath, modelId) {
  const nameEl = document.getElementById('fastModelName')
  const prevText = nameEl ? nameEl.textContent : ''
  if (nameEl) {
    nameEl.textContent = 'Loading ' + _formatModelName(modelId) + '...'
    nameEl.classList.remove('active')
  }
  // Close dropdown
  const dd = document.getElementById('fastModelDropdown')
  if (dd) dd.style.display = 'none'
  const bar = document.getElementById('fastModelBar')
  if (bar) bar.classList.remove('open')

  try {
    const result = await window.app.loadExtractionModel(modelPath)
    if (result && result.error) {
      showToast('Failed to load: ' + result.error, 'error')
      if (nameEl) nameEl.textContent = prevText
    } else {
      showToast('Fast Assistant loaded', 'success')
      window.app.saveAppSettings({ lastFastModelPath: modelPath })
      await refreshExtractionModelStatus()
    }
  } catch (err) {
    showToast('Failed to load: ' + (err.message || 'Unknown error'), 'error')
    if (nameEl) nameEl.textContent = prevText
  }
}

/**
 * Load the selected extraction model.
 */
async function loadExtractionModel() {
  const select = document.getElementById('extractionModelSelect')
  if (!select || !select.value) {
    showToast('Select a model first', 'warning')
    return
  }
  const modelPath = select.value
  try {
    const result = await window.app.loadExtractionModel(modelPath)
    if (result && result.error) {
      showToast(`Failed to load extraction model: ${result.error}`, 'error')
    } else {
      showToast('Extraction model loaded', 'success')
      // Persist as the preferred fast model for next startup
      window.app.saveAppSettings({ lastFastModelPath: modelPath })
      await refreshExtractionModelStatus()
    }
  } catch (err) {
    showToast(`Failed to load extraction model: ${err.message || 'Unknown error'}`, 'error')
  }
}

/**
 * Unload the extraction model.
 */
async function unloadExtractionModel() {
  try {
    await window.app.unloadExtractionModel()
    showToast('Extraction model unloaded', 'info')
    await refreshExtractionModelStatus()
  } catch (err) {
    showToast(`Failed to unload extraction model: ${err.message || 'Unknown error'}`, 'error')
  }
}

/**
 * Populate the extraction model dropdown with available models.
 * Called when the models panel is shown.
 */
function populateExtractionModelList(models) {
  // Filter to models <= 8B where possible (heuristic: name contains 4B, 7B, 8B, 3B, 1B, 2B)
  const smallModels = models.filter(m => /[1-8][Bb]/.test(m.id))
  _extractionModelList = smallModels.length > 0 ? smallModels : models
  _renderExtractionModelSection()
}

// ── Agent Roles Tab ───────────────────────────────────────────────────────────

const ALL_TOOLS = [
  // File
  'read_file', 'write_file', 'edit_file', 'list_dir',
  // Shell & Search
  'bash', 'search_files', 'web_search', 'web_fetch',
  // Agent control
  'update_todos', 'edit_todos', 'task_complete', 'ask_user', 'rewind_context',
  // Browser (Playwright)
  'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type',
  'browser_get_text', 'browser_get_html', 'browser_evaluate', 'browser_wait_for',
  'browser_select_option', 'browser_close',
  // Xcode / iOS / Swift
  'xcode_setup_project', 'xcode_discover_projects', 'xcode_set_defaults', 'xcode_show_defaults',
  'xcode_list_schemes', 'xcode_list_simulators', 'xcode_boot_simulator',
  'xcode_build_simulator', 'xcode_build_run_simulator', 'xcode_test', 'xcode_clean',
  'xcode_get_build_settings', 'xcode_snapshot_ui', 'xcode_screenshot_simulator',
  'xcode_start_log_capture', 'xcode_stop_log_capture',
  'xcode_get_coverage_report', 'xcode_get_file_coverage',
  'xcode_get_bundle_id', 'xcode_get_app_path', 'xcode_record_video',
]

let _agentRoles = []
let _selectedRoleName = null
let _isNewRole = false

async function loadAgentRoles() {
  if (!window.app?.agentRolesList) return
  const res = await window.app.agentRolesList()
  _agentRoles = res.roles || []
  renderAgentRoleList()
  populateRoleDropdown()
}

function populateRoleDropdown() {
  const sel = document.getElementById('roleSelect')
  if (!sel) return
  const current = sel.value
  sel.innerHTML = ''
  for (const role of _agentRoles) {
    const opt = document.createElement('option')
    opt.value = role.name
    // Use stored icon for custom roles, fall back to ROLE_ICONS for builtins
    const icon = role.icon || ROLE_ICONS[role.name] || '🤖'
    const label = role.name.charAt(0).toUpperCase() + role.name.slice(1).replace(/-/g, ' ')
    opt.textContent = icon + ' ' + label
    sel.appendChild(opt)
  }
  // Restore previous selection if still valid, else default to general
  if ([...sel.options].some(o => o.value === current)) {
    sel.value = current
  } else {
    sel.value = 'general'
  }
}

function renderAgentRoleList() {
  const list = document.getElementById('agentRoleList')
  if (!list) return
  list.innerHTML = ''
  for (const role of _agentRoles) {
    const card = document.createElement('div')
    card.className = 'agent-role-card' + (role.builtin ? ' builtin' : '') + (role.name === _selectedRoleName ? ' active' : '')
    card.innerHTML = `<span class="agent-role-icon">${role.icon || '🤖'}</span><div class="agent-role-info"><div class="agent-role-name">${role.name}</div><div class="agent-role-tag">${role.builtin ? 'built-in' : 'custom'}</div></div>`
    card.onclick = () => agentRoleSelect(role.name)
    list.appendChild(card)
  }
}

function agentRoleSelect(name) {
  _selectedRoleName = name
  _isNewRole = false
  const role = _agentRoles.find(r => r.name === name)
  if (!role) return
  renderAgentRoleList()
  const editor = document.getElementById('agentRoleEditor')
  editor.style.display = 'flex'
  editor.style.flexDirection = 'column'
  document.getElementById('agentRoleEditorTitle').textContent = `${role.icon || '🤖'} ${role.name}`
  document.getElementById('agentRoleIcon').value = role.icon || ''
  document.getElementById('agentRoleName').value = role.name
  document.getElementById('agentRoleDesc').value = role.description || ''
  document.getElementById('agentRoleKeywords').value = role.keywords || ''
  document.getElementById('agentRolePrompt').value = role.prompt || ''
  document.getElementById('agentDeleteBtn').style.display = role.builtin ? 'none' : ''
  renderToolsGrid(role.tools || [])
}

function agentRoleNew() {
  _selectedRoleName = null
  _isNewRole = true
  renderAgentRoleList()
  const editor = document.getElementById('agentRoleEditor')
  editor.style.display = 'flex'
  editor.style.flexDirection = 'column'
  document.getElementById('agentRoleEditorTitle').textContent = 'New Role'
  document.getElementById('agentRoleIcon').value = '🤖'
  document.getElementById('agentRoleName').value = ''
  document.getElementById('agentRoleDesc').value = ''
  document.getElementById('agentRoleKeywords').value = ''
  document.getElementById('agentRolePrompt').value = ''
  document.getElementById('agentDeleteBtn').style.display = 'none'
  renderToolsGrid([])
}

function renderToolsGrid(selectedTools) {
  const grid = document.getElementById('agentRoleToolsGrid')
  if (!grid) return
  grid.innerHTML = ''

  const groups = [
    { label: '📁 File', tools: ['read_file','read_files','write_file','edit_file','edit_files','list_dir'] },
    { label: '⚡ Shell & Search', tools: ['bash','search_files','web_search','web_fetch'] },
    { label: '🤖 Agent', tools: ['update_todos','edit_todos','task_complete','ask_user','rewind_context'] },
    { label: '🌐 Browser', tools: ['browser_navigate','browser_screenshot','browser_click','browser_type','browser_get_text','browser_get_html','browser_evaluate','browser_wait_for','browser_select_option','browser_close'] },
    { label: '🍎 Xcode / Swift', tools: ['xcode_setup_project','xcode_discover_projects','xcode_set_defaults','xcode_show_defaults','xcode_list_schemes','xcode_list_simulators','xcode_boot_simulator','xcode_build_simulator','xcode_build_run_simulator','xcode_test','xcode_clean','xcode_get_build_settings','xcode_snapshot_ui','xcode_screenshot_simulator','xcode_start_log_capture','xcode_stop_log_capture','xcode_get_coverage_report','xcode_get_file_coverage','xcode_get_bundle_id','xcode_get_app_path','xcode_record_video'] },
  ]

  for (const group of groups) {
    const label = document.createElement('div')
    label.style.cssText = 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);padding:6px 0 3px;width:100%;'
    label.textContent = group.label
    grid.appendChild(label)

    const row = document.createElement('div')
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;'
    for (const tool of group.tools) {
      const chip = document.createElement('span')
      chip.className = 'agent-tool-chip' + (selectedTools.includes(tool) ? ' selected' : '')
      chip.textContent = tool
      chip.onclick = () => chip.classList.toggle('selected')
      row.appendChild(chip)
    }
    grid.appendChild(row)
  }
}

function getSelectedTools() {
  return [...document.querySelectorAll('#agentRoleToolsGrid .agent-tool-chip.selected')].map(c => c.textContent)
}

async function agentRoleSave() {
  const name = document.getElementById('agentRoleName').value.trim()
  if (!name) { alert('Role name is required'); return }
  const role = {
    name,
    icon: document.getElementById('agentRoleIcon').value.trim() || '🤖',
    description: document.getElementById('agentRoleDesc').value.trim(),
    keywords: document.getElementById('agentRoleKeywords').value.trim(),
    prompt: document.getElementById('agentRolePrompt').value.trim(),
    tools: getSelectedTools(),
    builtin: false,
  }
  const res = await window.app.agentRoleSave(role)
  if (res.error) { alert('Save failed: ' + res.error); return }
  _selectedRoleName = name
  await loadAgentRoles()
  agentRoleSelect(name)
}

async function agentRoleDelete() {
  if (!_selectedRoleName) return
  if (!confirm(`Delete role "${_selectedRoleName}"?`)) return
  await window.app.agentRoleDelete(_selectedRoleName)
  _selectedRoleName = null
  document.getElementById('agentRoleEditor').style.display = 'none'
  await loadAgentRoles()
}

async function agentRoleGenerate() {
  const name = document.getElementById('agentRoleName').value.trim()
  const description = document.getElementById('agentRoleDesc').value.trim()
  if (!name && !description) { alert('Enter a name and description first'); return }
  const btn = document.getElementById('agentGenerateBtn')
  const status = document.getElementById('agentGenerateStatus')
  btn.disabled = true
  btn.textContent = '⏳ Generating...'
  status.style.display = 'block'
  status.textContent = isGenerating
    ? '⏳ Agent is running — queued, will generate when it finishes...'
    : 'Asking the model to generate prompt and tools...'
  try {
    const res = await window.app.agentRoleGenerate({
      name: name || 'custom',
      description,
      existingPrompt: document.getElementById('agentRolePrompt').value.trim(),
    })
    if (res.error) { status.textContent = '❌ ' + res.error; return }
    if (res.prompt) document.getElementById('agentRolePrompt').value = res.prompt
    if (res.keywords) document.getElementById('agentRoleKeywords').value = res.keywords
    if (res.tools) renderToolsGrid(res.tools)
    status.textContent = '✅ Generated — review and save'
  } catch (err) {
    status.textContent = '❌ ' + err.message
  } finally {
    btn.disabled = false
    btn.textContent = '✨ Generate'
  }
}

// Load roles when the Agents tab is opened — hooked into switchMainTab above

// ── Memory Bank Tab ───────────────────────────────────────────────────────────

let _memoryLoaded = false

/**
 * Get the active project's directory basename for memory scoping.
 * Returns null when no project is open (shows global memory).
 */
function _memProjectId() {
  if (!currentProject) return null
  return currentProject.split('/').pop() || null
}

/**
 * Format a UTC timestamp string into a short human-readable form.
 */
function _memFmtTime(ts) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    const now = new Date()
    const diffMs = now - d
    if (diffMs < 60000) return 'just now'
    if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago'
    if (diffMs < 86400000) return Math.floor(diffMs / 3600000) + 'h ago'
    return d.toLocaleDateString()
  } catch { return '' }
}

/**
 * Format bytes into a human-readable size string.
 */
function _memFmtBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

/**
 * Render agent thinking notes into the notes panel.
 * Called both from live qwen-events and on memoryRefresh.
 */
function _memRenderNotes(notes, turn) {
  const body = document.getElementById('memoryNotesBody')
  const meta = document.getElementById('memoryNotesMeta')
  const badge = document.getElementById('memoryNotesBadge')
  if (!body) return
  if (!notes || !notes.trim()) {
    body.innerHTML = '<div class="memory-empty">No notes yet — the agent will write here when it calls agent_notes()</div>'
    body.classList.remove('has-notes')
    if (meta) meta.textContent = ''
    if (badge) badge.style.display = 'none'
    return
  }
  // Escape HTML but preserve newlines
  const escaped = notes.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  body.textContent = notes  // use textContent — pre-wrap handles newlines
  body.classList.add('has-notes')
  if (meta) meta.textContent = turn != null ? `Turn ${turn} · ${notes.length} chars` : `${notes.length} chars`
  if (badge) {
    badge.style.display = ''
    // Fade badge after 4s to indicate it's no longer actively updating
    clearTimeout(badge._fadeTimer)
    badge._fadeTimer = setTimeout(() => { badge.style.display = 'none' }, 4000)
  }
}

/**
 * Render a list of archive events into the feed element.
 */
function _memRenderFeed(events) {
  const feed = document.getElementById('memoryFeed')
  if (!feed) return
  if (!events || events.length === 0) {
    feed.innerHTML = '<div class="memory-empty">No archive events found</div>'
    return
  }
  feed.innerHTML = events.map(ev => {
    const type = ev.event_type || ev.type || 'unknown'
    const summary = ev.summary || (typeof ev.payload === 'string' ? ev.payload.slice(0, 120) : JSON.stringify(ev.payload || '').slice(0, 120))
    const agent = ev.agent_name ? `<span class="memory-event-agent">${ev.agent_name}</span>` : ''
    const time = _memFmtTime(ev.timestamp)
    return `<div class="memory-event">
      <div class="memory-event-header">
        <span class="memory-event-type ${type}">${type.replace(/_/g, ' ')}</span>
        ${agent}
        <span class="memory-event-time">${time}</span>
      </div>
      <div class="memory-event-summary" title="${(summary || '').replace(/"/g, '&quot;')}">${summary || '—'}</div>
    </div>`
  }).join('')
}

/**
 * Render KG triples into the results panel.
 */
function _memRenderTriples(triples) {
  const el = document.getElementById('memoryKgResults')
  if (!el) return
  if (!triples || triples.length === 0) {
    el.innerHTML = '<div class="memory-empty">No triples found for this entity</div>'
    return
  }
  el.innerHTML = triples.map(t => {
    const validUntil = t.valid_until ? `<div class="memory-triple-time">valid until ${_memFmtTime(t.valid_until)}</div>` : ''
    return `<div class="memory-triple">
      <span class="memory-triple-subject">${t.subject || '?'}</span>
      <span class="memory-triple-predicate">${t.predicate || '?'}</span>
      <span class="memory-triple-object">${t.object || '?'}</span>
      ${validUntil}
    </div>`
  }).join('')
}

/**
 * Load and render memory stats + recent archive events.
 */
async function memoryRefresh() {
  if (!window.app) return
  const btn = document.getElementById('memoryRefreshBtn')
  if (btn) btn.textContent = '…'
  const pid = _memProjectId()

  // Update subtitle to show scope
  const subtitle = document.getElementById('memorySubtitle')
  if (subtitle) {
    subtitle.textContent = pid
      ? `Project: ${pid} — archive, knowledge graph, and retrieval stats`
      : 'Global — session archive, knowledge graph, and retrieval stats'
  }
  try {
    // Stats
    if (window.app.memoryStats) {
      const stats = await window.app.memoryStats(pid)
      if (stats) {
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val }
        set('memStatTriplesVal', (stats.kg_triples ?? '—').toLocaleString())
        set('memStatVectorsVal', (stats.vector_count ?? '—').toLocaleString())
        set('memStatArchiveVal', (stats.archive_events ?? '—').toLocaleString())
        set('memStatSizeVal', stats.archive_size_bytes != null ? _memFmtBytes(stats.archive_size_bytes) : '—')
      }
    }

    // Recent events
    if (window.app.memoryArchiveEvents) {
      const events = await window.app.memoryArchiveEvents(100, pid)
      _memRenderFeed(events)
    }
  } catch (err) {
    const feed = document.getElementById('memoryFeed')
    if (feed) feed.innerHTML = `<div class="memory-empty">Memory backend unavailable — load a model to enable memory</div>`
  } finally {
    if (btn) btn.textContent = '↻ Refresh'
    _memoryLoaded = true
  }
}

/**
 * Search the archive by keyword.
 */
let _memSearchTimer = null
function memorySearch(query) {
  clearTimeout(_memSearchTimer)
  _memSearchTimer = setTimeout(async () => {
    if (!window.app || !window.app.memoryArchiveSearch) return
    const pid = _memProjectId()
    try {
      if (!query || query.trim().length < 2) {
        // Empty search — reload recent events
        const events = await window.app.memoryArchiveEvents(100, pid)
        _memRenderFeed(events)
        return
      }
      const results = await window.app.memoryArchiveSearch(query.trim(), 50, pid)
      _memRenderFeed(results)
    } catch (_) {}
  }, 300)
}

/**
 * Query the knowledge graph for an entity.
 */
async function memoryKgQuery() {
  const input = document.getElementById('memoryKgInput')
  const entity = input?.value?.trim()
  if (!entity || !window.app || !window.app.memoryKgQuery) return
  const el = document.getElementById('memoryKgResults')
  if (el) el.innerHTML = '<div class="memory-empty">Querying…</div>'
  try {
    const triples = await window.app.memoryKgQuery(entity)
    _memRenderTriples(triples)
  } catch (_) {
    if (el) el.innerHTML = '<div class="memory-empty">Query failed — memory backend may be unavailable</div>'
  }
}

// Allow Enter key in KG input to trigger query
document.addEventListener('DOMContentLoaded', () => {
  const kgInput = document.getElementById('memoryKgInput')
  if (kgInput) {
    kgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') memoryKgQuery()
    })
  }
})

// Auto-load memory data when the tab is first opened
// Hook into switchMainTab — called when user clicks the Memory tab
const _origSwitchMainTab = typeof switchMainTab === 'function' ? switchMainTab : null
// We patch via the tab onclick directly — switchMainTab is defined in app.js
// so we wrap it after definition by overriding the global
if (typeof window !== 'undefined') {
  window._memoryTabAutoLoad = function() {
    if (!_memoryLoaded) memoryRefresh()
  }
}

// ── Setup Wizard launcher ─────────────────────────────────────────────────────
async function openSetupWizard() {
  try {
    await window.app.openSetupWizard()
  } catch (e) {
    console.error('[setup-wizard] Failed to open:', e)
  }
}

// ── Models directory setting (settings panel) ─────────────────────────────────
async function loadModelsDirSetting() {
  try {
    const result = await window.setup.getModelsDir()
    const input = document.getElementById('modelsDirInput')
    const status = document.getElementById('modelsDirStatus')
    if (!input) return
    if (result && result.dir) {
      input.value = result.dir
      status.textContent = result.isDefault ? 'Default location' : '✓ Custom location saved'
      status.style.color = result.isDefault ? 'var(--muted)' : 'var(--green)'
    }
  } catch (_) {}
}

async function saveModelsDirSetting(dir) {
  const status = document.getElementById('modelsDirStatus')
  if (!dir || !dir.trim()) return
  try {
    const result = await window.setup.saveModelsDir(dir.trim())
    if (result.error) {
      if (status) { status.textContent = '✗ ' + result.error; status.style.color = 'var(--red)' }
    } else {
      if (status) { status.textContent = '✓ Saved'; status.style.color = 'var(--green)' }
    }
  } catch (e) {
    if (status) { status.textContent = '✗ Failed'; status.style.color = 'var(--red)' }
  }
}

async function pickModelsDirSetting() {
  try {
    const result = await window.setup.pickModelsDir()
    if (result.canceled) return
    if (result.error) return
    const input = document.getElementById('modelsDirInput')
    const status = document.getElementById('modelsDirStatus')
    if (input) input.value = result.dir
    if (status) { status.textContent = '✓ Saved'; status.style.color = 'var(--green)' }
  } catch (_) {}
}

// Load models dir when the setup panel is shown
document.addEventListener('DOMContentLoaded', () => {
  // Patch showPanel to load models dir when setup panel opens
  const _origShowPanel = typeof showPanel === 'function' ? showPanel : null
  if (_origShowPanel) {
    window._origShowPanelForModelsDir = _origShowPanel
  }
})

// Hook into the activity bar setup button click
;(function() {
  const setupBtn = document.querySelector('[data-panel="setup"]')
  if (setupBtn) {
    setupBtn.addEventListener('click', () => {
      loadModelsDirSetting()
      loadPermissionsSettings()
    })
  }
})()

// ══════════════════════════════════════════════════════════════════════════════
// CENTER PREVIEW PANEL — auto-shows HTML output from agent
// ══════════════════════════════════════════════════════════════════════════════

let _centerPreviewDevice = 'responsive'
let _centerPreviewFile = null

function setCenterPreviewDevice(name) {
  _centerPreviewDevice = name
  const viewport = document.getElementById('previewCenterViewport')
  const frame = document.getElementById('previewCenterFrame')
  const label = document.getElementById('previewCenterSize')

  document.querySelectorAll('.pcd-btn').forEach(b => b.classList.remove('active'))
  const btn = document.querySelector(`.pcd-btn[data-device="${name}"]`)
  if (btn) btn.classList.add('active')

  const devices = {
    responsive: { w: '100%', h: '100%', label: '' },
    desktop: { w: '1440px', h: '900px', label: '1440×900' },
    tablet: { w: '768px', h: '1024px', label: '768×1024' },
    mobile: { w: '375px', h: '667px', label: '375×667' },
  }
  const dev = devices[name] || devices.responsive

  if (name === 'responsive') {
    viewport.className = 'preview-center-viewport'
    frame.style.width = '100%'
    frame.style.height = '100%'
  } else {
    viewport.className = 'preview-center-viewport device'
    frame.style.width = dev.w
    frame.style.height = dev.h
  }
  if (label) label.textContent = dev.label
}

function refreshCenterPreview() {
  const frame = document.getElementById('previewCenterFrame')
  const empty = document.getElementById('previewCenterEmpty')
  if (!frame) return

  if (_centerPreviewFile) {
    frame.removeAttribute('sandbox')
    frame.removeAttribute('srcdoc')
    frame.src = 'file://' + _centerPreviewFile + '?t=' + Date.now()
    frame.style.display = 'block'
    if (empty) empty.style.display = 'none'
  }
}

async function autoUpdateCenterPreview() {
  if (!currentProject) return
  try {
    const entries = await window.app.readDir(currentProject)
    const htmlFile = entries.find(e => !e.isDir && e.name === 'index.html')
      || entries.find(e => !e.isDir && /\.html?$/i.test(e.name))
    if (htmlFile) {
      _centerPreviewFile = htmlFile.path
      refreshCenterPreview()
    }
  } catch (_) {}
}

// ── Split resize handle ──────────────────────────────────────────────────────
;(function initSplitResize() {
  document.addEventListener('DOMContentLoaded', () => {
    const handle = document.getElementById('splitResizeHandle')
    const chatPanel = document.getElementById('chatPanel')
    if (!handle || !chatPanel) return

    let dragging = false
    let startX = 0
    let startWidth = 0

    handle.addEventListener('mousedown', (e) => {
      dragging = true
      startX = e.clientX
      startWidth = chatPanel.offsetWidth
      handle.classList.add('dragging')
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      e.preventDefault()
    })

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return
      const delta = startX - e.clientX
      const newWidth = Math.max(320, Math.min(600, startWidth + delta))
      chatPanel.style.width = newWidth + 'px'
    })

    document.addEventListener('mouseup', () => {
      if (!dragging) return
      dragging = false
      handle.classList.remove('dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    })
  })
})()

// ── Hook into tool-result events to auto-update center preview ───────────────
// showPreviewButton already calls autoUpdateCenterPreview directly (patched above)
// File watcher already calls refreshCenterPreview on HTML/CSS/JS changes
// switchProject and openProject already call autoUpdateCenterPreview
