'use strict'

// Test that the generated pbxproj is parseable by `xcodebuild -list`.
// Repros the Meditation Script Writer failures:
//  - "PBXGroup _setTarget: unrecognized selector"
//  - "JSON text did not start with array or object"
// Both are caused by unquoted strings with spaces in name/productName fields,
// and by missing AppIcon.appiconset Contents.json.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const test = require('node:test')
const assert = require('node:assert/strict')
const { execSync } = require('node:child_process')

const { generateXcodeProject } = require('../xcode-project-gen.js')

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeSwiftApp(dir, productBase) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${productBase}App.swift`),
    'import SwiftUI\n@main struct X: App { var body: some Scene { WindowGroup { Text("x") } } }\n'
  )
  fs.writeFileSync(
    path.join(dir, 'ContentView.swift'),
    'import SwiftUI\nstruct ContentView: View { var body: some View { Text("x") } }\n'
  )
}

function hasXcodebuild() {
  try {
    execSync('xcodebuild -version', { stdio: 'ignore', timeout: 5000 })
    return true
  } catch { return false }
}

test('product name with spaces produces a parseable pbxproj', () => {
  const root = makeTmp('xgen-spaces-')
  writeSwiftApp(path.join(root, 'MedApp'), 'MedApp')
  const r = generateXcodeProject({
    projectDir: root,
    productName: 'Meditation Script Writer',
    sourceDir: 'MedApp',
    platform: 'ios',
  })
  assert.equal(r.error, undefined, r.error)

  const content = fs.readFileSync(r.path, 'utf-8')
  // Invariant: any `name = ...;` or `productName = ...;` whose value contains
  // a space must be quoted. Bare single-word values (Products, Debug, Release)
  // are fine.
  const unquoted = content
    .split('\n')
    .filter(l => {
      const m = l.match(/^\s*(?:name|productName)\s*=\s*([^;\n]+);/)
      if (!m) return false
      const value = m[1].trim()
      if (value.startsWith('"')) return false   // already quoted
      return /\s/.test(value)                    // bare word with whitespace
    })
  assert.equal(unquoted.length, 0,
    `found unquoted name/productName with spaces:\n${unquoted.join('\n')}`)
})

test('generated pbxproj survives xcodebuild -list', { skip: !hasXcodebuild() }, () => {
  const root = makeTmp('xgen-parse-')
  writeSwiftApp(path.join(root, 'MedApp'), 'MedApp')
  const r = generateXcodeProject({
    projectDir: root,
    productName: 'Meditation Script Writer',
    sourceDir: 'MedApp',
    platform: 'ios',
  })
  assert.equal(r.error, undefined, r.error)

  const projDir = path.dirname(r.path)  // .xcodeproj dir (r.path is the .pbxproj)
  const projName = path.basename(projDir)
  let out
  try {
    out = execSync(`xcodebuild -project "${projName}" -list 2>&1`, {
      cwd: path.dirname(projDir),
      timeout: 30000,
      encoding: 'utf-8',
    })
  } catch (err) {
    assert.fail(`xcodebuild -list failed:\n${err.stdout || err.message}`)
  }
  assert.match(out, /Targets:\s*\n\s*Meditation Script Writer/,
    `expected the target in -list output. got:\n${out}`)
  assert.match(out, /Schemes:\s*\n\s*Meditation Script Writer/,
    `expected the scheme in -list output. got:\n${out}`)
})

test('empty .xcassets gets an AppIcon.appiconset stub', () => {
  const root = makeTmp('xgen-icon-')
  const src = path.join(root, 'App')
  writeSwiftApp(src, 'App')
  fs.mkdirSync(path.join(src, 'Assets.xcassets'), { recursive: true })

  const r = generateXcodeProject({
    projectDir: root,
    productName: 'App',
    sourceDir: 'App',
    platform: 'ios',
  })
  assert.equal(r.error, undefined, r.error)

  const iconContents = path.join(src, 'Assets.xcassets', 'AppIcon.appiconset', 'Contents.json')
  assert.ok(fs.existsSync(iconContents),
    `expected ${iconContents} to exist, but it was not created`)
  const parsed = JSON.parse(fs.readFileSync(iconContents, 'utf-8'))
  assert.ok(Array.isArray(parsed.images))
})
