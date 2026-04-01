#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');

const appRoot = path.join(__dirname, '..');
const uxplayRoot = path.join(appRoot, 'uxplay');
const ffmpegRoot = path.join(appRoot, 'ffmpeg');
const distDir = path.join(appRoot, 'dist');
const tempDir = path.join(appRoot, 'temp', 'macos-companion');
const uxplayArtifact = path.join(uxplayRoot, 'resources', 'temp', 'airplay-bridge.zip');
const outputZip = path.join(distDir, 'echo-ios-dependencies-macos.zip');

function ensureFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}`);
  }
}

function resetDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyIfExists(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function makeExecutable(filePath) {
  try {
    fs.chmodSync(filePath, 0o755);
  } catch (_error) {
    // Ignore chmod failures on already-correct files.
  }
}

function buildManifest(packageRoot) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    platform: 'darwin',
    contents: {
      airplay: [],
      ffmpeg: [],
    },
  };

  const airplayDir = path.join(packageRoot, 'airplay-bridge');
  const ffmpegDir = path.join(packageRoot, 'ffmpeg');

  if (fs.existsSync(airplayDir)) {
    manifest.contents.airplay = fs.readdirSync(airplayDir).sort();
  }
  if (fs.existsSync(ffmpegDir)) {
    manifest.contents.ffmpeg = fs.readdirSync(ffmpegDir).sort();
  }

  fs.writeFileSync(
    path.join(packageRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

function main() {
  console.log('==========================================');
  console.log('Echo iOS Dependencies macOS Bundle');
  console.log('==========================================\n');

  ensureFile(uxplayArtifact, 'UxPlay packaged artifact');
  ensureFile(path.join(ffmpegRoot, 'ffmpeg'), 'ffmpeg binary');

  fs.mkdirSync(distDir, { recursive: true });
  resetDir(tempDir);

  const packageRoot = path.join(tempDir, 'echo-ios-dependencies-macos');
  const airplayDir = path.join(packageRoot, 'airplay-bridge');
  const ffmpegDir = path.join(packageRoot, 'ffmpeg');

  fs.mkdirSync(airplayDir, { recursive: true });
  fs.mkdirSync(ffmpegDir, { recursive: true });

  console.log('[bundle] Extracting packaged UxPlay artifact...');
  const zip = new AdmZip(uxplayArtifact);
  zip.extractAllTo(airplayDir, true);

  const uxplayCandidates = [
    path.join(airplayDir, 'uxplay'),
    path.join(airplayDir, 'echo-airplay'),
  ];
  const uxplayPath = uxplayCandidates.find((candidate) => fs.existsSync(candidate));
  if (!uxplayPath) {
    throw new Error(`Expected uxplay or echo-airplay in ${airplayDir}`);
  }

  const echoAirplayPath = path.join(airplayDir, 'echo-airplay');
  if (uxplayPath !== echoAirplayPath) {
    fs.copyFileSync(uxplayPath, echoAirplayPath);
  }
  makeExecutable(echoAirplayPath);

  const wrapperPath = path.join(airplayDir, 'echo-airplay-wrapper.sh');
  const wrapperScript = `#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export GST_PLUGIN_PATH="$SCRIPT_DIR/lib/gstreamer-1.0:$GST_PLUGIN_PATH"
export DYLD_LIBRARY_PATH="$SCRIPT_DIR/lib:$DYLD_LIBRARY_PATH"
exec "$SCRIPT_DIR/echo-airplay" "$@"
`;
  fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });

  console.log('[bundle] Copying ffmpeg...');
  for (const fileName of ['ffmpeg', 'LICENSE', 'README.md', 'ffmpeg.LICENSE', 'ffmpeg.README']) {
    const copied = copyIfExists(path.join(ffmpegRoot, fileName), path.join(ffmpegDir, fileName));
    if (copied && fileName === 'ffmpeg') {
      makeExecutable(path.join(ffmpegDir, fileName));
    }
  }

  const topLevelReadme = `Echo iOS Dependencies (macOS)

Contents:
- airplay-bridge/echo-airplay
- airplay-bridge/echo-airplay-wrapper.sh
- ffmpeg/ffmpeg

Install these as a separately distributed companion runtime.
`;
  fs.writeFileSync(path.join(packageRoot, 'README.txt'), topLevelReadme, 'utf8');
  buildManifest(packageRoot);

  console.log('[bundle] Creating downloadable zip...');
  fs.rmSync(outputZip, { force: true });
  execSync(`cd "${tempDir}" && zip -r "${outputZip}" "echo-ios-dependencies-macos"`, {
    stdio: 'inherit',
  });

  const sizeMb = (fs.statSync(outputZip).size / (1024 * 1024)).toFixed(2);
  console.log(`\n[bundle] Created ${outputZip} (${sizeMb} MB)`);
}

try {
  main();
} catch (error) {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
}
