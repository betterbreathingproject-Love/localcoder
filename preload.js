const { contextBridge, ipcRenderer } = require('electron')

// ── Setup wizard bridge ───────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('setup', {
  getInfo:        ()     => ipcRenderer.invoke('setup-get-info'),
  openUrl:        (url)  => ipcRenderer.invoke('setup-open-url', url),
  scanModels:     ()     => ipcRenderer.invoke('setup-scan-models'),
  complete:       (info) => ipcRenderer.invoke('setup-complete', info),
  isComplete:     ()     => ipcRenderer.invoke('setup-is-complete'),
  reset:          ()     => ipcRenderer.invoke('setup-reset'),
  launch:         ()     => ipcRenderer.invoke('setup-launch-main'),
  calibStatus:    ()     => ipcRenderer.invoke('calibration-status'),
  getModelsDir:   ()     => ipcRenderer.invoke('setup-get-models-dir'),
  pickModelsDir:  ()     => ipcRenderer.invoke('setup-pick-models-dir'),
  saveModelsDir:  (dir)  => ipcRenderer.invoke('setup-save-models-dir', dir),
  checkDeps:      ()     => ipcRenderer.invoke('setup-check-deps'),
  installDeps:    ()     => ipcRenderer.invoke('setup-install-deps'),
  onInstallLog:   (cb)   => ipcRenderer.on('setup-install-log', (_, line) => cb(line)),
  offInstallLog:  ()     => ipcRenderer.removeAllListeners('setup-install-log'),
  onCalibComplete:  (cb) => ipcRenderer.on('calibration-complete', (_, d) => cb(d)),
  offCalibComplete: ()   => ipcRenderer.removeAllListeners('calibration-complete'),
  checkPermissions:   ()       => ipcRenderer.invoke('setup-check-permissions'),
  openSystemPrefs:    (permId) => ipcRenderer.invoke('setup-open-system-prefs', permId),
})

contextBridge.exposeInMainWorld('app', {
  // server
  serverStart:    ()        => ipcRenderer.invoke('server-start'),
  serverStop:     ()        => ipcRenderer.invoke('server-stop'),
  serverRestart:  ()        => ipcRenderer.invoke('server-restart'),
  serverStatus:   ()        => ipcRenderer.invoke('server-status'),
  loadModel:      (p)       => ipcRenderer.invoke('load-model', p),
  chat:           (p)       => ipcRenderer.invoke('chat', p),
  getServerUrl:   ()        => ipcRenderer.invoke('get-server-url'),

  // streaming chat
  chatStream:     (p)       => ipcRenderer.send('chat-stream', p),
  chatStreamAbort:()        => ipcRenderer.invoke('chat-stream-abort'),
  onStreamChunk:  (cb)      => ipcRenderer.on('chat-stream-chunk', (_, d) => cb(d)),
  onStreamStats:  (cb)      => ipcRenderer.on('chat-stream-stats', (_, d) => cb(d)),
  onStreamDone:   (cb)      => ipcRenderer.on('chat-stream-done',  ()    => cb()),
  onStreamError:  (cb)      => ipcRenderer.on('chat-stream-error', (_, e) => cb(e)),
  offStream:      ()        => { for (const c of ['chat-stream-chunk','chat-stream-stats','chat-stream-done','chat-stream-error','chat-stream-finish-reason']) ipcRenderer.removeAllListeners(c) },
  onStreamFinishReason: (cb) => ipcRenderer.on('chat-stream-finish-reason', (_, d) => cb(d)),

  // qwen code agent
  qwenRun:        (p)       => ipcRenderer.invoke('qwen-run', { prompt: p.prompt, cwd: p.cwd, permissionMode: p.permissionMode, agentRole: p.agentRole, model: p.model, images: p.images, conversationHistory: p.conversationHistory, samplingParams: p.samplingParams, taskGraphPath: p.taskGraphPath }),
  qwenInterrupt:  ()        => ipcRenderer.invoke('qwen-interrupt'),
  onQwenEvent:    (cb)      => ipcRenderer.on('qwen-event', (_, d) => cb(d)),
  offQwenEvents:  ()        => ipcRenderer.removeAllListeners('qwen-event'),

  // ask_user — desktop input channel
  askUserReply:   (reply)   => ipcRenderer.invoke('ask-user-reply', reply),

  // steering docs
  steeringList:   ()        => ipcRenderer.invoke('steering-list'),
  steeringCreate: (p)       => ipcRenderer.invoke('steering-create', p),

  // agent roles
  agentRolesList:   ()      => ipcRenderer.invoke('agent-roles-list'),
  agentRoleSave:    (r)     => ipcRenderer.invoke('agent-role-save', r),
  agentRoleDelete:  (n)     => ipcRenderer.invoke('agent-role-delete', n),
  agentRoleGenerate:(p)     => ipcRenderer.invoke('agent-role-generate', p),

  // filesystem
  openFolder:     ()        => ipcRenderer.invoke('open-folder'),
  readDir:        (p)       => ipcRenderer.invoke('read-dir', p),
  readFile:       (p)       => ipcRenderer.invoke('read-file', p),
  writeFile:      (p, c)    => ipcRenderer.invoke('write-file', p, c),
  getProject:     ()        => ipcRenderer.invoke('get-project'),

  // git
  gitStatus:      (c)       => ipcRenderer.invoke('git-status', c),
  gitLog:         (c)       => ipcRenderer.invoke('git-log', c),
  gitInit:        (c)       => ipcRenderer.invoke('git-init', c),
  gitCommit:      (c, msg)  => ipcRenderer.invoke('git-commit', c, msg),
  gitPush:        (c)       => ipcRenderer.invoke('git-push', c),
  gitAddRemote:   (c, url)  => ipcRenderer.invoke('git-add-remote', c, url),

  // misc
  openExternal:   (u)       => ipcRenderer.invoke('open-external', u),
  onServerLog:    (cb)      => ipcRenderer.on('server-log', (_, m) => cb(m)),
  onServerStatus: (cb)      => ipcRenderer.on('server-status', (_, s) => cb(s)),
  onServerCrashed:(cb)      => ipcRenderer.on('server-crashed', (_, s) => cb(s)),

  // projects
  listProjects:   ()        => ipcRenderer.invoke('list-projects'),
  createProject:  (n, d)    => ipcRenderer.invoke('create-project', n, d),
  openProjectById:(id)      => ipcRenderer.invoke('open-project', id),
  deleteProject:  (id)      => ipcRenderer.invoke('delete-project', id),
  getHistory:     (id)      => ipcRenderer.invoke('get-history', id),
  appendHistory:  (id, m)   => ipcRenderer.invoke('append-history', id, m),
  clearHistory:   (id)      => ipcRenderer.invoke('clear-history', id),
  buildContext:   (d)       => ipcRenderer.invoke('build-context', d),

  // sessions
  listSessions:   (pid)     => ipcRenderer.invoke('list-sessions', pid),
  createSession:  (pid, n, t) => ipcRenderer.invoke('create-session', pid, n, t),
  renameSession:  (pid,sid,n) => ipcRenderer.invoke('rename-session', pid, sid, n),
  deleteSession:  (pid,sid) => ipcRenderer.invoke('delete-session', pid, sid),
  getSessionMsgs: (pid,sid) => ipcRenderer.invoke('get-session-messages', pid, sid),
  appendSessionMsg:(pid,sid,m) => ipcRenderer.invoke('append-session-message', pid, sid, m),
  clearSessionMsgs:(pid,sid) => ipcRenderer.invoke('clear-session-messages', pid, sid),
  setSessionMsgs: (pid,sid,m) => ipcRenderer.invoke('set-session-messages', pid, sid, m),

  // session todos & chat snapshot
  getSessionTodos:  (pid,sid) => ipcRenderer.invoke('get-session-todos', pid, sid),
  saveSessionTodos: (pid,sid,t) => ipcRenderer.invoke('save-session-todos', pid, sid, t),
  getSessionSnapshot: (pid,sid) => ipcRenderer.invoke('get-session-chat-snapshot', pid, sid),
  saveSessionSnapshot:(pid,sid,s) => ipcRenderer.invoke('save-session-chat-snapshot', pid, sid, s),

  // session workflow state (spec + task graph)
  getSessionWorkflowState:  (pid,sid) => ipcRenderer.invoke('get-session-workflow-state', pid, sid),
  saveSessionWorkflowState: (pid,sid,s) => ipcRenderer.invoke('save-session-workflow-state', pid, sid, s),

  // context settings
  getSettings:    (id)      => ipcRenderer.invoke('get-settings', id),
  saveSettings:   (id, s)   => ipcRenderer.invoke('save-settings', id, s),
  getDefaultSettings: ()    => ipcRenderer.invoke('get-default-settings'),

  // API keys
  getApiKeys:     ()        => ipcRenderer.invoke('get-api-keys'),
  saveApiKeys:    (k)       => ipcRenderer.invoke('save-api-keys', k),

  // app settings (global)
  getAppSettings: ()        => ipcRenderer.invoke('get-app-settings'),
  saveAppSettings:(s)       => ipcRenderer.invoke('save-app-settings', s),
  robinStats: ()            => ipcRenderer.invoke('robin-stats'),

  // setup wizard
  openSetupWizard:()        => ipcRenderer.invoke('open-setup-wizard'),

  // compactor
  compactorStatus:()        => ipcRenderer.invoke('compactor-status'),
  compactMessages:(m, o)    => ipcRenderer.invoke('compactor-compress-messages', m, o),
  compactText:    (t, ct)   => ipcRenderer.invoke('compactor-compress-text', t, ct),

  // task graph
  taskGraphParse:   (f)     => ipcRenderer.invoke('task-graph-parse', f),
  taskGraphExecute: (f, p)  => ipcRenderer.invoke('task-graph-execute', f, p),
  taskGraphPause:   ()      => ipcRenderer.invoke('task-graph-pause'),
  taskGraphAbort:   ()      => ipcRenderer.invoke('task-graph-abort'),
  taskGraphInject:  (msg)   => ipcRenderer.invoke('task-graph-inject', msg),
  taskGraphResume:  ()      => ipcRenderer.invoke('task-graph-resume'),
  taskGraphStatus:  ()      => ipcRenderer.invoke('task-graph-status'),

  // background tasks
  bgTaskList:       ()      => ipcRenderer.invoke('bg-task-list'),
  bgTaskCancel:     (id)    => ipcRenderer.invoke('bg-task-cancel', id),
  bgTaskOutput:     (id)    => ipcRenderer.invoke('bg-task-output', id),

  // AST search
  astSearch:        (p, c)  => ipcRenderer.invoke('ast-search', p, c),
  astPatterns:      ()      => ipcRenderer.invoke('ast-patterns'),
  astSearchStatus:  ()      => ipcRenderer.invoke('ast-search-status'),

  // spec workflow
  specInit:         (n, t)  => ipcRenderer.invoke('spec-init', n, t),
  specPhase:        (d)     => ipcRenderer.invoke('spec-phase', d),
  specAdvance:      (d)     => ipcRenderer.invoke('spec-advance', d),
  specArtifacts:    (d)     => ipcRenderer.invoke('spec-artifacts', d),
  specSaveArtifact: (d,p,c) => ipcRenderer.invoke('spec-save-artifact', d, p, c),
  specConfig:       (d)     => ipcRenderer.invoke('spec-config', d),
  specSaveConfig:   (d, u)  => ipcRenderer.invoke('spec-save-config', d, u),
  specList:         ()      => ipcRenderer.invoke('spec-list'),
  specDelete:       (n)     => ipcRenderer.invoke('spec-delete', n),

  // LSP
  lspStatus:         ()     => ipcRenderer.invoke('lsp-status'),
  lspSymbols:        (p)    => ipcRenderer.invoke('lsp-symbols', p),
  onLspStatusChange: (cb)   => ipcRenderer.on('lsp-status-change', (_, d) => cb(d)),
  offLspStatusChange:()     => ipcRenderer.removeAllListeners('lsp-status-change'),
  onLspDiagnostics:  (cb)   => ipcRenderer.on('lsp-diagnostics', (_, d) => cb(d)),
  offLspDiagnostics: ()     => ipcRenderer.removeAllListeners('lsp-diagnostics'),

  // Calibration
  getCalibration:        ()   => ipcRenderer.invoke('get-calibration'),
  calibrationStatus:     ()   => ipcRenderer.invoke('calibration-status'),
  recalibrate:           (modelId) => ipcRenderer.invoke('recalibrate', modelId),
  calibrationSetMode:    (mode)    => ipcRenderer.invoke('calibration-set-mode', mode),
  onCalibrationComplete: (cb) => ipcRenderer.on('calibration-complete', (_, d) => cb(d)),
  offCalibrationComplete:()   => ipcRenderer.removeAllListeners('calibration-complete'),
  onCalibrationStatus:   (cb) => ipcRenderer.on('calibration-status', (_, d) => cb(d)),
  offCalibrationStatus:  ()   => ipcRenderer.removeAllListeners('calibration-status'),

  // Memory — extraction model + fast assist
  loadExtractionModel:   (modelPath) => ipcRenderer.invoke('memory-extractor-load', modelPath),
  unloadExtractionModel: ()          => ipcRenderer.invoke('memory-extractor-unload'),
  getMemoryStatus:       ()          => ipcRenderer.invoke('memory-status'),
  assistChatReply:       (msg, role) => ipcRenderer.invoke('assist-chat-reply', msg, role),
  onFastModelStatus:     (cb)        => ipcRenderer.on('fast-model-status', (_, d) => cb(d)),
  offFastModelStatus:    ()          => ipcRenderer.removeAllListeners('fast-model-status'),

  // Memory bank — archive viewer, KG query, stats
  memoryArchiveSearch:   (q, limit, projectId) => ipcRenderer.invoke('memory-archive-search', q, limit, projectId),
  memoryArchiveEvents:   (limit, projectId)    => ipcRenderer.invoke('memory-archive-events', limit, projectId),
  memoryKgQuery:         (entity)              => ipcRenderer.invoke('memory-kg-query', entity),
  memoryStats:           (projectId)           => ipcRenderer.invoke('memory-stats', projectId),

  // Speculative decoding + KV cache quantization + prefix cache
  speculativeSet:  (opts)  => ipcRenderer.invoke('speculative-set', opts),
  kvCacheSet:      (bits)  => ipcRenderer.invoke('kv-cache-set', bits),
  prefixCacheSet:  (opts)  => ipcRenderer.invoke('prefix-cache-set', opts),
  prefixCacheStatus: ()    => ipcRenderer.invoke('prefix-cache-status'),

  // File undo — restore files to their state before the last agent write/edit
  undoList:        (sid)        => ipcRenderer.invoke('undo-list', sid),
  undoApply:       (sid, idx)   => ipcRenderer.invoke('undo-apply', sid, idx),
  undoClear:       (sid)        => ipcRenderer.invoke('undo-clear', sid),

  // Telegram
  telegramPair:      ()      => ipcRenderer.invoke('telegram-pair'),
  telegramStatus:    ()      => ipcRenderer.invoke('telegram-status'),
  telegramStart:     (token) => ipcRenderer.invoke('telegram-start', token),
  telegramStop:      ()      => ipcRenderer.invoke('telegram-stop'),
  telegramGetToken:  ()      => ipcRenderer.invoke('telegram-get-token'),
  onTelegramUnavailable: (cb) => ipcRenderer.on('telegram-unavailable', (_, d) => cb(d)),
  offTelegramUnavailable: () => ipcRenderer.removeAllListeners('telegram-unavailable'),

  // Mini App
  miniappStart:      ()     => ipcRenderer.invoke('miniapp-start'),
  miniappStop:       ()     => ipcRenderer.invoke('miniapp-stop'),
  miniappStatus:     ()     => ipcRenderer.invoke('miniapp-status'),

  // terminal
  terminalCreate:    (opts) => ipcRenderer.invoke('terminal-create', opts),
  terminalWrite:     (id, data) => ipcRenderer.invoke('terminal-write', { id, data }),
  terminalResize:    (id, cols, rows) => ipcRenderer.invoke('terminal-resize', { id, cols, rows }),
  terminalClose:     (id)   => ipcRenderer.invoke('terminal-close', { id }),
  terminalCloseAll:  ()     => ipcRenderer.invoke('terminal-close-all'),
  terminalList:      ()     => ipcRenderer.invoke('terminal-list'),
  terminalRunInteractive: (cmd, cwd) => ipcRenderer.invoke('terminal-run-interactive', { command: cmd, cwd }),
  terminalReadBuffer:(id, lines) => ipcRenderer.invoke('terminal-read-buffer', { id, lines }),
  onTerminalOutput:  (cb)   => ipcRenderer.on('terminal-output', (_, d) => cb(d)),
  onTerminalExit:    (cb)   => ipcRenderer.on('terminal-exit', (_, d) => cb(d)),
  onTerminalFocus:   (cb)   => ipcRenderer.on('terminal-focus', (_, d) => cb(d)),
  offTerminalEvents: ()     => { for (const c of ['terminal-output','terminal-exit','terminal-focus']) ipcRenderer.removeAllListeners(c) },

  // events
  onTaskStatusEvent:(cb)    => ipcRenderer.on('task-status-event', (_, d) => cb(d)),
  onOrchestratorEvent:(cb)  => ipcRenderer.on('orchestrator-agent-event', (_, d) => cb(d)),
  offOrchestratorEvents:()  => ipcRenderer.removeAllListeners('orchestrator-agent-event'),
  onOrchestratorCompleted:(cb) => ipcRenderer.on('orchestrator-completed', () => cb()),
  offOrchestratorCompleted:() => ipcRenderer.removeAllListeners('orchestrator-completed'),
  onBgTaskEvent:    (cb)    => ipcRenderer.on('bg-task-event', (_, d) => cb(d)),
  onFilesChanged:   (cb)    => ipcRenderer.on('files-changed', (_, d) => cb(d)),
  offFilesChanged:  ()      => ipcRenderer.removeAllListeners('files-changed'),
  watchProject:     (d)     => ipcRenderer.invoke('watch-project', d),
  unwatchProject:   ()      => ipcRenderer.invoke('unwatch-project'),
})
