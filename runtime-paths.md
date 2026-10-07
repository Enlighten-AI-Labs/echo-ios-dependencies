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

On macOS, `airplay-bridge/` must be kept together as one directory. `echo-airplay` loads its libraries from `airplay-bridge/lib/`, its GStreamer plugins from `airplay-bridge/lib/gstreamer-1.0/` and its plugin scanner from `airplay-bridge/libexec/gstreamer-1.0/`, all relative to its own location. It needs no environment variables and no Homebrew.

This repository is intended to distribute those artifacts independently from any desktop application bundle.
