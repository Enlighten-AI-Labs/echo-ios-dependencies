#!/bin/bash
# Compiles UxPlay on macOS using Homebrew
# Prerequisites: Homebrew installed, Xcode Command Line Tools

set -e  # Exit on error

echo "=========================================="
echo "UxPlay macOS Build Script"
echo "=========================================="

# Check if we're on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
  echo "ERROR: This script must be run on macOS"
  exit 1
fi

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UXPLAY_SOURCE="$PROJECT_ROOT/resources/UxPlay-master"
BUILD_DIR="$UXPLAY_SOURCE/build"

echo "Project root: $PROJECT_ROOT"
echo "UxPlay source: $UXPLAY_SOURCE"

# Check if UxPlay source exists
if [ ! -d "$UXPLAY_SOURCE" ]; then
  echo "ERROR: UxPlay source not found at $UXPLAY_SOURCE"
  echo "Please ensure resources/UxPlay-master directory exists"
  exit 1
fi

# Check for Homebrew
if ! command -v brew &> /dev/null; then
  echo "ERROR: Homebrew not found"
  echo "Please install Homebrew from https://brew.sh"
  exit 1
fi

echo "Homebrew found: $(brew --version | head -n1)"

# Check for Xcode Command Line Tools
if ! xcode-select -p &> /dev/null; then
  echo "ERROR: Xcode Command Line Tools not found"
  echo "Please install with: xcode-select --install"
  exit 1
fi

echo "Xcode Command Line Tools found"

# Install build dependencies
echo ""
echo "Installing build dependencies..."
brew install --formula cmake gstreamer openssl@3 libplist || {
  echo "ERROR: Failed to install dependencies"
  exit 1
}

# Check if dependencies are installed
if ! command -v cmake &> /dev/null; then
  echo "ERROR: CMake not found after installation"
  exit 1
fi

# Get number of CPU cores for parallel build
CPU_CORES=$(sysctl -n hw.ncpu)
echo "Detected $CPU_CORES CPU cores"

# Create build directory
echo ""
echo "Creating build directory..."
cd "$UXPLAY_SOURCE"
mkdir -p build
cd build

# Configure with CMake
echo ""
echo "Configuring build with CMake..."
cmake .. -DGST_MACOS=ON || {
  echo "ERROR: CMake configuration failed"
  exit 1
}

# Build
echo ""
echo "Building UxPlay (using $CPU_CORES parallel jobs)..."
make -j"$CPU_CORES" || {
  echo "ERROR: Build failed"
  exit 1
}

# Check if executable was created
if [ -f "uxplay" ]; then
  echo ""
  echo "=========================================="
  echo "Build successful!"
  echo "=========================================="
  echo "Executable: $BUILD_DIR/uxplay"
  ls -lh uxplay
  
  # Make executable
  chmod +x uxplay
  
  echo ""
  echo "Next steps:"
  echo "  1. Run: npm run package:uxplay:macos"
  echo "  2. Run: npm run upload:uxplay"
else
  echo "ERROR: Build completed but uxplay executable not found"
  exit 1
fi
