#!/usr/bin/env node

/**
 * Test script for UxPlayService
 * Tests if the service can spawn UxPlay correctly on the current platform
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

// Set up paths for the service to find modules
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

// Import the service
const UxPlayService = require('../src/main/services/uxplayService');
const UxPlayInstaller = require('../src/main/services/uxplayInstaller');
const UxPlayMacOSInstaller = require('../src/main/services/uxplayMacOSInstaller');

async function testUxPlayService() {
  console.log('==========================================');
  console.log('Testing UxPlayService');
  console.log('==========================================');
  console.log(`Platform: ${os.platform()}`);
  console.log(`Architecture: ${os.arch()}`);
  console.log('');

  // Create service instance
  const service = new UxPlayService();

  // Set up installer based on platform
  const platform = os.platform();
  let installer;
  if (platform === 'darwin') {
    installer = new UxPlayMacOSInstaller();
    console.log('Using macOS installer');
  } else if (platform === 'win32') {
    installer = new UxPlayInstaller();
    console.log('Using Windows installer');
  } else {
    console.error(`❌ Platform ${platform} is not supported`);
    process.exit(1);
  }

  service.setInstaller(installer);

  // Check if UxPlay is installed
  console.log('\n1. Checking if UxPlay is installed...');
  try {
    const isInstalled = await service.isInstalled();
    if (!isInstalled) {
      console.error('❌ UxPlay is not installed');
      console.error('   Please install it first using the AirPlay installer in the app');
      // Give logger time to flush before exiting
      await new Promise(resolve => setTimeout(resolve, 100));
      process.exit(1);
    }
    console.log('✓ UxPlay is installed');
  } catch (error) {
    console.error(`❌ Error checking installation: ${error.message}`);
    await new Promise(resolve => setTimeout(resolve, 100));
    process.exit(1);
  }

  // Find executable
  console.log('\n2. Finding UxPlay executable...');
  const executablePath = await service.findUxPlayExecutable();
  if (!executablePath) {
    console.error('❌ Could not find UxPlay executable');
    process.exit(1);
  }
  console.log(`✓ Found executable: ${executablePath}`);

  // Set up event listeners
  console.log('\n3. Setting up event listeners...');
  service.on('status', (data) => {
    console.log(`   Status: ${data.status}${data.message ? ` - ${data.message}` : ''}`);
  });

  service.on('deviceConnected', (deviceInfo) => {
    console.log(`   ✓ Device connected: ${deviceInfo.name} (${deviceInfo.model})`);
  });

  service.on('streamingStarted', (data) => {
    console.log('   ✓ Streaming started');
  });

  service.on('error', (error) => {
    console.error(`   ❌ Error: ${error.error || error.message || error}`);
  });

  // Try to start the service
  console.log('\n4. Starting UxPlay service...');
  console.log('   (This will start UxPlay and listen for AirPlay connections)');
  console.log('   Press Ctrl+C to stop\n');

  try {
    const result = await service.start();
    if (result.success) {
      console.log('✓ UxPlay service started successfully!');
      console.log('   Waiting for AirPlay connection...');
      console.log('   (Connect from your iPhone/iPad to see device connection)');
    } else {
      console.error(`❌ Failed to start: ${result.error || 'Unknown error'}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`❌ Error starting service: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }

  // Handle cleanup on exit
  process.on('SIGINT', async () => {
    console.log('\n\nStopping UxPlay service...');
    try {
      await service.stop();
      console.log('✓ Service stopped');
      // Give logger time to flush before exiting
      await new Promise(resolve => setTimeout(resolve, 200));
      process.exit(0);
    } catch (error) {
      console.error(`❌ Error stopping service: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 200));
      process.exit(1);
    }
  });

  // Keep process alive
  process.stdin.resume();
}

// Run the test
testUxPlayService().catch(async (error) => {
  console.error('❌ Test failed:', error);
  // Give logger time to flush before exiting
  await new Promise(resolve => setTimeout(resolve, 200));
  process.exit(1);
});

