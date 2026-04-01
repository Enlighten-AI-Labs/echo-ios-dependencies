#!/usr/bin/env node

/**
 * Minimize UxPlay package by removing unused DLLs and plugins
 * This script helps identify what's actually needed by testing removals
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const scriptDir = __dirname;
const projectRoot = path.join(scriptDir, '..');
const packageDir = path.join(projectRoot, 'resources', 'temp', 'uxplay-package');
const backupDir = path.join(projectRoot, 'resources', 'temp', 'uxplay-package-backup');

// Essential DLLs that should never be removed
const ESSENTIAL_DLLS = [
  'uxplay.exe',
  'libgstreamer-1.0-0.dll',
  'libgstbase-1.0-0.dll',
  'libgstvideo-1.0-0.dll',
  'libgstaudio-1.0-0.dll',
  'libgstapp-1.0-0.dll',
  'libgstpbutils-1.0-0.dll',
  'libgstrtp-1.0-0.dll',
  'libgstsdp-1.0-0.dll',
  'libglib-2.0-0.dll',
  'libgobject-2.0-0.dll',
  'libgio-2.0-0.dll',
  'libgmodule-2.0-0.dll',
  'libgthread-2.0-0.dll',
  'libffi-8.dll',
  'libintl-8.dll',
  'libpcre2-8-0.dll',
  'libstdc++-6.dll',
  'libgcc_s_seh-1.dll',
  'libwinpthread-1.dll',
  'zlib1.dll',
  'libxml2-2.dll',
  'libiconv-2.dll',
  'libssl-3-x64.dll',
  'libcrypto-3-x64.dll',
  'libplist-2.0.dll',
  'dnssd.dll',
  // FFmpeg DLLs (required by libgstlibav.dll)
  'avcodec-61.dll',
  'avformat-61.dll',
  'avutil-59.dll',
  'swscale-8.dll',
  'swresample-5.dll',
];

// Essential plugins
const ESSENTIAL_PLUGINS = [
  'libgstcoreelements.dll',
  'libgsttypefindfunctions.dll',
  'libgstplayback.dll',
  'libgstrawparse.dll',
  'libgstvideorate.dll',
  'libgstaudioconvert.dll',
  'libgstaudioresample.dll',
  'libgstapp.dll',
  'libgsttcp.dll',
  'libgstudp.dll',
  'libgstrtp.dll',
  'libgstrtsp.dll',
  'libgstlibav.dll',
  'libgstvideoparsersbad.dll',
];

function createBackup() {
  console.log('Creating backup...');
  if (fs.existsSync(backupDir)) {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
  fs.cpSync(packageDir, backupDir, { recursive: true });
  console.log('✓ Backup created\n');
}

function restoreBackup() {
  console.log('Restoring from backup...');
  if (fs.existsSync(backupDir)) {
    if (fs.existsSync(packageDir)) {
      fs.rmSync(packageDir, { recursive: true, force: true });
    }
    fs.cpSync(backupDir, packageDir, { recursive: true });
    console.log('✓ Backup restored\n');
  } else {
    console.log('✗ No backup found\n');
  }
}

function testUxPlay() {
  console.log('Testing UxPlay startup...');
  try {
    const env = {
      ...process.env,
      PATH: `${packageDir};${process.env.PATH}`,
      GST_PLUGIN_PATH: path.join(packageDir, 'lib', 'gstreamer-1.0'),
    };

    // Try to start UxPlay and see if it loads plugins successfully
    const output = execSync(
      `"${path.join(packageDir, 'uxplay.exe')}" --help`,
      { env, encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
    );
    
    // Check for critical errors
    if (output.includes('Required gstreamer plugin') || 
        output.includes('ERROR: stopping')) {
      return false;
    }
    
    return true;
  } catch (error) {
    // If exit code is 0, it's probably OK (help command exits)
    return error.status === 0 || error.status === null;
  }
}

function analyzeAndRemove() {
  console.log('==========================================');
  console.log('UxPlay Package Minimizer');
  console.log('==========================================\n');

  if (!fs.existsSync(packageDir)) {
    console.error('❌ Package directory not found!');
    console.error(`   Expected at: ${packageDir}`);
    console.error('\n   Please run: npm run package:uxplay:windows');
    process.exit(1);
  }

  createBackup();

  // Get all DLLs
  const allDlls = fs.readdirSync(packageDir)
    .filter(file => file.endsWith('.dll'))
    .filter(dll => !ESSENTIAL_DLLS.includes(dll));

  console.log(`Found ${allDlls.length} non-essential DLLs to test\n`);

  // Get all plugins
  const pluginsDir = path.join(packageDir, 'lib', 'gstreamer-1.0');
  const allPlugins = fs.existsSync(pluginsDir)
    ? fs.readdirSync(pluginsDir)
        .filter(file => file.endsWith('.dll'))
        .filter(plugin => !ESSENTIAL_PLUGINS.includes(plugin))
    : [];

  console.log(`Found ${allPlugins.length} non-essential plugins to test\n`);

  console.log('==========================================');
  console.log('Minimization Strategy');
  console.log('==========================================\n');
  console.log('This script helps identify what can be removed.');
  console.log('Manual process:');
  console.log('1. Remove DLLs/plugins in batches');
  console.log('2. Test with: npm run start:uxplay');
  console.log('3. If it works, keep removed items');
  console.log('4. If it fails, restore and try smaller batches\n');

  console.log('Current package size:');
  const currentSize = getDirectorySize(packageDir);
  console.log(`  ${(currentSize / (1024 * 1024)).toFixed(2)} MB\n`);

  console.log('Essential DLLs:', ESSENTIAL_DLLS.length);
  console.log('Essential plugins:', ESSENTIAL_PLUGINS.length);
  console.log('Non-essential DLLs:', allDlls.length);
  console.log('Non-essential plugins:', allPlugins.length);
}

function getDirectorySize(dirPath) {
  let totalSize = 0;
  const files = fs.readdirSync(dirPath);

  files.forEach(file => {
    const filePath = path.join(dirPath, file);
    const stats = fs.statSync(filePath);

    if (stats.isDirectory()) {
      totalSize += getDirectorySize(filePath);
    } else {
      totalSize += stats.size;
    }
  });

  return totalSize;
}

// Command line interface
const command = process.argv[2];

if (command === 'restore') {
  restoreBackup();
} else if (command === 'test') {
  const result = testUxPlay();
  console.log(result ? '✓ UxPlay test passed' : '✗ UxPlay test failed');
  process.exit(result ? 0 : 1);
} else {
  analyzeAndRemove();
}

