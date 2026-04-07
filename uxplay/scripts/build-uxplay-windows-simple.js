#!/usr/bin/env node

/**
 * Simplified Windows build script that can run directly
 * Checks for MSYS2 and executes build commands
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MSYS2_BASE = process.env.MSYS2_BASE || 'C:\\msys64';
const MSYS2_BASH = path.join(MSYS2_BASE, 'usr', 'bin', 'bash.exe');

function getToolchainConfig() {
  const subsystem = (process.env.MSYS2_SUBSYSTEM || process.env.MSYSTEM || 'MINGW64').toUpperCase();
  if (subsystem === 'UCRT64') {
    return {
      subsystem,
      packagePrefix: 'mingw-w64-ucrt-x86_64',
    };
  }

  if (subsystem === 'MINGW64') {
    return {
      subsystem,
      packagePrefix: 'mingw-w64-x86_64',
    };
  }

  throw new Error(`Unsupported MSYS2 subsystem: ${subsystem}`);
}

class UxPlayBuilder {
  constructor() {
    this.scriptDir = __dirname;
    this.projectRoot = path.join(this.scriptDir, '..');
    this.uxplaySource = path.join(this.projectRoot, 'resources', 'UxPlay-master');
    this.buildDir = path.join(this.uxplaySource, 'build');
  }

  checkMsys2() {
    if (!fs.existsSync(MSYS2_BASH)) {
      throw new Error(
        `MSYS2 not found at ${MSYS2_BASE}\n` +
        'Please install MSYS2 from https://www.msys2.org/\n' +
        'Default installation: C:\\msys64\n' +
        'Or set MSYS2_BASE environment variable'
      );
    }
    console.log(`✓ MSYS2 found: ${MSYS2_BASE}`);
  }

  checkBonjourSdk() {
    const bonjourSdk = process.env.BONJOUR_SDK_HOME || 'C:\\Program Files\\Bonjour SDK';
    if (!fs.existsSync(bonjourSdk)) {
      console.warn(`⚠ Warning: Bonjour SDK not found at ${bonjourSdk}`);
      console.warn('You may need to install it for the build to succeed.');
      console.warn('Download from: https://developer.apple.com/download/all/?q=Bonjour%20SDK%20for%20Windows');
    } else {
      console.log(`✓ Bonjour SDK found: ${bonjourSdk}`);
    }
  }

  checkUxPlaySource() {
    if (!fs.existsSync(this.uxplaySource)) {
      throw new Error(
        `UxPlay source not found at ${this.uxplaySource}\n` +
        'Please ensure resources/UxPlay-master directory exists'
      );
    }
    console.log(`✓ UxPlay source found: ${this.uxplaySource}`);
  }

  /**
   * Convert Windows path to MSYS2 path format
   */
  toMsysPath(winPath) {
    return winPath
      .replace(/\\/g, '/')
      .replace(/^([A-Z]):/, (match, drive) => `/${drive.toLowerCase()}`)
      .toLowerCase();
  }

  /**
   * Install dependencies using pacman
   */
  installDependencies() {
    console.log('\nInstalling build dependencies...');
    const toolchain = getToolchainConfig();
    
    const packages = [
      `${toolchain.packagePrefix}-cmake`,
      `${toolchain.packagePrefix}-gcc`,
      `${toolchain.packagePrefix}-ninja`,
      `${toolchain.packagePrefix}-libplist`,
      `${toolchain.packagePrefix}-gstreamer`,
      `${toolchain.packagePrefix}-gst-plugins-base`,
      `${toolchain.packagePrefix}-gst-libav`,
      `${toolchain.packagePrefix}-gst-plugins-good`,
      `${toolchain.packagePrefix}-gst-plugins-bad`,
    ];

    const pacmanCmd = `pacman -S --noconfirm --needed ${packages.join(' ')}`;
    
    // Run pacman through MSYS2 bash
    // Escape quotes properly for Windows command line
    const bashCmd = `"${MSYS2_BASH}" -lc "${pacmanCmd.replace(/"/g, '\\"')}"`;
    
    console.log(`Running: ${bashCmd}`);
    
    try {
      execSync(bashCmd, {
        stdio: 'inherit',
        env: {
          ...process.env,
          MSYSTEM: toolchain.subsystem,
          MSYS2_SUBSYSTEM: toolchain.subsystem,
          CHERE_INVOKING: '1',
        },
        shell: true,
      });
      console.log('✓ Dependencies installed');
    } catch (error) {
      console.warn('Warning: Some packages may already be installed or installation failed');
      console.warn('You may need to install them manually in MSYS2 terminal');
      // Don't fail here - packages might already be installed
    }
  }

  /**
   * Run CMake configuration
   */
  configureBuild() {
    console.log('\nConfiguring build with CMake...');
    const toolchain = getToolchainConfig();
    
    // Clean build directory
    if (fs.existsSync(this.buildDir)) {
      fs.rmSync(this.buildDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.buildDir, { recursive: true });

    const uxplayMsysPath = this.toMsysPath(this.uxplaySource);
    const buildMsysPath = this.toMsysPath(this.buildDir);
    
    const bonjourSdk = process.env.BONJOUR_SDK_HOME || 'C:/Program Files/Bonjour SDK';
    const cmakeCmd = `cd "${buildMsysPath}" && export BONJOUR_SDK_HOME="${bonjourSdk}" && export CFLAGS="-O2 -march=x86-64 -mtune=generic -mno-avx -mno-avx2" && export CXXFLAGS="-O2 -march=x86-64 -mtune=generic -mno-avx -mno-avx2" && cmake .. -G Ninja -DNO_MARCH_NATIVE=ON -DCMAKE_C_FLAGS="$CFLAGS" -DCMAKE_CXX_FLAGS="$CXXFLAGS"`;
    
    // Run through MSYS2 bash
    const bashCmd = `"${MSYS2_BASH}" -lc "${cmakeCmd.replace(/"/g, '\\"')}"`;
    
    console.log(`Running: ${bashCmd}`);
    
    try {
      execSync(bashCmd, {
        stdio: 'inherit',
        env: {
          ...process.env,
          MSYSTEM: toolchain.subsystem,
          MSYS2_SUBSYSTEM: toolchain.subsystem,
          CHERE_INVOKING: '1',
        },
        shell: true,
      });
      console.log('✓ CMake configuration complete');
    } catch (error) {
      throw new Error(`CMake configuration failed: ${error.message}`);
    }
  }

  /**
   * Build with Ninja
   */
  build() {
    console.log('\nBuilding UxPlay...');
    const toolchain = getToolchainConfig();
    
    const buildMsysPath = this.toMsysPath(this.buildDir);
    const ninjaCmd = `cd "${buildMsysPath}" && ninja`;
    
    // Run through MSYS2 bash
    const bashCmd = `"${MSYS2_BASH}" -lc "${ninjaCmd.replace(/"/g, '\\"')}"`;
    
    console.log(`Running: ${bashCmd}`);
    
    try {
      execSync(bashCmd, {
        stdio: 'inherit',
        env: {
          ...process.env,
          MSYSTEM: toolchain.subsystem,
          MSYS2_SUBSYSTEM: toolchain.subsystem,
          CHERE_INVOKING: '1',
        },
        shell: true,
      });
      console.log('✓ Build complete');
    } catch (error) {
      throw new Error(`Build failed: ${error.message}`);
    }
  }

  /**
   * Verify build output
   */
  verifyBuild() {
    const exePath = path.join(this.buildDir, 'uxplay.exe');
    if (!fs.existsSync(exePath)) {
      throw new Error('Build completed but uxplay.exe not found');
    }
    
    const stats = fs.statSync(exePath);
    console.log(`✓ Executable created: ${exePath}`);
    console.log(`  Size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
  }

  /**
   * Main build process
   */
  async run() {
    try {
      console.log('==========================================');
      console.log('UxPlay Windows Build');
      console.log('==========================================\n');
      console.log(`MSYS2 subsystem: ${getToolchainConfig().subsystem}`);

      this.checkMsys2();
      this.checkBonjourSdk();
      this.checkUxPlaySource();
      
      this.installDependencies();
      this.configureBuild();
      this.build();
      this.verifyBuild();

      console.log('\n==========================================');
      console.log('Build successful!');
      console.log('==========================================');
      console.log(`\nExecutable: ${path.join(this.buildDir, 'uxplay.exe')}`);
      console.log('\nNext steps:');
      console.log('  1. npm run package:uxplay:windows');
      console.log('  2. npm run upload:uxplay\n');
    } catch (error) {
      console.error('\n❌ Build failed:', error.message);
      if (error.stdout) console.error('STDOUT:', error.stdout.toString());
      if (error.stderr) console.error('STDERR:', error.stderr.toString());
      process.exit(1);
    }
  }
}

// Run if executed directly
if (require.main === module) {
  const builder = new UxPlayBuilder();
  builder.run();
}

module.exports = UxPlayBuilder;
