---
inclusion: manual
---

# Xcode & iOS Simulator Guidance

## Simulator Runtime Prerequisite

Before attempting any iOS Simulator build, **verify that a simulator runtime is installed** — not just device types.

```bash
xcrun simctl list runtimes
```

If the output is empty or shows no iOS runtimes, the user must install one first:

```bash
xcodebuild -downloadPlatform iOS
```

Or: **Xcode → Settings → Platforms → iOS → Download**.

Device types (listed by `xcrun simctl list devicetypes`) are just hardware definitions. Without a matching runtime, no simulators exist and builds will fail with:

> `Unable to find a device matching the provided destination specifier`
> `iOS X.X is not installed`

## Checking Available Simulators

```bash
# List actual bootable simulators (not just device types)
xcrun simctl list devices available

# If empty — no runtime installed. Fix that first.
```

## Build Command Pattern

```bash
xcodebuild -project <Project>.xcodeproj \
  -scheme <Scheme> \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' \
  build
```

- Always use `-destination` with a device name that exists in `xcrun simctl list devices available`.
- Use `OS=latest` unless a specific version is needed.
- If the build fails with destination errors, re-check runtimes before retrying.

## Common Pitfalls

1. **No runtime installed** — `xcrun simctl list devices` returns empty sections. Fix: install the platform.
2. **Device name mismatch** — the destination name must exactly match an available simulator (e.g. "iPhone 16" not "iPhone16").
3. **Xcode CLI tools not set** — run `xcode-select -p` to confirm. Fix: `sudo xcode-select -s /Applications/Xcode.app`.
4. **Multiple Xcode versions** — ensure the active Xcode has the runtime you need.

## Diagnostic Sequence

When an iOS simulator build fails, run these in order:

1. `xcode-select -p` — confirm Xcode path
2. `xcrun simctl list runtimes` — confirm runtime installed
3. `xcrun simctl list devices available` — confirm simulators exist
4. Only then retry the build
