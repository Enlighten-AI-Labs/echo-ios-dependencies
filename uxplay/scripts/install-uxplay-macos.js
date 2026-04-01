#!/usr/bin/env node

/**
 * Install UxPlay on macOS via the installer
 */

const path = require('path');
const os = require('os');

// Mock Electron app module for testing outside Electron context
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(...args) {
  if (args[0] === 'electron') {
    return {
      app: {
        getPath: (name) => {
          if (name === 'appData') {
            return path.join(os.homedir(), 'Library', 'Application Support', 'echo-desktop');
          }
          return path.join(os.tmpdir(), 'echo-test');
        }
      }
    };
  }
  return originalRequire.apply(this, args);
};

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const UxPlayMacOSInstaller = require('../src/main/services/uxplayMacOSInstaller');

async function install() {
  console.log('==========================================');
  console.log('Installing UxPlay for macOS');
  console.log('==========================================\n');

  const installer = new UxPlayMacOSInstaller();

  installer.setProgressCallback((progress) => {
    process.stdout.write(`\rProgress: ${progress}%`);
  });

  installer.setStatusCallback((status) => {
    console.log(`\n${status}`);
  });

  try {
    await installer.install();
    console.log('\n✅ UxPlay installed successfully!');
    console.log('\nYou can now test the service with:');
    console.log('  node scripts/test-uxplay-service.js\n');
  } catch (error) {
    console.error(`\n❌ Installation failed: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

install();

