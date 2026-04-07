# Runtime Paths

This document describes the generic companion layout produced by this repository.

## `ffmpeg`

Recommended locations:

1. `ffmpeg/ffmpeg`
2. `bin/ffmpeg`
3. `ffmpeg`
4. any `ffmpeg` available on the system `PATH`

## iOS Bridge Companion

Recommended locations:

1. `airplay-bridge/echo-airplay`
2. `airplay-bridge/uxplay`
3. `bin/echo-airplay`
4. `bin/uxplay`
5. any compatible bridge executable available on the system `PATH`

## Bundle Layout

The downloadable macOS bundle is expected to contain:

- `airplay-bridge/`
- `ffmpeg/`
- `manifest.json`

This repository is intended to distribute those artifacts independently from any desktop application bundle.
