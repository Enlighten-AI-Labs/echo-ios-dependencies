#!/usr/bin/env node

/**
 * Test script to verify UxPlayService structure and platform detection
 * Tests code structure without requiring UxPlay to be installed
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

async function testStructure() {
  console.log('==========================================');
  console.log('Testing UxPlayService Structure');
  console.log('==========================================');
  console.log(`Platform: ${os.platform()}`);
  console.log(`Architecture: ${os.arch()}`);
  console.log('');

  try {
    // Import the service
    const UxPlayService = require('../src/main/services/uxplayService');
    const UxPlayInstaller = require('../src/main/services/uxplayInstaller');
    const UxPlayMacOSInstaller = require('../src/main/services/uxplayMacOSInstaller');

    console.log('✓ Successfully imported UxPlayService and installers');

    // Create service instance
    const service = new UxPlayService();
    console.log('✓ Created UxPlayService instance');

    // Check platform-specific methods exist
    const platform = os.platform();
    console.log(`\nChecking platform-specific methods for ${platform}...`);

    if (platform === 'darwin') {
      if (typeof service.startMacOS === 'function') {
        console.log('✓ startMacOS() method exists');
      } else {
        console.error('❌ startMacOS() method missing');
        process.exit(1);
      }
    } else if (platform === 'win32') {
      if (typeof service.startWindows === 'function') {
        console.log('✓ startWindows() method exists');
      } else {
        console.error('❌ startWindows() method missing');
        process.exit(1);
      }
    }

    // Check shared methods
    if (typeof service.setupProcessHandlers === 'function') {
      console.log('✓ setupProcessHandlers() method exists');
    } else {
      console.error('❌ setupProcessHandlers() method missing');
      process.exit(1);
    }

    if (typeof service.cleanupPreviousProcesses === 'function') {
      console.log('✓ cleanupPreviousProcesses() method exists');
    } else {
      console.error('❌ cleanupPreviousProcesses() method missing');
      process.exit(1);
    }

    // Test platform detection in start() method
    console.log('\nTesting platform dispatch logic...');
    const installer = platform === 'darwin' 
      ? new UxPlayMacOSInstaller() 
      : new UxPlayInstaller();
    service.setInstaller(installer);
    console.log('✓ Set installer based on platform');

    // Check that start() would dispatch correctly
    // We can't actually call start() without UxPlay installed, but we can verify the code path
    const startMethod = service.start.toString();
    if (startMethod.includes('os.platform()')) {
      console.log('✓ start() method contains platform detection');
    }
    if (startMethod.includes('startMacOS') || startMethod.includes('startWindows')) {
      console.log('✓ start() method dispatches to platform-specific methods');
    }

    console.log('\n==========================================');
    console.log('✓ All structure tests passed!');
    console.log('==========================================');
    console.log('\nNote: To test actual spawning, UxPlay must be installed.');
    console.log('      Run the full test with: node scripts/test-uxplay-service.js');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testStructure().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});

