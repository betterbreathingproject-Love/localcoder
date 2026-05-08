'use strict'

/**
 * Post-Write Auto-Fixer
 * ─────────────────────
 * Runs immediately after write_file / edit_file, BEFORE the post-write cache
 * records the content. Silently fixes trivial issues so the agent never wastes
 * a turn on them.
 *
 * Pipeline: Agent writes → fixer runs → cache records fixed content → LSP checks
 *
 * Only fixes deterministic, safe transformations:
 *   1. Missing 'use strict' at top of .js files
 *   2. Missing trailing newline
 *   3. ESLint --fix (if eslint is available in the project)
 *
 * Returns { fixed: boolean, fixedContent: string|null, fixes: string[] }
 *   - fixed: true if any changes were made
 *   - fixedContent: the corrected file content (null if no changes)
 *   - fixes: human-readable list of what was fixed
 */

const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

// File extensions eligible for auto-fix
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])

// Files/patterns to skip (generated files, vendor, etc.)
const SKIP_PATTERNS = [
  /node_modules/,
  /\.min\.js$/,
  /vendor\//,
  /dist\//,
  /build\//,
]

/**
 * Run the auto-fixer on a file after it was written.
 *
 * @param {string} absPath - Absolute path to the file
 * @param {string} cwd - Working directory (for eslint resolution)
 * @param {object} [opts]
 * @param {boolean} [opts.useStrict=true] - Enforce 'use strict' at top
 * @param {boolean} [opts.trailingNewline=true] - Ensure trailing newline
 * @param {boolean} [opts.eslintFix=true] - Run eslint --fix if available
 * @param {number} [opts.eslintTimeout=5000] - Timeout for eslint in ms
 * @returns {{ fixed: boolean, fixedContent: string|null, fixes: string[] }}
 */
function fixAfterWrite(absPath, cwd, opts = {}) {
  const {
    useStrict = true,
    trailingNewline = true,
    eslintFix = true,
    eslintTimeout = 5000,
  } = opts

  const ext = path.extname(absPath).toLowerCase()
  const fixes = []

  // Only process JS files
  if (!JS_EXTENSIONS.has(ext)) {
    return { fixed: false, fixedContent: null, fixes }
  }

  // Skip vendor/generated files
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(absPath)) {
      return { fixed: false, fixedContent: null, fixes }
    }
  }

  let code
  try {
    code = fs.readFileSync(absPath, 'utf-8')
  } catch {
    return { fixed: false, fixedContent: null, fixes }
  }

  let modified = false

  // ── 1. Ensure 'use strict' ──────────────────────────────────────────────
  if (useStrict) {
    const trimmed = code.trimStart()
    const hasStrict = trimmed.startsWith("'use strict'") ||
                      trimmed.startsWith('"use strict"')
    if (!hasStrict) {
      // Preserve any leading shebang
      if (code.startsWith('#!')) {
        const newlineIdx = code.indexOf('\n')
        if (newlineIdx !== -1) {
          const shebang = code.slice(0, newlineIdx + 1)
          const rest = code.slice(newlineIdx + 1)
          code = shebang + "'use strict'\n\n" + rest
        }
      } else {
        code = "'use strict'\n\n" + code
      }
      modified = true
      fixes.push("added 'use strict'")
    }
  }

  // ── 2. Ensure trailing newline ──────────────────────────────────────────
  if (trailingNewline && code.length > 0 && !code.endsWith('\n')) {
    code += '\n'
    modified = true
    fixes.push('added trailing newline')
  }

  // Write back if we made in-memory fixes
  if (modified) {
    try {
      fs.writeFileSync(absPath, code, 'utf-8')
    } catch {
      // Can't write — return unfixed
      return { fixed: false, fixedContent: null, fixes: [] }
    }
  }

  // ── 3. ESLint --fix ─────────────────────────────────────────────────────
  if (eslintFix) {
    try {
      execSync(
        `npx eslint --fix "${absPath}" 2>/dev/null`,
        { cwd, timeout: eslintTimeout, stdio: 'pipe' }
      )
      // Re-read to see if eslint changed anything
      const afterEslint = fs.readFileSync(absPath, 'utf-8')
      if (afterEslint !== code) {
        code = afterEslint
        modified = true
        fixes.push('eslint --fix applied')
      }
    } catch {
      // ESLint not available, not configured, or has unfixable errors — skip
    }
  }

  return {
    fixed: modified,
    fixedContent: modified ? code : null,
    fixes,
  }
}

// ── Duplicate Symbol Detection ────────────────────────────────────────────────
// Scans for duplicate function/class declarations in a file after write.
// Returns an array of warnings (empty if no duplicates found).

// Extensions eligible for duplicate detection
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.htm'])

/**
 * Detect duplicate top-level function/class declarations in a file.
 * For HTML files, extracts <script> content first.
 *
 * @param {string} absPath - Absolute path to the file
 * @returns {{ duplicates: Array<{name: string, lines: number[]}> }}
 */
function detectDuplicateSymbols(absPath) {
  const ext = path.extname(absPath).toLowerCase()
  if (!CODE_EXTENSIONS.has(ext)) return { duplicates: [] }

  // Skip vendor/generated
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(absPath)) return { duplicates: [] }
  }

  let code
  try {
    code = fs.readFileSync(absPath, 'utf-8')
  } catch {
    return { duplicates: [] }
  }

  // For HTML files, extract all <script> blocks
  if (ext === '.html' || ext === '.htm') {
    const scripts = []
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi
    let match
    while ((match = scriptRegex.exec(code)) !== null) {
      scripts.push(match[1])
    }
    code = scripts.join('\n')
  }

  // Regex-based detection of function/class declarations
  // Matches: function name(, async function name(, class Name {, class Name extends
  const declRegex = /^[ \t]*(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s+|class\s+)([A-Za-z_$][A-Za-z0-9_$]*)/gm
  const declarations = new Map() // name → [lineNumbers]

  const lines = code.split('\n')
  for (let i = 0; i < lines.length; i++) {
    declRegex.lastIndex = 0
    const m = declRegex.exec(lines[i])
    if (m) {
      const name = m[1]
      if (!declarations.has(name)) declarations.set(name, [])
      declarations.get(name).push(i + 1)
    }
  }

  const duplicates = []
  for (const [name, lineNums] of declarations) {
    if (lineNums.length > 1) {
      duplicates.push({ name, lines: lineNums })
    }
  }

  return { duplicates }
}

// ── Lightweight Syntax Check ──────────────────────────────────────────────────
// Quick syntax validation without requiring external tools.
// For JS: uses `new Function()` to check syntax.
// For HTML: extracts <script> and checks each block.

/**
 * Run a lightweight syntax check on a file.
 * Returns null if OK, or an error message string if syntax is broken.
 *
 * @param {string} absPath - Absolute path to the file
 * @returns {string|null} Error message or null if valid
 */
function checkSyntax(absPath) {
  const ext = path.extname(absPath).toLowerCase()

  let code
  try {
    code = fs.readFileSync(absPath, 'utf-8')
  } catch {
    return null // Can't read — skip
  }

  if (JS_EXTENSIONS.has(ext)) {
    return _checkJsSyntax(code, absPath)
  }

  if (ext === '.html' || ext === '.htm') {
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi
    let match
    let blockIdx = 0
    while ((match = scriptRegex.exec(code)) !== null) {
      blockIdx++
      const err = _checkJsSyntax(match[1], `${absPath} <script block #${blockIdx}>`)
      if (err) return err
    }
  }

  return null
}

function _checkJsSyntax(code, label) {
  try {
    // Use Function constructor for syntax check — doesn't execute the code
    new Function(code)
    return null
  } catch (e) {
    // Extract useful info from the syntax error
    const msg = e.message || 'Unknown syntax error'
    return `Syntax error in ${path.basename(label)}: ${msg}`
  }
}

module.exports = {
  fixAfterWrite,
  detectDuplicateSymbols,
  checkSyntax,
  JS_EXTENSIONS,
  CODE_EXTENSIONS,
  SKIP_PATTERNS,
}
