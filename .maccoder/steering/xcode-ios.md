---
name: Xcode & iOS Simulator
description: Guidance for building and running iOS projects in the simulator
auto_generated: false
when_files: *.xcodeproj, *.xcworkspace, Package.swift
---

# Xcode & iOS Simulator Guidance

## Simulator Runtime Prerequisite

Before attempting any iOS Simulator build, **verify that a simulator runtime is installed** — not just device types.

```bash
xcrun simctl list runtimes
```

If the output is empty or shows no iOS runtimes, install one first:

```bash
xcodebuild -downloadPlatform iOS
```

Or: **Xcode → Settings → Platforms → iOS → Download**.

Device types (listed by `xcrun simctl list devicetypes`) are hardware definitions only. Without a matching runtime, no simulators exist and builds will fail with:

> `Unable to find a device matching the provided destination specifier`
> `iOS X.X is not installed`

## Diagnostic Sequence

When an iOS simulator build fails, run these in order before retrying:

1. `xcode-select -p` — confirm Xcode path is set
2. `xcrun simctl list runtimes` — confirm a runtime is installed
3. `xcrun simctl list devices available` — confirm actual simulators exist
4. Only then retry the build

## Build Command Pattern

```bash
xcodebuild -project <Project>.xcodeproj \
  -scheme <Scheme> \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' \
  build
```

- Use a device name from `xcrun simctl list devices available` — it must match exactly.
- Use `OS=latest` unless a specific version is needed.

## Common Pitfalls

1. **No runtime installed** — `xcrun simctl list devices` returns empty sections under each runtime. Fix: install the platform first.
2. **Device name mismatch** — destination name must exactly match an available simulator (e.g. `iPhone 16` not `iPhone16`).
3. **Xcode CLI tools not set** — `xcode-select -p` returns nothing or wrong path. Fix: `sudo xcode-select -s /Applications/Xcode.app`.
4. **Multiple Xcode versions** — ensure the active Xcode has the runtime you need.
