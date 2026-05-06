'use strict'

/**
 * project-map-generator.js
 *
 * Generates `.maccoder/steering/code-map.md` for a project — a compact index
 * of symbols (functions, classes, variables, event handlers) plus naming
 * conventions that the agent reads before searching. Purpose:
 *
 *   - Stop the agent from guessing at variable/function names when debugging.
 *   - Give it a symbol table so search_files queries hit on the first try.
 *
 * Runs purely from static parsing — no agent dispatch required, no model
 * calls. Fast enough to run on every project-open via a hook.
 *
 * Design notes:
 *   - Output is a single markdown file under 300 lines, injectable via
 *     steering-loader.js.
 *   - Scans the top 30 largest code files (by size) so we cover the
 *     important source without exploding on huge projects.
 *   - Supported extensions: .js, .jsx, .ts, .tsx, .py, .html, .swift, .rs,
 *     .go, .java.
 *   - HTML files are scanned for inline <script> blocks (games often have
 *     all logic in index.html — exactly the screenshot case).
 */

const fs = require('node:fs')
const path = require('node:path')

const CODE_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx',
  '.py',
  '.html', '.htm',
  '.swift',
  '.rs',
  '.go',
  '.java',
  '.kt', '.kts',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx',
  '.rb',
  '.php',
  '.dart',
  '.cs',
  '.lua',
])

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache',
  'venv', '.venv', '__pycache__', '.pytest_cache',
  'target', 'DerivedData', '.build',
  'resources', 'coverage', '.nyc_output',
])

// Max files to scan per project — keeps the generator fast on big repos.
const MAX_FILES = 30
const MAX_FILE_BYTES = 512 * 1024  // skip anything over 512KB per file

/**
 * Walk projectDir, return list of { path, size, ext } for code files,
 * sorted by size descending. Skips ignored dirs and huge files.
 */
function collectCodeFiles(projectDir) {
  const results = []
  function walk(dir) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (_) { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      if (IGNORE_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (!CODE_EXTS.has(ext)) continue
        let stat
        try { stat = fs.statSync(full) } catch { continue }
        if (stat.size > MAX_FILE_BYTES) continue
        if (stat.size < 20) continue
        results.push({ path: full, size: stat.size, ext })
      }
    }
  }
  walk(projectDir)
  results.sort((a, b) => b.size - a.size)
  return results.slice(0, MAX_FILES)
}

// ── Language-specific symbol extractors ─────────────────────────────────────
// Each returns { classes:[], functions:[], variables:[], handlers:[] }
// where each item is { name, line, signature? }.

function extractJsSymbols(source) {
  const out = { classes: [], functions: [], variables: [], handlers: [] }
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // class Foo { ... }   or   class Foo extends Bar {
    const classMatch = line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Z]\w*)/)
    if (classMatch) {
      out.classes.push({ name: classMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
      continue
    }

    // function foo(...)  or  async function foo(...)  or  function* foo(...)
    const fnMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([a-zA-Z_$][\w$]*)\s*\(([^)]*)\)/)
    if (fnMatch) {
      out.functions.push({ name: fnMatch[1], line: lineNum, signature: `${fnMatch[1]}(${fnMatch[2]})` })
      continue
    }

    // const foo = (...) => ...   or   const foo = function(...) ...
    const arrowMatch = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\(([^)]*)\)|[a-zA-Z_$][\w$]*)\s*=>/)
    if (arrowMatch) {
      out.functions.push({ name: arrowMatch[1], line: lineNum, signature: `${arrowMatch[1]}(${arrowMatch[2] || ''})` })
      continue
    }

    // const foo = function(...) ...
    const fnExprMatch = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\*?\s*\(([^)]*)\)/)
    if (fnExprMatch) {
      out.functions.push({ name: fnExprMatch[1], line: lineNum, signature: `${fnExprMatch[1]}(${fnExprMatch[2]})` })
      continue
    }

    // method inside class:  methodName(args) {   or  async methodName(args) {
    // Be conservative — require indentation + parens + opening brace at end.
    const methodMatch = line.match(/^\s{2,}(?:async\s+|static\s+|get\s+|set\s+)*([a-zA-Z_$][\w$]*)\s*\(([^)]*)\)\s*\{/)
    if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'function', 'return'].includes(methodMatch[1])) {
      out.functions.push({ name: methodMatch[1], line: lineNum, signature: `${methodMatch[1]}(${methodMatch[2]})` })
      continue
    }

    // top-level const/let/var (not arrow functions — already captured above)
    const varMatch = line.match(/^(?:export\s+)?(const|let|var)\s+([A-Z_][A-Z0-9_]{2,})\s*=/)
    if (varMatch) {
      out.variables.push({ name: varMatch[2], line: lineNum, signature: line.trim().slice(0, 80) })
      continue
    }

    // addEventListener('click', ...)  or  .on('click', ...)
    const listenerMatch = line.match(/\.(?:addEventListener|on)\s*\(\s*['"]([\w-]+)['"]/)
    if (listenerMatch) {
      out.handlers.push({ name: listenerMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
    }
  }

  return out
}

function extractPythonSymbols(source) {
  const out = { classes: [], functions: [], variables: [], handlers: [] }
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    const classMatch = line.match(/^\s*class\s+([A-Za-z_]\w*)\s*[:\(]/)
    if (classMatch) {
      out.classes.push({ name: classMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
      continue
    }
    const fnMatch = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/)
    if (fnMatch) {
      out.functions.push({ name: fnMatch[1], line: lineNum, signature: `${fnMatch[1]}(${fnMatch[2]})` })
      continue
    }
    const varMatch = line.match(/^([A-Z_][A-Z0-9_]{2,})\s*=/)
    if (varMatch) {
      out.variables.push({ name: varMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
    }
  }
  return out
}

function extractSwiftSymbols(source) {
  const out = { classes: [], functions: [], variables: [], handlers: [] }
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    const typeMatch = line.match(/^\s*(?:public\s+|private\s+|internal\s+|final\s+)*(?:struct|class|enum|protocol|actor)\s+([A-Z]\w*)/)
    if (typeMatch) {
      out.classes.push({ name: typeMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
      continue
    }
    const fnMatch = line.match(/^\s*(?:public\s+|private\s+|internal\s+|static\s+|override\s+|@\w+\s+)*func\s+([a-zA-Z_]\w*)\s*(?:<[^>]+>)?\s*\(([^)]*)\)/)
    if (fnMatch) {
      out.functions.push({ name: fnMatch[1], line: lineNum, signature: `${fnMatch[1]}(${fnMatch[2]})` })
    }
  }
  return out
}

function extractRustSymbols(source) {
  const out = { classes: [], functions: [], variables: [], handlers: [] }
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    // struct, enum, trait, impl
    const typeMatch = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+([A-Z]\w*)/)
    if (typeMatch) {
      out.classes.push({ name: typeMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
      continue
    }
    // impl blocks — capture the type being implemented
    const implMatch = line.match(/^\s*impl(?:<[^>]*>)?\s+(?:(\w+)\s+for\s+)?([A-Z]\w*)/)
    if (implMatch) {
      const name = implMatch[2]
      if (!out.classes.some(c => c.name === name)) {
        out.classes.push({ name, line: lineNum, signature: line.trim().slice(0, 80) })
      }
      continue
    }
    // fn declarations
    const fnMatch = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([a-zA-Z_]\w*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/)
    if (fnMatch) {
      out.functions.push({ name: fnMatch[1], line: lineNum, signature: `${fnMatch[1]}(${fnMatch[2].slice(0, 60)})` })
      continue
    }
    // const / static
    const varMatch = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Z_][A-Z0-9_]*)\s*:/)
    if (varMatch) {
      out.variables.push({ name: varMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
    }
  }
  return out
}

function extractGoSymbols(source) {
  const out = { classes: [], functions: [], variables: [], handlers: [] }
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    // type Name struct/interface
    const typeMatch = line.match(/^type\s+([A-Z]\w*)\s+(?:struct|interface)\b/)
    if (typeMatch) {
      out.classes.push({ name: typeMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
      continue
    }
    // func (receiver) Name(...)  or  func Name(...)
    const fnMatch = line.match(/^func\s+(?:\([^)]*\)\s+)?([a-zA-Z_]\w*)\s*\(([^)]*)\)/)
    if (fnMatch) {
      out.functions.push({ name: fnMatch[1], line: lineNum, signature: `${fnMatch[1]}(${fnMatch[2].slice(0, 60)})` })
      continue
    }
    // const block or var block with SCREAMING_SNAKE
    const varMatch = line.match(/^\s*(?:const|var)\s+([A-Z_][A-Z0-9_]*)\s*[=:]/)
    if (varMatch) {
      out.variables.push({ name: varMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
    }
  }
  return out
}

function extractJavaSymbols(source) {
  const out = { classes: [], functions: [], variables: [], handlers: [] }
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    // class, interface, enum, record, @interface (annotation)
    const typeMatch = line.match(/^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|static\s+)*(?:class|interface|enum|record|@interface)\s+([A-Z]\w*)/)
    if (typeMatch) {
      out.classes.push({ name: typeMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
      continue
    }
    // method declarations (return type + name + parens)
    const fnMatch = line.match(/^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|synchronized\s+|native\s+|default\s+)*(?:[\w<>\[\],\s]+)\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)\s*(?:throws\s+[\w,\s]+)?\s*\{?/)
    if (fnMatch && !['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'class', 'interface'].includes(fnMatch[1])) {
      out.functions.push({ name: fnMatch[1], line: lineNum, signature: `${fnMatch[1]}(${fnMatch[2].slice(0, 60)})` })
      continue
    }
    // static final constants
    const varMatch = line.match(/^\s*(?:public\s+|private\s+|protected\s+)?static\s+final\s+\w+\s+([A-Z_][A-Z0-9_]*)\s*=/)
    if (varMatch) {
      out.variables.push({ name: varMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
    }
  }
  return out
}

function extractKotlinSymbols(source) {
  const out = { classes: [], functions: [], variables: [], handlers: [] }
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    // class, object, interface, enum class, data class, sealed class
    const typeMatch = line.match(/^\s*(?:public\s+|private\s+|internal\s+|protected\s+|open\s+|abstract\s+|sealed\s+|data\s+|inner\s+)*(?:class|object|interface|enum\s+class)\s+([A-Z]\w*)/)
    if (typeMatch) {
      out.classes.push({ name: typeMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
      continue
    }
    // fun declarations
    const fnMatch = line.match(/^\s*(?:public\s+|private\s+|internal\s+|protected\s+|open\s+|override\s+|suspend\s+|inline\s+)*fun\s+(?:<[^>]+>\s+)?([a-zA-Z_]\w*)\s*\(([^)]*)\)/)
    if (fnMatch) {
      out.functions.push({ name: fnMatch[1], line: lineNum, signature: `${fnMatch[1]}(${fnMatch[2].slice(0, 60)})` })
      continue
    }
    // const val / companion object constants
    const varMatch = line.match(/^\s*(?:const\s+val|val|var)\s+([A-Z_][A-Z0-9_]*)\s*[=:]/)
    if (varMatch) {
      out.variables.push({ name: varMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
    }
  }
  return out
}

function extractCppSymbols(source) {
  const out = { classes: [], functions: [], variables: [], handlers: [] }
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    // class, struct, enum, namespace
    const typeMatch = line.match(/^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|enum(?:\s+class)?|namespace)\s+([A-Z_]\w*)/)
    if (typeMatch) {
      out.classes.push({ name: typeMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
      continue
    }
    // function/method declarations (return type + name + parens)
    // Matches: void foo(...), int MyClass::bar(...), static bool baz(...)
    const fnMatch = line.match(/^\s*(?:static\s+|virtual\s+|inline\s+|explicit\s+|constexpr\s+)*(?:[\w:*&<>]+\s+)+([a-zA-Z_]\w*)\s*\(([^)]*)\)\s*(?:const\s*)?(?:override\s*)?(?:noexcept\s*)?[{;]?\s*$/)
    if (fnMatch && !['if', 'for', 'while', 'switch', 'catch', 'return', 'class', 'struct', 'delete', 'new'].includes(fnMatch[1])) {
      out.functions.push({ name: fnMatch[1], line: lineNum, signature: `${fnMatch[1]}(${fnMatch[2].slice(0, 60)})` })
      continue
    }
    // #define MACRO_NAME
    const defineMatch = line.match(/^#define\s+([A-Z_][A-Z0-9_]*)\b/)
    if (defineMatch) {
      out.variables.push({ name: defineMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
      continue
    }
    // constexpr / const globals
    const varMatch = line.match(/^\s*(?:static\s+)?(?:constexpr|const)\s+\w+\s+([A-Z_][A-Z0-9_]*)\s*=/)
    if (varMatch) {
      out.variables.push({ name: varMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
    }
  }
  return out
}

function extractRubySymbols(source) {
  const out = { classes: [], functions: [], variables: [], handlers: [] }
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    // class Foo / module Foo
    const typeMatch = line.match(/^\s*(?:class|module)\s+([A-Z]\w*)/)
    if (typeMatch) {
      out.classes.push({ name: typeMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
      continue
    }
    // def method_name
    const fnMatch = line.match(/^\s*def\s+(self\.)?([a-zA-Z_]\w*[?!=]?)\s*(?:\(([^)]*)\))?/)
    if (fnMatch) {
      const name = (fnMatch[1] || '') + fnMatch[2]
      out.functions.push({ name, line: lineNum, signature: `${name}(${fnMatch[3] || ''})` })
      continue
    }
    // CONSTANT = ...
    const varMatch = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/)
    if (varMatch) {
      out.variables.push({ name: varMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
    }
  }
  return out
}

function extractPhpSymbols(source) {
  const out = { classes: [], functions: [], variables: [], handlers: [] }
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    // class, interface, trait, enum
    const typeMatch = line.match(/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Z]\w*)/)
    if (typeMatch) {
      out.classes.push({ name: typeMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
      continue
    }
    // function declarations
    const fnMatch = line.match(/^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)/)
    if (fnMatch) {
      out.functions.push({ name: fnMatch[1], line: lineNum, signature: `${fnMatch[1]}(${fnMatch[2].slice(0, 60)})` })
      continue
    }
    // const / define
    const constMatch = line.match(/^\s*(?:public\s+|private\s+|protected\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=/)
    if (constMatch) {
      out.variables.push({ name: constMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
      continue
    }
    const defineMatch = line.match(/define\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/)
    if (defineMatch) {
      out.variables.push({ name: defineMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
    }
  }
  return out
}

function extractDartSymbols(source) {
  const out = { classes: [], functions: [], variables: [], handlers: [] }
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    // class, mixin, extension, enum
    const typeMatch = line.match(/^\s*(?:abstract\s+|sealed\s+)?(?:class|mixin|extension|enum)\s+([A-Z]\w*)/)
    if (typeMatch) {
      out.classes.push({ name: typeMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
      continue
    }
    // function/method declarations
    const fnMatch = line.match(/^\s*(?:static\s+|Future\s*<[^>]*>\s+|Stream\s*<[^>]*>\s+|[\w<>]+\s+)?([a-zA-Z_]\w*)\s*\(([^)]*)\)\s*(?:async\s*)?[{=]/)
    if (fnMatch && !['if', 'for', 'while', 'switch', 'catch', 'return', 'class', 'new'].includes(fnMatch[1])) {
      out.functions.push({ name: fnMatch[1], line: lineNum, signature: `${fnMatch[1]}(${fnMatch[2].slice(0, 60)})` })
      continue
    }
    // const / final top-level
    const varMatch = line.match(/^(?:const|final)\s+(?:\w+\s+)?([A-Z_][A-Z0-9_]*)\s*=/)
    if (varMatch) {
      out.variables.push({ name: varMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
    }
  }
  return out
}

function extractCSharpSymbols(source) {
  const out = { classes: [], functions: [], variables: [], handlers: [] }
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    // class, struct, interface, enum, record
    const typeMatch = line.match(/^\s*(?:public\s+|private\s+|protected\s+|internal\s+|abstract\s+|sealed\s+|static\s+|partial\s+)*(?:class|struct|interface|enum|record)\s+([A-Z]\w*)/)
    if (typeMatch) {
      out.classes.push({ name: typeMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
      continue
    }
    // method declarations
    const fnMatch = line.match(/^\s*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|virtual\s+|override\s+|abstract\s+|async\s+)*(?:[\w<>\[\]?,\s]+)\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)\s*[{=]?/)
    if (fnMatch && !['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'class', 'struct', 'namespace'].includes(fnMatch[1])) {
      out.functions.push({ name: fnMatch[1], line: lineNum, signature: `${fnMatch[1]}(${fnMatch[2].slice(0, 60)})` })
      continue
    }
    // const fields
    const varMatch = line.match(/^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?(?:static\s+)?(?:readonly\s+)?const\s+\w+\s+([A-Z_][A-Z0-9_]*)\s*=/)
    if (varMatch) {
      out.variables.push({ name: varMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
    }
  }
  return out
}

function extractLuaSymbols(source) {
  const out = { classes: [], functions: [], variables: [], handlers: [] }
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    // function Module.method(...)  or  function Module:method(...)
    const methodMatch = line.match(/^\s*function\s+([A-Z]\w*)[.:]\s*([a-zA-Z_]\w*)\s*\(([^)]*)\)/)
    if (methodMatch) {
      if (!out.classes.some(c => c.name === methodMatch[1])) {
        out.classes.push({ name: methodMatch[1], line: lineNum, signature: `${methodMatch[1]}` })
      }
      out.functions.push({ name: `${methodMatch[1]}.${methodMatch[2]}`, line: lineNum, signature: `${methodMatch[1]}.${methodMatch[2]}(${methodMatch[3]})` })
      continue
    }
    // local function name(...)  or  function name(...)
    const fnMatch = line.match(/^\s*(?:local\s+)?function\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)/)
    if (fnMatch) {
      out.functions.push({ name: fnMatch[1], line: lineNum, signature: `${fnMatch[1]}(${fnMatch[2]})` })
      continue
    }
    // local name = function(...)
    const localFnMatch = line.match(/^\s*local\s+([a-zA-Z_]\w*)\s*=\s*function\s*\(([^)]*)\)/)
    if (localFnMatch) {
      out.functions.push({ name: localFnMatch[1], line: lineNum, signature: `${localFnMatch[1]}(${localFnMatch[2]})` })
      continue
    }
    // SCREAMING_SNAKE constants
    const varMatch = line.match(/^\s*(?:local\s+)?([A-Z_][A-Z0-9_]{2,})\s*=/)
    if (varMatch) {
      out.variables.push({ name: varMatch[1], line: lineNum, signature: line.trim().slice(0, 80) })
    }
  }
  return out
}

/**
 * Extract <script>...</script> bodies from an HTML file and scan each as JS.
 * This is the case that bit us in the screenshot — the tower-defence game
 * had all its Enemy/Tower/wave logic inside index.html.
 */
function extractHtmlSymbols(source) {
  const out = { classes: [], functions: [], variables: [], handlers: [] }
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
  let match
  // Figure out line numbers for each script block by counting newlines up to match.index
  while ((match = scriptRe.exec(source)) !== null) {
    const scriptBody = match[1]
    const prefix = source.slice(0, match.index)
    const startLine = prefix.split('\n').length
    const jsSymbols = extractJsSymbols(scriptBody)
    const shift = (items) => items.map(it => ({ ...it, line: it.line + startLine - 1 }))
    out.classes.push(...shift(jsSymbols.classes))
    out.functions.push(...shift(jsSymbols.functions))
    out.variables.push(...shift(jsSymbols.variables))
    out.handlers.push(...shift(jsSymbols.handlers))
  }
  return out
}

/**
 * Dispatch to the right extractor based on extension.
 */
function extractSymbols(filePath, ext, source) {
  switch (ext) {
    case '.js': case '.jsx': case '.ts': case '.tsx':
      return extractJsSymbols(source)
    case '.py':
      return extractPythonSymbols(source)
    case '.swift':
      return extractSwiftSymbols(source)
    case '.html': case '.htm':
      return extractHtmlSymbols(source)
    case '.rs':
      return extractRustSymbols(source)
    case '.go':
      return extractGoSymbols(source)
    case '.java':
      return extractJavaSymbols(source)
    case '.kt': case '.kts':
      return extractKotlinSymbols(source)
    case '.c': case '.h': case '.cpp': case '.hpp': case '.cc': case '.cxx':
      return extractCppSymbols(source)
    case '.rb':
      return extractRubySymbols(source)
    case '.php':
      return extractPhpSymbols(source)
    case '.dart':
      return extractDartSymbols(source)
    case '.cs':
      return extractCSharpSymbols(source)
    case '.lua':
      return extractLuaSymbols(source)
    default:
      return { classes: [], functions: [], variables: [], handlers: [] }
  }
}

/**
 * Derive the dominant naming convention from a list of symbol names.
 * Returns a short description like "camelCase functions, PascalCase classes".
 */
function detectConventions(symbols) {
  const all = [
    ...symbols.classes.map(s => ({ kind: 'class', name: s.name })),
    ...symbols.functions.map(s => ({ kind: 'fn', name: s.name })),
    ...symbols.variables.map(s => ({ kind: 'var', name: s.name })),
  ]
  const counts = { camelCase: 0, PascalCase: 0, snake_case: 0, SCREAMING_SNAKE: 0 }
  for (const s of all) {
    const n = s.name
    if (/^[A-Z][A-Z0-9_]+$/.test(n)) counts.SCREAMING_SNAKE++
    else if (/^[a-z][a-zA-Z0-9]*$/.test(n)) counts.camelCase++
    else if (/^[A-Z][a-zA-Z0-9]*$/.test(n)) counts.PascalCase++
    else if (/^[a-z][a-z0-9_]*$/.test(n) && n.includes('_')) counts.snake_case++
  }
  const parts = []
  if (counts.PascalCase > 2) parts.push('PascalCase for classes/types')
  if (counts.camelCase > 2) parts.push('camelCase for functions and variables')
  if (counts.snake_case > 2) parts.push('snake_case for functions')
  if (counts.SCREAMING_SNAKE > 2) parts.push('SCREAMING_SNAKE for constants')
  return parts.length ? parts.join(', ') : 'mixed / no dominant convention detected'
}

/**
 * Build the markdown body for code-map.md from the aggregated symbols per file.
 *
 * Keeps lines bounded: max 12 symbols per file, max truncated signature length.
 */
function buildMapBody(projectDir, perFile) {
  const totalClasses = perFile.reduce((n, f) => n + f.symbols.classes.length, 0)
  const totalFns = perFile.reduce((n, f) => n + f.symbols.functions.length, 0)
  const totalVars = perFile.reduce((n, f) => n + f.symbols.variables.length, 0)

  // Aggregate all symbols to detect project-wide conventions
  const aggregated = {
    classes: perFile.flatMap(f => f.symbols.classes),
    functions: perFile.flatMap(f => f.symbols.functions),
    variables: perFile.flatMap(f => f.symbols.variables),
    handlers: perFile.flatMap(f => f.symbols.handlers),
  }
  const convention = detectConventions(aggregated)

  // Event handler names (unique) are often what debug mode needs — e.g.
  // "click", "mousemove", "keydown" — so surface them prominently.
  const handlerNames = Array.from(new Set(aggregated.handlers.map(h => h.name))).slice(0, 20)

  // Top-level class names — the most valuable anchor for search queries.
  const classNames = Array.from(new Set(aggregated.classes.map(c => c.name)))

  const lines = []
  lines.push('# Code Map')
  lines.push('')
  lines.push('> Auto-generated index of symbols in this project. Read this BEFORE running search_files — use the EXACT names listed here rather than guessing.')
  lines.push('')
  lines.push('## Summary')
  lines.push(`- Project root: \`${projectDir}\``)
  lines.push(`- Files indexed: ${perFile.length}`)
  lines.push(`- Classes/types: ${totalClasses}`)
  lines.push(`- Functions: ${totalFns}`)
  lines.push(`- Constants: ${totalVars}`)
  lines.push(`- Naming convention: ${convention}`)
  lines.push('')

  if (classNames.length > 0) {
    lines.push('## Class / type names (use these exact names when searching)')
    lines.push('')
    lines.push(classNames.map(n => `\`${n}\``).join(', '))
    lines.push('')
  }

  if (handlerNames.length > 0) {
    lines.push('## Event handlers attached in this project')
    lines.push('')
    lines.push(handlerNames.map(n => `\`${n}\``).join(', '))
    lines.push('')
  }

  lines.push('## Per-file symbols')
  lines.push('')
  for (const f of perFile) {
    const rel = path.relative(projectDir, f.path)
    const syms = f.symbols
    const count = syms.classes.length + syms.functions.length + syms.variables.length
    if (count === 0) continue
    lines.push(`### ${rel}`)
    lines.push('')
    // Show first N symbols of each kind to keep size bounded
    const cap = (arr, n) => arr.slice(0, n)
    if (syms.classes.length > 0) {
      lines.push('Classes/types:')
      for (const c of cap(syms.classes, 8)) {
        lines.push(`  - \`${c.name}\` (line ${c.line})`)
      }
      if (syms.classes.length > 8) lines.push(`  - ... and ${syms.classes.length - 8} more`)
    }
    if (syms.functions.length > 0) {
      lines.push('Functions:')
      for (const fn of cap(syms.functions, 12)) {
        lines.push(`  - \`${fn.signature || fn.name}\` (line ${fn.line})`)
      }
      if (syms.functions.length > 12) lines.push(`  - ... and ${syms.functions.length - 12} more`)
    }
    if (syms.variables.length > 0) {
      lines.push('Constants:')
      const constNames = cap(syms.variables, 10).map(v => `\`${v.name}\``).join(', ')
      lines.push(`  ${constNames}${syms.variables.length > 10 ? `, +${syms.variables.length - 10} more` : ''}`)
    }
    lines.push('')
  }

  lines.push('## Search guidance')
  lines.push('')
  lines.push('- If a symbol is not in the list above, it probably does not exist in the codebase under that name.')
  lines.push('- Prefer reading the listed file at the listed line over guessing search regex.')
  lines.push('- If the thing you need is not in this map, run `list_dir` and `read_file` to learn — do NOT make up variable names.')
  lines.push('')

  return lines.join('\n')
}

/**
 * Main entry: scan projectDir, write .maccoder/steering/code-map.md.
 *
 * @param {string} projectDir absolute path
 * @returns {{ path: string, filesScanned: number, skipped: boolean, reason?: string }}
 */
function generateCodeMap(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') {
    return { skipped: true, reason: 'projectDir is required' }
  }
  try { fs.accessSync(projectDir) } catch {
    return { skipped: true, reason: 'project directory does not exist' }
  }

  const files = collectCodeFiles(projectDir)
  if (files.length === 0) {
    return { skipped: true, reason: 'no code files found' }
  }

  const perFile = []
  for (const f of files) {
    let source
    try { source = fs.readFileSync(f.path, 'utf-8') } catch { continue }
    const symbols = extractSymbols(f.path, f.ext, source)
    perFile.push({ path: f.path, ext: f.ext, symbols })
  }

  const body = buildMapBody(projectDir, perFile)

  // Write with the steering-loader front-matter format
  const frontMatter = [
    '---',
    'name: Code Map',
    'description: Auto-generated symbol index for this project (read before searching)',
    'auto_generated: true',
    '---',
    '',
  ].join('\n')

  const steeringDir = path.join(projectDir, '.maccoder', 'steering')
  try { fs.mkdirSync(steeringDir, { recursive: true }) } catch {}

  const outPath = path.join(steeringDir, 'code-map.md')
  fs.writeFileSync(outPath, frontMatter + body, 'utf-8')

  return { path: outPath, filesScanned: perFile.length, skipped: false }
}

/**
 * Check whether a fresh code-map.md exists. Returns true if the file exists
 * and is newer than `maxAgeMs` (default 1 hour).
 */
function hasFreshCodeMap(projectDir, maxAgeMs = 60 * 60 * 1000) {
  try {
    const p = path.join(projectDir, '.maccoder', 'steering', 'code-map.md')
    const stat = fs.statSync(p)
    return (Date.now() - stat.mtimeMs) < maxAgeMs
  } catch {
    return false
  }
}

module.exports = {
  generateCodeMap,
  hasFreshCodeMap,
  // Exported for tests:
  collectCodeFiles,
  extractJsSymbols,
  extractPythonSymbols,
  extractSwiftSymbols,
  extractHtmlSymbols,
  extractRustSymbols,
  extractGoSymbols,
  extractJavaSymbols,
  extractKotlinSymbols,
  extractCppSymbols,
  extractRubySymbols,
  extractPhpSymbols,
  extractDartSymbols,
  extractCSharpSymbols,
  extractLuaSymbols,
  detectConventions,
}
