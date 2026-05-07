'use strict'

// Regression tests for the "shortlist" fixes in direct-bridge.js:
//   #1  write_file / edit_file / edit_file_lines auto-coerce non-strings
//   #3  read_file returns helpful parent-listing hint on missing file
//   #7  bash strips -quiet from xcodebuild and annotates the output
//   #8  compile-loop key is stable for xcodebuild(project, scheme)
//
// The compile-loop detector lives inside the agent loop, so we can't unit-test
// it directly without standing up a full loop. Instead #8 is covered by a
// targeted regex-equivalence test on the key-derivation logic.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const test = require('node:test')
const assert = require('node:assert/strict')

const { executeTool } = require('../direct-bridge.js')

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// ─── #1: auto-coerce ─────────────────────────────────────────────────────────

test('write_file stringifies a plain object and notes the coercion', async () => {
  const cwd = makeTmp('wf-coerce-')
  const res = await executeTool(
    'write_file',
    { path: 'Contents.json', content: { info: { author: 'xcode', version: 1 } } },
    cwd, null, null, null, null,
  )
  assert.equal(res.error, undefined, res.error)
  assert.match(res.result, /auto-stringified/)
  const written = fs.readFileSync(path.join(cwd, 'Contents.json'), 'utf-8')
  assert.deepEqual(JSON.parse(written), { info: { author: 'xcode', version: 1 } })
})

test('write_file still rejects non-JSONifiable values with a useful message', async () => {
  const cwd = makeTmp('wf-reject-')
  const res = await executeTool(
    'write_file',
    { path: 'x.txt', content: 42 },
    cwd, null, null, null, null,
  )
  assert.ok(res.error)
  assert.match(res.error, /number/)
})

test('edit_file coerces array new_string (agent sent lines)', async () => {
  const cwd = makeTmp('ef-coerce-')
  fs.writeFileSync(path.join(cwd, 'greet.txt'), 'hello\nworld\n')
  const res = await executeTool(
    'edit_file',
    { path: 'greet.txt', old_string: 'hello', new_string: ['hi', 'there'] },
    cwd, null, null, null, null,
  )
  assert.equal(res.error, undefined, res.error)
  const after = fs.readFileSync(path.join(cwd, 'greet.txt'), 'utf-8')
  assert.equal(after, 'hi\nthere\nworld\n')
})

test('edit_file_lines coerces array new_content', async () => {
  const cwd = makeTmp('efl-coerce-')
  fs.writeFileSync(path.join(cwd, 'f.txt'), 'a\nb\nc\nd\n')
  const res = await executeTool(
    'edit_file_lines',
    { path: 'f.txt', start_line: 2, end_line: 3, new_content: ['X', 'Y'] },
    cwd, null, null, null, null,
  )
  assert.equal(res.error, undefined, res.error)
  const after = fs.readFileSync(path.join(cwd, 'f.txt'), 'utf-8')
  assert.equal(after, 'a\nX\nY\nd\n')
})

// ─── #3: helpful read_file error ──────────────────────────────────────────────

test('read_file lists nearby files when the target is missing', async () => {
  const cwd = makeTmp('rf-hint-')
  const inner = path.join(cwd, 'MedApp')
  fs.mkdirSync(inner, { recursive: true })
  fs.writeFileSync(path.join(inner, 'ContentView.swift'), 'import SwiftUI\n')
  fs.writeFileSync(path.join(inner, 'MedAppApp.swift'), 'import SwiftUI\n')

  const res = await executeTool(
    'read_file',
    { path: 'MedApp/DoesNotExist.swift' },
    cwd, null, null, null, null,
  )
  assert.ok(res.error)
  assert.match(res.error, /Deepest existing parent: MedApp/)
  assert.match(res.error, /ContentView\.swift/)
  assert.match(res.error, /MedAppApp\.swift/)
})

test('read_file climbs through multiple missing segments', async () => {
  const cwd = makeTmp('rf-climb-')
  fs.mkdirSync(path.join(cwd, 'SubA'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'SubA', 'file.txt'), 'hi')

  const res = await executeTool(
    'read_file',
    { path: 'SubA/DoesNotExist/Nested/file.txt' },
    cwd, null, null, null, null,
  )
  assert.ok(res.error)
  assert.match(res.error, /Deepest existing parent: SubA/)
  assert.match(res.error, /do not exist/)
})

// ─── #7: strip -quiet from xcodebuild ─────────────────────────────────────────

test('bash strips -quiet from xcodebuild and annotates the result', async () => {
  const cwd = makeTmp('bash-quiet-')
  // Use a stubbed xcodebuild on PATH so we don't actually invoke Xcode.
  const binDir = path.join(cwd, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const stub = path.join(binDir, 'xcodebuild')
  fs.writeFileSync(stub,
    '#!/bin/bash\n' +
    'echo "argv: $@"\n' +
    // If -quiet is still present, we emit a marker so the test can detect it.
    'for a in "$@"; do if [ "$a" = "-quiet" ] || [ "$a" = "--quiet" ]; then echo "QUIET_STILL_PRESENT"; fi; done\n' +
    'echo "** BUILD SUCCEEDED **"\n'
  )
  fs.chmodSync(stub, 0o755)

  const res = await executeTool(
    'bash',
    { command: `PATH="${binDir}:$PATH" xcodebuild -project Foo.xcodeproj -scheme Foo -quiet build` },
    cwd, null, null, null, null,
  )
  assert.equal(res.error, undefined, res.error)
  assert.match(res.result, /bash note: -quiet flag removed/)
  assert.match(res.result, /BUILD SUCCEEDED/)
  assert.doesNotMatch(res.result, /QUIET_STILL_PRESENT/,
    '-quiet should have been removed before the stub saw it')
})

test('bash does not touch -quiet on non-xcodebuild commands', async () => {
  const cwd = makeTmp('bash-noquiet-')
  const res = await executeTool(
    'bash',
    { command: 'echo hi --quiet' },
    cwd, null, null, null, null,
  )
  assert.equal(res.error, undefined)
  assert.doesNotMatch(res.result || '', /-quiet flag removed/)
})

// ─── #8: compile-loop key stability for xcodebuild ────────────────────────────
// The real detector lives inside the agent loop. Duplicate its key derivation
// here and assert that the same (project, scheme) produces the same key across
// command variations.

function deriveKey(cmd) {
  if (/\bxcodebuild\b/.test(cmd)) {
    const projMatch = cmd.match(/-(?:project|workspace)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/)
    const schemeMatch = cmd.match(/-scheme\s+(?:"([^"]+)"|'([^']+)'|(\S+))/)
    const proj = projMatch ? (projMatch[1] || projMatch[2] || projMatch[3]) : null
    const scheme = schemeMatch ? (schemeMatch[1] || schemeMatch[2] || schemeMatch[3]) : null
    if (proj || scheme) return `xcodebuild:${proj || '?'}:${scheme || '?'}`
    return 'xcodebuild:' + cmd.slice(0, 60)
  }
  const fileMatch = cmd.match(/\b(\S+\.(swift|kt|java|ts|rs|go|c|cpp|m))\b/)
  return fileMatch ? fileMatch[1] : cmd.slice(0, 60)
}

test('xcodebuild compile-loop key collapses across differing flag sets', () => {
  const a = deriveKey('xcodebuild -project "Meditation Script Writer.xcodeproj" -scheme "Meditation Script Writer" -configuration Debug build')
  const b = deriveKey('xcodebuild -configuration Release -scheme "Meditation Script Writer" -project "Meditation Script Writer.xcodeproj" -destination generic/platform=iOS build')
  const c = deriveKey('xcodebuild -project "Meditation Script Writer.xcodeproj" -scheme "Meditation Script Writer" clean build')
  assert.equal(a, b)
  assert.equal(a, c)
  assert.equal(a, 'xcodebuild:Meditation Script Writer.xcodeproj:Meditation Script Writer')
})

test('xcodebuild key changes when project or scheme changes', () => {
  const a = deriveKey('xcodebuild -project A.xcodeproj -scheme A build')
  const b = deriveKey('xcodebuild -project B.xcodeproj -scheme A build')
  const c = deriveKey('xcodebuild -project A.xcodeproj -scheme B build')
  assert.notEqual(a, b)
  assert.notEqual(a, c)
  assert.notEqual(b, c)
})

test('non-xcodebuild compile key still keys on source file', () => {
  assert.equal(deriveKey('swiftc Sources/App.swift -o App'), 'Sources/App.swift')
  assert.equal(deriveKey('rustc src/main.rs'), 'src/main.rs')
})

// ─── #2: generate_xcode_project accepts a quoted project_dir ─────────────────

test('generate_xcode_project tolerates quoted project_dir', async () => {
  const cwd = makeTmp('gxp-quoted-')
  const proj = path.join(cwd, 'MedApp Proj')
  const src = path.join(proj, 'MedApp')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'MedAppApp.swift'),
    'import SwiftUI\n@main struct MedAppApp: App { var body: some Scene { WindowGroup { Text("x") } } }\n')
  fs.writeFileSync(path.join(src, 'ContentView.swift'),
    'import SwiftUI\nstruct ContentView: View { var body: some View { Text("x") } }\n')

  const res = await executeTool(
    'generate_xcode_project',
    {
      product_name: 'MedApp',
      project_dir: '"MedApp Proj"',         // quoted — common model mistake
      source_dir: 'MedApp',
      platform: 'ios',
    },
    cwd, null, null, null, null,
  )
  assert.equal(res.error, undefined, res.error)
  assert.match(res.result, /Generated/)
  assert.ok(fs.existsSync(path.join(proj, 'MedApp.xcodeproj', 'project.pbxproj')))
})
