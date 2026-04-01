#!/usr/bin/env node

/**
 * Script to setup UxPlay binaries for bundling with Echo Desktop
 * This script downloads platform-specific UxPlay binaries from Supabase storage
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { createWriteStream } = require('fs');
const { getRemoteArtifactCandidates } = require('../src/main/services/airplayBridgePaths');

// Load environment variables from monorepo root
const { loadEnv } = require('../../../../scripts/load-env');
loadEnv();

class UxPlayInstaller {
  constructor() {
    this.rootDir = path.join(__dirname, '..');
    this.resourcesDir = path.join(this.rootDir, 'resources');
    this.targetDir = path.join(this.resourcesDir, 'temp', 'airplay-bridge');
    this.tempDir = path.join(this.resourcesDir, 'temp', 'airplay-download');
    this.bucketName = 'desktop-releases';
    this.platform = os.platform();
    this.arch = os.arch();
    this.supabase = null;
    this.remoteCandidates = getRemoteArtifactCandidates(this.platform);
    
    // Determine platform-specific paths
    this.setupPlatformPaths();
    
    // Try to initialize Supabase client
    this.initializeSupabase();
  }

  /**
   * Setup platform-specific file paths
   * Note: Files are downloaded with original names but renamed to generic names for distribution
   */
  setupPlatformPaths() {
    if (this.platform === 'win32') {
      this.sourceFileName = 'uxplay.exe'; // Name in the downloaded zip (legacy)
      this.altSourceFileName = 'echo-airplay.exe'; // Name if already renamed in zip
      this.targetFileName = 'echo-airplay.exe'; // Generic name for distribution
      this.zipFileName = 'airplay-bridge.zip';
    } else if (this.platform === 'darwin') {
      this.sourceFileName = 'uxplay';
      this.altSourceFileName = 'echo-airplay';
      this.targetFileName = 'echo-airplay';
      this.zipFileName = 'airplay-bridge.zip';
    } else {
      // Linux - not currently supported but structure ready
      this.sourceFileName = 'uxplay';
      this.altSourceFileName = 'echo-airplay';
      this.targetFileName = 'echo-airplay';
      this.zipFileName = 'airplay-bridge.zip';
    }
  }

  /**
   * Initialize Supabase client
   */
  initializeSupabase() {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    
    if (supabaseUrl && supabaseKey) {
      try {
        const { createClient } = require('@supabase/supabase-js');
        this.supabase = createClient(supabaseUrl, supabaseKey);
        console.log('[uxplay-installer] Supabase client initialized');
      } catch (error) {
        console.warn('[uxplay-installer] Failed to initialize Supabase:', error.message);
      }
    } else {
      console.warn('[uxplay-installer] Supabase credentials not found in environment');
    }
  }

  /**
   * Setup directories
   */
  setupDirectories() {
    const dirs = [this.resourcesDir, this.targetDir, this.tempDir];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Clean up temporary files
   */
  cleanup() {
    try {
      if (fs.existsSync(this.tempDir)) {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      }
    } catch (error) {
      console.warn('[uxplay-installer] Failed to cleanup temp directory:', error.message);
    }
  }

  /**
   * Download file from Supabase storage
   */
  async downloadFromSupabase(filePath, destination) {
    if (!this.supabase) {
      throw new Error('Supabase client not available');
    }

    try {
      console.log(`[uxplay-installer] Downloading from Supabase: ${filePath}`);
      
      const { data, error } = await this.supabase.storage
        .from(this.bucketName)
        .download(filePath);

      if (error) {
        throw new Error(`Supabase download error: ${error.message}`);
      }

      if (!data) {
        throw new Error('No data received from Supabase');
      }

      // Convert blob to buffer and write to file
      const arrayBuffer = await data.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      fs.writeFileSync(destination, buffer);
      
      console.log(`[uxplay-installer] Downloaded successfully to: ${destination}`);
      return destination;
    } catch (error) {
      throw new Error(`Failed to download from Supabase: ${error.message}`);
    }
  }

  /**
   * Download file from fallback URL (if provided)
   */
  async downloadFromUrl(url, destination) {
    console.log(`[uxplay-installer] Downloading from URL: ${url}`);
    
    return new Promise((resolve, reject) => {
      const file = createWriteStream(destination);
      
      https.get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          return this.downloadFromUrl(response.headers.location, destination)
            .then(resolve)
            .catch(reject);
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'], 10) || 0;
        let downloadedSize = 0;

        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          if (totalSize) {
            const percent = ((downloadedSize / totalSize) * 100).toFixed(2);
            process.stdout.write(`\rProgress: ${percent}% (${downloadedSize}/${totalSize} bytes)`);
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          console.log('\n[uxplay-installer] Download completed');
          resolve();
        });

        file.on('error', (err) => {
          fs.unlink(destination, () => {});
          reject(err);
        });
      }).on('error', reject);
    });
  }

  /**
   * Extract zip file (for macOS/Linux bundles)
   */
  async extractZip(zipPath, extractDir) {
    return new Promise((resolve, reject) => {
      try {
        // Try using native unzip command first (available on macOS/Linux)
        const { execSync } = require('child_process');
        console.log(`[uxplay-installer] Extracting zip using unzip command: ${zipPath}`);
        execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'inherit' });
        console.log(`[uxplay-installer] Extraction completed`);
        resolve();
      } catch (error) {
        // Fallback to adm-zip if available
        try {
          const AdmZip = require('adm-zip');
          console.log(`[uxplay-installer] Falling back to adm-zip for extraction`);
          const zip = new AdmZip(zipPath);
          zip.extractAllTo(extractDir, true);
          console.log(`[uxplay-installer] Extraction completed`);
          resolve();
        } catch (zipError) {
          reject(new Error(`Failed to extract zip: ${error.message}. Also tried adm-zip: ${zipError.message}`));
        }
      }
    });
  }

  /**
   * Check if AirPlay bridge is already installed
   */
  isInstalled() {
    const targetPath = path.join(this.targetDir, this.targetFileName);
    return fs.existsSync(targetPath);
  }

  /**
   * Create the batch wrapper script for Windows
   */
  createBatchWrapper() {
    if (this.platform !== 'win32') return;

    const batchContent = `@echo off
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
"%SCRIPT_DIR%echo-airplay.exe" %*
`;

    const batchPath = path.join(this.targetDir, 'echo-airplay.bat');
    fs.writeFileSync(batchPath, batchContent);
    console.log(`[airplay-bridge] ✅ Created batch wrapper: ${batchPath}`);
  }

  /**
   * Try to download from Supabase, with fallback to legacy path
   */
  async downloadWithFallback(zipTempPath) {
    const failures = [];

    for (const candidate of this.remoteCandidates) {
      if (!candidate.endsWith('.zip')) {
        continue;
      }

      try {
        console.log(`[airplay-bridge] Trying Supabase path: ${candidate}`);
        await this.downloadFromSupabase(candidate, zipTempPath);
        return true;
      } catch (error) {
        failures.push(`${candidate}: ${error.message}`);
        console.log(`[airplay-bridge] Candidate failed: ${error.message}`);
      }
    }

    throw new Error(`Failed to download from all Supabase paths: ${failures.join(' | ')}`);
  }

  /**
   * Check if a path is a file (not a directory)
   */
  isFile(filePath) {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Find the executable in the extracted directory
   */
  findExtractedExecutable() {
    // Check for target name first (already renamed in newer packages)
    // IMPORTANT: Must verify it's a FILE, not a directory
    const targetPath = path.join(this.targetDir, this.targetFileName);
    if (this.isFile(targetPath)) {
      return { path: targetPath, needsRename: false };
    }
    
    // Check for alternate source name
    if (this.altSourceFileName) {
      const altPath = path.join(this.targetDir, this.altSourceFileName);
      if (this.isFile(altPath)) {
        return { path: altPath, needsRename: this.altSourceFileName !== this.targetFileName };
      }
    }
    
    // Check for original source name (legacy packages)
    const sourcePath = path.join(this.targetDir, this.sourceFileName);
    if (this.isFile(sourcePath)) {
      return { path: sourcePath, needsRename: true };
    }
    
    // Search recursively for Mach-O executables or known filenames
    const findExecutable = (dir, depth = 0) => {
      if (depth > 5) return null; // Limit depth to avoid infinite recursion
      
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        // First pass: look for exact filename matches that are FILES
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          
          const fullPath = path.join(dir, entry.name);
          const lowerName = entry.name.toLowerCase();
          
          if (lowerName === this.sourceFileName.toLowerCase() || 
              lowerName === this.targetFileName.toLowerCase() ||
              (this.altSourceFileName && lowerName === this.altSourceFileName.toLowerCase())) {
            // Verify it's actually an executable (Mach-O on macOS, .exe on Windows)
            if (this.platform === 'win32') {
              if (lowerName.endsWith('.exe')) {
                return fullPath;
              }
            } else {
              // On Unix, check if it's a Mach-O binary
              try {
                const { execSync } = require('child_process');
                const fileType = execSync(`file "${fullPath}"`, { encoding: 'utf8' });
                if (fileType.includes('Mach-O') || fileType.includes('executable')) {
                  return fullPath;
                }
              } catch {
                // If file command fails, still return if it has execute permission
                const stats = fs.statSync(fullPath);
                if (stats.mode & 0o111) {
                  return fullPath;
                }
              }
            }
          }
        }
        
        // Second pass: recurse into directories (prioritize 'build' directories)
        const directories = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX');
        // Sort to check 'build' directories first
        directories.sort((a, b) => {
          if (a.name === 'build') return -1;
          if (b.name === 'build') return 1;
          return 0;
        });
        
        for (const entry of directories) {
          const found = findExecutable(path.join(dir, entry.name), depth + 1);
          if (found) return found;
        }
      } catch (err) {
        console.warn(`[uxplay-installer] Error searching ${dir}: ${err.message}`);
      }
      
      return null;
    };
    
    const foundPath = findExecutable(this.targetDir);
    if (foundPath) {
      const needsRename = path.basename(foundPath).toLowerCase() !== this.targetFileName.toLowerCase();
      return { path: foundPath, needsRename };
    }
    
    return null;
  }

  /**
   * Install AirPlay bridge binary
   */
  async install() {
    try {
      console.log(`[airplay-bridge] Setting up AirPlay bridge for ${this.platform}...`);
      
      this.setupDirectories();
      
      const targetPath = path.join(this.targetDir, this.targetFileName);
      
      // Try to download from Supabase
      if (this.supabase) {
        try {
          // Download zip (with fallback to legacy path)
          const zipTempPath = path.join(this.tempDir, this.zipFileName);
          await this.downloadWithFallback(zipTempPath);
          
          // Extract zip to target directory (includes DLLs and lib folder)
          await this.extractZip(zipTempPath, this.targetDir);
          
          // Find the executable (handles both new and legacy package formats)
          const found = this.findExtractedExecutable();
          
          if (!found) {
            throw new Error(`Executable not found in extracted zip. Looked for: ${this.sourceFileName}, ${this.targetFileName}, ${this.altSourceFileName || 'N/A'}`);
          }
          
          if (found.needsRename) {
            fs.renameSync(found.path, targetPath);
            console.log(`[airplay-bridge] ✅ Renamed ${path.basename(found.path)} to ${this.targetFileName}`);
          } else {
            console.log(`[airplay-bridge] ✅ Found ${this.targetFileName} (already correctly named)`);
          }
          
          // Clean up old batch wrapper if it exists
          const oldBatPath = path.join(this.targetDir, 'uxplay.bat');
          if (fs.existsSync(oldBatPath)) {
            fs.unlinkSync(oldBatPath);
            console.log(`[airplay-bridge] Removed legacy uxplay.bat`);
          }
          
          // Create new batch wrapper with correct binary name
          this.createBatchWrapper();
          
          // Make executable on Unix systems
          if (this.platform !== 'win32') {
            fs.chmodSync(targetPath, 0o755);
          }
          
          console.log(`[airplay-bridge] ✅ Installed to: ${targetPath}`);
          
          this.cleanup();
          console.log('[airplay-bridge] ✅ AirPlay bridge setup completed successfully!');
          return true;
        } catch (error) {
          console.error(`[airplay-bridge] Supabase download failed: ${error.message}`);
          this.cleanup();
          return false;
        }
      } else {
        console.warn('[airplay-bridge] ⚠️  Supabase client not available');
        console.warn('[airplay-bridge] Cannot download AirPlay bridge');
        console.warn('[airplay-bridge] Please ensure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are set in .env.local');
        return false;
      }
    } catch (error) {
      console.error('[airplay-bridge] ❌ AirPlay bridge setup failed:', error.message);
      this.cleanup();
      throw error;
    }
  }
}

// Main execution
async function main() {
  const installer = new UxPlayInstaller();

  if (installer.isInstalled()) {
    console.log(`[airplay-bridge] ✅ AirPlay bridge is already installed at ${installer.targetDir}`);
    console.log('[airplay-bridge] Use --force to reinstall');

    if (!process.argv.includes('--force')) {
      return;
    }
    
    console.log('[airplay-bridge] Forcing reinstall...');
  }

  try {
    const result = await installer.install();
    if (!result) {
      console.error('[airplay-bridge] Installation did not complete successfully');
      process.exit(1);
    }
  } catch (error) {
    console.error('[airplay-bridge] Installation failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = UxPlayInstaller;
