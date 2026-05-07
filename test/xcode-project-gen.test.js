'use strict'

// Regression tests for the smart source-dir resolver in xcode-project-gen.
// Reproduces the failure mode seen with the Meditation Script Writer session:
//   cwd = session working dir
//   project lives inside a nested subfolder with a product name containing spaces.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const test = require('node:test')
const assert = require('node:assert/strict')

const { generateXcodeProject, resolveSourceDir } = require('../xcode-project-gen.js')

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

test('auto-discovers source dir one level below projectDir when product_name has spaces', () => {
  const root = makeTmp('xgen-nested-')
  const inner = path.join(root, 'Meditation Script Writer', 'MeditationScriptWriter')
  writeSwiftApp(inner, 'MeditationScriptWriter')

  const r = generateXcodeProject({
    projectDir: root,
    productName: 'Meditation Script Writer',
  })
  assert.equal(r.error, undefined)
  assert.ok(r.path.endsWith('.xcodeproj/project.pbxproj'))
  assert.equal(r.stats.swiftFiles, 2)
})

test('honors explicit project_dir + source_dir', () => {
  const root = makeTmp('xgen-explicit-')
  const projDir = path.join(root, 'Outer')
  const inner = path.join(projDir, 'Inner')
  writeSwiftApp(inner, 'Inner')

  const r = generateXcodeProject({
    projectDir: projDir,
    productName: 'Inner',
    sourceDir: 'Inner',
  })
  assert.equal(r.error, undefined)
  assert.equal(r.stats.swiftFiles, 2)
})

test('accepts a nested source_dir path relative to projectDir', () => {
  const root = makeTmp('xgen-nested-src-')
  const inner = path.join(root, 'Outer', 'Inner')
  writeSwiftApp(inner, 'Inner')

  const r = generateXcodeProject({
    projectDir: root,
    productName: 'Inner',
    sourceDir: 'Outer/Inner',
  })
  assert.equal(r.error, undefined)
  assert.equal(r.stats.swiftFiles, 2)
})

test('ambiguous layout surfaces candidates in the error', () => {
  const root = makeTmp('xgen-ambig-')
  for (const name of ['AppA', 'AppB']) {
    writeSwiftApp(path.join(root, name), name)
  }
  const r = generateXcodeProject({ projectDir: root, productName: 'Unknown' })
  assert.ok(r.error, 'expected an error')
  assert.match(r.error, /Candidate source directories/)
  assert.match(r.error, /AppA/)
  assert.match(r.error, /AppB/)
})

test('empty projectDir produces a helpful error', () => {
  const root = makeTmp('xgen-empty-')
  const r = generateXcodeProject({ projectDir: root, productName: 'Foo' })
  assert.ok(r.error)
  assert.match(r.error, /No directory containing Swift files/)
})

test('resolveSourceDir returns candidates metadata', () => {
  const root = makeTmp('xgen-resolve-')
  writeSwiftApp(path.join(root, 'Foo'), 'Foo')
  writeSwiftApp(path.join(root, 'Bar'), 'Bar')

  const res = resolveSourceDir(root, null, 'DoesNotMatch')
  assert.ok(!res.srcRoot, 'should not auto-pick when multiple app candidates exist')
  assert.ok(Array.isArray(res.candidates))
  assert.equal(res.candidates.length, 2)
  for (const c of res.candidates) {
    assert.equal(typeof c.name, 'string')
    assert.equal(typeof c.hasApp, 'boolean')
    assert.equal(typeof c.swiftCount, 'number')
  }
})
