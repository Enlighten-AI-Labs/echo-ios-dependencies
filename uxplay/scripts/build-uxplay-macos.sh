#!/bin/bash
# Legacy entry point. The supported macOS build is `npm run build:macos`, which builds the pinned
# UxPlay source and packages a relocatable, validated bridge. This script only delegates to it so
# it can no longer produce a Homebrew-linked binary or install packages.
# Requires ECHO_MACOS_MIN_VERSION (see uxplay/docs/UXPLAY_BUILD_README.md).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../.."
exec npm run build:macos
