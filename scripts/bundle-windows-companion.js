#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const appRoot = path.join(__dirname, '..');
const uxplayRoot = path.join(appRoot, 'uxplay');
const distDir = path.join(appRoot, 'dist');
const tempDir = path.join(appRoot, 'temp', 'windows-companion');
const uxplayArtifact = path.join(uxplayRoot, 'resources', 'temp', 'airplay-bridge.zip');
const outputZip = path.join(distDir, 'echo-ios-dependencies-windows.zip');

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

function resolveWindowsFfmpegSource() {
  const candidates = [
    process.env.ECHO_WINDOWS_FFMPEG_PATH,
    path.join(appRoot, 'ffmpeg', 'ffmpeg.exe'),
    path.join(appRoot, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Windows ffmpeg binary not found. Checked: ${candidates.join(', ') || '(no candidates)'}`,
  );
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

  ensureFile(uxplayArtifact, 'UxPlay packaged artifact');
  const ffmpegSource = resolveWindowsFfmpegSource();
  ensureFile(ffmpegSource, 'Windows ffmpeg binary');

  fs.mkdirSync(distDir, { recursive: true });
  resetDir(tempDir);

  const packageRoot = path.join(tempDir, 'echo-ios-dependencies-windows');
  const airplayDir = path.join(packageRoot, 'airplay-bridge');
  const ffmpegDir = path.join(packageRoot, 'ffmpeg');

  fs.mkdirSync(airplayDir, { recursive: true });
  fs.mkdirSync(ffmpegDir, { recursive: true });

  console.log('[bundle] Extracting packaged UxPlay artifact...');
  const zip = new AdmZip(uxplayArtifact);
  zip.extractAllTo(airplayDir, true);

  const bridgeCandidates = [
    path.join(airplayDir, 'echo-airplay.exe'),
    path.join(airplayDir, 'uxplay.exe'),
    path.join(airplayDir, 'uxplay-windows.exe'),
  ];
  const bridgePath = bridgeCandidates.find((candidate) => fs.existsSync(candidate));
  if (!bridgePath) {
    throw new Error(`Expected a Windows bridge executable in ${airplayDir}`);
  }

  const normalizedBridgePath = path.join(airplayDir, 'echo-airplay.exe');
  if (bridgePath !== normalizedBridgePath) {
    fs.copyFileSync(bridgePath, normalizedBridgePath);
  }

  console.log('[bundle] Copying ffmpeg...');
  fs.copyFileSync(ffmpegSource, path.join(ffmpegDir, 'ffmpeg.exe'));

  const ffmpegCandidates = [
    [path.join(appRoot, 'ffmpeg', 'LICENSE'), path.join(ffmpegDir, 'LICENSE')],
    [path.join(appRoot, 'ffmpeg', 'README.md'), path.join(ffmpegDir, 'README.md')],
    [path.join(path.dirname(ffmpegSource), 'ffmpeg.exe.LICENSE'), path.join(ffmpegDir, 'ffmpeg.exe.LICENSE')],
    [path.join(path.dirname(ffmpegSource), 'ffmpeg.exe.README'), path.join(ffmpegDir, 'ffmpeg.exe.README')],
    [path.join(path.dirname(ffmpegSource), 'README.md'), path.join(ffmpegDir, 'ffmpeg-static.README.md')],
    [path.join(path.dirname(ffmpegSource), 'LICENSE'), path.join(ffmpegDir, 'ffmpeg-static.LICENSE')],
  ];

  for (const [sourcePath, targetPath] of ffmpegCandidates) {
    copyIfExists(sourcePath, targetPath);
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
  const output = new AdmZip();
  output.addLocalFolder(packageRoot, path.basename(packageRoot));
  output.writeZip(outputZip);

  const sizeMb = (fs.statSync(outputZip).size / (1024 * 1024)).toFixed(2);
  console.log(`\n[bundle] Created ${outputZip} (${sizeMb} MB)`);
}

try {
  main();
} catch (error) {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
}
