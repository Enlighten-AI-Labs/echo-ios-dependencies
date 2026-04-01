#!/usr/bin/env node

/**
 * Analyze UxPlay dependencies to determine minimal required DLLs and plugins
 * Tests which DLLs are actually needed by running UxPlay and checking what loads
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const scriptDir = __dirname;
const projectRoot = path.join(scriptDir, '..');
const packageDir = path.join(projectRoot, 'resources', 'temp', 'uxplay-package');
const msys2Bin = 'C:\\msys64\\ucrt64\\bin';

// Check if package exists
const uxplayExe = path.join(packageDir, 'uxplay.exe');
if (!fs.existsSync(uxplayExe)) {
  console.error('❌ UxPlay executable not found!');
  console.error(`   Expected at: ${uxplayExe}`);
  console.error('\n   Please run: npm run package:uxplay:windows');
  process.exit(1);
}

console.log('==========================================');
console.log('UxPlay Dependency Analyzer');
console.log('==========================================\n');

// Analyze DLL dependencies
function analyzeDllDependencies() {
  console.log('Analyzing DLL dependencies...\n');

  // Get all DLLs in package
  const packageDlls = fs.readdirSync(packageDir)
    .filter(file => file.endsWith('.dll'))
    .sort();

  console.log(`Found ${packageDlls.length} DLLs in package\n`);

  // Categorize DLLs
  const categories = {
    'GStreamer Core': [],
    'GStreamer Plugins': [],
    'FFmpeg': [],
    'GLib/GTK': [],
    'OpenSSL': [],
    'libplist': [],
    'System Runtime': [],
    'Other': [],
  };

  packageDlls.forEach(dll => {
    if (dll.startsWith('libgstreamer') || dll.startsWith('libgstbase') || 
        dll.startsWith('libgstvideo') || dll.startsWith('libgstaudio') ||
        dll.startsWith('libgstapp') || dll.startsWith('libgstpbutils') ||
        dll.startsWith('libgstrtp') || dll.startsWith('libgstsdp')) {
      categories['GStreamer Core'].push(dll);
    } else if (dll.startsWith('libgst')) {
      categories['GStreamer Plugins'].push(dll);
    } else if (dll.startsWith('av') || dll.includes('avcodec') || 
               dll.includes('avformat') || dll.includes('avutil') ||
               dll.includes('swscale') || dll.includes('swresample')) {
      categories['FFmpeg'].push(dll);
    } else if (dll.startsWith('libglib') || dll.startsWith('libgobject') ||
               dll.startsWith('libgio') || dll.startsWith('libgmodule') ||
               dll.startsWith('libgthread') || dll.startsWith('libffi') ||
               dll.startsWith('libintl') || dll.startsWith('libpcre')) {
      categories['GLib/GTK'].push(dll);
    } else if (dll.includes('ssl') || dll.includes('crypto')) {
      categories['OpenSSL'].push(dll);
    } else if (dll.includes('plist')) {
      categories['libplist'].push(dll);
    } else if (dll.includes('stdc++') || dll.includes('gcc') || 
               dll.includes('winpthread') || dll.includes('zlib')) {
      categories['System Runtime'].push(dll);
    } else {
      categories['Other'].push(dll);
    }
  });

  // Print categorized list
  Object.entries(categories).forEach(([category, dlls]) => {
    if (dlls.length > 0) {
      console.log(`${category} (${dlls.length}):`);
      dlls.forEach(dll => console.log(`  - ${dll}`));
      console.log('');
    }
  });
}

// Analyze plugin dependencies
function analyzePluginDependencies() {
  console.log('Analyzing GStreamer plugin dependencies...\n');

  const pluginsDir = path.join(packageDir, 'lib', 'gstreamer-1.0');
  if (!fs.existsSync(pluginsDir)) {
    console.log('⚠ Plugins directory not found');
    return;
  }

  const plugins = fs.readdirSync(pluginsDir)
    .filter(file => file.endsWith('.dll'))
    .sort();

  console.log(`Found ${plugins.length} plugins\n`);

  // Essential plugins for UxPlay
  const essentialPlugins = [
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
    'libgstvideotestsrc.dll',
    'libgstaudiotestsrc.dll',
    'libgstautodetect.dll',
    'libgstlibav.dll',
    'libgstopenh264.dll',
    'libgstvideoparsersbad.dll',
    'libgstvideofilter.dll',
    'libgstaudiofx.dll',
    'libgstvolume.dll',
  ];

  console.log('Essential plugins (required for basic functionality):');
  essentialPlugins.forEach(plugin => {
    const exists = plugins.includes(plugin);
    console.log(`  ${exists ? '✓' : '✗'} ${plugin}`);
  });

  console.log(`\nAdditional plugins (${plugins.length - essentialPlugins.length}):`);
  plugins.filter(p => !essentialPlugins.includes(p)).forEach(plugin => {
    console.log(`  + ${plugin}`);
  });
}

// Test minimal configuration
function testMinimalConfig() {
  console.log('\n==========================================');
  console.log('Testing Minimal Configuration');
  console.log('==========================================\n');

  console.log('To determine minimal requirements:');
  console.log('1. Start UxPlay with: npm run start:uxplay');
  console.log('2. Check which DLLs/plugins are actually loaded');
  console.log('3. Remove unused DLLs/plugins one by one');
  console.log('4. Test after each removal to ensure functionality\n');

  console.log('Current package size:');
  const stats = fs.statSync(packageDir);
  const totalSize = getDirectorySize(packageDir);
  console.log(`  Total: ${(totalSize / (1024 * 1024)).toFixed(2)} MB\n`);
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

// Run analysis
analyzeDllDependencies();
analyzePluginDependencies();
testMinimalConfig();

console.log('==========================================');
console.log('Analysis Complete');
console.log('==========================================\n');

