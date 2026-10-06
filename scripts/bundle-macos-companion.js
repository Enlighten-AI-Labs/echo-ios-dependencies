#!/usr/bin/env node

// Assembles dist/echo-ios-dependencies-macos.zip from the validated relocatable bridge and the
// checked-in ffmpeg, then validates the final zip (including a relocated runtime launch) before
// it is renamed into place. A sidecar manifest records the final artifact sha256.

const fs = require('fs');
const path = require('path');
const {
  MACOS_CONTRACT,
  MIN_MACOS_ENV,
  hashTree,
  requireMinMacOS,
  run,
  safeExtractZip,
  sha256File,
  writeZipAtomically,
} = require('../uxplay/scripts/macos-gstreamer-runtime');
const {
  COMPANION_DIR,
  validateBridgeDir,
  validateFfmpeg,
  validateZip,
} = require('../uxplay/scripts/validate-macos-package');

const appRoot = path.join(__dirname, '..');

const DEFAULTS = {
  bridgeZip: path.join(appRoot, 'uxplay', 'resources', 'temp', 'airplay-bridge.zip'),
  ffmpegDir: path.join(appRoot, 'ffmpeg'),
  outputZip: path.join(appRoot, 'dist', 'echo-ios-dependencies-macos.zip'),
  tempDir: path.join(appRoot, 'temp', 'macos-companion'),
};

const FFMPEG_FILES = ['ffmpeg', 'LICENSE', 'README.md', 'ffmpeg.LICENSE', 'ffmpeg.README'];
const FFMPEG_FLAGGED_OPTIONS = ['--enable-nonfree', '--enable-gpl', '--enable-version3'];

function sidecarPath(outputZip) {
  return outputZip.replace(/\.zip$/, '.manifest.json');
}

function gitState() {
  try {
    return {
      commit: run('git', ['-C', appRoot, 'rev-parse', 'HEAD']).trim(),
      dirty: run('git', ['-C', appRoot, 'status', '--porcelain']).trim().length > 0,
    };
  } catch (_error) {
    return { commit: null, dirty: null };
  }
}

/** ffmpeg ships unchanged; record what is known about it and flag what is not. */
function describeFfmpeg(ffmpegPath) {
  const binary = fs.readFileSync(ffmpegPath);
  const flagged = FFMPEG_FLAGGED_OPTIONS.filter((option) => binary.includes(option));
  const gaps = ['ffmpeg: checked-in prebuilt binary has no source receipt (exact source/version/build provenance unknown)'];
  if (flagged.includes('--enable-nonfree')) {
    gaps.push('ffmpeg: built with --enable-nonfree, which makes the binary non-redistributable under GPL; pre-existing, needs a decision');
  }
  return {
    sha256: sha256File(ffmpegPath),
    configureOptionsFlagged: flagged,
    component: {
      name: 'ffmpeg (prebuilt)',
      version: 'unknown',
      license: flagged.includes('--enable-gpl') ? 'GPL (configure flags: see configureOptionsFlagged)' : 'LGPL-2.1-or-later',
      linkage: 'separate executable',
      sourceUrl: null,
      sourceSha256: null,
      licenseFiles: ['ffmpeg/LICENSE', 'ffmpeg/ffmpeg.LICENSE'],
    },
    gaps,
  };
}

function bundleMacosCompanion(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const sidecar = sidecarPath(opts.outputZip);
  fs.rmSync(opts.outputZip, { force: true });
  fs.rmSync(`${opts.outputZip}.partial`, { force: true });
  fs.rmSync(sidecar, { force: true });

  try {
    const minMacOS = requireMinMacOS(opts.minMacOS);
    if (!fs.existsSync(opts.bridgeZip)) throw new Error(`Packaged AirPlay bridge not found at ${opts.bridgeZip}`);
    const ffmpegPath = path.join(opts.ffmpegDir, 'ffmpeg');
    if (!fs.existsSync(ffmpegPath)) throw new Error(`ffmpeg binary not found at ${ffmpegPath}`);

    fs.rmSync(opts.tempDir, { recursive: true, force: true });
    const packageRoot = path.join(opts.tempDir, COMPANION_DIR);
    const airplayDir = path.join(packageRoot, 'airplay-bridge');
    const ffmpegDir = path.join(packageRoot, 'ffmpeg');

    console.log('[bundle] Extracting and validating the AirPlay bridge...');
    safeExtractZip(opts.bridgeZip, airplayDir);
    const provenance = validateBridgeDir(airplayDir, { requiredPlugins: opts.requiredPlugins, expectedMinMacOS: minMacOS });
    validateFfmpeg(ffmpegPath, minMacOS);

    console.log('[bundle] Copying ffmpeg (unchanged)...');
    fs.mkdirSync(ffmpegDir, { recursive: true });
    for (const fileName of FFMPEG_FILES) {
      const source = path.join(opts.ffmpegDir, fileName);
      if (!fs.existsSync(source)) continue;
      fs.copyFileSync(source, path.join(ffmpegDir, fileName));
      fs.chmodSync(path.join(ffmpegDir, fileName), fileName === 'ffmpeg' ? 0o755 : 0o644);
    }
    const ffmpeg = describeFfmpeg(path.join(ffmpegDir, 'ffmpeg'));

    fs.writeFileSync(path.join(packageRoot, 'README.txt'), `Echo iOS Dependencies (macOS)

Supported: Apple silicon (thin ${MACOS_CONTRACT.arch}), macOS ${minMacOS} or newer.
Build kind: ${provenance.buildKind}
Intel and universal Macs are not supported by this bundle.

Contents:
- airplay-bridge/echo-airplay (self-contained: bundled libraries in airplay-bridge/lib,
  GStreamer plugins in airplay-bridge/lib/gstreamer-1.0, scanner in airplay-bridge/libexec)
- airplay-bridge/THIRD_PARTY_NOTICES.md, airplay-bridge/licenses/, airplay-bridge/provenance.json
- ffmpeg/ffmpeg
- manifest.json (file hashes, components, source commits, release gaps)

Install these as a separately distributed companion runtime. Homebrew is not required.
`, { mode: 0o644 });

    const components = [
      ...provenance.components.map((component) => ({
        ...component,
        licenseFiles: component.licenseFiles.map((rel) => `airplay-bridge/${rel}`),
      })),
      ffmpeg.component,
    ];
    const manifest = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      platform: 'darwin',
      arch: MACOS_CONTRACT.arch,
      minimumMacOS: minMacOS,
      buildKind: provenance.buildKind,
      uxplay: provenance.uxplay,
      companion: opts.companion || gitState(),
      airplayBridge: { archiveSha256: sha256File(opts.bridgeZip), provenance: 'airplay-bridge/provenance.json' },
      ffmpeg: { sha256: ffmpeg.sha256, configureOptionsFlagged: ffmpeg.configureOptionsFlagged },
      contents: {
        airplay: fs.readdirSync(airplayDir).sort(),
        ffmpeg: fs.readdirSync(ffmpegDir).sort(),
      },
      components,
      files: hashTree(packageRoot),
      releaseGaps: [...provenance.releaseGaps, ...ffmpeg.gaps],
    };
    fs.writeFileSync(path.join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

    console.log('[bundle] Creating and validating the downloadable zip...');
    const zip = writeZipAtomically(opts.tempDir, opts.outputZip);
    const validation = validateZip(zip.partial, {
      runtime: opts.runtime !== false,
      gstProbe: opts.gstProbe !== false,
      requiredPlugins: opts.requiredPlugins,
      expectedMinMacOS: minMacOS,
    });
    zip.commit();

    const summary = {
      artifact: path.basename(opts.outputZip),
      sha256: sha256File(opts.outputZip),
      size: fs.statSync(opts.outputZip).size,
      platform: manifest.platform,
      arch: manifest.arch,
      minimumMacOS: manifest.minimumMacOS,
      buildKind: manifest.buildKind,
      uxplay: manifest.uxplay,
      companion: manifest.companion,
      airplayBridge: manifest.airplayBridge,
      ffmpeg: manifest.ffmpeg,
      components: manifest.components,
      files: manifest.files,
      releaseGaps: manifest.releaseGaps,
      runtimeValidation: validation.runtime || null,
    };
    fs.writeFileSync(`${sidecar}.partial`, `${JSON.stringify(summary, null, 2)}\n`);
    fs.renameSync(`${sidecar}.partial`, sidecar);
    return { outputZip: opts.outputZip, sidecar, summary };
  } catch (error) {
    fs.rmSync(`${opts.outputZip}.partial`, { force: true });
    fs.rmSync(`${sidecar}.partial`, { force: true });
    throw error;
  }
}

function main() {
  console.log('==========================================');
  console.log('Echo iOS Dependencies macOS Bundle');
  console.log('==========================================\n');
  const { outputZip, sidecar, summary } = bundleMacosCompanion({ minMacOS: process.env[MIN_MACOS_ENV] });
  console.log(`\n[bundle] Created ${outputZip} (${(summary.size / (1024 * 1024)).toFixed(2)} MB)`);
  console.log(`[bundle] sha256 ${summary.sha256}`);
  console.log(`[bundle] arch=${summary.arch} minimumMacOS=${summary.minimumMacOS} buildKind=${summary.buildKind}`);
  console.log(`[bundle] manifest ${sidecar}`);
  for (const gap of summary.releaseGaps) console.log(`[bundle] release gap: ${gap}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\nERROR: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { DEFAULTS, bundleMacosCompanion };
