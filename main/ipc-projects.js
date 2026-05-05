'use strict'

const fs = require('fs')
const path = require('path')
const { listProjects, createProject, openProject, deleteProject, getHistory, appendHistory, clearHistory, buildProjectContext, getSettings, saveSettings, DEFAULT_SETTINGS, listSessions, createSession, renameSession, deleteSession, getSessionMessages, appendSessionMessage, clearSessionMessages, setSessionMessages, getSessionTodos, saveSessionTodos, getSessionChatSnapshot, saveSessionChatSnapshot, getSessionWorkflowState, saveSessionWorkflowState, getApiKeys, saveApiKeys, getAppSettings, saveAppSettings } = require('../projects')

// ── validation ────────────────────────────────────────────────────────────────
function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0 }

// ── steering prompt helper ────────────────────────────────────────────────────
function checkSteeringPrompt(projectDir, getMainWindow) {
  if (!projectDir) return
  const steeringDir = path.join(projectDir, '.maccoder', 'steering')
  if (!fs.existsSync(steeringDir)) {
    const win = getMainWindow()
    if (win) {
      win.webContents.send('steering-prompt', {
        projectDir,
        message: 'Generate steering docs for this project?',
      })
    }
  }
}

// ── IPC registration ──────────────────────────────────────────────────────────
function register(ipcMain, { getCurrentProject, setCurrentProject, getMainWindow }) {

  // ── projects ────────────────────────────────────────────────────────────
  ipcMain.handle('list-projects', () => listProjects())

  ipcMain.handle('create-project', (_, name, directory) => {
    if (!isNonEmptyString(name)) return { error: 'name is required' }
    if (!isNonEmptyString(directory)) return { error: 'directory is required' }
    const p = createProject(name, typeof directory === 'string' ? directory.trim() : directory)
    setCurrentProject(p.directory)
    checkSteeringPrompt(p.directory, getMainWindow)
    return p
  })

  ipcMain.handle('open-project', (_, id) => {
    if (!isNonEmptyString(id)) return null
    const p = openProject(id)
    if (p) {
      setCurrentProject(p.directory)
      checkSteeringPrompt(p.directory, getMainWindow)
    }
    return p
  })

  ipcMain.handle('delete-project', (_, id) => {
    if (!isNonEmptyString(id)) return { error: 'id is required' }
    deleteProject(id)
    return { ok: true }
  })

  ipcMain.handle('get-history', (_, projectId) => {
    if (!isNonEmptyString(projectId)) return []
    return getHistory(projectId)
  })

  ipcMain.handle('append-history', (_, projectId, message) => {
    if (!isNonEmptyString(projectId)) return { error: 'projectId is required' }
    return appendHistory(projectId, message)
  })

  ipcMain.handle('clear-history', (_, projectId) => {
    if (!isNonEmptyString(projectId)) return { error: 'projectId is required' }
    clearHistory(projectId)
    return { ok: true }
  })

  ipcMain.handle('build-context', (_, directory) => {
    if (!isNonEmptyString(directory)) return ''
    return buildProjectContext(directory)
  })

  // ── sessions ────────────────────────────────────────────────────────────
  ipcMain.handle('list-sessions', (_, projectId) => {
    if (!isNonEmptyString(projectId)) return []
    return listSessions(projectId)
  })

  ipcMain.handle('create-session', (_, projectId, name, sessionType) => {
    if (!isNonEmptyString(projectId)) return { error: 'projectId is required' }
    if (!isNonEmptyString(name)) return { error: 'name is required' }
    return createSession(projectId, name, sessionType)
  })

  ipcMain.handle('rename-session', (_, projectId, sessionId, name) => {
    if (!isNonEmptyString(projectId) || !isNonEmptyString(sessionId)) return { error: 'projectId and sessionId are required' }
    return renameSession(projectId, sessionId, name)
  })

  ipcMain.handle('delete-session', (_, projectId, sessionId) => {
    if (!isNonEmptyString(projectId) || !isNonEmptyString(sessionId)) return { error: 'projectId and sessionId are required' }
    deleteSession(projectId, sessionId)
    return { ok: true }
  })

  ipcMain.handle('get-session-messages', (_, projectId, sessionId) => {
    if (!isNonEmptyString(projectId) || !isNonEmptyString(sessionId)) return []
    return getSessionMessages(projectId, sessionId)
  })

  ipcMain.handle('append-session-message', (_, projectId, sessionId, message) => {
    if (!isNonEmptyString(projectId) || !isNonEmptyString(sessionId)) return { error: 'projectId and sessionId are required' }
    return appendSessionMessage(projectId, sessionId, message)
  })

  ipcMain.handle('clear-session-messages', (_, projectId, sessionId) => {
    if (!isNonEmptyString(projectId) || !isNonEmptyString(sessionId)) return { error: 'ids are required' }
    clearSessionMessages(projectId, sessionId)
    return { ok: true }
  })

  ipcMain.handle('set-session-messages', (_, projectId, sessionId, messages) => {
    if (!isNonEmptyString(projectId) || !isNonEmptyString(sessionId)) return { error: 'ids are required' }
    if (!Array.isArray(messages)) return { error: 'messages must be an array' }
    return setSessionMessages(projectId, sessionId, messages)
  })

  // ── session todos & chat snapshot ───────────────────────────────────────
  ipcMain.handle('get-session-todos', (_, projectId, sessionId) => {
    if (!isNonEmptyString(projectId) || !isNonEmptyString(sessionId)) return []
    return getSessionTodos(projectId, sessionId)
  })

  ipcMain.handle('save-session-todos', (_, projectId, sessionId, todos) => {
    if (!isNonEmptyString(projectId) || !isNonEmptyString(sessionId)) return { error: 'ids are required' }
    return saveSessionTodos(projectId, sessionId, todos)
  })

  ipcMain.handle('get-session-chat-snapshot', (_, projectId, sessionId) => {
    if (!isNonEmptyString(projectId) || !isNonEmptyString(sessionId)) return null
    return getSessionChatSnapshot(projectId, sessionId)
  })

  ipcMain.handle('save-session-chat-snapshot', (_, projectId, sessionId, snapshot) => {
    if (!isNonEmptyString(projectId) || !isNonEmptyString(sessionId)) return { error: 'ids are required' }
    return saveSessionChatSnapshot(projectId, sessionId, snapshot)
  })

  // ── session workflow state (spec + task graph) ──────────────────────────
  ipcMain.handle('get-session-workflow-state', (_, projectId, sessionId) => {
    if (!isNonEmptyString(projectId) || !isNonEmptyString(sessionId)) return null
    return getSessionWorkflowState(projectId, sessionId)
  })

  ipcMain.handle('save-session-workflow-state', (_, projectId, sessionId, state) => {
    if (!isNonEmptyString(projectId) || !isNonEmptyString(sessionId)) return { error: 'ids are required' }
    return saveSessionWorkflowState(projectId, sessionId, state)
  })

  // ── context settings ────────────────────────────────────────────────────
  ipcMain.handle('get-settings', (_, projectId) => {
    if (!isNonEmptyString(projectId)) return DEFAULT_SETTINGS
    return getSettings(projectId)
  })

  ipcMain.handle('save-settings', (_, projectId, settings) => {
    if (!isNonEmptyString(projectId)) return { error: 'projectId is required' }
    if (!settings || typeof settings !== 'object') return { error: 'settings must be an object' }
    return saveSettings(projectId, settings)
  })

  ipcMain.handle('get-default-settings', () => DEFAULT_SETTINGS)

  // ── API keys (global) ───────────────────────────────────────────────────
  ipcMain.handle('get-api-keys', () => getApiKeys())

  ipcMain.handle('save-api-keys', (_, keys) => {
    if (!keys || typeof keys !== 'object') return { error: 'keys must be an object' }
    return saveApiKeys(keys)
  })

  // ── app settings (global) ─────────────────────────────────────────────
  ipcMain.handle('get-app-settings', () => getAppSettings())

  ipcMain.handle('save-app-settings', (_, settings) => {
    if (!settings || typeof settings !== 'object') return { error: 'settings must be an object' }
    const result = saveAppSettings(settings)
    // Start/stop Robin Router based on settings change
    try {
      const { robinRouter } = require('../robin-router')
      if (result.robinAutoEnabled && result.openrouterApiKey) {
        if (!robinRouter.enabled) {
          robinRouter.start(result.openrouterApiKey).catch(() => {})
        }
      } else {
        robinRouter.stop()
      }
    } catch (_) {}
    return result
  })

  // ── Robin Router stats ──────────────────────────────────────────────────
  ipcMain.handle('robin-stats', () => {
    try {
      const { robinRouter } = require('../robin-router')
      return { enabled: robinRouter.enabled, ...robinRouter.getStats(), models: robinRouter.getModels().slice(0, 5) }
    } catch (_) { return { enabled: false } }
  })
}

module.exports = { register, checkSteeringPrompt }
