#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');

const appRoot = path.join(__dirname, '..');
const uxplayRoot = path.join(appRoot, 'uxplay');
const ffmpegRoot = path.join(appRoot, 'ffmpeg');
const distDir = path.join(appRoot, 'dist');
const tempDir = path.join(appRoot, 'temp', 'windows-companion');
const uxplayArtifact = path.join(uxplayRoot, 'resources', 'temp', 'airplay-bridge.zip');
const outputZip = path.join(distDir, 'echo-ios-dependencies-windows.zip');

function resolveWindowsFfmpegBinary() {
  const candidates = [
    path.join(ffmpegRoot, 'ffmpeg.exe'),
    path.join(appRoot, '..', 'desktop', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    path.join(appRoot, '..', 'desktop', 'build', 'runtime-node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

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

function buildManifest(packageRoot) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    platform: 'win32',
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
  console.log('Echo iOS Dependencies Windows Bundle');
  console.log('==========================================\n');

  ensureFile(uxplayArtifact, 'Windows AirPlay bridge artifact');
  const ffmpegBinary = resolveWindowsFfmpegBinary();
  if (!ffmpegBinary) {
    throw new Error('Windows ffmpeg binary not found in ios-dependencies or desktop ffmpeg-static locations');
  }

  fs.mkdirSync(distDir, { recursive: true });
  resetDir(tempDir);

  const packageRoot = path.join(tempDir, 'echo-ios-dependencies-windows');
  const airplayDir = path.join(packageRoot, 'airplay-bridge');
  const ffmpegDir = path.join(packageRoot, 'ffmpeg');

  fs.mkdirSync(airplayDir, { recursive: true });
  fs.mkdirSync(ffmpegDir, { recursive: true });

  console.log('[bundle] Extracting validated AirPlay bridge artifact...');
  const zip = new AdmZip(uxplayArtifact);
  zip.extractAllTo(airplayDir, true);

  console.log('[bundle] Copying ffmpeg...');
  fs.copyFileSync(ffmpegBinary, path.join(ffmpegDir, 'ffmpeg.exe'));
  for (const fileName of ['LICENSE', 'README.md', 'ffmpeg.LICENSE', 'ffmpeg.README']) {
    copyIfExists(path.join(ffmpegRoot, fileName), path.join(ffmpegDir, fileName));
  }

  const topLevelReadme = `Echo iOS Dependencies (Windows)

Contents:
- airplay-bridge/echo-airplay.exe
- airplay-bridge/echo-airplay.bat
- ffmpeg/ffmpeg.exe

Install these as a separately distributed companion runtime.
`;
  fs.writeFileSync(path.join(packageRoot, 'README.txt'), topLevelReadme, 'utf8');
  buildManifest(packageRoot);

  console.log('[bundle] Creating downloadable zip...');
  fs.rmSync(outputZip, { force: true });
  execSync(`powershell -Command "Compress-Archive -Path '${packageRoot}\\*' -DestinationPath '${outputZip}' -Force"`, {
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
