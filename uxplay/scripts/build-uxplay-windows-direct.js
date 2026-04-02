#!/usr/bin/env node

/**
 * Direct Windows build script - runs the working MSYS2 configure/build steps
 * without relying on the interactive ucrt64 launcher.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const MSYS2_BASH = 'C:\\msys64\\usr\\bin\\bash.exe';
const MSYS2_PATH_PREFIX = '/ucrt64/bin:/usr/bin';

function toMsysPath(windowsPath) {
  return windowsPath.replace(/\\/g, '/').replace(/^([A-Z]):/, '/$1');
}

function runCommand(cmd, description) {
  console.log(`\n${description}...`);
  console.log(`Command: ${cmd}`);

  try {
    const output = execSync(cmd, {
      encoding: 'utf8',
      shell: true,
      stdio: 'pipe',
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

  if (!fs.existsSync(MSYS2_BASH)) {
    console.error(`MSYS2 bash not found at ${MSYS2_BASH}`);
    process.exit(1);
  }
  console.log(`✓ MSYS2 found: ${MSYS2_BASH}`);

  const scriptDir = __dirname;
  const projectRoot = path.join(scriptDir, '..');
  const uxplaySource = path.join(projectRoot, 'resources', 'UxPlay-master');
  const buildDir = path.join(uxplaySource, 'build');

  if (!fs.existsSync(uxplaySource)) {
    console.error(`UxPlay source not found: ${uxplaySource}`);
    process.exit(1);
  }
  console.log(`✓ UxPlay source found: ${uxplaySource}`);

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

  const installCmd = `"${MSYS2_BASH}" -lc "export PATH='${MSYS2_PATH_PREFIX}:$PATH'; pacman -S --noconfirm --needed ${packages}"`;
  if (!runCommand(installCmd, 'Installing dependencies')) {
    console.warn('Warning: dependency installation had issues; continuing with existing toolchain');
  }

  const bonjourSdk = process.env.BONJOUR_SDK_HOME || 'C:/Program Files/Bonjour SDK';
  const sourceMsys = toMsysPath(uxplaySource);

  const configureCmd = `"${MSYS2_BASH}" -lc "export PATH='${MSYS2_PATH_PREFIX}:$PATH'; export BONJOUR_SDK_HOME='${bonjourSdk}'; cd '${sourceMsys}'; cmake -S . -B build -G Ninja"`;
  if (!runCommand(configureCmd, 'Configuring CMake build')) {
    process.exit(1);
  }

  const buildCmd = `"${MSYS2_BASH}" -lc "export PATH='${MSYS2_PATH_PREFIX}:$PATH'; cd '${sourceMsys}/build'; ninja"`;
  if (!runCommand(buildCmd, 'Building with Ninja')) {
    process.exit(1);
  }

  const possibleNames = ['uxplay.exe', 'uxplay', 'UxPlay.exe', 'UxPlay'];
  const executablePath = possibleNames
    .map((fileName) => path.join(buildDir, fileName))
    .find((candidate) => fs.existsSync(candidate));

  if (!executablePath) {
    console.error(`Build completed but executable not found in ${buildDir}`);
    process.exit(1);
  }

  const stats = fs.statSync(executablePath);
  console.log('\n==========================================');
  console.log('Build successful!');
  console.log('==========================================');
  console.log(`Executable: ${executablePath}`);
  console.log(`Size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
}

main();
