#!/usr/bin/env node

/**
 * Direct Windows build script - runs commands step by step
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const MSYS2_BASE = process.env.MSYS2_BASE || 'C:\\msys64';
const MSYS2_BASH = path.join(MSYS2_BASE, 'usr', 'bin', 'bash.exe');
const MSYS2_USR_BIN = path.join(MSYS2_BASE, 'usr', 'bin');

function getToolchainConfig() {
  const subsystem = (process.env.MSYS2_SUBSYSTEM || process.env.MSYSTEM || 'MINGW64').toUpperCase();
  const toolchains = {
    MINGW64: {
      subsystem: 'MINGW64',
      binDir: path.join(MSYS2_BASE, 'mingw64', 'bin'),
    },
    UCRT64: {
      subsystem: 'UCRT64',
      binDir: path.join(MSYS2_BASE, 'ucrt64', 'bin'),
    },
  };

  const config = toolchains[subsystem];
  if (!config) {
    throw new Error(`Unsupported MSYS2 subsystem: ${subsystem}`);
  }

  return config;
}

function runCommand(cmd, description, options = {}) {
  console.log(`\n${description}...`);
  console.log(`Command: ${cmd}`);
  try {
    const output = execSync(cmd, { 
      encoding: 'utf8',
      shell: true,
      stdio: 'pipe', // Capture output so we can see errors
      ...options,
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

  const toolchain = getToolchainConfig();
  console.log(`MSYS2 subsystem: ${toolchain.subsystem}`);

  // Check prerequisites
  if (!fs.existsSync(MSYS2_BASH)) {
    console.error(`❌ MSYS2 not found at ${MSYS2_BASH}`);
    console.error('Please install MSYS2 from https://www.msys2.org/');
    process.exit(1);
  }
  console.log(`✓ MSYS2 found: ${MSYS2_BASH}`);

  const scriptDir = __dirname;
  const projectRoot = path.join(scriptDir, '..');
  const uxplaySourceCandidates = [
    path.join(projectRoot, 'resources', 'UxPlay-master'),
    path.join(projectRoot, '..', '..', 'desktop', 'resources', 'UxPlay-master'),
  ];
  const uxplaySource = uxplaySourceCandidates.find((candidate) => fs.existsSync(candidate));
  
  if (!uxplaySource) {
    console.error(`Checked:\n${uxplaySourceCandidates.map((candidate) => `  - ${candidate}`).join('\n')}`);
    console.error(`❌ UxPlay source not found: ${uxplaySource}`);
    process.exit(1);
  }
  console.log(`✓ UxPlay source found: ${uxplaySource}`);

  // Convert paths for MSYS2
  const uxplayMsys = uxplaySource.replace(/\\/g, '/').replace(/^([A-Z]):/, '/$1').toLowerCase();
  const buildMsys = `${uxplayMsys}/build`;

  const msysEnv = {
    ...process.env,
    MSYSTEM: toolchain.subsystem,
    MSYS2_SUBSYSTEM: toolchain.subsystem,
    CHERE_INVOKING: '1',
    PATH: `${toolchain.binDir};${MSYS2_USR_BIN};${process.env.PATH || ''}`,
  };
  if (!fs.existsSync(toolchain.binDir)) {
    console.error(`MSYS2 ${toolchain.subsystem} bin directory not found at ${toolchain.binDir}`);
    console.error('Please ensure MSYS2 is properly installed');
    process.exit(1);
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
  const buildEnv = {
    ...msysEnv,
    BONJOUR_SDK_HOME: bonjourSdkMsys,
    CFLAGS: '-O2 -march=x86-64 -mtune=generic -mno-avx -mno-avx2',
    CXXFLAGS: '-O2 -march=x86-64 -mtune=generic -mno-avx -mno-avx2',
  };
  const bashCmd = `"${MSYS2_BASH}" -lc "bash '${buildScriptMsys}'"`;
  
  console.log(`\nRunning build script...`);
  console.log(`Script: ${buildScript}`);
  console.log(`Command: ${bashCmd}`);
  
  try {
    const output = execSync(bashCmd, { 
      encoding: 'utf8',
      shell: true,
      stdio: 'inherit', // Show output in real-time
      env: buildEnv,
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
