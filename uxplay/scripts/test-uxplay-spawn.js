#!/usr/bin/env node

/**
 * Quick test to verify UxPlay spawns correctly
 * This will start the service and let it run - press Ctrl+C to stop
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
const UxPlayService = require('../src/main/services/uxplayService');

async function testSpawn() {
  console.log('==========================================');
  console.log('Testing UxPlay Service Spawn');
  console.log('==========================================\n');

  const installer = new UxPlayMacOSInstaller();
  const service = new UxPlayService();
  service.setInstaller(installer);

  // Check if UxPlay is installed
  console.log('1. Checking if UxPlay is installed...');
  const isInstalled = await installer.isUxPlayInstalled();
  if (!isInstalled) {
    console.error('❌ UxPlay is not installed');
    console.error('   Please install it first using: node scripts/install-uxplay-macos.js');
    process.exit(1);
  }
  console.log('✓ UxPlay is installed\n');

  // Find executable
  console.log('2. Finding UxPlay executable...');
  const executable = await installer.findUxPlayExecutable();
  if (!executable) {
    console.error('❌ UxPlay executable not found');
    process.exit(1);
  }
  console.log(`✓ Found: ${executable}\n`);

  // Test UxPlay option recognition
  console.log('3. Testing UxPlay options recognition...');
  const { spawn } = require('child_process');
  const testProcess = spawn(executable, ['-h'], { stdio: 'pipe' });
  let helpOutput = '';
  testProcess.stdout.on('data', (data) => {
    helpOutput += data.toString();
  });
  testProcess.stderr.on('data', (data) => {
    helpOutput += data.toString();
  });
  
  await new Promise((resolve) => {
    testProcess.on('close', resolve);
  });

  if (helpOutput.includes('-vs') && helpOutput.includes('-as')) {
    console.log('✓ Required options (-vs, -as) are recognized\n');
  } else {
    console.error('❌ Required options not found in help output');
    console.error('   UxPlay may not be installed correctly');
    process.exit(1);
  }

  // Set up event listeners
  console.log('4. Setting up service event listeners...');
  service.on('status', (data) => {
    console.log(`   Status: ${data.status}${data.message ? ` - ${data.message}` : ''}`);
  });

  service.on('error', (data) => {
    console.error(`   ❌ Error: ${data.error}`);
  });

  service.on('device-connected', (data) => {
    console.log(`   ✓ Device connected: ${data.deviceName || data.deviceId}`);
  });

  // Start the service
  console.log('\n5. Starting UxPlay service...');
  console.log('   (This will start UxPlay and listen for AirPlay connections)');
  console.log('   Press Ctrl+C to stop\n');

  try {
    const result = await service.start();
    console.log(`\n✓ Service started successfully!`);
    console.log(`   Result: ${JSON.stringify(result)}\n`);
    console.log('UxPlay is now running and waiting for AirPlay connections.');
    console.log('You can connect from an iOS device using Screen Mirroring.');
    console.log('\nPress Ctrl+C to stop the service...\n');

    // Keep process alive
    process.on('SIGINT', async () => {
      console.log('\n\nStopping UxPlay service...');
      try {
        await service.stop();
        console.log('✓ Service stopped');
        process.exit(0);
      } catch (error) {
        console.error(`❌ Error stopping service: ${error.message}`);
        process.exit(1);
      }
    });

    // Keep alive
    await new Promise(() => {});
  } catch (error) {
    console.error(`\n❌ Failed to start service: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

testSpawn();

