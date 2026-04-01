#!/usr/bin/env node

/**
 * Packages UxPlay macOS build with all required dependencies
 * Creates a zip archive ready for upload to Supabase
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

class UxPlayMacOSPackager {
  constructor() {
    this.rootDir = path.join(__dirname, '..');
    this.resourcesDir = path.join(this.rootDir, 'resources');
    this.uxplaySource = path.join(this.resourcesDir, 'UxPlay-master');
    this.buildDir = path.join(this.uxplaySource, 'build');
    this.packageDir = path.join(this.resourcesDir, 'temp', 'uxplay-package');
    this.outputZip = path.join(this.resourcesDir, 'temp', 'uxplay-macos.zip');
    
    // Homebrew paths
    this.homebrewPrefix = process.env.HOMEBREW_PREFIX || '/opt/homebrew';
    this.homebrewBin = path.join(this.homebrewPrefix, 'bin');
    this.homebrewLib = path.join(this.homebrewPrefix, 'lib');
  }

  /**
   * Check if Homebrew is installed
   */
  checkHomebrew() {
    if (!fs.existsSync(this.homebrewPrefix)) {
      // Try Intel Mac location
      this.homebrewPrefix = '/usr/local';
      this.homebrewBin = path.join(this.homebrewPrefix, 'bin');
      this.homebrewLib = path.join(this.homebrewPrefix, 'lib');
      
      if (!fs.existsSync(this.homebrewPrefix)) {
        throw new Error(
          'Homebrew not found at /opt/homebrew or /usr/local\n' +
          'Please install Homebrew from https://brew.sh'
        );
      }
    }
    console.log(`[package] Homebrew found at: ${this.homebrewPrefix}`);
  }

  /**
   * Check if UxPlay executable exists
   */
  checkUxPlayBuild() {
    const exePath = path.join(this.buildDir, 'uxplay');
    if (!fs.existsSync(exePath)) {
      throw new Error(
        `UxPlay executable not found at ${exePath}\n` +
        'Please run the build script first: npm run build:uxplay:macos'
      );
    }
    console.log(`[package] UxPlay executable found: ${exePath}`);
    return exePath;
  }

  /**
   * Get dynamic library dependencies using otool
   */
  getDylibDependencies(exePath) {
    try {
      const output = execSync(`otool -L "${exePath}"`, { encoding: 'utf8' });
      const deps = [];
      const lines = output.split('\n');
      
      for (const line of lines) {
        const match = line.match(/^\s+(.+\.dylib)/);
        if (match) {
          const libPath = match[1];
          // Only include Homebrew libraries
          if (libPath.includes(this.homebrewPrefix)) {
            deps.push(libPath);
          }
        }
      }
      
      return deps;
    } catch (error) {
      console.warn('[package] Could not get dependencies with otool:', error.message);
      return [];
    }
  }

  /**
   * Copy dynamic library and resolve its dependencies
   */
  copyDylib(libPath, targetDir) {
    const libName = path.basename(libPath);
    const targetPath = path.join(targetDir, libName);
    
    if (!fs.existsSync(libPath)) {
      console.warn(`[package] WARNING: Library not found: ${libPath}`);
      return false;
    }
    
    // Copy library
    fs.copyFileSync(libPath, targetPath);
    
    // Get dependencies of this library
    const deps = this.getDylibDependencies(libPath);
    for (const dep of deps) {
      const depName = path.basename(dep);
      const depTarget = path.join(targetDir, depName);
      if (!fs.existsSync(depTarget) && fs.existsSync(dep)) {
        fs.copyFileSync(dep, depTarget);
        console.log(`[package] Copied dependency: ${depName}`);
      }
    }
    
    console.log(`[package] Copied: ${libName}`);
    return true;
  }

  /**
   * Copy GStreamer plugins
   */
  copyGstPlugins(targetDir) {
    const pluginsDir = path.join(targetDir, 'lib', 'gstreamer-1.0');
    fs.mkdirSync(pluginsDir, { recursive: true });
    
    const gstPluginsPath = path.join(this.homebrewLib, 'gstreamer-1.0');
    if (!fs.existsSync(gstPluginsPath)) {
      console.warn(`[package] WARNING: GStreamer plugins directory not found: ${gstPluginsPath}`);
      return;
    }
    
    // Copy all plugins
    try {
      const plugins = fs.readdirSync(gstPluginsPath);
      let copied = 0;
      
      for (const plugin of plugins) {
        if (plugin.endsWith('.so')) {
          const sourcePath = path.join(gstPluginsPath, plugin);
          const targetPath = path.join(pluginsDir, plugin);
          
          if (fs.statSync(sourcePath).isFile()) {
            fs.copyFileSync(sourcePath, targetPath);
            copied++;
          }
        }
      }
      
      console.log(`[package] Copied ${copied} GStreamer plugins`);
    } catch (error) {
      console.warn(`[package] Error copying plugins: ${error.message}`);
    }
  }

  /**
   * Create package directory structure
   */
  setupPackageDir() {
    // Clean and create package directory
    if (fs.existsSync(this.packageDir)) {
      fs.rmSync(this.packageDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.packageDir, { recursive: true });
    
    console.log(`[package] Package directory: ${this.packageDir}`);
  }

  /**
   * Package UxPlay with all dependencies
   */
  package() {
    console.log('==========================================');
    console.log('UxPlay macOS Packaging');
    console.log('==========================================\n');
    
    // Pre-flight checks
    this.checkHomebrew();
    const exePath = this.checkUxPlayBuild();
    
    // Setup package directory
    this.setupPackageDir();
    
    // Copy executable
    const targetExe = path.join(this.packageDir, 'uxplay');
    fs.copyFileSync(exePath, targetExe);
    
    // Make executable
    fs.chmodSync(targetExe, 0o755);
    console.log(`[package] Copied executable: uxplay`);
    
    // Get and copy dynamic library dependencies
    console.log('\n[package] Copying dynamic libraries...');
    const deps = this.getDylibDependencies(exePath);
    let copiedLibs = 0;
    
    const libDir = path.join(this.packageDir, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    
    for (const dep of deps) {
      if (this.copyDylib(dep, libDir)) {
        copiedLibs++;
      }
    }
    
    console.log(`[package] Copied ${copiedLibs} libraries\n`);
    
    // Copy GStreamer plugins
    console.log('[package] Copying GStreamer plugins...');
    this.copyGstPlugins(this.packageDir);
    
    // Create zip archive
    console.log('\n[package] Creating zip archive...');
    if (fs.existsSync(this.outputZip)) {
      fs.unlinkSync(this.outputZip);
    }
    
    if (AdmZip) {
      const zip = new AdmZip();
      zip.addLocalFolder(this.packageDir, '');
      zip.writeZip(this.outputZip);
    } else {
      // Fallback: use zip command
      try {
        execSync(`cd "${this.packageDir}" && zip -r "${this.outputZip}" .`, {
          stdio: 'inherit',
        });
      } catch (error) {
        throw new Error(
          'Failed to create zip archive. Please install adm-zip:\n' +
          '  npm install --save-dev adm-zip\n' +
          'Or ensure zip command is available in PATH'
        );
      }
    }
    
    const zipSize = fs.statSync(this.outputZip).size;
    const zipSizeMB = (zipSize / (1024 * 1024)).toFixed(2);
    
    console.log(`[package] Created zip archive: ${this.outputZip}`);
    console.log(`[package] Archive size: ${zipSizeMB} MB`);
    
    console.log('\n==========================================');
    console.log('Packaging complete!');
    console.log('==========================================');
    console.log(`Output: ${this.outputZip}`);
    console.log('\nNext step: npm run upload:uxplay');
    
    return this.outputZip;
  }
}

// Main execution
if (require.main === module) {
  try {
    const packager = new UxPlayMacOSPackager();
    packager.package();
  } catch (error) {
    console.error('\nERROR:', error.message);
    process.exit(1);
  }
}

module.exports = UxPlayMacOSPackager;
