'use strict'

// End-to-end: generate a minimal iOS app and run `xcodebuild build`
// against a simulator. This exercises the exact path that was failing
// for the Meditation Script Writer session. Skipped if the machine has
// no Xcode or no iOS simulator runtime installed.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const test = require('node:test')
const assert = require('node:assert/strict')
const { execSync } = require('node:child_process')

const { generateXcodeProject } = require('../xcode-project-gen.js')

function envOk() {
  try {
    execSync('xcodebuild -version', { stdio: 'ignore', timeout: 5000 })
  } catch { return false }
  try {
    const out = execSync('xcrun simctl list runtimes', {
      timeout: 5000, encoding: 'utf-8',
    })
    return /iOS \d/.test(out)
  } catch { return false }
}

test('generated iOS project builds for the simulator', { skip: !envOk() }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xgen-build-'))
  const src = path.join(root, 'App')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'AppApp.swift'),
    'import SwiftUI\n@main struct AppApp: App { var body: some Scene { WindowGroup { ContentView() } } }\n')
  fs.writeFileSync(path.join(src, 'ContentView.swift'),
    'import SwiftUI\nstruct ContentView: View { var body: some View { Text("hi") } }\n')
  fs.mkdirSync(path.join(src, 'Assets.xcassets'), { recursive: true })

  const r = generateXcodeProject({
    projectDir: root,
    productName: 'Meditation Script Writer',
    sourceDir: 'App',
    platform: 'ios',
    deploymentTarget: '15.0',
  })
  assert.equal(r.error, undefined, r.error)

  const projDir = path.dirname(r.path)
  const projName = path.basename(projDir)
  // Don't use -quiet — it swallows "BUILD SUCCEEDED" too, leaving only warnings.
  let out
  try {
    out = execSync(
      `xcodebuild -project "${projName}" -scheme "Meditation Script Writer" -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build 2>&1`,
      { cwd: path.dirname(projDir), timeout: 300000, encoding: 'utf-8' }
    )
  } catch (err) {
    assert.fail(`xcodebuild build failed:\n${(err.stdout || err.message).split('\n').slice(-30).join('\n')}`)
  }
  assert.match(out, /BUILD SUCCEEDED/, `expected BUILD SUCCEEDED. tail:\n${out.split('\n').slice(-20).join('\n')}`)
})
