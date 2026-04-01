#!/usr/bin/env node

/**
 * Node.js wrapper for building UxPlay on Windows
 * This script checks for MSYS2 and runs the bash build script
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const MSYS2_BASE = process.env.MSYS2_BASE || 'C:\\msys64';
const MSYS2_BASH = path.join(MSYS2_BASE, 'usr', 'bin', 'bash.exe');

function checkMsys2() {
  if (!fs.existsSync(MSYS2_BASH)) {
    throw new Error(
      `MSYS2 not found at ${MSYS2_BASE}\n` +
      'Please install MSYS2 from https://www.msys2.org/\n' +
      'Or set MSYS2_BASE environment variable to your MSYS2 installation path'
    );
  }
  console.log(`✓ MSYS2 found at: ${MSYS2_BASE}`);
}

function checkBonjourSdk() {
  const bonjourSdk = process.env.BONJOUR_SDK_HOME || 'C:\\Program Files\\Bonjour SDK';
  if (!fs.existsSync(bonjourSdk)) {
    console.warn(`⚠ Warning: Bonjour SDK not found at ${bonjourSdk}`);
    console.warn('Build may fail. Install Bonjour SDK for Windows v3.0');
    console.warn('Download from: https://developer.apple.com/download/all/?q=Bonjour%20SDK%20for%20Windows');
  } else {
    console.log(`✓ Bonjour SDK found at: ${bonjourSdk}`);
  }
}

function checkUxPlaySource() {
  const scriptDir = __dirname;
  const projectRoot = path.join(scriptDir, '..');
  const uxplaySource = path.join(projectRoot, 'resources', 'UxPlay-master');
  
  if (!fs.existsSync(uxplaySource)) {
    throw new Error(
      `UxPlay source not found at ${uxplaySource}\n` +
      'Please ensure resources/UxPlay-master directory exists'
    );
  }
  console.log(`✓ UxPlay source found: ${uxplaySource}`);
  return uxplaySource;
}

function runBuild() {
  const scriptDir = __dirname;
  const buildScript = path.join(scriptDir, 'build-uxplay-windows.sh');
  
  // Convert Windows path to MSYS2 path format
  const msysPath = scriptDir.replace(/\\/g, '/').replace(/^([A-Z]):/, '/$1').toLowerCase();
  
  console.log('\n==========================================');
  console.log('Starting UxPlay build in MSYS2...');
  console.log('==========================================\n');
  
  // Run bash script in MSYS2 environment
  const args = [
    '-lc',
    `cd "${msysPath.replace(/^\/c/, '/c')}" && bash build-uxplay-windows.sh`
  ];
  
  console.log(`Executing: ${MSYS2_BASH} ${args.join(' ')}\n`);
  
  const process = spawn(MSYS2_BASH, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      MSYSTEM: 'UCRT64',
      CHERE_INVOKING: '1',
    },
  });
  
  process.on('close', (code) => {
    if (code === 0) {
      console.log('\n==========================================');
      console.log('Build completed successfully!');
      console.log('==========================================');
    } else {
      console.error(`\nBuild failed with exit code: ${code}`);
      process.exit(code);
    }
  });
  
  process.on('error', (error) => {
    console.error('Failed to start build process:', error.message);
    process.exit(1);
  });
}

// Main execution
try {
  console.log('==========================================');
  console.log('UxPlay Windows Build (Node.js Wrapper)');
  console.log('==========================================\n');
  
  checkMsys2();
  checkBonjourSdk();
  checkUxPlaySource();
  
  runBuild();
} catch (error) {
  console.error('\n❌ Pre-flight check failed:', error.message);
  process.exit(1);
}



