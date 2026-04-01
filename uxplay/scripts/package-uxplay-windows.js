#!/usr/bin/env node

/**
 * Packages UxPlay Windows build with all required DLLs and dependencies
 * Creates a self-contained zip archive ready for Supabase upload
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
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

class UxPlayPackager {
  constructor() {
    this.rootDir = path.join(__dirname, '..');
    this.resourcesDir = path.join(this.rootDir, 'resources');
    this.uxplaySource = path.join(this.resourcesDir, 'UxPlay-master');
    this.buildDir = path.join(this.uxplaySource, 'build');
    this.packageDir = path.join(this.resourcesDir, 'temp', 'airplay-bridge');
    this.outputZip = path.join(this.resourcesDir, 'temp', 'airplay-bridge.zip');
    
    // Generic names for distribution (hide implementation details)
    this.sourceExeName = 'uxplay.exe';
    this.targetExeName = 'echo-airplay.exe';
    this.targetBatName = 'echo-airplay.bat';
    
    // MSYS2 UCRT64 paths (default installation)
    this.msys2Base = process.env.MSYS2_BASE || 'C:\\msys64';
    this.msys2Bin = path.join(this.msys2Base, 'ucrt64', 'bin');
    this.msys2Lib = path.join(this.msys2Base, 'ucrt64', 'lib');
    this.msys2GstPlugins = path.join(this.msys2Base, 'ucrt64', 'lib', 'gstreamer-1.0');
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

  /**
   * Copy DLLs from MSYS2 to package directory
   */
  copyDlls() {
    console.log('\nCopying required DLLs...');
    const dlls = this.getRequiredDlls();
    let copied = 0;
    let missing = [];

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

    // Copy additional GStreamer-related DLLs that plugins might need
    const additionalDlls = [
      'libgstallocators-1.0-0.dll',
      'libgstcontroller-1.0-0.dll',
      'libgstnet-1.0-0.dll',
      'libgsttag-1.0-0.dll',
      'liborc-0.4-0.dll', // ORC (Optimized Inner Loop Runtime Compiler) - used by many plugins
    ];

    // Copy FFmpeg libraries (required by libgstlibav.dll) - find by pattern
    console.log('\nCopying FFmpeg DLLs...');
    try {
      const ffmpegDlls = fs.readdirSync(this.msys2Bin).filter(file => 
        (file.startsWith('avcodec') || file.startsWith('avformat') || 
         file.startsWith('avutil') || file.startsWith('avfilter') ||
         file.startsWith('avdevice') || file.startsWith('swscale') ||
         file.startsWith('swresample')) && file.endsWith('.dll')
      );
      
      for (const dll of ffmpegDlls) {
        const sourcePath = path.join(this.msys2Bin, dll);
        const destPath = path.join(this.packageDir, dll);
        if (!fs.existsSync(destPath)) {
          fs.copyFileSync(sourcePath, destPath);
          console.log(`  ✓ ${dll}`);
          copied++;
        }
      }
    } catch (error) {
      console.warn(`  ⚠ Could not copy FFmpeg DLLs: ${error.message}`);
    }

    console.log('\nCopying additional GStreamer DLLs...');
    for (const dll of additionalDlls) {
      const sourcePath = path.join(this.msys2Bin, dll);
      const destPath = path.join(this.packageDir, dll);

      if (fs.existsSync(sourcePath)) {
        if (!fs.existsSync(destPath)) {
          fs.copyFileSync(sourcePath, destPath);
          copied++;
          console.log(`  ✓ ${dll}`);
        }
      }
    }

    // Copy ALL DLLs from MSYS2 bin to ensure we have all dependencies
    // This is a catch-all to ensure plugins can find their DLL dependencies
    console.log('\nCopying all remaining DLLs from bin directory...');
    try {
      const allDlls = fs.readdirSync(this.msys2Bin).filter(file => 
        file.endsWith('.dll')
      );
      
      let additionalCopied = 0;
      for (const dll of allDlls) {
        const destPath = path.join(this.packageDir, dll);
        if (!fs.existsSync(destPath)) {
          const sourcePath = path.join(this.msys2Bin, dll);
          fs.copyFileSync(sourcePath, destPath);
          additionalCopied++;
        }
      }
      if (additionalCopied > 0) {
        console.log(`  ✓ Copied ${additionalCopied} additional DLLs`);
        copied += additionalCopied;
      }
    } catch (error) {
      console.warn(`  ⚠ Could not copy all DLLs: ${error.message}`);
    }

    // Also copy DLLs from MSYS2 lib directory (some dependencies might be there)
    const msys2Lib = path.join(this.msys2Base, 'ucrt64', 'lib');
    if (fs.existsSync(msys2Lib)) {
      console.log('\nCopying DLLs from MSYS2 lib directory...');
      try {
        const libDlls = fs.readdirSync(msys2Lib, { recursive: true, withFileTypes: true })
          .filter(dirent => dirent.isFile() && dirent.name.endsWith('.dll'))
          .map(dirent => path.join(dirent.path, dirent.name));
        
        let libCopied = 0;
        for (const libDll of libDlls) {
          const dllName = path.basename(libDll);
          const destPath = path.join(this.packageDir, dllName);
          
          // Only copy if not already in package and it's a relevant DLL
          if (!fs.existsSync(destPath) && 
              (dllName.startsWith('lib') || dllName.startsWith('av') || dllName.startsWith('sw'))) {
            try {
              fs.copyFileSync(libDll, destPath);
              libCopied++;
            } catch (err) {
              // Skip if copy fails (permissions, etc.)
            }
          }
        }
        if (libCopied > 0) {
          console.log(`  ✓ Copied ${libCopied} DLLs from lib directory`);
          copied += libCopied;
        }
      } catch (error) {
        console.warn(`  ⚠ Could not copy DLLs from lib directory: ${error.message}`);
      }
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

    // Copy essential plugins
    const essentialPlugins = [
      'libgstcoreelements.dll',
      'libgsttypefindfunctions.dll',
      'libgstplayback.dll',
      'libgstrawparse.dll',
      'libgstvideoconvert.dll',
      'libgstvideoscale.dll',
      'libgstvideorate.dll',
      'libgstaudioconvert.dll',
      'libgstaudioresample.dll',
      'libgstapp.dll',
      'libgsttcp.dll',
      'libgstudp.dll',
      'libgstrtp.dll',
      'libgstrtsp.dll',
      'libgstsdp.dll',
      'libgstvideotestsrc.dll',
      'libgstaudiotestsrc.dll',
      'libgstautodetect.dll',
      'libgstlibav.dll', // For h264/aac decoding
      'libgstopenh264.dll', // Alternative h264 decoder
      'libgstx264.dll', // x264 encoder
      'libgstvideoparsersbad.dll', // h264 parser
      'libgstvideofilter.dll',
      'libgstaudiofx.dll',
      'libgstvolume.dll',
    ];

    let copied = 0;
    const pluginFiles = fs.readdirSync(this.msys2GstPlugins);

    for (const plugin of essentialPlugins) {
      const sourcePath = path.join(this.msys2GstPlugins, plugin);
      const destPath = path.join(pluginsDir, plugin);

      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, destPath);
        copied++;
        console.log(`  ✓ ${plugin}`);
      }
    }

    // Also copy any other plugins that might be needed
    for (const file of pluginFiles) {
      if (file.endsWith('.dll') && !essentialPlugins.includes(file)) {
        const sourcePath = path.join(this.msys2GstPlugins, file);
        const destPath = path.join(pluginsDir, file);
        if (!fs.existsSync(destPath)) {
          fs.copyFileSync(sourcePath, destPath);
          console.log(`  + ${file} (additional)`);
        }
      }
    }

    console.log(`\nCopied ${copied} essential plugins`);
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
set "GST_PLUGIN_PATH=%SCRIPT_DIR%lib\\gstreamer-1.0"

REM Set GStreamer registry (optional, helps with plugin loading)
set "GST_REGISTRY=%TEMP%\\gst-registry-%RANDOM%.bin"

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
