# Little Spud macOS

This is a native macOS shell for Little Spud. It keeps the Little Spud WebUI as the single UI implementation, but packages it as `Little Spud.app` with a menu bar item, native local notifications, and app-only update checks.

The app does not use APNs. Notifications are local macOS notifications triggered by the bundled WebUI while the app is running and paired with a Tater Hub.

## WebUI Bundle

`build_app.sh` bundles the current Little Spud WebUI repo root into `Little Spud.app/Contents/Resources/WebUI`. Tagging this repo builds exactly the checked-out WebUI version.

## Build

```sh
macos/LittleSpud/scripts/build_app.sh
```

The app bundle is written to:

```sh
macos/LittleSpud/build/Little Spud.app
```

## Updates

```sh
macos/LittleSpud/scripts/package_update.sh
```

This creates:

```sh
macos/LittleSpud/build/LittleSpud-v<version>.zip
macos/LittleSpud/build/update-manifest.json
macos/LittleSpud/releases/LittleSpud-v<version>.zip
macos/LittleSpud/update-manifest.json
```

By default the manifest points at the tracked zip under `macos/LittleSpud/releases/` on `main`, matching the main Tater macOS updater pattern.

## DMG

```sh
macos/LittleSpud/scripts/build_dmg.sh
```

This creates:

```sh
macos/LittleSpud/build/LittleSpud-v<version>.dmg
macos/LittleSpud/releases/LittleSpud-v<version>.dmg
```

## Tagged Release

The GitHub workflow runs on tags that match:

```sh
v*
```

For version `0.1.32`, tag:

```sh
git tag v0.1.32
git push origin v0.1.32
```
