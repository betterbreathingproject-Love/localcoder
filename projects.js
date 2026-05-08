/**
 * Project + session + conversation persistence for LocalCoder Mac Studio.
 * Stores data in ~/.qwencoder/projects/{id}/
 *   project.json   — metadata
 *   settings.json   — context & compactor settings
 *   sessions/
 *     {sessionId}.json — { name, created, lastUsed, messages: [...] }
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DATA_DIR = path.join(require('os').homedir(), '.qwencoder')
const PROJECTS_DIR = path.join(DATA_DIR, 'projects')

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) }
function uid() { return crypto.randomBytes(6).toString('hex') }

// ── project CRUD ──────────────────────────────────────────────────────────────
function listProjects() {
  ensureDir(PROJECTS_DIR)
  try {
    return fs.readdirSync(PROJECTS_DIR)
      .filter(f => fs.existsSync(path.join(PROJECTS_DIR, f, 'project.json')))
      .map(f => {
        const p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f, 'project.json'), 'utf-8'))
        return { ...p, id: f }
      })
      .sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))
  } catch { return [] }
}

function createProject(name, directory) {
  ensureDir(PROJECTS_DIR)
  const id = uid()
  const projDir = path.join(PROJECTS_DIR, id)
  ensureDir(projDir)
  ensureDir(path.join(projDir, 'sessions'))
  // Trim directory path to prevent trailing spaces from file pickers causing
  // path resolution failures later (e.g. "photo ranker " vs "photo ranker")
  const cleanDirectory = typeof directory === 'string' ? directory.trim() : directory
  const meta = { name, directory: cleanDirectory, created: Date.now(), lastOpened: Date.now() }
  fs.writeFileSync(path.join(projDir, 'project.json'), JSON.stringify(meta, null, 2))
  fs.writeFileSync(path.join(projDir, 'history.json'), '[]')
  const sess = createSession(id, 'Session 1')
  meta.activeSession = sess.id
  fs.writeFileSync(path.join(projDir, 'project.json'), JSON.stringify(meta, null, 2))
  return { ...meta, id }
}

function openProject(id) {
  const metaPath = path.join(PROJECTS_DIR, id, 'project.json')
  if (!fs.existsSync(metaPath)) return null
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
  meta.lastOpened = Date.now()
  ensureDir(path.join(PROJECTS_DIR, id, 'sessions'))
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  return { ...meta, id }
}

function deleteProject(id) {
  const projDir = path.join(PROJECTS_DIR, id)
  if (fs.existsSync(projDir)) fs.rmSync(projDir, { recursive: true })
}

// ── sessions ──────────────────────────────────────────────────────────────────
function sessionsDir(projectId) { return path.join(PROJECTS_DIR, projectId, 'sessions') }
function sessionPath(projectId, sessionId) { return path.join(sessionsDir(projectId), sessionId + '.json') }

function listSessions(projectId) {
  const dir = sessionsDir(projectId)
  ensureDir(dir)
  try {
    const sessions = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
          return { id: f.replace('.json', ''), name: data.name, type: data.type || 'vibe', created: data.created, lastUsed: data.lastUsed, messageCount: (data.messages || []).length }
        } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))

    if (!sessions.length) {
      const legacyPath = path.join(PROJECTS_DIR, projectId, 'history.json')
      if (fs.existsSync(legacyPath)) {
        try {
          const msgs = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'))
          const sess = createSession(projectId, 'Session 1')
          if (msgs.length) {
            const data = JSON.parse(fs.readFileSync(sessionPath(projectId, sess.id), 'utf-8'))
            data.messages = msgs
            fs.writeFileSync(sessionPath(projectId, sess.id), JSON.stringify(data, null, 2))
            sess.messageCount = msgs.length
          }
          return [sess]
        } catch {}
      }
      return [createSession(projectId, 'Session 1')]
    }
    return sessions
  } catch { return [] }
}

function createSession(projectId, name, sessionType) {
  const dir = sessionsDir(projectId)
  ensureDir(dir)
  const id = uid()
  const type = sessionType === 'spec' ? 'spec' : 'vibe'
  const data = { name: name || `Session ${Date.now()}`, type, created: Date.now(), lastUsed: Date.now(), messages: [] }
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(data, null, 2))
  const metaPath = path.join(PROJECTS_DIR, projectId, 'project.json')
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    meta.activeSession = id
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  } catch {}
  return { id, name: data.name, type, created: data.created, lastUsed: data.lastUsed, messageCount: 0 }
}

function renameSession(projectId, sessionId, name) {
  const p = sessionPath(projectId, sessionId)
  if (!fs.existsSync(p)) return null
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
  data.name = name
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
  return { id: sessionId, name }
}

function deleteSession(projectId, sessionId) {
  const p = sessionPath(projectId, sessionId)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

function getSessionMessages(projectId, sessionId) {
  const p = sessionPath(projectId, sessionId)
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')).messages || [] } catch { return [] }
}

function appendSessionMessage(projectId, sessionId, message) {
  const p = sessionPath(projectId, sessionId)
  let data
  try { data = JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { data = { name: 'Session', created: Date.now(), messages: [] } }
  data.messages.push({ ...message, ts: Date.now() })
  data.lastUsed = Date.now()
  if (data.messages.length > 500) data.messages = data.messages.slice(-500)
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
  return data.messages
}

function clearSessionMessages(projectId, sessionId) {
  const p = sessionPath(projectId, sessionId)
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    data.messages = []; data.lastUsed = Date.now()
    fs.writeFileSync(p, JSON.stringify(data, null, 2))
  } catch {}
}

function setSessionMessages(projectId, sessionId, messages) {
  const p = sessionPath(projectId, sessionId)
  let data
  try { data = JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { data = { name: 'Session', created: Date.now() } }
  data.messages = messages; data.lastUsed = Date.now()
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
  return messages
}

// ── todo persistence ──────────────────────────────────────────────────────────
function getSessionTodos(projectId, sessionId) {
  const p = sessionPath(projectId, sessionId)
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')).todos || [] } catch { return [] }
}

function saveSessionTodos(projectId, sessionId, todos) {
  const p = sessionPath(projectId, sessionId)
  let data
  try { data = JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { data = { name: 'Session', created: Date.now(), messages: [] } }
  data.todos = todos
  data.lastUsed = Date.now()
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
  return todos
}

// ── chat snapshot persistence ─────────────────────────────────────────────────
function getSessionChatSnapshot(projectId, sessionId) {
  const p = sessionPath(projectId, sessionId)
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')).chatSnapshot || null } catch { return null }
}

function saveSessionChatSnapshot(projectId, sessionId, snapshot) {
  const p = sessionPath(projectId, sessionId)
  let data
  try { data = JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { data = { name: 'Session', created: Date.now(), messages: [] } }
  data.chatSnapshot = snapshot
  data.lastUsed = Date.now()
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
  return snapshot
}

// ── session workflow state (spec + task graph) ────────────────────────────────
function getSessionWorkflowState(projectId, sessionId) {
  const p = sessionPath(projectId, sessionId)
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return data.workflowState || null
  } catch { return null }
}

function saveSessionWorkflowState(projectId, sessionId, state) {
  const p = sessionPath(projectId, sessionId)
  let data
  try { data = JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { data = { name: 'Session', created: Date.now(), messages: [] } }
  data.workflowState = state
  data.lastUsed = Date.now()
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
  return state
}

// ── legacy history (backward compat) ──────────────────────────────────────────
function getHistory(projectId) {
  const histPath = path.join(PROJECTS_DIR, projectId, 'history.json')
  try { return JSON.parse(fs.readFileSync(histPath, 'utf-8')) } catch { return [] }
}

function appendHistory(projectId, message) {
  const hist = getHistory(projectId)
  hist.push({ ...message, ts: Date.now() })
  const trimmed = hist.slice(-200)
  const histPath = path.join(PROJECTS_DIR, projectId, 'history.json')
  ensureDir(path.dirname(histPath))
  fs.writeFileSync(histPath, JSON.stringify(trimmed, null, 2))
  return trimmed
}

function clearHistory(projectId) {
  const histPath = path.join(PROJECTS_DIR, projectId, 'history.json')
  if (fs.existsSync(histPath)) fs.writeFileSync(histPath, '[]')
}

// ── context builder ───────────────────────────────────────────────────────────
function buildProjectContext(directory, settings) {
  if (!directory || !fs.existsSync(directory)) return ''
  const ignoreList = settings?.ignorePatterns || ['node_modules', '__pycache__', 'dist', 'build', '.git']
  const maxFiles = 100
  try {
    const files = []
    const walk = (dir, prefix) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const e of entries) {
        if (e.name.startsWith('.') || ignoreList.some(p => {
          if (p.startsWith('*')) return e.name.endsWith(p.slice(1))
          return e.name === p
        })) continue
        const rel = prefix ? prefix + '/' + e.name : e.name
        if (e.isDirectory()) { walk(path.join(dir, e.name), rel) }
        else { files.push(rel) }
        if (files.length > maxFiles) return
      }
    }
    walk(directory, '')
    if (!files.length) return `\n\nProject directory: ${directory}\nThis is an empty project directory. Create files directly in this directory.\n`
    return `\n\nProject directory: ${directory}\nProject files:\n${files.map(f => '- ' + f).join('\n')}\n`
  } catch { return '' }
}

// ── context settings ──────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  maxContextTokens: 8000,
  maxFileTokens: 2000,
  maxHistoryMessages: 40,
  ignorePatterns: ['node_modules', '__pycache__', 'dist', 'build', '.git', '*.lock'],
  autoCompact: true,
  compactThreshold: 30,
  compactKeepRecent: 10,
}

function getSettings(projectId) {
  const settingsPath = path.join(PROJECTS_DIR, projectId, 'settings.json')
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) }
  } catch { return { ...DEFAULT_SETTINGS } }
}

function saveSettings(projectId, settings) {
  const settingsPath = path.join(PROJECTS_DIR, projectId, 'settings.json')
  ensureDir(path.dirname(settingsPath))
  const merged = { ...DEFAULT_SETTINGS, ...settings }
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2))
  return merged
}

// ── API keys (global, not per-project) ────────────────────────────────────────
const API_KEYS_PATH = path.join(DATA_DIR, 'api-keys.json')

function getApiKeys() {
  try {
    return JSON.parse(fs.readFileSync(API_KEYS_PATH, 'utf-8'))
  } catch { return {} }
}

function saveApiKeys(keys) {
  ensureDir(DATA_DIR)
  fs.writeFileSync(API_KEYS_PATH, JSON.stringify(keys, null, 2))
  return keys
}

// ── app settings (global, not per-project) ────────────────────────────────────
const APP_SETTINGS_PATH = path.join(DATA_DIR, 'app-settings.json')

function getAppSettings() {
  try {
    return JSON.parse(fs.readFileSync(APP_SETTINGS_PATH, 'utf-8'))
  } catch { return {} }
}

function saveAppSettings(settings) {
  ensureDir(DATA_DIR)
  const merged = { ...getAppSettings(), ...settings }
  fs.writeFileSync(APP_SETTINGS_PATH, JSON.stringify(merged, null, 2))
  return merged
}

module.exports = {
  listProjects, createProject, openProject, deleteProject,
  getHistory, appendHistory, clearHistory, buildProjectContext,
  getSettings, saveSettings, DEFAULT_SETTINGS,
  listSessions, createSession, renameSession, deleteSession,
  getSessionMessages, appendSessionMessage, clearSessionMessages, setSessionMessages,
  getSessionTodos, saveSessionTodos,
  getSessionChatSnapshot, saveSessionChatSnapshot,
  getSessionWorkflowState, saveSessionWorkflowState,
  getApiKeys, saveApiKeys,
  getAppSettings, saveAppSettings,
}
