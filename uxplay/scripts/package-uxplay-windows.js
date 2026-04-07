#!/usr/bin/env node

/**
 * Packages UxPlay Windows build with all required DLLs and dependencies
 * Creates a self-contained zip archive ready for Supabase upload
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const {
  REQUIRED_PLUGINS,
  buildWindowsRuntimeEnv,
} = require('./windows-gstreamer-runtime');
// Use Node.js built-in zlib or extract-zip for creating zip files
// For now, we'll use a simple approach with child_process zip command
// Fallback to adm-zip if available
let AdmZip;
try {
  AdmZip = require('adm-zip');
} catch (error) {
  // Fallback: use zip command if available
  AdmZip = null;
}

function normalizeSubsystem(value) {
  const subsystem = (value || process.env.MSYS2_SUBSYSTEM || process.env.MSYSTEM || 'MINGW64').toUpperCase();
  if (subsystem !== 'MINGW64' && subsystem !== 'UCRT64') {
    throw new Error(`Unsupported MSYS2 subsystem: ${subsystem}`);
  }

  return subsystem;
}

function getToolchainConfig(msys2Base, subsystem) {
  const normalizedSubsystem = normalizeSubsystem(subsystem);
  const toolchainDir = normalizedSubsystem === 'UCRT64' ? 'ucrt64' : 'mingw64';
  const rootDir = path.join(msys2Base, toolchainDir);

  return {
    subsystem: normalizedSubsystem,
    rootDir,
    binDir: path.join(rootDir, 'bin'),
    libDir: path.join(rootDir, 'lib'),
    gstPluginsDir: path.join(rootDir, 'lib', 'gstreamer-1.0'),
    libexecDir: path.join(rootDir, 'libexec', 'gstreamer-1.0'),
    objdumpPath: path.join(rootDir, 'bin', 'objdump.exe'),
  };
}

class UxPlayPackager {
  constructor() {
    this.rootDir = path.join(__dirname, '..');
    this.resourcesDir = path.join(this.rootDir, 'resources');
    this.uxplaySourceCandidates = [
      path.join(this.resourcesDir, 'UxPlay-master'),
      path.join(this.rootDir, '..', '..', 'desktop', 'resources', 'UxPlay-master'),
    ];
    this.uxplaySource = this.uxplaySourceCandidates.find((candidate) => fs.existsSync(candidate)) || this.uxplaySourceCandidates[0];
    this.buildDir = path.join(this.uxplaySource, 'build');
    this.packageDir = path.join(this.resourcesDir, 'temp', 'airplay-bridge');
    this.outputZip = path.join(this.resourcesDir, 'temp', 'airplay-bridge.zip');
    
    // Generic names for distribution (hide implementation details)
    this.sourceExeName = 'uxplay.exe';
    this.targetExeName = 'echo-airplay.exe';
    this.targetBatName = 'echo-airplay.bat';
    
    this.msys2Base = process.env.MSYS2_BASE || 'C:\\msys64';
    this.toolchain = getToolchainConfig(this.msys2Base);
    this.msys2Bin = this.toolchain.binDir;
    this.msys2Lib = this.toolchain.libDir;
    this.msys2GstPlugins = this.toolchain.gstPluginsDir;
    this.msys2Libexec = this.toolchain.libexecDir;
    this.objdumpPath = this.toolchain.objdumpPath;
  }

  /**
   * Check if MSYS2 is installed
   */
  checkMsys2() {
    if (!fs.existsSync(this.msys2Bin)) {
      throw new Error(
        `MSYS2 not found at ${this.msys2Bin}\n` +
        'Please install MSYS2 from https://www.msys2.org/\n' +
        'Or set MSYS2_BASE environment variable to your MSYS2 installation path'
      );
    }
    console.log(`✓ MSYS2 found at: ${this.msys2Base}`);
    console.log(`✓ Using ${this.toolchain.subsystem} toolchain runtime`);
  }

  /**
   * Check if build exists
   */
  checkBuild() {
    const exePath = path.join(this.buildDir, 'uxplay.exe');
    if (!fs.existsSync(exePath)) {
      throw new Error(
        `UxPlay executable not found at ${exePath}\n` +
        'Please run the build script first: npm run build:uxplay:windows'
      );
    }
    console.log(`✓ UxPlay executable found: ${exePath}`);
  }

  /**
   * Get list of required DLLs
   */
  getRequiredDlls() {
    return [
      // GStreamer core
      'libgstreamer-1.0-0.dll',
      'libgstbase-1.0-0.dll',
      'libgstvideo-1.0-0.dll',
      'libgstaudio-1.0-0.dll',
      'libgstapp-1.0-0.dll',
      'libgstpbutils-1.0-0.dll',
      'libgstrtp-1.0-0.dll',
      'libgstsdp-1.0-0.dll',
      
      // OpenSSL
      'libssl-3-x64.dll',
      'libcrypto-3-x64.dll',
      
      // libplist
      'libplist-2.0.dll',
      
      // GLib (required by GStreamer)
      'libglib-2.0-0.dll',
      'libgobject-2.0-0.dll',
      'libgio-2.0-0.dll',
      'libgmodule-2.0-0.dll',
      'libgthread-2.0-0.dll',
      
      // Other dependencies
      'libffi-8.dll',
      'libintl-8.dll',
      'libpcre2-8-0.dll',
      'libzstd.dll',
      'libbz2-1.dll',
      'liblzma-5.dll',
      'zlib1.dll', // Note: zlib is named zlib1.dll in MSYS2, not libz.dll
      
      // XML (for libplist)
      'libxml2-2.dll',
      
      // Iconv
      'libiconv-2.dll',
      
      // WinPthreads (MinGW runtime)
      'libwinpthread-1.dll',
      
      // C++ Standard Library (required for GCC-compiled executables)
      'libstdc++-6.dll',
      
      // GCC Runtime (SEH exception handling)
      'libgcc_s_seh-1.dll',
    ];
  }

  getDependencyEntryPoints() {
    const entryPoints = [
      path.join(this.buildDir, this.sourceExeName),
      ...REQUIRED_PLUGINS.map((plugin) => path.join(this.msys2GstPlugins, plugin)),
    ];

    const scannerSource = path.join(this.msys2Libexec, 'gst-plugin-scanner.exe');
    if (fs.existsSync(scannerSource)) {
      entryPoints.push(scannerSource);
    }

    return entryPoints.filter((entryPath) => fs.existsSync(entryPath));
  }

  parseDllDependencies(binaryPath) {
    const output = execFileSync(this.objdumpPath, ['-p', binaryPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });

    return output
      .split(/\r?\n/u)
      .map((line) => line.match(/^\s*DLL Name:\s+(.+)$/u))
      .filter(Boolean)
      .map((match) => match[1].trim())
      .filter(Boolean);
  }

  findDependencySource(dllName) {
    const candidates = [
      path.join(this.msys2Bin, dllName),
      path.join(this.msys2Lib, dllName),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  collectDependencyClosure(entryPoints) {
    if (!fs.existsSync(this.objdumpPath)) {
      throw new Error(`objdump not found at ${this.objdumpPath}`);
    }

    const queue = [...entryPoints];
    const visitedFiles = new Set();
    const resolvedDependencies = new Map();

    while (queue.length > 0) {
      const currentPath = queue.pop();
      if (!currentPath || visitedFiles.has(currentPath) || !fs.existsSync(currentPath)) {
        continue;
      }

      visitedFiles.add(currentPath);

      let dllNames;
      try {
        dllNames = this.parseDllDependencies(currentPath);
      } catch (error) {
        throw new Error(`Failed to inspect dependencies for ${currentPath}: ${error.message}`);
      }

      for (const dllName of dllNames) {
        const key = dllName.toLowerCase();
        if (resolvedDependencies.has(key)) {
          continue;
        }

        const sourcePath = this.findDependencySource(dllName);
        if (!sourcePath) {
          continue;
        }

        resolvedDependencies.set(key, sourcePath);
        queue.push(sourcePath);
      }
    }

    return [...resolvedDependencies.values()];
  }

  /**
   * Copy DLLs from MSYS2 to package directory
   */
  copyDlls() {
    console.log('\nCopying required DLLs...');
    const dlls = this.getRequiredDlls();
    let copied = 0;
    const missing = [];

    for (const dll of dlls) {
      const sourcePath = path.join(this.msys2Bin, dll);
      const destPath = path.join(this.packageDir, dll);

      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, destPath);
        copied++;
        console.log(`  ✓ ${dll}`);
      } else {
        missing.push(dll);
        console.log(`  ✗ ${dll} (not found)`);
      }
    }

    console.log('\nTracing transitive DLL dependencies from the bridge and curated plugins...');
    const dependencyPaths = this.collectDependencyClosure(this.getDependencyEntryPoints());
    let tracedCopied = 0;
    for (const sourcePath of dependencyPaths) {
      const dllName = path.basename(sourcePath);
      const destPath = path.join(this.packageDir, dllName);
      if (fs.existsSync(destPath)) {
        continue;
      }

      fs.copyFileSync(sourcePath, destPath);
      tracedCopied++;
    }
    if (tracedCopied > 0) {
      console.log(`  ✓ Copied ${tracedCopied} traced dependency DLLs`);
      copied += tracedCopied;
    }

    // Also copy dnssd.dll from System32 if available (Bonjour SDK)
    const dnssdPath = 'C:\\Windows\\System32\\dnssd.dll';
    if (fs.existsSync(dnssdPath)) {
      const destDnssd = path.join(this.packageDir, 'dnssd.dll');
      try {
        if (!fs.existsSync(destDnssd)) {
          fs.copyFileSync(dnssdPath, destDnssd);
          console.log(`  ✓ dnssd.dll (from System32)`);
          copied++;
        }
      } catch (error) {
        console.warn(`  ⚠ Could not copy dnssd.dll: ${error.message}`);
        console.warn('    (This is usually OK as it should be in System32)');
      }
    }

    if (missing.length > 0) {
      console.warn(`\nWarning: ${missing.length} DLLs not found:`);
      missing.forEach(dll => console.warn(`  - ${dll}`));
      console.warn('Package may be incomplete. Some features may not work.');
    }

    console.log(`\nCopied ${copied} DLLs total`);
  }

  /**
   * Copy GStreamer plugins
   */
  copyGstPlugins() {
    console.log('\nCopying GStreamer plugins...');
    const pluginsDir = path.join(this.packageDir, 'lib', 'gstreamer-1.0');
    
    if (!fs.existsSync(this.msys2GstPlugins)) {
      console.warn(`Warning: GStreamer plugins directory not found at ${this.msys2GstPlugins}`);
      return;
    }

    // Create plugins directory
    fs.mkdirSync(pluginsDir, { recursive: true });

    let copied = 0;
    for (const plugin of REQUIRED_PLUGINS) {
      const sourcePath = path.join(this.msys2GstPlugins, plugin);
      const destPath = path.join(pluginsDir, plugin);

      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, destPath);
        copied++;
        console.log(`  ✓ ${plugin}`);
      } else {
        throw new Error(`Required GStreamer plugin not found in MSYS2: ${plugin}`);
      }
    }

    const scannerSource = path.join(this.msys2Libexec, 'gst-plugin-scanner.exe');
    const scannerDest = path.join(this.packageDir, 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner.exe');
    if (fs.existsSync(scannerSource)) {
      fs.mkdirSync(path.dirname(scannerDest), { recursive: true });
      fs.copyFileSync(scannerSource, scannerDest);
      console.log('  ✓ gst-plugin-scanner.exe');
    }

    console.log(`\nCopied ${copied} curated plugins`);
  }

  /**
   * Create wrapper script to set GST_PLUGIN_PATH
   */
  createWrapperScript() {
    console.log('\nCreating wrapper script...');
    
    const wrapperContent = `@echo off
REM Echo AirPlay Bridge - GStreamer environment wrapper
REM Note: Don't use setlocal/endlocal to ensure PATH changes persist

REM Set paths relative to script location
set "SCRIPT_DIR=%~dp0"

REM Add package directory to PATH FIRST so DLLs can be found
REM This ensures plugins can find their DLL dependencies
REM Add root directory first (contains most DLLs), then plugin directory
set "PATH=%SCRIPT_DIR%;%SCRIPT_DIR%lib\\gstreamer-1.0;%PATH%"

REM Set GStreamer plugin path
set "GST_PLUGIN_PATH=%SCRIPT_DIR%lib\\echo-gstreamer-plugins"
set "GST_PLUGIN_SYSTEM_PATH_1_0=%SCRIPT_DIR%lib\\echo-gstreamer-plugins"
set "ORC_CODE=backup"

REM Set GStreamer registry (optional, helps with plugin loading)
set "GST_REGISTRY=%TEMP%\\gst-registry-%RANDOM%.bin"
set "GST_REGISTRY_FORK=no"
if exist "%SCRIPT_DIR%libexec\\gstreamer-1.0\\gst-plugin-scanner.exe" set "GST_PLUGIN_SCANNER=%SCRIPT_DIR%libexec\\gstreamer-1.0\\gst-plugin-scanner.exe"

REM Run AirPlay bridge with the configured environment
"%SCRIPT_DIR%${this.targetExeName}" %*
`;

    const wrapperPath = path.join(this.packageDir, this.targetBatName);
    fs.writeFileSync(wrapperPath, wrapperContent, 'utf8');
    console.log(`  ✓ Created ${this.targetBatName} wrapper`);
  }

  /**
   * Create package directory structure
   */
  setupPackageDir() {
    console.log('\nSetting up package directory...');
    
    // Clean previous package
    if (fs.existsSync(this.packageDir)) {
      fs.rmSync(this.packageDir, { recursive: true, force: true });
    }
    
    fs.mkdirSync(this.packageDir, { recursive: true });
    console.log(`✓ Package directory: ${this.packageDir}`);
  }

  /**
   * Copy and rename executable to generic name
   */
  copyExecutable() {
    console.log('\nCopying AirPlay bridge executable...');
    const sourceExe = path.join(this.buildDir, this.sourceExeName);
    const destExe = path.join(this.packageDir, this.targetExeName);
    
    fs.copyFileSync(sourceExe, destExe);
    console.log(`✓ Copied and renamed: ${this.sourceExeName} -> ${this.targetExeName}`);
  }

  /**
   * Create README for package
   */
  createReadme() {
    const readmeContent = `Echo AirPlay Bridge - Self-Contained Package

This package contains:
- ${this.targetExeName} - AirPlay server executable
- Required DLLs - All runtime dependencies
- GStreamer plugins - Video/audio processing plugins

Usage:
  Run ${this.targetBatName} (recommended) or ${this.targetExeName} directly

Requirements:
  - Windows 10 or later (64-bit)
  - Network access for AirPlay discovery

Validation:
  Run node uxplay/scripts/validate-windows-package.js <path-to-echo-airplay.exe>
`;

    const readmePath = path.join(this.packageDir, 'README.txt');
    fs.writeFileSync(readmePath, readmeContent, 'utf8');
    console.log('✓ Created README.txt');
  }

  /**
   * Create zip archive
   */
  createZip() {
    console.log('\nCreating zip archive...');
    
    // Clean previous zip
    if (fs.existsSync(this.outputZip)) {
      fs.unlinkSync(this.outputZip);
    }

    if (AdmZip) {
      const zip = new AdmZip();
      zip.addLocalFolder(this.packageDir, '');
      zip.writeZip(this.outputZip);
    } else {
      // Fallback: try to use PowerShell Compress-Archive
      try {
        const psCmd = `Compress-Archive -Path "${this.packageDir}\\*" -DestinationPath "${this.outputZip}" -Force`;
        execSync(`powershell -Command "${psCmd}"`, {
          stdio: 'inherit',
        });
      } catch (error) {
        throw new Error(
          'Failed to create zip archive. Please install adm-zip:\n' +
          '  npm install --save-dev adm-zip\n' +
          'Or ensure zip command or PowerShell is available'
        );
      }
    }

    const stats = fs.statSync(this.outputZip);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    
    console.log(`✓ Created: ${this.outputZip}`);
    console.log(`✓ Size: ${sizeMB} MB`);
  }

  validatePackage() {
    console.log('\nValidating packaged bridge runtime...');
    const bridgeExe = path.join(this.packageDir, this.targetExeName);
    const runtime = buildWindowsRuntimeEnv(bridgeExe, process.env);
    const validationArgs = [
      '-n', 'Echo Validation',
      '-p', '47000,47001,47002',
      '-vrtp', 'config-interval=1 ! udpsink host=127.0.0.1 port=47010',
    ];

    const result = execSync(
      `node "${path.join(__dirname, 'validate-windows-package.js')}" "${bridgeExe}"`,
      {
        cwd: this.rootDir,
        stdio: 'inherit',
        env: runtime.env,
      },
    );

    return result;
  }

  /**
   * Main packaging process
   */
  async package() {
    try {
      console.log('==========================================');
      console.log('Echo AirPlay Bridge - Windows Packaging');
      console.log('==========================================\n');

      this.checkMsys2();
      this.checkBuild();
      this.setupPackageDir();
      this.copyExecutable();
      this.copyDlls();
      this.copyGstPlugins();
      this.createWrapperScript();
      this.createReadme();
      this.validatePackage();
      this.createZip();

      console.log('\n==========================================');
      console.log('Packaging completed successfully!');
      console.log('==========================================');
      console.log(`\nOutput: ${this.outputZip}`);
      console.log('\nNext step: Run "npm run upload:airplay-bridge" to upload to Supabase\n');
    } catch (error) {
      console.error('\n❌ Packaging failed:', error.message);
      process.exit(1);
    }
  }
}

// Run if executed directly
if (require.main === module) {
  const packager = new UxPlayPackager();
  packager.package();
}

module.exports = UxPlayPackager;
