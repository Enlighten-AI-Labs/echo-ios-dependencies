#!/usr/bin/env node

/**
 * Builds the pinned UxPlay source for macOS (thin arm64, explicit minimum macOS).
 * Build dependencies must already be installed (Homebrew is checked read-only, never modified).
 * Output is an intermediate build + build-info.json; package-uxplay-macos.js turns it into
 * the relocatable bridge. This script never produces a release artifact itself.
 */

const fs = require('fs');
const path = require('path');
const {
  MACOS_CONTRACT,
  MIN_MACOS_ENV,
  UXPLAY_PIN,
  requireMinMacOS,
  run,
  safeExtractZip,
  sha256File,
} = require('./macos-gstreamer-runtime');

const uxplayRoot = path.join(__dirname, '..');
const tempRoot = path.join(uxplayRoot, 'resources', 'temp');

const distRoot = path.join(uxplayRoot, '..', 'dist');

const DEFAULTS = {
  workDir: path.join(tempRoot, 'uxplay-build'),
  // Everything downstream of this build; a new build makes all of them stale.
  finalArtifacts: [
    path.join(tempRoot, 'airplay-bridge.zip'),
    path.join(distRoot, 'echo-ios-dependencies-macos.zip'),
    path.join(distRoot, 'echo-ios-dependencies-macos.manifest.json'),
  ],
};

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
// Parallel compile jobs. Capped by default so builds stay polite on shared hosts.
const BUILD_JOBS_ENV = 'ECHO_MACOS_BUILD_JOBS';
const DEFAULT_BUILD_JOBS = 4;
const MAX_BUILD_JOBS = 16;
const REQUIRED_TOOLS = ['cmake', 'pkg-config', 'clang', 'otool', 'lipo', 'install_name_tool', 'codesign', 'zip'];
const REQUIRED_PKG_CONFIG = ['gstreamer-1.0', 'gstreamer-app-1.0', 'gstreamer-video-1.0', 'gstreamer-sdp-1.0', 'libplist-2.0', 'openssl'];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadArchive(destination, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(UXPLAY_PIN.archiveUrl, { redirect: 'follow', headers: { 'User-Agent': 'echo-ios-dependencies' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > MAX_ARCHIVE_BYTES) throw new Error(`archive is ${body.length} bytes, limit ${MAX_ARCHIVE_BYTES}`);
      fs.writeFileSync(destination, body);
      return destination;
    } catch (error) {
      lastError = error;
      console.warn(`  download attempt ${attempt}/${attempts} failed: ${error.message}`);
      if (attempt < attempts) await wait(2000 * attempt);
    }
  }
  throw new Error(`Could not download ${UXPLAY_PIN.archiveUrl}: ${lastError.message}`);
}

/** Verifies the archive digest before anything is extracted. */
function verifyArchive(archivePath) {
  const size = fs.statSync(archivePath).size;
  if (size > MAX_ARCHIVE_BYTES) throw new Error(`${archivePath} is ${size} bytes, limit ${MAX_ARCHIVE_BYTES}`);
  const digest = sha256File(archivePath);
  if (digest !== UXPLAY_PIN.archiveSha256) {
    throw new Error(`UxPlay archive sha256 ${digest} does not match pinned ${UXPLAY_PIN.archiveSha256}`);
  }
}

function preflight() {
  const missing = REQUIRED_TOOLS.filter((tool) => {
    try {
      run('/bin/sh', ['-c', `command -v ${tool}`]);
      return false;
    } catch (_error) {
      return true;
    }
  });
  if (missing.length > 0) throw new Error(`Missing build tools: ${missing.join(', ')}`);
  const absent = REQUIRED_PKG_CONFIG.filter((pkg) => {
    try {
      run('pkg-config', ['--exists', pkg]);
      return false;
    } catch (_error) {
      return true;
    }
  });
  if (absent.length > 0) {
    throw new Error(
      `Missing build dependencies (pkg-config): ${absent.join(', ')}. Install them before building; `
      + 'this script does not install or update packages.',
    );
  }
  const gst = run('pkg-config', ['--modversion', 'gstreamer-1.0']).trim();
  if (!/^1\.(2[4-9]|[3-9]\d)\./.test(gst)) throw new Error(`GStreamer ${gst} is unsupported; need 1.24 or newer 1.x`);
  return {
    gstreamer: gst,
    cmake: run('cmake', ['--version']).split('\n')[0].trim(),
    clang: run('clang', ['--version']).split('\n')[0].trim(),
    sdk: run('xcrun', ['--show-sdk-version']).trim(),
  };
}

function parseBuildJobs(value) {
  if (value === undefined || value === '') return DEFAULT_BUILD_JOBS;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_BUILD_JOBS) {
    throw new Error(`${BUILD_JOBS_ENV}="${value}" must be a whole number from 1 to ${MAX_BUILD_JOBS}`);
  }
  return Number(value);
}

function cmakeCacheValue(buildDir, key) {
  const cache = fs.readFileSync(path.join(buildDir, 'CMakeCache.txt'), 'utf8');
  const match = cache.match(new RegExp(`^${key}:[A-Z]+=(.*)$`, 'm'));
  return match ? match[1] : null;
}

async function buildUxPlay({ minMacOS, buildJobs = process.env[BUILD_JOBS_ENV], sourceArchive = process.env.UXPLAY_SOURCE_ARCHIVE, workDir = DEFAULTS.workDir, finalArtifacts = DEFAULTS.finalArtifacts } = {}) {
  // Clear outputs first: an interrupted build must not leave a previous artifact looking current.
  for (const artifact of finalArtifacts) fs.rmSync(artifact, { force: true });
  fs.rmSync(workDir, { recursive: true, force: true });

  const target = requireMinMacOS(minMacOS);
  const jobs = parseBuildJobs(buildJobs);
  const toolchain = preflight();
  fs.mkdirSync(workDir, { recursive: true });

  const archivePath = path.join(workDir, 'uxplay-source.zip');
  if (sourceArchive) {
    console.log(`[build] Using local source archive ${sourceArchive}`);
    fs.copyFileSync(sourceArchive, archivePath);
  } else {
    console.log(`[build] Downloading ${UXPLAY_PIN.archiveUrl}`);
    await downloadArchive(archivePath);
  }
  verifyArchive(archivePath);

  const topDir = `UxPlay-${UXPLAY_PIN.commit}`;
  const zip = safeExtractZip(archivePath, path.join(workDir, 'src'), { topDir, maxEntries: 500, maxBytes: 32 * 1024 * 1024 });
  if (zip.getZipComment() !== UXPLAY_PIN.commit) throw new Error('UxPlay archive comment does not name the pinned commit');
  const sourceDir = path.join(workDir, 'src', topDir);

  const buildDir = path.join(workDir, 'build');
  console.log(`[build] Configuring UxPlay ${UXPLAY_PIN.version} for ${MACOS_CONTRACT.arch}, macOS ${target}`);
  // Keep the build machine's paths (and username) out of __FILE__ strings in the binary.
  // CMake splits flag strings on whitespace, so this is skipped for paths containing spaces.
  const prefixMap = /\s/.test(sourceDir) ? [] : [`-ffile-prefix-map=${sourceDir}=${topDir}`];
  if (prefixMap.length === 0) console.warn('[build] Source path contains whitespace; build paths will be embedded in the binary');
  run('cmake', [
    '-S', sourceDir, '-B', buildDir,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_OSX_ARCHITECTURES=${MACOS_CONTRACT.arch}`,
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${target}`,
    ...prefixMap.flatMap((flag) => [`-DCMAKE_C_FLAGS=${flag}`, `-DCMAKE_CXX_FLAGS=${flag}`]),
    // Room for the longer @rpath install names written during packaging.
    '-DCMAKE_EXE_LINKER_FLAGS=-Wl,-headerpad_max_install_names',
  ], { stdio: 'inherit' });
  run('cmake', ['--build', buildDir, '-j', String(jobs)], { stdio: 'inherit' });

  const binaryPath = path.join(buildDir, 'uxplay');
  if (!fs.existsSync(binaryPath)) throw new Error(`Build finished without ${binaryPath}`);
  const staticLibraries = ['LIBPLIST', 'LIBCRYPTO'].map((key) => {
    const value = cmakeCacheValue(buildDir, key);
    if (!value || !fs.existsSync(value)) throw new Error(`Could not resolve statically linked ${key} from CMakeCache.txt`);
    return fs.realpathSync(value);
  });

  const buildInfo = {
    schema: 1,
    uxplay: { version: UXPLAY_PIN.version, commit: UXPLAY_PIN.commit, archiveSha256: UXPLAY_PIN.archiveSha256 },
    arch: MACOS_CONTRACT.arch,
    minimumMacOS: target,
    binary: path.relative(workDir, binaryPath),
    binarySha256: sha256File(binaryPath),
    sourceDir: path.relative(workDir, sourceDir),
    staticLibraries,
    toolchain,
  };
  // Written last: its presence marks a complete build.
  const buildInfoPath = path.join(workDir, 'build-info.json');
  fs.writeFileSync(buildInfoPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
  return { buildInfoPath, buildInfo };
}

if (require.main === module) {
  console.log('==========================================');
  console.log('UxPlay macOS Builder (pinned source)');
  console.log('==========================================\n');
  buildUxPlay({ minMacOS: process.env[MIN_MACOS_ENV] })
    .then(({ buildInfoPath, buildInfo }) => {
      console.log(`\n[build] UxPlay ${buildInfo.uxplay.version} (${buildInfo.uxplay.commit}) built`);
      console.log(`[build] binary sha256 ${buildInfo.binarySha256}`);
      console.log(`[build] ${buildInfoPath}`);
      console.log('[build] Next: npm run package:macos:uxplay');
    })
    .catch((error) => {
      console.error(`\nERROR: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { DEFAULTS, buildUxPlay, parseBuildJobs, verifyArchive };
