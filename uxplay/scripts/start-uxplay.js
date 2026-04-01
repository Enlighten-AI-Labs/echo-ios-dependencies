#!/usr/bin/env node

/**
 * Start UxPlay server script (Cross-platform)
 * Sets up environment and starts UxPlay with proper configuration
 * Outputs all console logs for device detection debugging
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scriptDir = __dirname;
const projectRoot = path.join(scriptDir, '..');
const platform = os.platform();

// Get command line arguments
const args = process.argv.slice(2);

// Default arguments for UXPlay
// -n sets the AirPlay server name that appears on iOS devices
// -vrtp redirects the video stream to Echo Desktop via RTP
// NOTE: This requires the custom Echo-compiled UxPlay from Supabase
// -vrtp expects a full GStreamer pipeline string, not just host:port
const defaultArgs = [
  '-n', 'Echo',                 // Server name visible on iOS devices
  '-vrtp', 'config-interval=1 ! udpsink host=127.0.0.1 port=5000',  // Stream video via RTP to Echo Desktop
];

// If custom arguments are provided, use them; otherwise use defaults
const finalArgs = args.length > 0 ? args : defaultArgs;

/**
 * Find UxPlay executable based on platform
 */
async function findUxPlayExecutable() {
  if (platform === 'win32') {
    // Windows: Look for echo-airplay.exe in airplay-bridge directory
    const packageDir = path.join(projectRoot, 'resources', 'temp', 'airplay-bridge');
    const uxplayExe = path.join(packageDir, 'echo-airplay.exe');
    const uxplayBat = path.join(packageDir, 'echo-airplay.bat');
    
    if (!fs.existsSync(uxplayExe)) {
      throw new Error(`UxPlay executable not found at: ${uxplayExe}\nPlease run: npm run package:uxplay:windows`);
    }
    
    // Prefer wrapper script if available (better PATH handling)
    if (fs.existsSync(uxplayBat)) {
      return { executable: uxplayBat, isWrapper: true, cwd: packageDir };
    }
    
    return { executable: uxplayExe, isWrapper: false, cwd: packageDir };
  } else if (platform === 'darwin') {
    // macOS: ONLY look for Echo's custom UxPlay (NOT Homebrew)
    // Standard Homebrew UxPlay does NOT support -vrtp option required for Echo streaming
    const userBinDir = path.join(os.homedir(), '.local', 'bin');
    const appDataDir = path.join(os.homedir(), 'Library', 'Application Support');
    
    // Only paths where Echo's custom UxPlay would be installed
    const echoUxPlayPaths = [
      path.join(userBinDir, 'uxplay'),           // Our primary installation location
      path.join(userBinDir, 'uxplay-wrapper'),   // Wrapper script with env setup
      path.join(appDataDir, 'uxplay/uxplay'),    // App data installation
      path.join(appDataDir, 'uxplay-macos', 'extracted', 'UxPlay', 'uxplay'), // Direct from zip
    ];
    
    console.log('NOTE: Looking for Echo custom UxPlay (Homebrew version does NOT support -vrtp)');
    
    for (const uxplayPath of echoUxPlayPaths) {
      try {
        if (fs.existsSync(uxplayPath)) {
          const stats = fs.statSync(uxplayPath);
          if (stats.mode & 0o111) { // Check if executable
            return { executable: uxplayPath, isWrapper: false, cwd: process.cwd() };
          }
        }
      } catch (error) {
        // Continue searching
      }
    }
    
    // Note: We intentionally do NOT search PATH or Homebrew
    throw new Error(
      'Echo custom UxPlay not found.\n' +
      'Standard Homebrew UxPlay will NOT work (missing -vrtp support).\n' +
      'Please use the Echo Desktop app to install UxPlay from Supabase.'
    );
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}

/**
 * Set up environment variables based on platform
 */
function setupEnvironment(cwd) {
  const env = { ...process.env };
  
  if (platform === 'win32') {
    // Windows: Add package directory to PATH and set GStreamer plugin path
    env.PATH = `${cwd};${env.PATH}`;
    env.GST_PLUGIN_PATH = path.join(cwd, 'lib', 'gstreamer-1.0');
  } else if (platform === 'darwin') {
    // macOS: Set up GStreamer environment (same as service)
    const homebrewLibPaths = [
      '/opt/homebrew/lib',
      '/usr/local/lib',
    ];
    const homebrewGstPaths = [
      '/opt/homebrew/lib/gstreamer-1.0',
      '/usr/local/lib/gstreamer-1.0',
    ];
    
    const existingDyldPath = env.DYLD_LIBRARY_PATH || '';
    const dyldPath = [
      ...homebrewLibPaths,
      ...(existingDyldPath ? existingDyldPath.split(':') : []),
    ].filter(Boolean).join(':');
    
    const existingGstPath = env.GST_PLUGIN_PATH || '';
    const gstPath = [
      ...homebrewGstPaths,
      ...(existingGstPath ? existingGstPath.split(':') : []),
    ].filter(Boolean).join(':');
    
    env.DYLD_LIBRARY_PATH = dyldPath;
    env.DYLD_FALLBACK_LIBRARY_PATH = `${dyldPath}:/usr/lib`;
    env.GST_PLUGIN_PATH = gstPath;
    env.PKG_CONFIG_PATH = [
      '/opt/homebrew/lib/pkgconfig',
      '/usr/local/lib/pkgconfig',
      env.PKG_CONFIG_PATH || '',
    ].filter(Boolean).join(':');
    env.GI_TYPELIB_PATH = [
      '/opt/homebrew/lib/girepository-1.0',
      '/usr/local/lib/girepository-1.0',
      env.GI_TYPELIB_PATH || '',
    ].filter(Boolean).join(':');
  }
  
  return env;
}

/**
 * Start UxPlay process
 */
async function startUxPlay() {
  console.log('==========================================');
  console.log('Starting UxPlay Server');
  console.log(`Platform: ${platform}`);
  console.log('==========================================\n');
  
  const { executable, isWrapper, cwd } = await findUxPlayExecutable();
  const env = setupEnvironment(cwd);
  
  console.log(`Executable: ${executable}`);
  console.log(`Arguments: ${finalArgs.join(' ')}`);
  if (platform === 'darwin') {
    console.log(`DYLD_LIBRARY_PATH: ${env.DYLD_LIBRARY_PATH}`);
    console.log(`GST_PLUGIN_PATH: ${env.GST_PLUGIN_PATH}`);
  } else {
    console.log(`GST_PLUGIN_PATH: ${env.GST_PLUGIN_PATH}`);
  }
  console.log('');
  console.log('📱 Waiting for AirPlay device connection...');
  console.log('   Look for device detection messages below:\n');
  console.log('   Expected format: "connection request from <name> (<model>) with deviceID = <id>"\n');
  console.log('==========================================\n');
  
  let uxplayProcess;
  
  if (platform === 'win32' && isWrapper) {
    // Windows: Use cmd.exe to run batch wrapper
    const cmdArgs = ['/c', executable, ...finalArgs];
    uxplayProcess = spawn('cmd.exe', cmdArgs, {
      env,
      stdio: 'inherit', // Inherit to see all output
      cwd,
      shell: false,
    });
  } else {
    // Direct execution (Windows exe or macOS)
    uxplayProcess = spawn(executable, finalArgs, {
      env,
      stdio: 'inherit', // Inherit to see all output
      cwd,
    });
  }
  
  // Handle process events
  uxplayProcess.on('error', (error) => {
    console.error(`\n❌ Failed to start UxPlay: ${error.message}`);
    process.exit(1);
  });

  uxplayProcess.on('exit', (code, signal) => {
    console.log('\n==========================================');
    if (signal) {
      console.log(`UxPlay stopped by signal: ${signal}`);
    } else {
      console.log(`UxPlay exited with code: ${code}`);
    }
    console.log('==========================================');
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n\nStopping UxPlay...');
    uxplayProcess.kill('SIGTERM');
    setTimeout(() => {
      if (!uxplayProcess.killed) {
        uxplayProcess.kill('SIGKILL');
      }
      process.exit(0);
    }, 2000);
  });

  console.log('✓ UxPlay server started');
  console.log('  Press Ctrl+C to stop\n');
  
  // Keep process alive
  process.stdin.resume();
}

// Run
startUxPlay().catch((error) => {
  console.error(`\n❌ Error: ${error.message}`);
  process.exit(1);
});

