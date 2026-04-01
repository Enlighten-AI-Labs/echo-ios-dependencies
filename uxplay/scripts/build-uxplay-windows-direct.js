#!/usr/bin/env node

/**
 * Direct Windows build script - runs commands step by step
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const MSYS2_BASH = 'C:\\msys64\\usr\\bin\\bash.exe';

function runCommand(cmd, description) {
  console.log(`\n${description}...`);
  console.log(`Command: ${cmd}`);
  try {
    const output = execSync(cmd, { 
      encoding: 'utf8',
      shell: true,
      stdio: 'pipe' // Capture output so we can see errors
    });
    if (output) {
      console.log(output);
    }
    console.log(`✓ ${description} completed`);
    return true;
  } catch (error) {
    console.error(`✗ ${description} failed`);
    if (error.stdout) {
      console.error('STDOUT:', error.stdout.toString());
    }
    if (error.stderr) {
      console.error('STDERR:', error.stderr.toString());
    }
    if (error.message) {
      console.error('Error:', error.message);
    }
    return false;
  }
}

function main() {
  console.log('==========================================');
  console.log('UxPlay Windows Build');
  console.log('==========================================\n');

  // Check prerequisites
  if (!fs.existsSync(MSYS2_BASH)) {
    console.error(`❌ MSYS2 not found at ${MSYS2_BASH}`);
    console.error('Please install MSYS2 from https://www.msys2.org/');
    process.exit(1);
  }
  console.log(`✓ MSYS2 found: ${MSYS2_BASH}`);

  const scriptDir = __dirname;
  const projectRoot = path.join(scriptDir, '..');
  const uxplaySource = path.join(projectRoot, 'resources', 'UxPlay-master');
  
  if (!fs.existsSync(uxplaySource)) {
    console.error(`❌ UxPlay source not found: ${uxplaySource}`);
    process.exit(1);
  }
  console.log(`✓ UxPlay source found: ${uxplaySource}`);

  // Convert paths for MSYS2
  const uxplayMsys = uxplaySource.replace(/\\/g, '/').replace(/^([A-Z]):/, '/$1').toLowerCase();
  const buildMsys = `${uxplayMsys}/build`;

  // Step 1: Install dependencies
  const packages = [
    'mingw-w64-ucrt-x86_64-cmake',
    'mingw-w64-ucrt-x86_64-gcc',
    'mingw-w64-ucrt-x86_64-ninja',
    'mingw-w64-ucrt-x86_64-libplist',
    'mingw-w64-ucrt-x86_64-gstreamer',
    'mingw-w64-ucrt-x86_64-gst-plugins-base',
    'mingw-w64-ucrt-x86_64-gst-libav',
    'mingw-w64-ucrt-x86_64-gst-plugins-good',
    'mingw-w64-ucrt-x86_64-gst-plugins-bad',
  ].join(' ');

  // Use ucrt64.exe for pacman too to ensure consistent environment
  const MSYS2_UCRT64 = 'C:\\msys64\\ucrt64.exe';
  if (!fs.existsSync(MSYS2_UCRT64)) {
    console.error(`❌ MSYS2 UCRT64 launcher not found at ${MSYS2_UCRT64}`);
    console.error('Please ensure MSYS2 is properly installed');
    process.exit(1);
  }
  
  const installCmd = `"${MSYS2_UCRT64}" -c "pacman -S --noconfirm --needed ${packages}"`;
  if (!runCommand(installCmd, 'Installing dependencies')) {
    console.warn('⚠ Dependencies installation had issues (may already be installed)');
  }

  // Step 2: Create build directory
  const buildDir = path.join(uxplaySource, 'build');
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
  fs.mkdirSync(buildDir, { recursive: true });
  console.log(`✓ Created build directory: ${buildDir}`);

  // Step 3 & 4: Run the bash script that does everything
  // This ensures proper MSYS2 environment setup
  const buildScript = path.join(scriptDir, 'build-uxplay-windows.sh');
  const buildScriptMsys = buildScript.replace(/\\/g, '/').replace(/^([A-Z]):/, '/$1').toLowerCase();
  
  // Set BONJOUR_SDK_HOME if provided
  const bonjourSdk = process.env.BONJOUR_SDK_HOME || 'C:/Program Files/Bonjour SDK';
  const bonjourSdkMsys = bonjourSdk.replace(/\\/g, '/').replace(/^([A-Z]):/, '/$1').toLowerCase();
  
  // Run the bash script through MSYS2
  const bashCmd = `"${MSYS2_UCRT64}" -c "export BONJOUR_SDK_HOME='${bonjourSdkMsys}' && bash '${buildScriptMsys}'"`;
  
  console.log(`\nRunning build script...`);
  console.log(`Script: ${buildScript}`);
  console.log(`Command: ${bashCmd}`);
  
  try {
    const output = execSync(bashCmd, { 
      encoding: 'utf8',
      shell: true,
      stdio: 'inherit' // Show output in real-time
    });
    if (output) console.log(output);
  } catch (error) {
    console.error(`\n✗ Build script failed`);
    if (error.stdout) console.error('STDOUT:', error.stdout.toString());
    if (error.stderr) console.error('STDERR:', error.stderr.toString());
    if (error.message) console.error('Error:', error.message);
    process.exit(1);
  }

  // Step 5: Verify
  console.log('\nVerifying build output...');
  console.log(`Build directory: ${buildDir}`);
  
  // List all files in build directory
  try {
    const files = fs.readdirSync(buildDir);
    console.log(`Files in build directory: ${files.length}`);
    if (files.length > 0) {
      console.log('First 20 files:');
      files.slice(0, 20).forEach(file => {
        const filePath = path.join(buildDir, file);
        const stats = fs.statSync(filePath);
        const type = stats.isDirectory() ? '[DIR]' : '[FILE]';
        console.log(`  ${type} ${file} (${(stats.size / 1024).toFixed(2)} KB)`);
      });
    }
  } catch (error) {
    console.warn(`Could not list build directory: ${error.message}`);
  }
  
  // Check for executable with different possible names
  const possibleNames = ['uxplay.exe', 'uxplay', 'UxPlay.exe', 'UxPlay'];
  let exePath = null;
  let exeName = null;
  
  for (const name of possibleNames) {
    const testPath = path.join(buildDir, name);
    if (fs.existsSync(testPath)) {
      exePath = testPath;
      exeName = name;
      break;
    }
  }
  
  // Also check in subdirectories
  if (!exePath) {
    try {
      const files = fs.readdirSync(buildDir);
      for (const file of files) {
        const filePath = path.join(buildDir, file);
        if (fs.statSync(filePath).isDirectory()) {
          for (const name of possibleNames) {
            const testPath = path.join(filePath, name);
            if (fs.existsSync(testPath)) {
              exePath = testPath;
              exeName = name;
              break;
            }
          }
          if (exePath) break;
        }
      }
    } catch (error) {
      // Ignore errors
    }
  }
  
  if (exePath && fs.existsSync(exePath)) {
    const stats = fs.statSync(exePath);
    console.log(`\n==========================================`);
    console.log('Build successful!');
    console.log('==========================================');
    console.log(`Executable: ${exePath}`);
    console.log(`Size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
    console.log('\nNext steps:');
    console.log('  1. npm run package:uxplay:windows');
    console.log('  2. npm run upload:uxplay');
  } else {
    console.error('\n❌ Build completed but executable not found');
    console.error(`Checked for: ${possibleNames.join(', ')}`);
    console.error(`Build directory: ${buildDir}`);
    console.error('\nTroubleshooting:');
    console.error('  1. Check if ninja build actually completed successfully');
    console.error('  2. Check build logs for errors');
    console.error('  3. Try running ninja manually in MSYS2 terminal');
    process.exit(1);
  }
}

main();

