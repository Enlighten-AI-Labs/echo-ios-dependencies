#!/bin/bash
# Build script for UxPlay on Windows using MSYS2
# This script should be run from an MSYS2 terminal or executed via Node.js wrapper

set -e  # Exit on error

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UXPLAY_SOURCE="$PROJECT_ROOT/resources/UxPlay-master"
if [ ! -d "$UXPLAY_SOURCE" ]; then
  ALT_UXPLAY_SOURCE="$(cd "$PROJECT_ROOT/../../desktop/resources/UxPlay-master" 2>/dev/null && pwd)"
  if [ -n "$ALT_UXPLAY_SOURCE" ] && [ -d "$ALT_UXPLAY_SOURCE" ]; then
    UXPLAY_SOURCE="$ALT_UXPLAY_SOURCE"
  fi
fi
BUILD_DIR="$UXPLAY_SOURCE/build"

echo "=========================================="
echo "UxPlay Windows Build Script"
echo "=========================================="
echo "Project root: $PROJECT_ROOT"
echo "UxPlay source: $UXPLAY_SOURCE"
echo "Build directory: $BUILD_DIR"
echo ""

MSYS_SUBSYSTEM="${MSYSTEM:-${MSYS2_SUBSYSTEM:-MINGW64}}"
case "$MSYS_SUBSYSTEM" in
  UCRT64)
    PACKAGE_PREFIX="mingw-w64-ucrt-x86_64"
    ;;
  MINGW64)
    PACKAGE_PREFIX="mingw-w64-x86_64"
    ;;
  *)
    echo "ERROR: Unsupported MSYS2 subsystem: $MSYS_SUBSYSTEM"
    echo "Supported values: MINGW64, UCRT64"
    exit 1
    ;;
esac

echo "MSYS2 subsystem: $MSYS_SUBSYSTEM"
echo "Package prefix: $PACKAGE_PREFIX"
echo ""

# Force a conservative CPU target so the Windows bridge works on older x86_64 systems.
export CFLAGS="${CFLAGS:--O2 -march=x86-64 -mtune=generic -mno-avx -mno-avx2}"
export CXXFLAGS="${CXXFLAGS:--O2 -march=x86-64 -mtune=generic -mno-avx -mno-avx2}"
echo "CFLAGS: $CFLAGS"
echo "CXXFLAGS: $CXXFLAGS"
echo ""

# Check if UxPlay source exists
if [ ! -d "$UXPLAY_SOURCE" ]; then
  echo "ERROR: UxPlay source not found at $UXPLAY_SOURCE"
  exit 1
fi

# Check for Bonjour SDK
BONJOUR_SDK="${BONJOUR_SDK_HOME:-/c/Program Files/Bonjour SDK}"
if [ ! -d "$BONJOUR_SDK" ]; then
  echo "WARNING: Bonjour SDK not found at $BONJOUR_SDK"
  echo "Build may fail. Install Bonjour SDK for Windows v3.0"
else
  echo "Bonjour SDK found: $BONJOUR_SDK"
  export BONJOUR_SDK_HOME="$BONJOUR_SDK"
fi

# Install dependencies (if not already installed)
echo ""
echo "Installing/updating dependencies..."
pacman -S --noconfirm --needed \
  ${PACKAGE_PREFIX}-cmake \
  ${PACKAGE_PREFIX}-gcc \
  ${PACKAGE_PREFIX}-ninja \
  ${PACKAGE_PREFIX}-libplist \
  ${PACKAGE_PREFIX}-gstreamer \
  ${PACKAGE_PREFIX}-gst-plugins-base \
  ${PACKAGE_PREFIX}-gst-libav \
  ${PACKAGE_PREFIX}-gst-plugins-good \
  ${PACKAGE_PREFIX}-gst-plugins-bad || {
  echo "Warning: Some packages may already be installed"
}

# Create build directory
echo ""
echo "Setting up build directory..."
cd "$UXPLAY_SOURCE"
if [ -d "$BUILD_DIR" ]; then
  echo "Cleaning previous build..."
  rm -rf "$BUILD_DIR"
fi
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Configure with CMake
echo ""
echo "Configuring build with CMake..."
cmake .. -G Ninja \
  -DNO_MARCH_NATIVE=ON \
  -DCMAKE_C_FLAGS="$CFLAGS" \
  -DCMAKE_CXX_FLAGS="$CXXFLAGS" || {
  echo "ERROR: CMake configuration failed"
  exit 1
}

# Verify build.ninja was created
if [ ! -f "build.ninja" ]; then
  echo "ERROR: build.ninja not created"
  exit 1
fi
echo "✓ build.ninja created"

# Build with Ninja
echo ""
echo "Building UxPlay..."
ninja || {
  echo "ERROR: Build failed"
  exit 1
}

# Verify executable was created
if [ -f "uxplay.exe" ]; then
  echo ""
  echo "=========================================="
  echo "Build successful!"
  echo "=========================================="
  ls -lh uxplay.exe
  echo ""
  echo "Executable: $BUILD_DIR/uxplay.exe"
else
  echo "ERROR: Build completed but uxplay.exe not found"
  echo "Files in build directory:"
  ls -la
  exit 1
fi
