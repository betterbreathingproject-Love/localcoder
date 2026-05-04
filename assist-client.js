'use strict'

/**
 * assist-client.js — Node.js HTTP client for the dual-model fast assistant.
 *
 * Wraps the POST /memory/assist endpoint exposed by memory-bridge.py.
 * All functions catch errors internally and return null — never throw.
 * Uses Node.js built-in http module (no external dependencies).
 */

const http = require('http')

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

const FETCH_SUMMARIZE_THRESHOLD = 4000   // chars
const VISION_MAX_CHARS = 2000            // chars (~500 tokens)
const GIT_SUMMARIZE_THRESHOLD = 2000     // chars
const SEARCH_RANK_THRESHOLD = 15         // result count
const FILE_EXTRACT_THRESHOLD = 8000      // chars
const TODO_BOOTSTRAP_ENABLED = true
const TODO_WATCH_ENABLED = true
const ASSIST_TIMEOUT_MS = 65000          // 5s longer than server timeout

// Tools that are subject to pre-execution validation
const VALIDATED_TOOLS = new Set(['edit_file', 'write_file', 'bash', 'read_file', 'read_files'])

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * POST to /memory/assist and return the parsed JSON response, or null on any failure.
 *
 * On HTTP 503 with degraded:true  → return null silently (normal degraded mode)
 * On any other error              → log a warning and return null
 *
 * @param {string} taskType
 * @param {object} payload
 * @param {number} timeoutMs
 * @returns {Promise<object|null>}
 */
function _assistRequest(taskType, payload, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ task_type: taskType, payload })
    const options = {
      hostname: '127.0.0.1',
      port: 8090,
      path: '/memory/assist',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }

    let settled = false

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (settled) return
        settled = true

        let parsed = null
        try { parsed = JSON.parse(data) } catch (_) {}

        // HTTP 503 with degraded:true is a normal no-op — no warning
        if (res.statusCode === 503 && parsed && parsed.degraded) {
          return resolve(null)
        }

        // Any non-2xx status is an error
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.warn(`[assist-client] warn: ${taskType} failed: HTTP ${res.statusCode}`)
          return resolve(null)
        }

        resolve(parsed)
      })
    })

    req.on('error', (err) => {
      if (settled) return
      settled = true
      console.warn(`[assist-client] warn: ${taskType} failed: ${err.message}`)
      resolve(null)
    })

    req.setTimeout(timeoutMs, () => {
      if (settled) return
      settled = true
      req.destroy()
      console.warn(`[assist-client] warn: ${taskType} failed: request timed out after ${timeoutMs}ms`)
      resolve(null)
    })

    req.write(body)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Exported async functions
// ---------------------------------------------------------------------------

/**
 * Describe an image using the extraction model.
 * @param {string} imageData - base64-encoded image data
 * @param {string} mimeType
 * @param {string} prompt
 * @returns {Promise<string|null>}
 */
async function assistVision(imageData, mimeType, prompt) {
  try {
    const res = await _assistRequest('vision', { image_b64: imageData, mime_type: mimeType, prompt }, ASSIST_TIMEOUT_MS)
    return (res && typeof res.result === 'string') ? res.result : null
  } catch (_) { return null }
}

/**
 * Generate an initial todo list from the user's prompt.
 * @param {string} userPrompt
 * @returns {Promise<Array|null>}
 */
async function assistTodoBootstrap(userPrompt) {
  try {
    const res = await _assistRequest('todo_bootstrap', { user_prompt: userPrompt }, ASSIST_TIMEOUT_MS)
    return (res && Array.isArray(res.result_data)) ? res.result_data : null
  } catch (_) { return null }
}

/**
 * Infer todo status updates from a completed tool call.
 * @param {string} toolName
 * @param {*} toolResult
 * @param {Array} currentTodos
 * @returns {Promise<Array|null>}
 */
async function assistTodoWatch(toolName, toolResult, currentTodos) {
  try {
    const res = await _assistRequest('todo_watch', { tool_name: toolName, tool_result: toolResult, current_todos: currentTodos }, ASSIST_TIMEOUT_MS)
    return (res && Array.isArray(res.result_data)) ? res.result_data : null
  } catch (_) { return null }
}

/**
 * Summarize a large web fetch result.
 * Returns null immediately (no HTTP call) when rawContent is within threshold.
 * @param {string} url
 * @param {string} rawContent
 * @param {number} [maxOutputTokens]
 * @returns {Promise<string|null>}
 */
async function assistFetchSummarize(url, rawContent, maxOutputTokens) {
  if (rawContent.length <= FETCH_SUMMARIZE_THRESHOLD) return null
  try {
    const res = await _assistRequest('fetch_summarize', { url, raw_content: rawContent, max_output_tokens: maxOutputTokens || 512 }, ASSIST_TIMEOUT_MS)
    return (res && typeof res.result === 'string') ? res.result : null
  } catch (_) { return null }
}

/**
 * Pre-validate tool arguments before execution.
 * Returns null immediately (no HTTP call) for tools not in VALIDATED_TOOLS.
 * @param {string} toolName
 * @param {*} toolArgs
 * @param {*} recentContext
 * @returns {Promise<{valid: boolean, reason?: string}|null>}
 */
async function assistValidateTool(toolName, toolArgs, recentContext) {
  if (!VALIDATED_TOOLS.has(toolName)) return null
  try {
    const res = await _assistRequest('tool_validate', { tool_name: toolName, tool_args: toolArgs, recent_context: recentContext }, 10000)
    return (res && res.result_data != null) ? res.result_data : null
  } catch (_) { return null }
}

/**
 * Produce a one-sentence root cause diagnosis for a tool error.
 * @param {string} toolName
 * @param {*} toolArgs
 * @param {string} errorMessage
 * @param {*} recentContext
 * @returns {Promise<string|null>}
 */
async function assistDiagnoseError(toolName, toolArgs, errorMessage, recentContext) {
  try {
    const res = await _assistRequest('error_diagnose', { tool_name: toolName, tool_args: toolArgs, error_message: errorMessage, recent_context: recentContext }, 15000)
    return (res && typeof res.result === 'string') ? res.result : null
  } catch (_) { return null }
}

/**
 * Summarize a large git command output.
 * @param {string} command
 * @param {string} rawOutput
 * @returns {Promise<string|null>}
 */
async function assistGitSummarize(command, rawOutput) {
  try {
    const res = await _assistRequest('git_summarize', { command, raw_output: rawOutput }, ASSIST_TIMEOUT_MS)
    return (res && typeof res.result === 'string') ? res.result : null
  } catch (_) { return null }
}

/**
 * Rank search results by relevance to the current task.
 * @param {string} pattern
 * @param {string[]} results
 * @param {*} taskContext
 * @returns {Promise<string[]|null>}
 */
async function assistRankSearchResults(pattern, results, taskContext) {
  try {
    const res = await _assistRequest('rank_search', { pattern, results, task_context: taskContext }, ASSIST_TIMEOUT_MS)
    return (res && Array.isArray(res.result_data)) ? res.result_data : null
  } catch (_) { return null }
}

/**
 * Extract the section of a large file most relevant to the current task.
 * @param {string} filePath
 * @param {string} fileContent
 * @param {*} taskContext
 * @returns {Promise<string|null>}
 */
async function assistExtractRelevantSection(filePath, fileContent, taskContext) {
  try {
    const res = await _assistRequest('extract_section', { file_path: filePath, file_content: fileContent, task_context: taskContext }, 20000)
    return (res && typeof res.result === 'string') ? res.result : null
  } catch (_) { return null }
}

/**
 * Detect semantic repetition / planning loops in recent assistant responses.
 * @param {string[]} recentResponses
 * @returns {Promise<{repeating: boolean, reason?: string}|null>}
 */
async function assistDetectRepetition(recentResponses) {
  try {
    const res = await _assistRequest('detect_repetition', { recent_responses: recentResponses }, ASSIST_TIMEOUT_MS)
    return (res && res.result_data != null) ? res.result_data : null
  } catch (_) { return null }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Gather relevant file context for a task using the fast model.
 * Scans the file tree and identifies which files are most relevant to the
 * user's request, returning paths and brief descriptions.
 * @param {string} userPrompt - The user's request
 * @param {string} fileTree - Compact file tree of the project
 * @returns {Promise<Array<{path: string, reason: string}>|null>}
 */
async function assistGatherContext(userPrompt, fileTree) {
  try {
    const res = await _assistRequest('gather_context', {
      user_prompt: userPrompt,
      file_tree: fileTree,
    }, 12000)
    return (res && Array.isArray(res.result_data)) ? res.result_data : null
  } catch (_) { return null }
}

/**
 * Generate a short instant acknowledgement from the fast model before the
 * main agent starts its tool loop. Gives the user immediate feedback.
 * @param {string} userMessage
 * @param {string} agentRole
 * @returns {Promise<string|null>}
 */
async function assistChatReply(userMessage, agentRole) {
  try {
    const res = await _assistRequest('chat_reply', { user_message: userMessage, agent_role: agentRole }, 12000)
    return (res && typeof res.result === 'string' && res.result.length > 0) ? res.result : null
  } catch (_) { return null }
}

/**
 * Generate a brief progress summary from recent tool calls.
 * Used to keep the user informed and help the agent stay self-aware.
 * @param {Array} recentActions - [{tool, args_summary, result_summary}]
 * @param {Array} [todos] - Current todo list
 * @returns {Promise<string|null>}
 */
async function assistProgressSummary(recentActions, todos) {
  try {
    const res = await _assistRequest('progress_summary', {
      recent_actions: recentActions,
      todos: todos || [],
    }, 10000)
    return (res && typeof res.result === 'string' && res.result.length > 0) ? res.result : null
  } catch (_) { return null }
}

module.exports = {
  // Functions
  assistVision,
  assistTodoBootstrap,
  assistTodoWatch,
  assistFetchSummarize,
  assistValidateTool,
  assistDiagnoseError,
  assistGitSummarize,
  assistRankSearchResults,
  assistExtractRelevantSection,
  assistDetectRepetition,
  assistChatReply,
  assistProgressSummary,
  assistGatherContext,
  // Constants
  FETCH_SUMMARIZE_THRESHOLD,
  VISION_MAX_CHARS,
  GIT_SUMMARIZE_THRESHOLD,
  SEARCH_RANK_THRESHOLD,
  FILE_EXTRACT_THRESHOLD,
  TODO_BOOTSTRAP_ENABLED,
  TODO_WATCH_ENABLED,
  ASSIST_TIMEOUT_MS,
  // Sets
  VALIDATED_TOOLS,
  // Internal (exposed for testing)
  _assistRequest,
}
