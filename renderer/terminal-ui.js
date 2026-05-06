'use strict'
/**
 * Terminal UI — two-pane panel:
 *   • Agent pane  — live stream of agent activity (tool calls, bash output, thinking)
 *   • Shell pane  — multiple PTY sessions backed by xterm.js for proper VT100 emulation
 *
 * Loaded by renderer/index.html as a <script> tag.
 * All functions are global (vanilla JS, no framework).
 */

// ── xterm.js globals (loaded via <script> tags in index.html) ─────────────────
// @xterm/xterm exports Terminal onto globalThis
// @xterm/addon-fit exports FitAddon onto self.FitAddon
const XTerminal = window.Terminal
const XFitAddon = window.FitAddon ? window.FitAddon.FitAddon : null

// ── State ─────────────────────────────────────────────────────────────────────
let _termCollapsed  = false
let _termActivePane = 'agent'     // 'agent' | 'shell'

// Shell sessions: Map<id, { id, xterm, fitAddon, tabEl, containerEl, title }>
const _shellSessions = new Map()
let _activeShellId   = null       // currently visible shell session ID
let _shellNextNum    = 1          // counter for "Shell 1", "Shell 2", …

// Agent log state
let _agentRunning       = false
let _agentLastBashRow   = null
let _agentRenderPending = false
let _agentToolMap       = new Map()  // tool_use_id → { name, row }

// ── DOM refs ──────────────────────────────────────────────────────────────────
function _termPanel()      { return document.getElementById('terminalPanel') }
function _termHandle()     { return document.getElementById('terminalResizeHandle') }
function _agentPane()      { return document.getElementById('terminalAgentPane') }
function _agentLog()       { return document.getElementById('terminalAgentLog') }
function _agentEmpty()     { return document.getElementById('terminalAgentEmpty') }
function _shellPane()      { return document.getElementById('terminalShellPane') }
function _shellTabStrip()  { return document.getElementById('shellTabStrip') }
function _shellScreens()   { return document.getElementById('shellScreens') }
function _shellEmpty()     { return document.getElementById('terminalEmpty') }
function _tabAgent()       { return document.getElementById('termTabAgent') }
function _tabShell()       { return document.getElementById('termTabShell') }

// ── xterm.js theme (matches the dark UI) ──────────────────────────────────────
const _XTERM_THEME = {
  background:       '#0c0c10',
  foreground:       '#d4d4d4',
  cursor:           '#7c6af7',
  cursorAccent:     '#0c0c10',
  selectionBackground: 'rgba(124,106,247,0.3)',
  black:   '#555555', red:     '#f44747', green:   '#6a9955', yellow:  '#dcdcaa',
  blue:    '#569cd6', magenta: '#c586c0', cyan:    '#4ec9b0', white:   '#d4d4d4',
  brightBlack: '#888888', brightRed: '#f44747', brightGreen: '#6a9955',
  brightYellow: '#dcdcaa', brightBlue: '#569cd6', brightMagenta: '#c586c0',
  brightCyan: '#4ec9b0', brightWhite: '#ffffff',
}

// ── Top-level pane switching (Agent ↔ Shell) ──────────────────────────────────

function terminalSwitchTab(pane) {
  _termActivePane = pane
  const agentPane = _agentPane()
  const shellPane = _shellPane()
  const tabAgent  = _tabAgent()
  const tabShell  = _tabShell()

  if (pane === 'agent') {
    if (agentPane) agentPane.style.display = ''
    if (shellPane) shellPane.style.display = 'none'
    if (tabAgent)  { tabAgent.classList.add('active'); tabAgent.classList.remove('has-activity') }
    if (tabShell)  tabShell.classList.remove('active')
  } else {
    if (agentPane) agentPane.style.display = 'none'
    if (shellPane) shellPane.style.display = ''
    if (tabAgent)  tabAgent.classList.remove('active')
    if (tabShell)  { tabShell.classList.add('active'); tabShell.classList.remove('has-activity') }
    // Fit + focus the active shell after the pane becomes visible
    if (_activeShellId) {
      requestAnimationFrame(() => {
        _fitShell(_activeShellId)
        _focusShell(_activeShellId)
      })
    }
  }
}

// ── Shell session management ──────────────────────────────────────────────────

/** Create a new PTY session backed by xterm.js. */
async function terminalNew() {
  // Use the renderer's currentProject global (set in app.js)
  const cwd = (typeof currentProject !== 'undefined' && currentProject) ? currentProject : undefined
  let result
  try {
    result = await window.app.terminalCreate({ cwd })
  } catch (err) {
    console.warn('[terminal-ui] terminalCreate threw:', err)
    return
  }
  if (!result || result.error) {
    console.warn('[terminal-ui] create failed:', result?.error)
    return
  }

  const id    = result.id
  const num   = _shellNextNum++
  const title = `Shell ${num}`

  _createShellSession(id, title)

  // Switch to shell pane and activate this session
  terminalSwitchTab('shell')
  _activateShell(id)
  if (_termCollapsed) terminalToggle()
}

/** Internal: create xterm instance, container, and tab for a session. */
function _createShellSession(id, title) {
  // Container div for the xterm instance
  const containerEl = document.createElement('div')
  containerEl.className = 'xterm-container'
  containerEl.dataset.sessionId = id
  containerEl.style.display = 'none'

  const screens = _shellScreens()
  if (screens) screens.appendChild(containerEl)

  // Create xterm.js terminal
  const xterm = new XTerminal({
    theme: _XTERM_THEME,
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    fontSize: 12,
    lineHeight: 1.35,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 5000,
    allowProposedApi: true,
  })

  const fitAddon = new XFitAddon()
  xterm.loadAddon(fitAddon)
  xterm.open(containerEl)

  // Forward keystrokes to the PTY
  xterm.onData((data) => {
    window.app.terminalWrite(id, data)
  })

  // Send resize events to the PTY when xterm resizes
  xterm.onResize(({ cols, rows }) => {
    window.app.terminalResize(id, cols, rows)
  })

  // Create the tab button
  const tabEl = document.createElement('button')
  tabEl.className = 'shell-session-tab'
  tabEl.dataset.sessionId = id
  tabEl.innerHTML = `<span class="sst-title">${_escapeHtml(title)}</span>` +
    `<span class="sst-close" title="Close">✕</span>`
  tabEl.querySelector('.sst-title').addEventListener('click', () => _activateShell(id))
  tabEl.querySelector('.sst-close').addEventListener('click', (e) => {
    e.stopPropagation()
    _closeShell(id)
  })

  const strip = _shellTabStrip()
  if (strip) strip.appendChild(tabEl)

  // Register session
  _shellSessions.set(id, { id, xterm, fitAddon, tabEl, containerEl, title })
}

/** Fit the xterm instance to its container. */
function _fitShell(id) {
  const session = _shellSessions.get(id)
  if (!session) return
  try { session.fitAddon.fit() } catch (_) {}
}

/** Activate (focus) a shell session by ID. */
function _activateShell(id) {
  const session = _shellSessions.get(id)
  if (!session) return

  // Deactivate all tabs and containers
  for (const [, s] of _shellSessions) {
    s.tabEl.classList.remove('active')
    s.containerEl.style.display = 'none'
  }

  // Activate this one
  session.tabEl.classList.add('active')
  session.containerEl.style.display = ''
  _activeShellId = id

  // Hide empty state
  const empty = _shellEmpty()
  if (empty) empty.style.display = 'none'

  // Fit after display change, then focus
  requestAnimationFrame(() => {
    _fitShell(id)
    _focusShell(id)
  })
}

/** Focus the xterm instance of a shell session. */
function _focusShell(id) {
  const session = _shellSessions.get(id)
  if (session) session.xterm.focus()
}

/** Close a shell session. */
async function _closeShell(id) {
  const session = _shellSessions.get(id)
  if (!session) return

  try { await window.app.terminalClose(id) } catch (_) {}

  // Dispose xterm and remove DOM elements
  session.xterm.dispose()
  session.tabEl.remove()
  session.containerEl.remove()
  _shellSessions.delete(id)

  // If this was the active session, activate another or show empty
  if (_activeShellId === id) {
    _activeShellId = null
    const remaining = [..._shellSessions.keys()]
    if (remaining.length > 0) {
      _activateShell(remaining[remaining.length - 1])
    } else {
      const empty = _shellEmpty()
      if (empty) empty.style.display = ''
    }
  }
}

/** Close the currently active shell session. */
async function terminalCloseActive() {
  if (_activeShellId) await _closeShell(_activeShellId)
}

/** Toggle collapsed/expanded state. */
function terminalToggle() {
  const panel = _termPanel()
  if (!panel) return
  _termCollapsed = !_termCollapsed
  panel.classList.toggle('collapsed', _termCollapsed)
  const btn = document.getElementById('termToggleBtn')
  if (btn) btn.textContent = _termCollapsed ? '▲' : '▼'
  // Re-fit active terminal after expand
  if (!_termCollapsed && _activeShellId && _termActivePane === 'shell') {
    requestAnimationFrame(() => _fitShell(_activeShellId))
  }
}

// ── Resize drag ───────────────────────────────────────────────────────────────

function _initTerminalResize() {
  const handle = _termHandle()
  if (!handle) return

  let startY = 0, startHeight = 0
  let rafId = null

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    const panel = _termPanel()
    if (!panel || _termCollapsed) return
    startY = e.clientY
    startHeight = panel.offsetHeight
    handle.classList.add('dragging')
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onDrag)
    document.addEventListener('mouseup', onDragEnd)
  })

  function onDrag(e) {
    e.preventDefault()
    const panel = _termPanel()
    if (!panel) return
    const delta = startY - e.clientY
    const newH = Math.max(80, Math.min(window.innerHeight * 0.8, startHeight + delta))
    panel.style.height = newH + 'px'
    // Throttle xterm fit to one per animation frame to avoid layout thrashing
    if (!rafId && _activeShellId && _termActivePane === 'shell') {
      rafId = requestAnimationFrame(() => {
        rafId = null
        _fitShell(_activeShellId)
      })
    }
  }

  function onDragEnd() {
    handle.classList.remove('dragging')
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.removeEventListener('mousemove', onDrag)
    document.removeEventListener('mouseup', onDragEnd)
    if (rafId) { cancelAnimationFrame(rafId); rafId = null }
    // Final fit after drag ends
    if (_activeShellId && _termActivePane === 'shell') _fitShell(_activeShellId)
  }
}

// ── Window resize handler ─────────────────────────────────────────────────────
let _resizeTimer = null
function _onWindowResize() {
  clearTimeout(_resizeTimer)
  _resizeTimer = setTimeout(() => {
    if (_activeShellId && _termActivePane === 'shell' && !_termCollapsed) {
      _fitShell(_activeShellId)
    }
  }, 100)
}

// ── Agent log helpers ─────────────────────────────────────────────────────────

function _escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

function terminalClearAgent() {
  _agentLastBashRow = null
  _agentToolMap.clear()
  const log   = _agentLog()
  const empty = _agentEmpty()
  if (log)   { log.innerHTML = ''; log.style.display = 'none' }
  if (empty) empty.style.display = ''
}

function _agentAppendRow(type, icon, label, content) {
  const log   = _agentLog()
  const empty = _agentEmpty()
  if (!log) return null

  if (log.style.display === 'none') {
    log.style.display = ''
    if (empty) empty.style.display = 'none'
  }

  const row = document.createElement('div')
  row.className = `term-agent-row row-${type}`
  row.innerHTML =
    `<span class="term-agent-icon">${icon}</span>` +
    `<span class="term-agent-content">` +
      (label ? `<span class="term-agent-label">${_escapeHtml(label)}</span>` : '') +
      content +
    `</span>`
  log.appendChild(row)

  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60
  if (atBottom) log.scrollTop = log.scrollHeight

  if (_termActivePane !== 'agent') {
    const tab = _tabAgent()
    if (tab) tab.classList.add('has-activity')
  }
  return row
}

function _agentAddSeparator(label) {
  const log = _agentLog(), empty = _agentEmpty()
  if (!log) return
  if (log.style.display === 'none') { log.style.display = ''; if (empty) empty.style.display = 'none' }
  const sep = document.createElement('div')
  sep.className = 'term-agent-separator'
  sep.textContent = label || 'New session'
  log.appendChild(sep)
  log.scrollTop = log.scrollHeight
}

// ── Agent event handler ───────────────────────────────────────────────────────

function terminalHandleAgentEvent(ev) {
  if (!ev || !ev.type) return

  switch (ev.type) {
    case 'session-start': {
      _agentRunning = true
      _agentLastBashRow = null
      const cwd = ev.cwd ? ev.cwd.replace(/^.*\/([^/]+)$/, '$1') : ''
      _agentAddSeparator(cwd ? `▶ Session — ${cwd}` : '▶ New session')
      if (_termCollapsed) terminalToggle()
      terminalSwitchTab('agent')
      break
    }
    case 'session-end': {
      _agentRunning = false
      _agentLastBashRow = null
      break
    }
    case 'tool-use': {
      const name = ev.name || '?'
      const args = ev.input || ev.args || {}
      let row
      if (name === 'bash' || name === 'run_command' || name === 'execute_command') {
        const cmd = args.command || args.cmd || ''
        row = _agentAppendRow('bash', '⚡', 'bash',
          `<span class="term-fg-cyan">${_escapeHtml(cmd.slice(0,300))}</span>${cmd.length>300?'<span class="term-dim">…</span>':''}`)
        _agentLastBashRow = row
      } else if (['write_file','create_file','edit_file','edit_files','str_replace'].includes(name)) {
        const fp = args.path || args.file_path || args.target_file || ''
        row = _agentAppendRow('tool', '✏️', name,
          `<span class="term-fg-yellow">${_escapeHtml(fp || JSON.stringify(args).slice(0,120))}</span>`)
      } else if (['read_file','read_files','view_file'].includes(name)) {
        const fp = args.path || (Array.isArray(args.paths) ? args.paths.join(', ') : '') || ''
        row = _agentAppendRow('tool', '📄', name,
          `<span class="term-fg-blue">${_escapeHtml(fp.slice(0,200))}</span>`)
      } else if (['search_files','grep_search','file_search'].includes(name)) {
        const q = args.pattern || args.query || args.search_term || ''
        row = _agentAppendRow('tool', '🔍', name,
          `<span class="term-fg-magenta">${_escapeHtml(q.slice(0,120))}</span>`)
      } else if (name === 'list_dir') {
        row = _agentAppendRow('tool', '📁', name,
          `<span class="term-fg-blue">${_escapeHtml(args.path||'.')}</span>`)
      } else {
        row = _agentAppendRow('tool', '🔧', name,
          `<span class="term-dim">${_escapeHtml(JSON.stringify(args).slice(0,160))}</span>`)
      }
      if (ev.id && row) _agentToolMap.set(ev.id, { name, row })
      break
    }
    case 'tool-result': {
      const entry   = ev.tool_use_id ? _agentToolMap.get(ev.tool_use_id) : null
      const tName   = entry?.name || ''
      const isBash  = ['bash','run_command','execute_command'].includes(tName)
      const bashRow = entry?.row || _agentLastBashRow
      if (isBash && bashRow) {
        const out = typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content||'')
        const trimmed = out.trim().slice(0, 2000)
        if (trimmed) {
          const el = document.createElement('span')
          el.className = 'term-bash-output'
          el.textContent = trimmed + (out.length > 2000 ? '\n…(truncated)' : '')
          const c = bashRow.querySelector('.term-agent-content')
          if (c) c.appendChild(el)
          const log = _agentLog()
          if (log && log.scrollHeight - log.scrollTop - log.clientHeight < 80) log.scrollTop = log.scrollHeight
        }
        if (ev.tool_use_id) _agentToolMap.delete(ev.tool_use_id)
        if (bashRow === _agentLastBashRow) _agentLastBashRow = null
      } else if (ev.is_error) {
        const msg = typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content||'')
        _agentAppendRow('error', '✖', tName||'error',
          `<span class="term-fg-red">${_escapeHtml(msg.slice(0,300))}</span>`)
        if (ev.tool_use_id) _agentToolMap.delete(ev.tool_use_id)
      } else {
        if (ev.tool_use_id) _agentToolMap.delete(ev.tool_use_id)
      }
      break
    }
    case 'system': {
      const msg = ev.data || ev.message || ''
      if (!msg || (ev.subtype === 'debug' && msg.length < 4)) break
      _agentAppendRow('system', '·', '',
        `<span class="term-dim">${_escapeHtml(String(msg).slice(0,300))}</span>`)
      break
    }
    case 'error': {
      const msg = ev.error || ev.message || 'Unknown error'
      _agentAppendRow('error', '✖', 'error',
        `<span class="term-fg-red">${_escapeHtml(String(msg).slice(0,400))}</span>`)
      break
    }
    case 'thinking-delta': {
      if (!_agentRenderPending) {
        _agentRenderPending = true
        requestAnimationFrame(() => {
          _agentRenderPending = false
          const log = _agentLog()
          if (!log) return
          let row = log.querySelector('.term-thinking-live')
          if (!row) {
            row = document.createElement('div')
            row.className = 'term-agent-row row-thinking term-thinking-live'
            row.innerHTML = `<span class="term-agent-icon">💭</span><span class="term-agent-content"><span class="term-agent-label">thinking</span><span class="term-thinking-text term-dim"></span></span>`
            log.appendChild(row)
          }
          const el = row.querySelector('.term-thinking-text')
          if (el) el.textContent = (ev.text || '').slice(-300)
          if (log.scrollHeight - log.scrollTop - log.clientHeight < 60) log.scrollTop = log.scrollHeight
        })
      }
      break
    }
    case 'text-delta': {
      const log = _agentLog()
      if (log) { const r = log.querySelector('.term-thinking-live'); if (r) r.remove() }
      break
    }
    case 'lsp-activity': {
      const file  = ev.path ? ev.path.replace(/^.*\/([^/]+)$/, '$1') : ''
      const count = ev.count != null ? ` (${ev.count})` : ''
      _agentAppendRow('system', '🔬', 'lsp',
        `<span class="term-dim">${_escapeHtml(ev.action||'')}${file?' · '+_escapeHtml(file):''}${count}</span>`)
      break
    }
    case 'bash-waiting': {
      const elapsed = ev.elapsedSecs != null ? ` (${ev.elapsedSecs}s)` : ev.elapsed ? ` (${Math.round(ev.elapsed/1000)}s)` : ''
      _agentAppendRow('bash', '⏳', 'waiting',
        `<span class="term-fg-yellow">${_escapeHtml((ev.command||'').slice(0,200))}${elapsed}</span>`)
      break
    }
    default: break
  }
}

// ── IPC event listeners ───────────────────────────────────────────────────────

function _initTerminalEvents() {
  // PTY output — route to the right session's xterm instance
  window.app.onTerminalOutput((msg) => {
    const session = _shellSessions.get(msg.id)
    if (!session) return
    session.xterm.write(msg.data)
    // Activity dot on shell tab when not active
    if (_termActivePane !== 'shell' || msg.id !== _activeShellId) {
      const tab = _tabShell()
      if (tab) tab.classList.add('has-activity')
      if (msg.id !== _activeShellId && session.tabEl) {
        session.tabEl.classList.add('has-output')
      }
    }
  })

  // PTY exited
  window.app.onTerminalExit((msg) => {
    const session = _shellSessions.get(msg.id)
    if (!session) return
    session.xterm.write(`\r\n\x1b[90m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`)
    if (session.tabEl) session.tabEl.classList.add('dead')
  })

  // Agent routed interactive command here — adopt the session and switch to shell
  window.app.onTerminalFocus(async (msg) => {
    // If this session isn't tracked yet, adopt it
    if (!_shellSessions.has(msg.id)) {
      const num   = _shellNextNum++
      const title = msg.command ? `⚡ ${msg.command.slice(0,20)}` : `Shell ${num}`
      _createShellSession(msg.id, title)
    }

    if (_termCollapsed) terminalToggle()
    terminalSwitchTab('shell')
    _activateShell(msg.id)

    // Switch to Preview tab if not already there
    const previewTab = document.querySelector('.ed-tab[data-tab="agent"]')
    if (previewTab && !previewTab.classList.contains('active')) {
      if (typeof switchMainTab === 'function') switchMainTab('agent', previewTab)
    }

    // Flash the terminal header
    const panel = _termPanel()
    if (panel) {
      panel.classList.add('focused')
      setTimeout(() => panel.classList.remove('focused'), 3000)
    }
  })
}

// ── Init ──────────────────────────────────────────────────────────────────────

function _initTerminal() {
  _initTerminalResize()
  _initTerminalEvents()
  terminalSwitchTab('agent')
  window.addEventListener('resize', _onWindowResize)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initTerminal)
} else {
  _initTerminal()
}
