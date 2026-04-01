#!/usr/bin/env node

/**
 * Download UxPlay from GitHub and build for macOS
 * Packages the built binary for local bundling or release publishing
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const https = require('https');
const { createWriteStream } = require('fs');
const AdmZip = require('adm-zip');

class UxPlayMacOSBuilder {
  constructor() {
    this.rootDir = path.join(__dirname, '..');
    this.tempDir = path.join(this.rootDir, 'resources', 'temp', 'uxplay-build');
    this.buildDir = path.join(this.tempDir, 'UxPlay');
    this.sourceDir = path.join(this.buildDir, 'UxPlay');
    this.githubRepo = 'FDH2/UxPlay';
    this.githubApiUrl = `https://api.github.com/repos/${this.githubRepo}/releases/latest`;
    this.zipPath = path.join(this.tempDir, 'airplay-bridge.zip');
  }

  /**
   * Setup directories
   */
  setupDirectories() {
    if (fs.existsSync(this.tempDir)) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.tempDir, { recursive: true });
    console.log(`✓ Created temp directory: ${this.tempDir}`);
  }

  /**
   * Get latest release info from GitHub (use master branch for latest features)
   */
  async getLatestRelease() {
    // Use master branch to get latest features
    console.log(`\nUsing master branch for latest features...`);
    return Promise.resolve({
      tag_name: 'master',
      zipball_url: 'https://github.com/FDH2/UxPlay/archive/refs/heads/master.zip',
      published_at: new Date().toISOString(),
    });
  }

  /**
   * Download source code from GitHub
   */
  async downloadSource(release) {
    return new Promise((resolve, reject) => {
      // Use the source code archive (zipball)
      const sourceUrl = release.zipball_url;
      const zipPath = path.join(this.tempDir, 'source.zip');
      
      console.log(`\nDownloading source code from GitHub...`);
      console.log(`  URL: ${sourceUrl}`);
      
      const downloadWithRedirect = (url, maxRedirects = 5) => {
        if (maxRedirects <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        
        const file = createWriteStream(zipPath);
        
        https.get(url, {
          headers: {
            'User-Agent': 'Echo-Desktop-Builder'
          }
        }, (response) => {
          // Handle redirects
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            file.close();
            fs.unlink(zipPath, () => {});
            console.log(`  Following redirect to: ${response.headers.location}`);
            downloadWithRedirect(response.headers.location, maxRedirects - 1);
            return;
          }
          
          if (response.statusCode !== 200) {
            file.close();
            fs.unlink(zipPath, () => {});
            reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
            return;
          }

          const totalSize = parseInt(response.headers['content-length'], 10) || 0;
          let downloadedSize = 0;

          response.on('data', (chunk) => {
            downloadedSize += chunk.length;
            if (totalSize) {
              const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
              process.stdout.write(`\r  Progress: ${percent}% (${(downloadedSize / 1024 / 1024).toFixed(2)} MB)`);
            }
          });

          response.pipe(file);

          file.on('finish', () => {
            file.close();
            console.log('\n✓ Source code downloaded');
            resolve(zipPath);
          });

          file.on('error', (err) => {
            fs.unlink(zipPath, () => {});
            reject(err);
          });
        }).on('error', reject);
      };
      
      downloadWithRedirect(sourceUrl);
    });
  }

  /**
   * Extract source code
   */
  async extractSource(zipPath) {
    console.log(`\nExtracting source code...`);
    
    try {
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(this.tempDir, true);
      
      // Find the extracted directory (GitHub creates a directory with tag name or branch name)
      const entries = fs.readdirSync(this.tempDir);
      const extractedDir = entries.find(e => {
        const fullPath = path.join(this.tempDir, e);
        return fs.statSync(fullPath).isDirectory() && (e.startsWith('FDH2-UxPlay-') || e === 'UxPlay-master');
      });
      
      if (!extractedDir) {
        throw new Error('Could not find extracted source directory');
      }
      
      // Move contents to buildDir
      const extractedPath = path.join(this.tempDir, extractedDir);
      if (fs.existsSync(this.buildDir)) {
        fs.rmSync(this.buildDir, { recursive: true });
      }
      fs.renameSync(extractedPath, this.buildDir);
      
      console.log(`✓ Source code extracted to: ${this.buildDir}`);
      
      // Clean up source zip
      fs.unlinkSync(zipPath);
      
      return this.sourceDir;
    } catch (error) {
      throw new Error(`Failed to extract source: ${error.message}`);
    }
  }

  /**
   * Check for required build tools
   */
  checkBuildTools() {
    console.log(`\nChecking for build tools...`);
    
    const tools = {
      brew: ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'],
      cmake: ['/opt/homebrew/bin/cmake', '/usr/local/bin/cmake', '/usr/bin/cmake'],
      make: ['/usr/bin/make'],
      pkgConfig: ['/opt/homebrew/bin/pkg-config', '/usr/local/bin/pkg-config', '/usr/bin/pkg-config'],
    };
    
    const found = {};
    
    for (const [tool, paths] of Object.entries(tools)) {
      for (const toolPath of paths) {
        if (fs.existsSync(toolPath)) {
          found[tool] = toolPath;
          console.log(`  ✓ ${tool}: ${toolPath}`);
          break;
        }
      }
      if (!found[tool]) {
        const toolName = tool === 'pkgConfig' ? 'pkg-config' : tool;
        throw new Error(`${toolName} not found. Please install it first.`);
      }
    }
    
    return found;
  }

  /**
   * Install dependencies using Homebrew
   */
  async installDependencies(brewPath) {
    console.log(`\nInstalling dependencies with Homebrew...`);
    
    const deps = [
      'cmake',
      'pkg-config',
      'libplist',
      'openssl@3',
      'glib',
      'gstreamer',
    ];
    
    for (const dep of deps) {
      try {
        console.log(`  Checking ${dep}...`);
        execSync(`${brewPath} list ${dep} >/dev/null 2>&1`, { stdio: 'ignore' });
        console.log(`    ✓ ${dep} already installed`);
      } catch (error) {
        console.log(`    Installing ${dep}...`);
        execSync(`${brewPath} install ${dep}`, { stdio: 'inherit' });
        console.log(`    ✓ ${dep} installed`);
      }
    }
    
    console.log(`✓ All dependencies installed`);
  }

  /**
   * Build UxPlay
   */
  async buildUxPlay(tools) {
    console.log(`\nBuilding UxPlay...`);
    console.log(`  Source: ${this.buildDir}`);
    
    const buildDir = path.join(this.buildDir, 'build');
    
    // Clean previous build
    if (fs.existsSync(buildDir)) {
      fs.rmSync(buildDir, { recursive: true });
    }
    fs.mkdirSync(buildDir, { recursive: true });
    
    // Configure with CMake
    console.log(`  Running CMake...`);
    execSync(`${tools.cmake} ..`, {
      cwd: buildDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        PKG_CONFIG_PATH: [
          '/opt/homebrew/lib/pkgconfig',
          '/usr/local/lib/pkgconfig',
          process.env.PKG_CONFIG_PATH || '',
        ].filter(Boolean).join(':'),
      }
    });
    
    // Build
    console.log(`  Building...`);
    const cpuCount = os.cpus().length;
    execSync(`${tools.make} -j${cpuCount}`, {
      cwd: buildDir,
      stdio: 'inherit',
    });
    
    // Install to temp directory
    const installPrefix = path.join(this.tempDir, 'install');
    console.log(`  Installing to ${installPrefix}...`);
    execSync(`DESTDIR=${installPrefix} ${tools.make} install`, {
      cwd: buildDir,
      stdio: 'inherit',
    });
    
    // Find the built executable
    const possiblePaths = [
      path.join(installPrefix, 'usr', 'local', 'bin', 'uxplay'),
      path.join(installPrefix, 'opt', 'homebrew', 'bin', 'uxplay'),
      path.join(buildDir, 'uxplay'),
    ];
    
    let uxplayPath = null;
    for (const possiblePath of possiblePaths) {
      if (fs.existsSync(possiblePath)) {
        uxplayPath = possiblePath;
        break;
      }
    }
    
    if (!uxplayPath) {
      // Search recursively
      const findExecutable = (dir) => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name === 'uxplay') {
              return fullPath;
            } else if (entry.isDirectory()) {
              const found = findExecutable(fullPath);
              if (found) return found;
            }
          }
        } catch (error) {
          // Ignore errors
        }
        return null;
      };
      
      uxplayPath = findExecutable(installPrefix) || findExecutable(buildDir);
    }
    
    if (!uxplayPath) {
      throw new Error('Could not find built uxplay executable');
    }
    
    console.log(`✓ Build complete: ${uxplayPath}`);
    return uxplayPath;
  }

  /**
   * Package the built binary
   */
  async packageBinary(uxplayPath) {
    console.log(`\nPackaging binary...`);
    
    // Create package directory structure matching what setup-uxplay-binaries.js expects
    const packageDir = path.join(this.tempDir, 'package');
    if (fs.existsSync(packageDir)) {
      fs.rmSync(packageDir, { recursive: true });
    }
    fs.mkdirSync(packageDir, { recursive: true });
    
    // Copy executable (setup script expects it at root of zip)
    const targetPath = path.join(packageDir, 'uxplay');
    fs.copyFileSync(uxplayPath, targetPath);
    fs.chmodSync(targetPath, 0o755);
    console.log(`  ✓ Copied executable to package`);
    
    // Create zip (matching format expected by setup-uxplay-binaries.js)
    if (fs.existsSync(this.zipPath)) {
      fs.unlinkSync(this.zipPath);
    }
    
    const zip = new AdmZip();
    zip.addLocalFolder(packageDir);
    zip.writeZip(this.zipPath);
    
    const stats = fs.statSync(this.zipPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`✓ Package created: ${this.zipPath} (${sizeMB} MB)`);
    
    // Move to location expected by upload script
    const uploadZipPath = path.join(this.rootDir, 'resources', 'temp', 'airplay-bridge.zip');
    const uploadDir = path.dirname(uploadZipPath);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    if (fs.existsSync(uploadZipPath)) {
      fs.unlinkSync(uploadZipPath);
    }
    fs.copyFileSync(this.zipPath, uploadZipPath);
    console.log(`✓ Copied to upload location: ${uploadZipPath}`);
    
    return uploadZipPath;
  }

  /**
   * Main build process
   */
  async build() {
    try {
      console.log('==========================================');
      console.log('UxPlay macOS Builder');
      console.log('==========================================\n');
      
      this.setupDirectories();
      
      const release = await this.getLatestRelease();
      const sourceZip = await this.downloadSource(release);
      await this.extractSource(sourceZip);
      
      const tools = this.checkBuildTools();
      await this.installDependencies(tools.brew);
      
      const uxplayPath = await this.buildUxPlay(tools);
      const zipPath = await this.packageBinary(uxplayPath);
      
      console.log('\n==========================================');
      console.log('Build completed successfully!');
      console.log('==========================================');
      console.log(`\nPackage ready: ${zipPath}`);
      console.log('\nPublish this artifact through a standalone release process.');

      return zipPath;
    } catch (error) {
      console.error('\n❌ Build failed:', error.message);
      console.error(error.stack);
      process.exit(1);
    }
  }
}

// Run if executed directly
if (require.main === module) {
  const builder = new UxPlayMacOSBuilder();
  builder.build();
}

module.exports = UxPlayMacOSBuilder;
