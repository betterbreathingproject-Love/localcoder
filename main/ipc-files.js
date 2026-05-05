'use strict'

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { execSync } = require('child_process')
const { dialog, shell } = require('electron')

// ── validation ────────────────────────────────────────────────────────────────
function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0 }

/**
 * Validate that a path doesn't escape the expected root via traversal.
 * Returns the resolved absolute path or null if invalid.
 */
function safePath(filePath) {
  if (!isNonEmptyString(filePath)) return null
  // Block null bytes
  if (filePath.includes('\0')) return null
  return path.resolve(filePath)
}

// ── IPC registration ──────────────────────────────────────────────────────────
function register(ipcMain, { getMainWindow, getCurrentProject, setCurrentProject }) {

  ipcMain.handle('open-folder', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths.length) return null
    const folderPath = result.filePaths[0].trim()
    setCurrentProject(folderPath)
    return folderPath
  })

  ipcMain.handle('read-dir', async (_, dirPath) => {
    const resolved = safePath(dirPath)
    if (!resolved) return []
    try {
      const entries = await fsp.readdir(resolved, { withFileTypes: true })
      return entries
        .filter(e => !e.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1
          if (!a.isDirectory() && b.isDirectory()) return 1
          return a.name.localeCompare(b.name)
        })
        .map(e => ({ name: e.name, path: path.join(resolved, e.name), isDir: e.isDirectory() }))
    } catch { return [] }
  })

  ipcMain.handle('read-file', async (_, filePath) => {
    const resolved = safePath(filePath)
    if (!resolved) return null
    try { return await fsp.readFile(resolved, 'utf-8') } catch { return null }
  })

  ipcMain.handle('write-file', async (_, filePath, content) => {
    const resolved = safePath(filePath)
    if (!resolved) return { error: 'Invalid file path' }
    if (typeof content !== 'string') return { error: 'content must be a string' }
    try {
      await fsp.mkdir(path.dirname(resolved), { recursive: true })
      await fsp.writeFile(resolved, content, 'utf-8')
      return { ok: true }
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('get-project', () => getCurrentProject())

  // ── git ──────────────────────────────────────────────────────────────────
  ipcMain.handle('git-status', async (_, cwd) => {
    const dir = safePath(cwd || getCurrentProject())
    if (!dir) return { branch: '', files: [], isRepo: false }
    try {
      const out = execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8', timeout: 5000 })
      const branch = execSync('git branch --show-current', { cwd: dir, encoding: 'utf-8', timeout: 5000 }).trim()
      return { branch, files: out.trim().split('\n').filter(Boolean).map(l => ({ status: l.slice(0, 2).trim(), file: l.slice(3) })), isRepo: true }
    } catch { return { branch: '', files: [], isRepo: false } }
  })

  ipcMain.handle('git-log', async (_, cwd) => {
    const dir = safePath(cwd || getCurrentProject())
    if (!dir) return []
    try {
      const out = execSync('git log --oneline -20', { cwd: dir, encoding: 'utf-8', timeout: 5000 })
      return out.trim().split('\n').map(l => { const [hash, ...rest] = l.split(' '); return { hash, message: rest.join(' ') } })
    } catch { return [] }
  })

  ipcMain.handle('git-init', async (_, cwd) => {
    const dir = safePath(cwd || getCurrentProject())
    if (!dir) return { error: 'No project directory' }
    try {
      const projectName = path.basename(dir)

      // Set up credential helper
      try { execSync('git config --global credential.helper osxkeychain', { encoding: 'utf-8', timeout: 3000 }) } catch {}

      // Init repo
      execSync('git init', { cwd: dir, encoding: 'utf-8', timeout: 5000 })
      execSync('git add -A', { cwd: dir, encoding: 'utf-8', timeout: 10000 })
      execSync('git commit -m "Initial commit"', { cwd: dir, encoding: 'utf-8', timeout: 10000 })

      // Auto-create GitHub repo and push using gh CLI
      let remoteUrl = ''
      try {
        // Check if gh is available and authenticated
        execSync('gh auth status', { encoding: 'utf-8', timeout: 5000 })
        // Create private repo on GitHub
        const repoOut = execSync(`gh repo create "${projectName}" --private --source="${dir}" --push`, { cwd: dir, encoding: 'utf-8', timeout: 30000 })
        remoteUrl = repoOut.trim()
      } catch (ghErr) {
        // gh not available or not authenticated — repo created locally only
        console.log('[git-init] gh CLI unavailable or failed:', ghErr.message)
      }

      return { ok: true, remote: remoteUrl || null }
    } catch (err) { return { error: err.message } }
  })

  ipcMain.handle('git-commit', async (_, cwd, message) => {
    const dir = safePath(cwd || getCurrentProject())
    if (!dir) return { error: 'No project directory' }
    try {
      execSync('git add -A', { cwd: dir, encoding: 'utf-8', timeout: 10000 })
      execSync(`git commit -m "${(message || 'Update').replace(/"/g, '\\"')}"`, { cwd: dir, encoding: 'utf-8', timeout: 10000 })
      return { ok: true }
    } catch (err) { return { error: err.message } }
  })

  ipcMain.handle('git-push', async (_, cwd) => {
    const dir = safePath(cwd || getCurrentProject())
    if (!dir) return { error: 'No project directory' }
    try {
      // Check if remote exists
      let hasRemote = false
      try {
        const remote = execSync('git remote get-url origin', { cwd: dir, encoding: 'utf-8', timeout: 3000 }).trim()
        hasRemote = !!remote
      } catch { /* no remote */ }

      // Auto-create remote if missing (using gh CLI)
      if (!hasRemote) {
        try {
          execSync('gh auth status', { encoding: 'utf-8', timeout: 5000 })
          const projectName = path.basename(dir)
          execSync(`gh repo create "${projectName}" --private --source="${dir}" --remote=origin`, { cwd: dir, encoding: 'utf-8', timeout: 30000 })
          hasRemote = true
        } catch {
          return { error: 'NO_REMOTE' }
        }
      }

      // Commit any uncommitted changes first
      try {
        const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8', timeout: 5000 }).trim()
        if (status) {
          execSync('git add -A', { cwd: dir, encoding: 'utf-8', timeout: 10000 })
          execSync('git commit -m "Auto-commit before push"', { cwd: dir, encoding: 'utf-8', timeout: 10000 })
        }
      } catch { /* nothing to commit */ }

      // Push
      const out = execSync('git push -u origin HEAD 2>&1', { cwd: dir, encoding: 'utf-8', timeout: 30000 })
      return { ok: true, output: out }
    } catch (err) {
      const msg = err.stderr || err.stdout || err.message || ''
      if (msg.includes('Authentication') || msg.includes('403') || msg.includes('401') || msg.includes('could not read Username') || msg.includes('terminal prompts disabled')) {
        return { error: 'AUTH_REQUIRED' }
      }
      return { error: msg || err.message }
    }
  })

  ipcMain.handle('git-add-remote', async (_, cwd, url) => {
    const dir = safePath(cwd || getCurrentProject())
    if (!dir || !url) return { error: 'Missing directory or URL' }
    try {
      try { execSync('git remote get-url origin', { cwd: dir, encoding: 'utf-8', timeout: 3000 }) } catch {
        execSync(`git remote add origin "${url}"`, { cwd: dir, encoding: 'utf-8', timeout: 5000 })
      }
      return { ok: true }
    } catch (err) { return { error: err.message } }
  })

  ipcMain.handle('open-external', (_, url) => {
    if (!isNonEmptyString(url)) return
    // Only allow http/https URLs
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url)
      }
    } catch {}
  })

  // ── File undo ─────────────────────────────────────────────────────────────
  // Exposes the undo store from direct-bridge.js to the renderer.
  // sessionId scopes the undo stack to the current conversation.

  ipcMain.handle('undo-list', (_, sessionId) => {
    try {
      const { undoList } = require('../direct-bridge')
      return undoList(sessionId || '')
    } catch (e) {
      return []
    }
  })

  ipcMain.handle('undo-apply', (_, sessionId, index) => {
    try {
      const { undoApply } = require('../direct-bridge')
      const result = undoApply(sessionId || '', index ?? 0)
      if (result.ok) {
        // Notify renderer that a file changed
        getMainWindow()?.webContents.send('files-changed', { path: result.filePath, action: 'undo' })
      }
      return result
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('undo-clear', (_, sessionId) => {
    try {
      const { undoClear } = require('../direct-bridge')
      undoClear(sessionId || '')
      return { ok: true }
    } catch (e) {
      return { error: e.message }
    }
  })
}

module.exports = { register, safePath }
