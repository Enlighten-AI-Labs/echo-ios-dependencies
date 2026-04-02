# Echo iOS Dependencies

This repository contains separately distributed companion runtimes and build scripts for iOS mirroring support on macOS and Windows.

The intent is to keep these artifacts outside any closed-source desktop application bundle and publish them independently with their own licenses, notices, and release assets.

## Contents

- `ffmpeg/`
  A separately distributed `ffmpeg` binary plus license and notice files.
- `uxplay/scripts/`
  Build and packaging scripts for the iOS bridge companion on macOS and Windows.
- `uxplay/docs/`
  Notes about building and packaging the companion.
- `scripts/`
  Helper scripts for assembling downloadable companion bundles.

## Build Outputs

The macOS packaging flow produces:

- `uxplay/resources/temp/airplay-bridge.zip`
  A packaged iOS bridge binary.
- `dist/echo-ios-dependencies-macos.zip`
  A downloadable bundle containing the companion binaries and notices.

The Windows packaging flow produces:

- `uxplay/resources/temp/airplay-bridge.zip`
  A packaged Windows iOS bridge binary.
- `dist/echo-ios-dependencies-windows.zip`
  A downloadable bundle containing the companion binaries and notices.

## Local Layout

The bundle layout is:

- `airplay-bridge/`
- `ffmpeg/`
- `manifest.json`

## Build

Install dependencies:

```bash
npm install
```

Build the macOS companion bundle:

```bash
npm run build:macos
```

Build the Windows companion bundle:

```bash
npm run build:windows
```

## Notes

- The repository does not need to expose or document any closed-source application internals.
- Release artifacts should be published through this repository's release process or another standalone distribution channel.

See [runtime-paths.md](./runtime-paths.md) for generic install layout notes.
