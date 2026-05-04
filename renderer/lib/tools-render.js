// Tool use rendering — extracted from app.js

function _toolDisplayName(name) {
  // Clean up tool names: mcp__vision__vision_analyze → vision_analyze, read_file → Read File
  let display = name
  if (display.startsWith('mcp__')) {
    const parts = display.split('__')
    display = parts[parts.length - 1]
  }
  return display.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function _renderToolParams(input) {
  if (!input || (typeof input === 'string' && !input.trim())) return ''
  const obj = typeof input === 'string' ? (() => { try { return JSON.parse(input) } catch { return null } })() : input
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    const str = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
    return `<div class="tool-param"><span class="tool-param-val">${esc(str)}</span></div>`
  }
  const entries = Object.entries(obj)
  if (entries.length === 0) return ''
  return entries.map(([key, val]) => {
    let display
    if (typeof val === 'string') {
      display = val.length > 300 ? val.slice(0, 300) + '…' : val
    } else {
      const s = JSON.stringify(val, null, 2)
      display = s.length > 300 ? s.slice(0, 300) + '…' : s
    }
    return `<div class="tool-param">
      <span class="tool-param-key">${esc(key)}</span>
      <span class="tool-param-val">${esc(display)}</span>
    </div>`
  }).join('')
}

function renderToolUse(name, input, status='running') {
  const id = 'tool-' + Date.now() + '-' + Math.random().toString(36).slice(2,6)

  // Special case: task_complete — render the summary as formatted content
  if (name === 'task_complete') {
    const obj = typeof input === 'string' ? (() => { try { return JSON.parse(input) } catch { return null } })() : input
    const summary = (obj?.summary || '').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"')
    const rendered = summary ? esc(summary).replace(/\n/g, '<br>') : 'Task completed.'
    return `<div class="tool-block ${status}" id="${id}">
      <div class="tool-header">
        <span class="tool-icon">🏁</span>
        <div class="tool-header-info">
          <span class="tool-name">Task Complete</span>
          <span class="tool-name-raw">task_complete</span>
        </div>
        <span class="tool-status ${status}">${status === 'done' ? '✓ Done' : 'Running…'}</span>
      </div>
      <div class="tool-result-body" style="padding:10px 14px;font-size:13px;line-height:1.6">${rendered}</div>
    </div>`
  }

  const icons = { read_file:'📖', read_files:'📚', write_file:'✏️', edit_file:'✏️', edit_files:'✏️', bash:'⚡', search:'🔍', list_dir:'📁',
    browser_navigate:'🌐', browser_screenshot:'📸', browser_click:'👆', browser_type:'⌨️',
    browser_get_text:'📄', browser_get_html:'🧾', browser_evaluate:'⚙️', browser_wait_for:'⏳',
    browser_select_option:'☑️', browser_close:'🚪', vision_analyze:'👁️',
    web_search:'🔎', web_fetch:'🌍', default:'🔧' }
  const icon = icons[name] || icons[name.split('__').pop()] || icons.default
  const displayName = _toolDisplayName(name)
  const statusLabel = status === 'running' ? 'Running…' : status === 'done' ? 'Done' : status === 'error' ? 'Error' : status
  const statusIcon = status === 'running' ? '<span class="tool-spinner"></span>' : status === 'done' ? '✓' : status === 'error' ? '✗' : ''
  const params = _renderToolParams(input)

  // Read-type tools auto-collapse when done — result is hidden unless expanded
  const READ_TOOLS = new Set(['read_file', 'read_files', 'list_dir', 'web_fetch', 'web_search', 'browser_get_text', 'browser_get_html'])
  const autoCollapse = READ_TOOLS.has(name) ? ' auto-collapse' : ''

  return `<div class="tool-block${autoCollapse} ${status}" id="${id}">
    <div class="tool-header" onclick="this.parentElement.toggleAttribute('open')">
      <span class="tool-icon">${icon}</span>
      <div class="tool-header-info">
        <span class="tool-name">${esc(displayName)}</span>
        <span class="tool-name-raw">${esc(name)}</span>
      </div>
      <span class="tool-status ${status}">${statusIcon} ${statusLabel}</span>
      <span class="tool-chevron">▸</span>
    </div>
    ${params ? `<div class="tool-params">${params}</div>` : ''}
    <div class="tool-body-raw">${esc(typeof input === 'string' ? input : JSON.stringify(input, null, 2))}</div>
  </div>`
}

function _renderTodoBlock(id, input, status) {
  const obj = typeof input === 'string' ? (() => { try { return JSON.parse(input) } catch { return null } })() : input
  const todos = obj?.todos || (Array.isArray(obj) ? obj : [])

  // Update the persistent todo panel instead of rendering inline
  updateTodoPanel(todos, status)

  // Return a minimal inline indicator instead of a full block
  const statusLabel = status === 'running' ? 'Updating…' : status === 'done' ? '✓ Done' : status === 'error' ? '✗ Error' : status
  const statusCls = status === 'done' ? 'todo-status-done' : status === 'error' ? 'todo-status-error' : 'todo-status-running'
  return `<div class="tool-block todo-block ${status}" id="${id}" style="display:none">
    <span class="todo-status ${statusCls}">${statusLabel}</span>
  </div>`
}

function updateTodoPanel(todos, status) {
  const panel = document.getElementById('todoPanel')
  const body = document.getElementById('todoPanelBody')
  const countEl = document.getElementById('todoPanelCount')
  if (!panel || !body) return

  panel.style.display = 'block'

  // Merge incoming todos with existing ones to prevent data loss when the
  // model sends a partial update (e.g., only the items it changed).
  // Always merge by id when we have existing todos — this prevents duplication
  // when the bootstrap and the model both send todo lists with overlapping content.
  let merged = todos
  if (currentTodos.length > 0 && todos.length > 0) {
    // Build a map of incoming updates keyed by id (normalise to string for comparison)
    const updates = new Map(todos.map(t => [String(t.id), t]))
    // Start from the existing list and apply updates
    merged = currentTodos.map(existing => {
      const update = updates.get(String(existing.id))
      return update ? { ...existing, ...update } : existing
    })
    // Add any new items from the incoming list that weren't in the existing list
    for (const t of todos) {
      if (!currentTodos.some(e => String(e.id) === String(t.id))) merged.push(t)
    }
    // If the incoming list is a full replacement (same or more items and all IDs
    // are new — e.g. model reset the list), use it directly instead of merging.
    const allNew = todos.every(t => !currentTodos.some(e => String(e.id) === String(t.id)))
    if (allNew) merged = todos
  }

  // Persist todos to session storage
  currentTodos = merged
  if (activeProjectId && activeSessionId) {
    window.app.saveSessionTodos(activeProjectId, activeSessionId, merged)
  }

  const done = merged.filter(t => t.status === 'completed' || t.status === 'done').length
  const total = merged.length
  countEl.textContent = `${done}/${total}`

  // The model often marks multiple items in_progress speculatively.
  // Only the first non-done item should show as active — everything else
  // that isn't completed renders as pending to avoid visual noise.
  const firstPendingId = merged.find(t => {
    const s = t.status
    return s !== 'completed' && s !== 'done' && s !== 'skipped'
  })?.id ?? null

  let itemsHtml = ''
  for (const todo of merged) {
    const isDone = todo.status === 'completed' || todo.status === 'done'
    // Only the first non-done item is "active" regardless of what the model said
    const isActive = !isDone && String(todo.id) === String(firstPendingId)
    const checkCls = isDone ? 'todo-check done' : isActive ? 'todo-check active' : 'todo-check'
    const checkIcon = isDone ? '✓' : isActive ? '◉' : '○'
    const textCls = isDone ? 'todo-text done' : isActive ? 'todo-text active' : 'todo-text'
    let content = (typeof todo.content === 'string' && todo.content) ? todo.content
      : (typeof todo.title === 'string' && todo.title) ? todo.title
      : (typeof todo.text === 'string' && todo.text) ? todo.text
      : ''
    // Guard against the model double-encoding a todo object as the content string
    // e.g. content = '{"content":"","status":"pending"}' — extract the inner content
    if (content && content.startsWith('{')) {
      try {
        const inner = JSON.parse(content)
        const innerContent = inner.content || inner.title || inner.text || ''
        if (innerContent) content = innerContent
      } catch { /* not JSON — use as-is */ }
    }
    const todoId = todo.id != null ? `<span class="todo-id">${esc(String(todo.id))}</span>` : ''
    itemsHtml += `<div class="todo-item ${isDone ? 'completed' : ''} ${isActive ? 'in-progress' : ''}">
      <span class="${checkCls}">${checkIcon}</span>
      ${todoId}
      <span class="${textCls}">${esc(content)}</span>
    </div>`
  }

  body.innerHTML = itemsHtml || '<div style="color:var(--muted);font-size:11px;padding:4px 8px">No items</div>'
}

function toggleTodoPanel() {
  const panel = document.getElementById('todoPanel')
  if (panel) panel.classList.toggle('collapsed')
}

/**
 * Apply surgical edit_todos operations to the current todo list.
 * Supports append (add new items), update (patch by id), remove (delete by id).
 * Calls updateTodoPanel with the result.
 */
function applyTodoEdits(ops) {
  if (!ops) return
  let todos = [...(currentTodos || [])]

  // append — auto-assign IDs continuing from the current max
  if (Array.isArray(ops.append) && ops.append.length > 0) {
    const maxId = todos.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0)
    ops.append.forEach((item, i) => {
      todos.push({
        id: maxId + i + 1,
        content: item.content || '',
        status: item.status === 'done' ? 'completed' : item.status === 'in_progress' ? 'in_progress' : 'pending',
      })
    })
  }

  // update — patch matching items by id
  if (Array.isArray(ops.update) && ops.update.length > 0) {
    todos = todos.map(t => {
      const patch = ops.update.find(u => String(u.id) === String(t.id))
      if (!patch) return t
      return {
        ...t,
        content: patch.content != null ? patch.content : t.content,
        status: patch.status != null
          ? (patch.status === 'done' ? 'completed' : patch.status === 'in_progress' ? 'in_progress' : 'pending')
          : t.status,
      }
    })
  }

  // remove — filter out by id
  if (Array.isArray(ops.remove) && ops.remove.length > 0) {
    const removeSet = new Set(ops.remove.map(String))
    todos = todos.filter(t => !removeSet.has(String(t.id)))
  }

  updateTodoPanel(todos, 'running')
}

function renderToolResult(content, isError=false) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)

  // Extract and render inline screenshots from browser_screenshot results
  const imgMatch = text.match(/!\[screenshot\]\((data:image\/png;base64,[A-Za-z0-9+/=]+)\)/)
  let imgHtml = ''
  let displayText = text
  if (imgMatch) {
    imgHtml = `<div style="margin:6px 0"><img src="${imgMatch[1]}" style="max-width:100%;max-height:400px;border-radius:6px;border:1px solid var(--border);cursor:pointer" onclick="window.open().document.write('<img src=\\''+this.src+'\\'>')" title="Click to open full size"></div>`
    displayText = text.replace(imgMatch[0], '').trim()
  }

  // Extract and render inline video from browser_close results
  const videoMatch = text.match(/Video recording saved:\s*(.+\.(?:webm|mp4))/i)
  let videoHtml = ''
  if (videoMatch) {
    const videoPath = videoMatch[1].trim()
    const ext = videoPath.split('.').pop().toLowerCase()
    const mimeType = ext === 'mp4' ? 'video/mp4' : 'video/webm'
    videoHtml = `<div style="margin:8px 0">
      <video controls playsinline style="max-width:100%;max-height:400px;border-radius:6px;border:1px solid var(--border);background:#000">
        <source src="file://${esc(videoPath)}" type="${mimeType}">
      </video>
      <div style="font-size:11px;color:var(--muted);margin-top:4px;cursor:pointer" onclick="navigator.clipboard.writeText('${esc(videoPath)}');this.textContent='Copied!';setTimeout(()=>this.textContent='${esc(videoPath)}',1500)" title="Click to copy path">${esc(videoPath)}</div>
    </div>`
  }

  const escaped = esc(displayText)
  // For task_complete summaries, unescape \n to actual newlines and render as markdown
  const isTaskComplete = displayText.startsWith('__TASK_COMPLETE__') || displayText.includes('## ') || displayText.includes('### ')
  let renderedContent = escaped
  if (isTaskComplete || displayText.includes('\\n')) {
    // Unescape JSON-escaped newlines and render as simple HTML
    const unescaped = displayText.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"')
    renderedContent = esc(unescaped).replace(/\n/g, '<br>')
  }
  const limit = 8000
  const cls = isError ? 'tool-result error' : 'tool-result'
  const icon = isError ? '✗' : '✓'
  const label = isError ? 'Error' : 'Output'
  if (renderedContent.length > limit) {
    const id = 'tr-' + Date.now() + Math.random().toString(36).slice(2,6)
    return `<div class="${cls}" id="${id}">
      <div class="tool-result-header"><span class="tool-result-icon ${isError?'error':''}">${icon}</span> ${label}</div>
      ${imgHtml}${videoHtml}
      <div class="tool-result-body">${renderedContent.slice(0, limit)}<span class="tool-result-more" onclick="this.parentElement.innerHTML=window._toolResultFull['${id}'];delete window._toolResultFull['${id}']">… show all (${displayText.length} chars)</span></div>
    </div>`
      + `<script>if(!window._toolResultFull)window._toolResultFull={};window._toolResultFull['${id}']=\`${renderedContent.replace(/`/g,'\\`').replace(/<\/script/gi,'<\\/script')}\`</script>`
  }
  return `<div class="${cls}">
    <div class="tool-result-header"><span class="tool-result-icon ${isError?'error':''}">${icon}</span> ${label}</div>
    ${imgHtml}${videoHtml}
    <div class="tool-result-body">${renderedContent}</div>
  </div>`
}
