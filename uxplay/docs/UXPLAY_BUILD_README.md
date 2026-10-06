# Echo iOS Bridge Packaging Note

This repository builds and packages the UxPlay-based AirPlay bridge as a separately distributed companion runtime. Echo Desktop does not bundle, download or install the bridge in-app.

## macOS

`npm run build:macos` runs three steps. Each step removes its previous outputs, and everything downstream of them, before it starts. If a step fails with an error, it also removes anything it wrote, so a failed command never leaves a final zip or sidecar behind.

1. `build:macos:uxplay`: downloads (or reads from `UXPLAY_SOURCE_ARCHIVE`) the pinned UxPlay 1.73.6 source archive (commit `21eef8df25d91e12635c36d8176ad192725baca2`) and checks its sha256 before a bounded, path-checked extraction. It then builds thin arm64 with the selected deployment target and writes `uxplay/resources/temp/uxplay-build/build-info.json`.
2. `package:macos:uxplay`: collects the full recursive dylib closure of the binary, the curated GStreamer plugins and `gst-plugin-scanner`. `@rpath` is resolved the way dyld does, including run paths inherited from the executable that loads a library. Plugins only get their own run paths, because their loader isn't known at build time. It then:
   - rewrites every install name to `@rpath` with relative rpaths
   - ad-hoc signs the copied files
   - writes license texts, `THIRD_PARTY_NOTICES.md` and `provenance.json` (UxPlay commit, per-component source URL and sha256, per-file sha256, release gaps)
   - validates the result and writes `uxplay/resources/temp/airplay-bridge.zip`
3. `bundle:macos`: validates the bridge and the unchanged checked-in `ffmpeg`, then assembles `dist/echo-ios-dependencies-macos.zip`. `ffmpeg/LICENSE` and `ffmpeg/ffmpeg.LICENSE` are required. It validates the final zip, including an offline relocated runtime check. It then writes `dist/echo-ios-dependencies-macos.manifest.json` with the final zip sha256, and only after that renames the zip into place.

If the process is killed outright (for example SIGKILL or power loss), cleanup code can't run. Outputs are written as `*.partial` files and renamed into place, so a killed run can leave `*.partial` files, or a sidecar manifest without its zip. It can't leave a final zip without its sidecar. The next run removes all of these before it starts.

`npm run validate:macos` re-runs the full validation on `dist/echo-ios-dependencies-macos.zip`. Besides checking every file hash, it requires:
- each component's license notices to be present
- the manifest to match the bridge's `provenance.json` (components, UxPlay source, release gaps)
- `echo-airplay`, the plugin scanner, the wrapper and `ffmpeg` to be executable
- `echo-airplay`, the scanner and `ffmpeg` to be Mach-O executables, and the required plugins and bundled libraries to be Mach-O libraries
- valid code signatures on every bundled Mach-O file and on `ffmpeg` (checked statically with `codesign --verify --strict`; `ffmpeg` itself is never run)

Source attribution is recorded per step:
- the bridge's `provenance.json` records the companion commit it was packaged from
- `manifest.json` records the companion commit that bundled it
- both record the pinned UxPlay source commit and archive hash

`npm run build:macos` rebuilds every step from the same checkout, so the two commits match. Bundling a previously packaged bridge keeps the bridge's own record unchanged, with its hash in the manifest. Release evidence should come from a fresh full pipeline at the exact release commit.

`npm test` covers the packaging and validation rules with small compiled fixtures.

### Support contract

- **Architecture:** thin `arm64` only. Intel and universal binaries are rejected, including an Intel `ffmpeg`.
- **Minimum macOS:** must be selected explicitly with `ECHO_MACOS_MIN_VERSION`. No default is taken from the build host. Every bundled binary, library, plugin, the scanner and `ffmpeg` must have a minimum OS at or below the selected target, otherwise packaging fails. Homebrew bottles carry the minimum OS of the machine they were built for, for example 26.0 on macOS 26.
- **Build kind:** until a production minimum macOS is approved (`MACOS_CONTRACT.approvedMinimumMacOS`), every build is labelled `development` in `provenance.json`, `manifest.json` and `README.txt`.

```bash
ECHO_MACOS_MIN_VERSION=26.0 npm run build:macos
```

The UxPlay compile uses 4 parallel jobs by default. To change this, set `ECHO_MACOS_BUILD_JOBS` to a whole number from 1 to 16. Any other value fails before the build starts.

### Build requirements

These are build-time only. The scripts check for them read-only and never install anything:

- Xcode command line tools: `clang`, `otool`, `lipo`, `install_name_tool`, `codesign`
- `cmake` and `pkg-config`
- GStreamer ≥ 1.24 (with gst-plugins-base/good/bad and gst-libav), `libplist` and `openssl@3`, for example from Homebrew

The packaged bridge does not load anything from Homebrew. `echo-airplay` is self-contained:

- libraries are in `airplay-bridge/lib/`
- plugins are in `airplay-bridge/lib/gstreamer-1.0/`
- the scanner is in `airplay-bridge/libexec/gstreamer-1.0/`

GStreamer finds the plugins and the scanner relative to its own library location, so no environment variables or wrapper are needed. `echo-airplay-wrapper.sh` is kept only for compatibility and execs the binary directly.

### Not bundled

These UxPlay options need plugins that are not included:

- cover art: `-ca`
- recording: `-mp4`
- HLS video: `-hls`

`uxplay/scripts/build-uxplay-macos.sh` is a legacy entry point that only delegates to `npm run build:macos`.
