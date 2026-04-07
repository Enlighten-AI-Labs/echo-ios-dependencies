#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  buildWindowsRuntimeEnv,
} = require('./windows-gstreamer-runtime');

function resolveBridgeExe() {
  const cliArg = process.argv[2];
  if (cliArg) {
    return path.resolve(cliArg);
  }

  const packageDir = path.join(__dirname, '..', 'resources', 'temp', 'airplay-bridge');
  return path.join(packageDir, 'echo-airplay.exe');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const bridgeExe = resolveBridgeExe();
  if (!fs.existsSync(bridgeExe)) {
    throw new Error(`Bridge executable not found at ${bridgeExe}`);
  }

  const runtime = buildWindowsRuntimeEnv(bridgeExe, process.env);

  console.log(`Bridge executable: ${bridgeExe}`);
  console.log(`Curated plugin dir: ${runtime.curatedPluginDir}`);
  console.log(`Curated plugins copied this run: ${runtime.copiedPlugins.length}`);
  if (runtime.scannerPath) {
    console.log(`Plugin scanner: ${runtime.scannerPath}`);
  }

  const args = [
    '-n', 'Echo Validation',
    '-p', '47000,47001,47002',
    '-vrtp', 'config-interval=1 ! udpsink host=127.0.0.1 port=47010',
  ];

  const child = spawn(bridgeExe, args, {
    cwd: runtime.bridgeDir,
    env: runtime.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let exitCode = null;
  let exitSignal = null;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('exit', (code, signal) => {
    exitCode = code;
    exitSignal = signal;
  });

  await wait(4000);

  if (exitCode !== null || exitSignal !== null) {
    throw new Error(
      `Bridge exited early with code=${exitCode} signal=${exitSignal}\nstdout:\n${stdout.slice(0, 1200)}\nstderr:\n${stderr.slice(0, 2000)}`,
    );
  }

  if (/Failed to load plugin|module could not be found|GStreamer-WARNING|STATUS_ILLEGAL_INSTRUCTION/iu.test(stderr)) {
    throw new Error(`Bridge emitted runtime warnings during startup:\n${stderr.slice(0, 2000)}`);
  }

  child.kill('SIGTERM');
  await wait(800);

  console.log('Windows bridge package validation passed.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
