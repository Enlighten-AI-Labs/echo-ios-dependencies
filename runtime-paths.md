# Runtime Paths

This document describes the generic companion layout produced by this repository.

## `ffmpeg`

Recommended locations:

1. `ffmpeg/ffmpeg` on macOS
2. `ffmpeg/ffmpeg.exe` on Windows
3. `bin/ffmpeg`
4. `bin/ffmpeg.exe`
5. any `ffmpeg` available on the system `PATH`

## iOS Bridge Companion

Recommended locations:

1. `airplay-bridge/echo-airplay` on macOS
2. `airplay-bridge/echo-airplay.exe` on Windows
3. `airplay-bridge/uxplay`
4. `airplay-bridge/uxplay.exe`
5. `airplay-bridge/uxplay-windows.exe`
6. `bin/echo-airplay`
7. `bin/echo-airplay.exe`
8. `bin/uxplay`
9. `bin/uxplay.exe`
10. any compatible bridge executable available on the system `PATH`

## Bundle Layout

The downloadable bundles are expected to contain:

- `airplay-bridge/`
- `ffmpeg/`
- `manifest.json`

This repository is intended to distribute those artifacts independently from any desktop application bundle.
