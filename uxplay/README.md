# UxPlay Companion Contents

This folder now owns the repo-local UxPlay companion tooling.

## Current Contents

- `scripts/`: existing build, package, upload, test, and local-run scripts for the UxPlay-based AirPlay companion
- `docs/`: build notes migrated alongside the scripts
- `airplay-bridge/`: intended drop-in location for built companion binaries

## Important Limitation

This repository does not currently contain a checked-in UxPlay runtime binary. The scripts here are the real build/package toolchain, but some still assume Echo monorepo paths and should be cleaned up before this folder is extracted into its own standalone repo.

## Intended End State

The open-source companion repo should produce:

- macOS: `echo-airplay` and any required wrapper files, with `ffmpeg` installed alongside it
- Windows: `echo-airplay.exe` plus any wrapper/runtime files, with `ffmpeg.exe` alongside it

Echo Desktop should then detect both binaries from the same install root on macOS and Windows.
