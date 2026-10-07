#!/usr/bin/env node

// Validates the relocatable macOS AirPlay bridge and the downloadable companion bundle.
// Static checks need only Xcode command line tools; --runtime also launches the bundled
// binary with `-h` (exits during argument parsing, before GStreamer or network setup) and an
// offline GStreamer probe from a relocated copy with a scrubbed environment.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  BRIDGE_LAYOUT,
  MACOS_CONTRACT,
  PROBE_PIPELINES,
  REQUIRED_FACTORIES,
  REQUIRED_PLUGINS,
  UXPLAY_PIN,
  buildKindFor,
  candidatePaths,
  contractErrors,
  inspectMachO,
  isSystemPath,
  listFiles,
  machOHeader,
  machOKind,
  requireMinMacOS,
  run,
  safeExtractZip,
  sha256File,
} = require('./macos-gstreamer-runtime');

const COMPANION_DIR = 'echo-ios-dependencies-macos';
const FFMPEG_COMPONENT = 'ffmpeg (prebuilt)';
const BRIDGE_EXECUTABLES = [BRIDGE_LAYOUT.executable, BRIDGE_LAYOUT.scanner, 'echo-airplay-wrapper.sh'];
const PROBE_SOURCE = path.join(__dirname, 'macos-gst-probe.c');

class ValidationError extends Error {
  constructor(subject, errors) {
    super(`${subject} failed validation:\n- ${errors.join('\n- ')}`);
    this.errors = errors;
  }
}

function insideDir(candidate, dir) {
  const resolved = path.resolve(candidate);
  const root = path.resolve(dir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Required images must be regular thin Mach-O files of the expected type, checked before the
 * architecture/minimum-OS/signature checks (which only see files that already look like Mach-O).
 */
function requiredImageErrors(rootDir, expectations) {
  const errors = [];
  for (const [rel, types] of expectations) {
    const filePath = path.join(rootDir, rel);
    if (!fs.existsSync(filePath)) continue;
    if (!fs.lstatSync(filePath).isFile()) {
      errors.push(`${rel} is not a regular file`);
      continue;
    }
    const { kind, filetype } = machOHeader(filePath);
    if (!kind) errors.push(`${rel} is not a Mach-O image`);
    else if (kind === 'thin' && !types.includes(filetype)) errors.push(`${rel} is a Mach-O ${filetype}, expected ${types.join(' or ')}`);
  }
  return errors;
}

/** Hashes cover bytes only, so launchable files also need their execute bits (u, g and o). */
function executableModeErrors(rootDir, rels) {
  const errors = [];
  for (const rel of rels) {
    const filePath = path.join(rootDir, rel);
    if (!fs.existsSync(filePath)) continue;
    const mode = fs.statSync(filePath).mode & 0o777;
    if ((mode & 0o111) !== 0o111) errors.push(`${rel} is not executable (mode ${mode.toString(8).padStart(4, '0')})`);
  }
  return errors;
}

/** Compares a recorded {relPath: sha256} map with the files actually present. */
function inventoryErrors(rootDir, recorded, exclude) {
  const errors = [];
  let actual;
  try {
    actual = listFiles(rootDir).filter((rel) => !exclude.includes(rel));
  } catch (error) {
    return [error.message];
  }
  for (const rel of actual) {
    if (!recorded[rel]) errors.push(`${rel} is not listed in the inventory`);
    else if (recorded[rel] !== sha256File(path.join(rootDir, rel))) errors.push(`${rel} does not match its recorded sha256`);
  }
  for (const rel of Object.keys(recorded)) {
    if (!actual.includes(rel)) errors.push(`${rel} is listed in the inventory but missing`);
  }
  return errors;
}

/** Load-command errors for a bundled Mach-O: everything must resolve inside the bundle or to the OS. */
function loadCommandErrors(bridgeDir, rel, info) {
  const errors = [];
  const filePath = path.join(bridgeDir, rel);
  if (info.id && !info.id.startsWith('@rpath/')) errors.push(`${rel}: install name ${info.id} is not @rpath-relative`);
  for (const rpath of info.rpaths) {
    const expanded = rpath.startsWith('@loader_path') ? path.join(path.dirname(filePath), rpath.slice('@loader_path'.length)) : null;
    if (!expanded || !insideDir(expanded, bridgeDir)) errors.push(`${rel}: rpath ${rpath} points outside the bundle`);
  }
  for (const dep of info.deps) {
    if (isSystemPath(dep.name)) continue;
    if (!dep.name.startsWith('@rpath/')) {
      errors.push(`${rel}: dependency ${dep.name} is not bundled`);
      continue;
    }
    const inBundleRpaths = info.rpaths.filter((rpath) => rpath.startsWith('@loader_path'));
    const found = candidatePaths(dep.name, { loaderPath: filePath, executableDir: null, rpaths: inBundleRpaths })
      .find((candidate) => insideDir(candidate, bridgeDir) && fs.existsSync(candidate));
    if (!found) errors.push(`${rel}: dependency ${dep.name} does not resolve inside the bundle`);
    else if (machOHeader(found).filetype !== 'dylib') errors.push(`${rel}: dependency ${dep.name} resolves to a file that is not a Mach-O dylib`);
  }
  return errors;
}

/** Static validation of an extracted airplay-bridge directory. Returns its provenance. */
function validateBridgeDir(bridgeDir, { requiredPlugins = REQUIRED_PLUGINS, expectedMinMacOS = null } = {}) {
  const errors = [];
  const at = (rel) => path.join(bridgeDir, rel);

  if (!fs.existsSync(at(BRIDGE_LAYOUT.libDir)) || !fs.statSync(at(BRIDGE_LAYOUT.libDir)).isDirectory()) {
    errors.push('Missing bundled lib/ directory (binary-only or stale archive)');
  }
  for (const rel of [BRIDGE_LAYOUT.executable, BRIDGE_LAYOUT.scanner, BRIDGE_LAYOUT.notices]) {
    if (!fs.existsSync(at(rel))) errors.push(`Missing required file ${rel}`);
  }
  for (const plugin of requiredPlugins) {
    if (!fs.existsSync(at(`${BRIDGE_LAYOUT.pluginDir}/${plugin}`))) errors.push(`Missing required plugin ${plugin}`);
  }
  errors.push(...executableModeErrors(bridgeDir, BRIDGE_EXECUTABLES));
  errors.push(...requiredImageErrors(bridgeDir, [
    [BRIDGE_LAYOUT.executable, ['execute']],
    [BRIDGE_LAYOUT.scanner, ['execute']],
    ...requiredPlugins.map((plugin) => [`${BRIDGE_LAYOUT.pluginDir}/${plugin}`, ['dylib', 'bundle']]),
  ]));
  if (!fs.existsSync(at(BRIDGE_LAYOUT.provenance))) {
    errors.push('Missing provenance.json (stale or binary-only archive)');
    throw new ValidationError(`Bridge ${bridgeDir}`, errors);
  }

  const provenance = readJson(at(BRIDGE_LAYOUT.provenance));
  let minMacOS = null;
  try {
    minMacOS = requireMinMacOS(provenance.minimumMacOS, 'provenance.minimumMacOS');
  } catch (error) {
    errors.push(error.message);
  }
  if (expectedMinMacOS && provenance.minimumMacOS !== expectedMinMacOS) {
    errors.push(`Bridge targets macOS ${provenance.minimumMacOS}, expected ${expectedMinMacOS}`);
  }
  if (provenance.arch !== MACOS_CONTRACT.arch) errors.push(`Bridge declares arch ${provenance.arch}, contract is ${MACOS_CONTRACT.arch}`);
  const uxplay = provenance.uxplay || {};
  if (uxplay.commit !== UXPLAY_PIN.commit || uxplay.archiveSha256 !== UXPLAY_PIN.archiveSha256) {
    errors.push(`UxPlay source ${uxplay.commit || 'unknown'} does not match pinned ${UXPLAY_PIN.version} (${UXPLAY_PIN.commit})`);
  }
  if (minMacOS && provenance.buildKind !== buildKindFor(minMacOS)) {
    errors.push(`buildKind ${provenance.buildKind} is not valid for target macOS ${minMacOS}`);
  }
  const gaps = provenance.releaseGaps || [];
  if (provenance.buildKind === 'release-candidate' && gaps.length > 0) {
    errors.push(`Release candidate has unresolved release gaps: ${gaps.join('; ')}`);
  }

  const recorded = Object.fromEntries(Object.entries(provenance.files || {}).map(([rel, entry]) => [rel, entry.sha256]));
  errors.push(...inventoryErrors(bridgeDir, recorded, [BRIDGE_LAYOUT.provenance]));

  for (const component of provenance.components || []) {
    const files = component.licenseFiles || [];
    if (files.length === 0) errors.push(`Component ${component.name} has no license notice`);
    for (const rel of files) {
      if (!fs.existsSync(at(rel))) errors.push(`Component ${component.name} license file ${rel} is missing`);
    }
  }

  let files = [];
  try {
    files = listFiles(bridgeDir);
  } catch (error) {
    errors.push(error.message);
  }
  for (const rel of files) {
    if (!machOKind(at(rel))) continue;
    const info = inspectMachO(at(rel));
    errors.push(...contractErrors(rel, info, minMacOS || '0.0'));
    if (info.kind !== 'thin') continue;
    errors.push(...loadCommandErrors(bridgeDir, rel, info));
    const verify = spawnSync('codesign', ['--verify', '--strict', at(rel)], { encoding: 'utf8' });
    if (verify.status !== 0) errors.push(`${rel}: code signature invalid (${verify.stderr.trim()})`);
  }

  if (errors.length > 0) throw new ValidationError(`Bridge ${bridgeDir}`, errors);
  return provenance;
}

/** ffmpeg is shipped unchanged; it must still satisfy the same architecture/OS contract. */
function validateFfmpeg(ffmpegPath, minMacOS) {
  if (!fs.existsSync(ffmpegPath)) throw new ValidationError('ffmpeg', [`ffmpeg binary not found at ${ffmpegPath}`]);
  const header = machOHeader(ffmpegPath);
  if (!header.kind || (header.kind === 'thin' && header.filetype !== 'execute')) {
    throw new ValidationError('ffmpeg', [`${ffmpegPath} is not a Mach-O executable`]);
  }
  const info = inspectMachO(ffmpegPath);
  const errors = contractErrors('ffmpeg', info, minMacOS);
  errors.push(...executableModeErrors(path.dirname(ffmpegPath), ['ffmpeg']).map((error) => `ffmpeg: ${error}`));
  // Static check only; ffmpeg is never executed. arm64 macOS kills unsigned or tampered code at launch.
  const verify = spawnSync('codesign', ['--verify', '--strict', ffmpegPath], { encoding: 'utf8' });
  if (verify.status !== 0) errors.push(`ffmpeg: code signature invalid (${verify.stderr.trim()})`);
  for (const dep of info.deps) {
    if (!isSystemPath(dep.name)) errors.push(`ffmpeg: dependency ${dep.name} is not a system library`);
  }
  if (errors.length > 0) throw new ValidationError('ffmpeg', errors);
  return info;
}

/** Static validation of an extracted echo-ios-dependencies-macos directory. */
function validateCompanionDir(packageRoot, { requiredPlugins, expectedMinMacOS = null } = {}) {
  const manifestPath = path.join(packageRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new ValidationError('Companion bundle', ['Missing manifest.json']);
  const manifest = readJson(manifestPath);
  const errors = [];
  const bridgeDir = path.join(packageRoot, 'airplay-bridge');
  let provenance = null;
  try {
    provenance = validateBridgeDir(bridgeDir, { requiredPlugins, expectedMinMacOS });
  } catch (error) {
    errors.push(...(error.errors || [error.message]));
  }
  try {
    validateFfmpeg(path.join(packageRoot, 'ffmpeg', 'ffmpeg'), requireMinMacOS(manifest.minimumMacOS, 'manifest.minimumMacOS'));
  } catch (error) {
    errors.push(...(error.errors || [error.message]));
  }
  if (manifest.platform !== 'darwin' || manifest.arch !== MACOS_CONTRACT.arch) {
    errors.push(`Manifest platform/arch ${manifest.platform}/${manifest.arch} does not match darwin/${MACOS_CONTRACT.arch}`);
  }
  if (provenance && manifest.minimumMacOS !== provenance.minimumMacOS) {
    errors.push(`Manifest minimumMacOS ${manifest.minimumMacOS} differs from bridge ${provenance.minimumMacOS}`);
  }
  if (provenance && manifest.buildKind !== provenance.buildKind) {
    errors.push(`Manifest buildKind ${manifest.buildKind} differs from bridge ${provenance.buildKind}`);
  }
  if (manifest.buildKind === 'release-candidate' && (manifest.releaseGaps || []).length > 0) {
    errors.push(`Release candidate has unresolved release gaps: ${manifest.releaseGaps.join('; ')}`);
  }
  if (provenance) errors.push(...manifestProvenanceErrors(manifest, provenance));
  errors.push(...componentNoticeErrors(packageRoot, manifest));
  const ffmpegPath = path.join(packageRoot, 'ffmpeg', 'ffmpeg');
  if (fs.existsSync(ffmpegPath) && (manifest.ffmpeg || {}).sha256 !== sha256File(ffmpegPath)) {
    errors.push('Manifest ffmpeg sha256 does not match the bundled ffmpeg');
  }
  errors.push(...inventoryErrors(packageRoot, manifest.files || {}, ['manifest.json']));
  if (errors.length > 0) throw new ValidationError(`Companion bundle ${packageRoot}`, errors);
  return manifest;
}

/** Every manifest component (bridge components and ffmpeg) must point at notices that exist. */
function componentNoticeErrors(packageRoot, manifest) {
  const errors = [];
  const components = manifest.components || [];
  if (!components.some((component) => component.name === FFMPEG_COMPONENT)) {
    errors.push(`Manifest has no ${FFMPEG_COMPONENT} component`);
  }
  for (const component of components) {
    const files = component.licenseFiles || [];
    if (files.length === 0) errors.push(`Component ${component.name} has no license notice`);
    for (const rel of files) {
      const filePath = path.join(packageRoot, rel);
      if (!insideDir(filePath, packageRoot) || !fs.existsSync(filePath)) {
        errors.push(`Component ${component.name} license file ${rel} is missing`);
      }
    }
  }
  return errors;
}

/** The final manifest must restate the bridge provenance, not drop or alter it. */
function manifestProvenanceErrors(manifest, provenance) {
  const errors = [];
  if (JSON.stringify(manifest.uxplay) !== JSON.stringify(provenance.uxplay)) {
    errors.push('Manifest uxplay source differs from bridge provenance');
  }
  const listed = new Map((manifest.components || []).map((component) => [`${component.name}@${component.version}`, component]));
  for (const component of provenance.components || []) {
    const expected = { ...component, licenseFiles: component.licenseFiles.map((rel) => `airplay-bridge/${rel}`) };
    const actual = listed.get(`${component.name}@${component.version}`);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(`Manifest component ${component.name} ${component.version} differs from bridge provenance`);
    }
  }
  for (const gap of provenance.releaseGaps || []) {
    if (!(manifest.releaseGaps || []).includes(gap)) errors.push(`Manifest drops bridge release gap: ${gap}`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Runtime checks (bounded, offline)

function scrubbedEnv(workRoot) {
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: path.join(workRoot, 'home'),
    TMPDIR: path.join(workRoot, 'tmp'),
    XDG_CACHE_HOME: path.join(workRoot, 'home', '.cache'),
    XDG_CONFIG_HOME: path.join(workRoot, 'home', '.config'),
    XDG_DATA_HOME: path.join(workRoot, 'home', '.local', 'share'),
    LANG: 'C',
    DYLD_PRINT_LIBRARIES: '1',
  };
  for (const dir of [env.HOME, env.TMPDIR, env.XDG_CACHE_HOME]) fs.mkdirSync(dir, { recursive: true });
  return env;
}

/** Every image dyld reports must come from the OS or from inside the relocated bundle. */
function loadedImageErrors(output, bundleDirs) {
  const errors = [];
  const images = [];
  for (const line of output.split('\n')) {
    // e.g. "dyld[123]: <UUID> /path/to/image" (the UUID is omitted on some macOS versions)
    const match = line.match(/^dyld\[\d+\]: (?:<[0-9A-Fa-f-]+> )?(\/.+)$/);
    if (!match) continue;
    images.push(match[1]);
    if (!isSystemPath(match[1]) && !bundleDirs.some((dir) => insideDir(match[1], dir))) {
      errors.push(`loaded ${match[1]} from outside the bundle`);
    }
  }
  return { errors, images };
}

function spawnChecked(label, command, args, env, timeoutMs) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : `exit ${result.status} signal ${result.signal}`;
    throw new ValidationError(label, [`${reason}\nstdout:\n${(result.stdout || '').slice(0, 1500)}\nstderr:\n${(result.stderr || '').slice(-3000)}`]);
  }
  return result;
}

/**
 * Launches the bridge from a relocated copy (path with spaces) with no Homebrew/GStreamer
 * environment, and optionally probes plugin discovery through the bundled scanner.
 */
function runRuntimeChecks(bridgeDir, { minMacOS, gstProbe = true, timeoutMs = 60000 } = {}) {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-bridge-runtime-'));
  try {
    const relocated = path.join(workRoot, 'Relocated Bridge', 'airplay-bridge');
    fs.cpSync(bridgeDir, relocated, { recursive: true });
    const bundleDirs = [relocated, fs.realpathSync(relocated)];
    const env = scrubbedEnv(workRoot);
    const report = {};

    const help = spawnChecked('echo-airplay -h', path.join(relocated, BRIDGE_LAYOUT.executable), ['-h'], env, timeoutMs);
    const helpImages = loadedImageErrors(help.stderr, bundleDirs);
    if (!helpImages.images.some((image) => bundleDirs.some((dir) => insideDir(image, path.join(dir, BRIDGE_LAYOUT.libDir))))) {
      helpImages.errors.push('no bundled library was reported by dyld; cannot prove relocation');
    }
    if (helpImages.errors.length > 0) throw new ValidationError('echo-airplay -h', helpImages.errors);
    report.helpImages = helpImages.images.length;

    if (gstProbe) report.probe = runGstProbe(relocated, bundleDirs, env, workRoot, minMacOS, timeoutMs);
    return report;
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

function runGstProbe(relocated, bundleDirs, env, workRoot, minMacOS, timeoutMs) {
  const libDir = path.join(relocated, BRIDGE_LAYOUT.libDir);
  const probe = path.join(workRoot, 'macos-gst-probe');
  // Build-time headers only; the probe links against the relocated bundle's libraries.
  const cflags = run('pkg-config', ['--cflags', 'gstreamer-1.0']).trim().split(/\s+/).filter(Boolean);
  run('clang', [
    '-arch', MACOS_CONTRACT.arch, `-mmacosx-version-min=${minMacOS}`, ...cflags, PROBE_SOURCE, '-o', probe,
    path.join(libDir, 'libgstreamer-1.0.0.dylib'), path.join(libDir, 'libgobject-2.0.0.dylib'),
    path.join(libDir, 'libglib-2.0.0.dylib'), `-Wl,-rpath,${libDir}`,
  ]);

  const probeEnv = { ...env, GST_DEBUG: 'GST_PLUGIN_LOADING:5', GST_DEBUG_NO_COLOR: '1' };
  const result = spawnChecked('GStreamer probe', probe, [...REQUIRED_FACTORIES, '--', ...PROBE_PIPELINES], probeEnv, timeoutMs);
  const errors = [];
  const pluginDirs = bundleDirs.map((dir) => path.join(dir, BRIDGE_LAYOUT.pluginDir));
  const factories = {};
  for (const line of result.stdout.split('\n')) {
    const factory = line.match(/^FACTORY (\S+) (.+)$/);
    if (factory) {
      factories[factory[1]] = factory[2];
      if (!pluginDirs.some((dir) => insideDir(factory[2], dir))) errors.push(`factory ${factory[1]} came from ${factory[2]}`);
    }
    const plugin = line.match(/^PLUGIN (\S+) (.+)$/);
    if (plugin && plugin[2] !== '(none)' && !pluginDirs.some((dir) => insideDir(plugin[2], dir))) {
      errors.push(`registry contains plugin ${plugin[1]} from ${plugin[2]}`);
    }
  }
  for (const name of REQUIRED_FACTORIES) {
    if (!factories[name]) errors.push(`factory ${name} was not reported`);
  }
  if (/Failed to load plugin/i.test(result.stderr)) {
    errors.push(`plugin load failures:\n${result.stderr.split('\n').filter((l) => /Failed to load plugin/i.test(l)).slice(0, 10).join('\n')}`);
  }
  // The probe executable itself is the only image allowed outside the bundle.
  const images = loadedImageErrors(result.stderr, [...bundleDirs, probe, fs.realpathSync(probe)]);
  errors.push(...images.errors);
  // GStreamer logs e.g. ".../lib/../libexec/gstreamer-1.0/gst-plugin-scanner"; dyld logs the scanner process image.
  const scannerPaths = bundleDirs.map((dir) => path.join(dir, BRIDGE_LAYOUT.scanner));
  const logged = [...result.stderr.matchAll(/using system plugin scanner at (.+?gst-plugin-scanner)/g)].map((match) => path.resolve(match[1]));
  const scannerUsed = logged.some((p) => scannerPaths.includes(p))
    && images.images.some((image) => scannerPaths.includes(path.resolve(image)));
  if (!scannerUsed) errors.push('bundled gst-plugin-scanner was not used to build the registry');
  if (errors.length > 0) throw new ValidationError('GStreamer probe', errors);
  return { factories: Object.keys(factories).length, pipelines: PROBE_PIPELINES.length, scannerUsed };
}

// ---------------------------------------------------------------------------
// Zip entry points

/** Validates a bridge zip (airplay-bridge.zip) or the companion zip, after a bounded safe extraction. */
function validateZip(zipPath, { runtime = false, requiredPlugins, expectedMinMacOS = null, gstProbe = true } = {}) {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-macos-validate-'));
  try {
    safeExtractZip(zipPath, workRoot);
    const companionRoot = path.join(workRoot, COMPANION_DIR);
    let bridgeDir;
    let result;
    if (fs.existsSync(path.join(companionRoot, 'manifest.json'))) {
      result = { kind: 'companion', manifest: validateCompanionDir(companionRoot, { requiredPlugins, expectedMinMacOS }) };
      bridgeDir = path.join(companionRoot, 'airplay-bridge');
    } else {
      result = { kind: 'bridge', provenance: validateBridgeDir(workRoot, { requiredPlugins, expectedMinMacOS }) };
      bridgeDir = workRoot;
    }
    const minMacOS = (result.manifest || result.provenance).minimumMacOS;
    if (runtime) result.runtime = runRuntimeChecks(bridgeDir, { minMacOS, gstProbe });
    return result;
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((arg) => !arg.startsWith('--'));
  if (!target) {
    console.error('Usage: validate-macos-package.js <bridge-or-companion.zip> [--runtime]');
    process.exit(2);
  }
  const result = validateZip(path.resolve(target), { runtime: args.includes('--runtime') });
  const info = result.manifest || result.provenance;
  console.log(`[validate] ${result.kind} OK: ${target}`);
  console.log(`[validate] arch=${info.arch} minimumMacOS=${info.minimumMacOS} buildKind=${info.buildKind}`);
  if (result.runtime) console.log(`[validate] runtime: ${JSON.stringify(result.runtime)}`);
  for (const gap of info.releaseGaps || []) console.log(`[validate] release gap: ${gap}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\nERROR: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  COMPANION_DIR,
  FFMPEG_COMPONENT,
  ValidationError,
  runRuntimeChecks,
  validateBridgeDir,
  validateCompanionDir,
  validateFfmpeg,
  validateZip,
};
