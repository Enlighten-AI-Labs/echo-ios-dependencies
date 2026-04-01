#!/bin/bash
# Build script for UxPlay on Windows using MSYS2 UCRT64
# This script should be run from MSYS2 UCRT64 terminal or executed via Node.js wrapper

set -e  # Exit on error

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UXPLAY_SOURCE="$PROJECT_ROOT/resources/UxPlay-master"
BUILD_DIR="$UXPLAY_SOURCE/build"

echo "=========================================="
echo "UxPlay Windows Build Script"
echo "=========================================="
echo "Project root: $PROJECT_ROOT"
echo "UxPlay source: $UXPLAY_SOURCE"
echo "Build directory: $BUILD_DIR"
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
  mingw-w64-ucrt-x86_64-cmake \
  mingw-w64-ucrt-x86_64-gcc \
  mingw-w64-ucrt-x86_64-ninja \
  mingw-w64-ucrt-x86_64-libplist \
  mingw-w64-ucrt-x86_64-gstreamer \
  mingw-w64-ucrt-x86_64-gst-plugins-base \
  mingw-w64-ucrt-x86_64-gst-libav \
  mingw-w64-ucrt-x86_64-gst-plugins-good \
  mingw-w64-ucrt-x86_64-gst-plugins-bad || {
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
cmake .. -G Ninja || {
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
