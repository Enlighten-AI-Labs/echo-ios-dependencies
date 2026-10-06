#!/usr/bin/env node

/**
 * Packages the pinned UxPlay build into a relocatable airplay-bridge.zip:
 * recursive dylib/plugin/scanner closure, @rpath rewrite, ad-hoc signing,
 * license notices and a provenance inventory. Homebrew is a build input only.
 */

const fs = require('fs');
const path = require('path');
const {
  BRIDGE_LAYOUT,
  MACOS_CONTRACT,
  MIN_MACOS_ENV,
  REQUIRED_PLUGINS,
  UXPLAY_PIN,
  buildKindFor,
  collectClosure,
  hashTree,
  kegForPath,
  materializeClosure,
  requireMinMacOS,
  run,
  sha256File,
  writeZipAtomically,
} = require('./macos-gstreamer-runtime');
const { validateBridgeDir } = require('./validate-macos-package');

const uxplayRoot = path.join(__dirname, '..');
const repoRoot = path.join(uxplayRoot, '..');
const tempRoot = path.join(uxplayRoot, 'resources', 'temp');

const DEFAULTS = {
  buildInfoPath: path.join(tempRoot, 'uxplay-build', 'build-info.json'),
  outputZip: path.join(tempRoot, 'airplay-bridge.zip'),
  stagingDir: path.join(tempRoot, 'airplay-bridge.staging'),
  // A new bridge makes any previously bundled companion stale.
  downstreamArtifacts: [
    path.join(repoRoot, 'dist', 'echo-ios-dependencies-macos.zip'),
    path.join(repoRoot, 'dist', 'echo-ios-dependencies-macos.manifest.json'),
  ],
};

// Notices for code vendored inside the UxPlay source tree (statically compiled in).
const UXPLAY_SOURCE_NOTICES = [
  { name: 'UxPlay', license: UXPLAY_PIN.license, file: 'LICENSE' },
  { name: 'llhttp (vendored in UxPlay)', license: 'MIT', file: 'lib/llhttp/LICENSE-MIT' },
  { name: 'playfair (vendored in UxPlay)', license: 'GPL-3.0', file: 'lib/playfair/LICENSE.md' },
];

// Kept for layout compatibility only: echo-airplay finds its libraries/plugins without any environment.
const WRAPPER_SCRIPT = `#!/bin/sh
exec "$(dirname "$0")/echo-airplay" "$@"
`;

const SOURCE_OFFER_GAP = 'GPL/LGPL corresponding-source obligations are only recorded as upstream source URL + sha256; '
  + 'Homebrew build patches/options and a written source offer have not been legally reviewed';

function gstreamerInputs() {
  const pluginsDir = run('pkg-config', ['--variable=pluginsdir', 'gstreamer-1.0']).trim();
  const scannerDir = run('pkg-config', ['--variable=pluginscannerdir', 'gstreamer-1.0']).trim();
  return { pluginSourceDir: pluginsDir, scannerSource: path.join(scannerDir, 'gst-plugin-scanner') };
}

function gitState(dir) {
  try {
    return {
      commit: run('git', ['-C', dir, 'rev-parse', 'HEAD']).trim(),
      dirty: run('git', ['-C', dir, 'status', '--porcelain']).trim().length > 0,
    };
  } catch (_error) {
    return { commit: null, dirty: null };
  }
}

function readBuildInfo(buildInfoPath, minMacOS) {
  if (!fs.existsSync(buildInfoPath)) {
    throw new Error(`Build info not found at ${buildInfoPath}; run npm run build:macos:uxplay first`);
  }
  const info = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
  const baseDir = path.dirname(buildInfoPath);
  const binaryPath = path.resolve(baseDir, info.binary);
  const sourceDir = path.resolve(baseDir, info.sourceDir);
  if (info.uxplay.commit !== UXPLAY_PIN.commit || info.uxplay.archiveSha256 !== UXPLAY_PIN.archiveSha256) {
    throw new Error(`Build used UxPlay ${info.uxplay.commit}, expected pinned ${UXPLAY_PIN.commit}`);
  }
  if (info.arch !== MACOS_CONTRACT.arch) throw new Error(`Build arch ${info.arch} does not match contract ${MACOS_CONTRACT.arch}`);
  if (info.minimumMacOS !== minMacOS) {
    throw new Error(`Build targeted macOS ${info.minimumMacOS} but packaging requested ${minMacOS}`);
  }
  if (!fs.existsSync(binaryPath) || sha256File(binaryPath) !== info.binarySha256) {
    throw new Error(`UxPlay binary at ${binaryPath} is missing or does not match the recorded build`);
  }
  return { ...info, binaryPath, sourceDir };
}

function copyLicense(sourcePath, bridgeDir, rel) {
  const target = path.join(bridgeDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(sourcePath, target);
  fs.chmodSync(target, 0o644);
  return rel;
}

/** One component per Homebrew keg (dynamic or static) plus the UxPlay source notices. */
function collectComponents(entries, build, bridgeDir) {
  const components = [];
  const origins = {};

  for (const notice of UXPLAY_SOURCE_NOTICES) {
    const sourcePath = path.join(build.sourceDir, notice.file);
    if (!fs.existsSync(sourcePath)) throw new Error(`Missing ${notice.name} license notice at ${notice.file}`);
    const slug = notice.name.split(' ')[0].toLowerCase();
    components.push({
      name: notice.name,
      version: UXPLAY_PIN.version,
      license: notice.license,
      linkage: 'static',
      sourceUrl: UXPLAY_PIN.archiveUrl,
      sourceSha256: UXPLAY_PIN.archiveSha256,
      sourceRevision: UXPLAY_PIN.commit,
      licenseFiles: [copyLicense(sourcePath, bridgeDir, `${BRIDGE_LAYOUT.licensesDir}/${slug}/${path.basename(notice.file)}`)],
    });
  }

  const kegs = new Map();
  const addKeg = (realPath, linkage, dest) => {
    const keg = kegForPath(realPath);
    const key = `${keg.formula}@${keg.version}`;
    if (!kegs.has(key)) kegs.set(key, { keg, linkage: new Set(), files: [] });
    const record = kegs.get(key);
    record.linkage.add(linkage);
    record.files.push(dest || path.relative(keg.kegDir, realPath));
    if (dest) origins[dest] = `${key}:${path.relative(keg.kegDir, realPath)}`;
  };

  for (const entry of entries) {
    if (entry.dest === BRIDGE_LAYOUT.executable) {
      origins[entry.dest] = `uxplay@${UXPLAY_PIN.commit}:${build.binary}`;
      continue;
    }
    addKeg(entry.real, 'dynamic', entry.dest);
  }
  for (const staticLib of build.staticLibraries || []) addKeg(fs.realpathSync(staticLib), 'static', null);

  for (const [key, { keg, linkage, files }] of [...kegs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (keg.licenseFiles.length === 0) throw new Error(`No license text found in keg ${key}`);
    components.push({
      name: keg.formula,
      version: keg.version,
      upstreamVersion: keg.upstreamVersion,
      license: keg.license,
      linkage: [...linkage].sort().join('+'),
      sourceUrl: keg.sourceUrl,
      sourceSha256: keg.sourceSha256,
      homebrewTap: keg.tap,
      pouredFromBottle: keg.pouredFromBottle,
      bundledFiles: files.sort(),
      licenseFiles: keg.licenseFiles.map((file) => copyLicense(
        path.join(keg.kegDir, file), bridgeDir, `${BRIDGE_LAYOUT.licensesDir}/${keg.formula}/${file}`,
      )),
    });
  }
  return { components, origins };
}

function writeNotices(bridgeDir, components) {
  const lines = [
    '# Third-party notices',
    '',
    'The AirPlay bridge bundles the components below. License texts are in `licenses/`;',
    'source locations and checksums are recorded here and in `provenance.json`.',
    '',
  ];
  for (const component of components) {
    lines.push(`## ${component.name} ${component.version}`, '');
    lines.push(`- License: ${component.license}`);
    lines.push(`- Linkage: ${component.linkage}`);
    lines.push(`- Source: ${component.sourceUrl || 'unknown'}${component.sourceSha256 ? ` (sha256 ${component.sourceSha256})` : ''}`);
    if (component.sourceRevision) lines.push(`- Revision: ${component.sourceRevision}`);
    lines.push(`- License files: ${component.licenseFiles.join(', ')}`, '');
  }
  fs.writeFileSync(path.join(bridgeDir, BRIDGE_LAYOUT.notices), `${lines.join('\n')}\n`, { mode: 0o644 });
}

function releaseGapsFor(minMacOS, components) {
  const gaps = [];
  if (buildKindFor(minMacOS) !== 'release-candidate') {
    gaps.push(`Development build: macOS ${minMacOS} is not an approved production minimum (production OS contract unresolved)`);
  }
  gaps.push(SOURCE_OFFER_GAP);
  for (const component of components) {
    if (component.license === 'NOASSERTION') gaps.push(`${component.name} ${component.version}: license not asserted by its SBOM`);
    if (!component.sourceUrl || !component.sourceSha256) gaps.push(`${component.name} ${component.version}: no source receipt`);
  }
  return gaps;
}

function packageBridge(options = {}) {
  const outputZip = options.outputZip || DEFAULTS.outputZip;
  const stagingDir = options.stagingDir || DEFAULTS.stagingDir;
  // Remove previous outputs first so a failed run can never leave a stale "complete" artifact.
  for (const artifact of options.downstreamArtifacts || DEFAULTS.downstreamArtifacts) fs.rmSync(artifact, { force: true });
  fs.rmSync(outputZip, { force: true });
  fs.rmSync(`${outputZip}.partial`, { force: true });
  fs.rmSync(stagingDir, { recursive: true, force: true });
  let published = false;

  try {
    const minMacOS = requireMinMacOS(options.minMacOS);
    const requiredPlugins = options.requiredPlugins || REQUIRED_PLUGINS;
    const build = readBuildInfo(options.buildInfoPath || DEFAULTS.buildInfoPath, minMacOS);
    const { pluginSourceDir, scannerSource } = options.pluginSourceDir
      ? options
      : gstreamerInputs();

    const roots = [
      { source: build.binaryPath, dest: BRIDGE_LAYOUT.executable, executable: true },
      { source: scannerSource, dest: BRIDGE_LAYOUT.scanner, executable: true },
    ];
    for (const plugin of requiredPlugins) {
      const source = path.join(pluginSourceDir, plugin);
      if (!fs.existsSync(source)) throw new Error(`Required GStreamer plugin ${plugin} not found in ${pluginSourceDir}`);
      roots.push({ source, dest: `${BRIDGE_LAYOUT.pluginDir}/${plugin}`, executable: false });
    }

    const bridgeDir = path.join(stagingDir, 'airplay-bridge');
    fs.mkdirSync(bridgeDir, { recursive: true });
    const entries = collectClosure(roots, { minMacOS });
    materializeClosure(entries, bridgeDir);
    fs.writeFileSync(path.join(bridgeDir, 'echo-airplay-wrapper.sh'), WRAPPER_SCRIPT, { mode: 0o755 });

    const { components, origins } = collectComponents(entries, build, bridgeDir);
    writeNotices(bridgeDir, components);

    const hashes = hashTree(bridgeDir);
    const provenance = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      arch: MACOS_CONTRACT.arch,
      minimumMacOS: minMacOS,
      buildKind: buildKindFor(minMacOS),
      uxplay: {
        version: UXPLAY_PIN.version,
        commit: UXPLAY_PIN.commit,
        archiveUrl: UXPLAY_PIN.archiveUrl,
        archiveSha256: UXPLAY_PIN.archiveSha256,
        builtBinarySha256: build.binarySha256,
      },
      companion: options.companion || gitState(repoRoot),
      toolchain: build.toolchain || null,
      layout: BRIDGE_LAYOUT,
      components,
      files: Object.fromEntries(Object.entries(hashes).map(([rel, sha256]) => [rel, { sha256, origin: origins[rel] || 'generated' }])),
      releaseGaps: releaseGapsFor(minMacOS, components),
    };
    fs.writeFileSync(path.join(bridgeDir, BRIDGE_LAYOUT.provenance), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o644 });

    validateBridgeDir(bridgeDir, { requiredPlugins, expectedMinMacOS: minMacOS });

    const zip = writeZipAtomically(bridgeDir, outputZip);
    const sha256 = sha256File(zip.partial);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    if (options.beforeCommit) options.beforeCommit(zip.partial);
    // Renaming the zip into place is the last step; nothing after it can fail the run.
    zip.commit();
    published = true;
    return { outputZip, sha256, provenance, fileCount: Object.keys(hashes).length + 1 };
  } finally {
    if (!published) {
      fs.rmSync(outputZip, { force: true });
      fs.rmSync(`${outputZip}.partial`, { force: true });
    }
  }
}

function main() {
  console.log('==========================================');
  console.log('UxPlay macOS Packaging (relocatable bridge)');
  console.log('==========================================\n');
  const result = packageBridge({ minMacOS: process.env[MIN_MACOS_ENV] });
  const { provenance } = result;
  console.log(`[package] ${result.outputZip}`);
  console.log(`[package] sha256 ${result.sha256}`);
  console.log(`[package] ${result.fileCount} files, ${provenance.components.length} components`);
  console.log(`[package] arch=${provenance.arch} minimumMacOS=${provenance.minimumMacOS} buildKind=${provenance.buildKind}`);
  for (const gap of provenance.releaseGaps) console.log(`[package] release gap: ${gap}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\nERROR: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { DEFAULTS, packageBridge };
