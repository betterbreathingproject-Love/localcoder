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

module.exports = { fixAfterWrite, JS_EXTENSIONS, SKIP_PATTERNS }
