// Shared helpers for the relocatable macOS AirPlay bridge: support contract, Mach-O inspection,
// recursive dependency closure, install-name rewriting and bounded zip handling.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const AdmZip = require('adm-zip');

// Existing upstream release (v0.1.4 shipped 1.73.6); pinned to an immutable commit + archive digest.
const UXPLAY_PIN = {
  version: '1.73.6',
  commit: '21eef8df25d91e12635c36d8176ad192725baca2',
  archiveUrl: 'https://github.com/FDH2/UxPlay/archive/21eef8df25d91e12635c36d8176ad192725baca2.zip',
  archiveSha256: '27ece3e90c6dfecfb288f7de7396b34c8f4bac393e9aee1d452be0d6b1c3ec81',
  license: 'GPL-3.0',
};

const MACOS_CONTRACT = {
  // Thin arm64 only. Intel and universal outputs are rejected until matching
  // binaries (including ffmpeg), toolchain and test hardware exist.
  arch: 'arm64',
  // Production minimum macOS is an open product decision. Until it is set, every build is
  // labelled "development" no matter which target was selected.
  approvedMinimumMacOS: null,
  // Apple silicon cannot run anything older.
  lowestPossibleMacOS: '11.0',
};

const MIN_MACOS_ENV = 'ECHO_MACOS_MIN_VERSION';

// Plugins UxPlay 1.73.6 needs for its default mirror/audio pipelines plus -vrtp/-artp.
// Cover art (-ca), recording (-mp4) and HLS (-hls) plugins are deliberately not bundled.
const REQUIRED_PLUGINS = [
  'coreelements', 'app', 'typefindfunctions', 'playback', 'videoparsersbad', 'rtp', 'udp',
  'applemedia', 'libav', 'videoconvertscale', 'videofilter', 'autodetect', 'osxaudio',
  'osxvideo', 'opengl', 'audioconvert', 'audioresample', 'volume', 'level',
].map((name) => `libgst${name}.dylib`);

const REQUIRED_FACTORIES = [
  'appsrc', 'queue', 'decodebin', 'h264parse', 'h265parse', 'vtdec', 'avdec_h264', 'avdec_aac',
  'avdec_alac', 'videoconvert', 'videoscale', 'videoflip', 'autovideosink', 'autoaudiosink',
  'audioconvert', 'audioresample', 'volume', 'level', 'rtph264pay', 'rtpL16pay', 'udpsink',
];

// Parsed (never set to PLAYING) by the runtime probe, mirroring UxPlay's -vrtp/-artp and audio paths.
const PROBE_PIPELINES = [
  'appsrc ! queue ! h264parse ! rtph264pay config-interval=1 ! udpsink host=127.0.0.1 port=9',
  'appsrc ! queue ! h264parse ! decodebin ! videoconvert ! videoscale ! autovideosink',
  'appsrc ! queue ! avdec_aac ! audioconvert ! audioresample ! volume ! level ! autoaudiosink',
];

const BRIDGE_LAYOUT = {
  executable: 'echo-airplay',
  libDir: 'lib',
  pluginDir: 'lib/gstreamer-1.0',
  scanner: 'libexec/gstreamer-1.0/gst-plugin-scanner',
  provenance: 'provenance.json',
  notices: 'THIRD_PARTY_NOTICES.md',
  licensesDir: 'licenses',
};

function isSystemPath(installName) {
  return installName.startsWith('/usr/lib/') || installName.startsWith('/System/Library/');
}

function parseVersion(value) {
  if (typeof value !== 'string' || !/^\d+(\.\d+){0,2}$/.test(value)) {
    return null;
  }
  const parts = value.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`Cannot compare versions "${a}" and "${b}"`);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Explicit minimum macOS target; never inferred from the build host. */
function requireMinMacOS(value, source = MIN_MACOS_ENV) {
  if (!value) {
    throw new Error(
      `${source} must be set explicitly (for example 26.0). No default is inferred from the build host.`,
    );
  }
  if (!parseVersion(value)) {
    throw new Error(`${source}="${value}" is not a macOS version like 26.0`);
  }
  if (compareVersions(value, MACOS_CONTRACT.lowestPossibleMacOS) < 0) {
    throw new Error(`${source}=${value} is below ${MACOS_CONTRACT.lowestPossibleMacOS}, the arm64 floor`);
  }
  return value;
}

function buildKindFor(minMacOS) {
  return MACOS_CONTRACT.approvedMinimumMacOS && minMacOS === MACOS_CONTRACT.approvedMinimumMacOS
    ? 'release-candidate'
    : 'development';
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

// ---------------------------------------------------------------------------
// Mach-O inspection

/** Returns 'thin', 'fat' or null based on the file magic. */
function machOKind(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(4);
  const read = fs.readSync(fd, header, 0, 4, 0);
  fs.closeSync(fd);
  if (read < 4) return null;
  const be = header.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(be)) return 'thin';
  if (be === 0xcafebabe || be === 0xcafebabf) return 'fat';
  return null;
}

const DYLIB_COMMANDS = new Set([
  'LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LAZY_LOAD_DYLIB', 'LC_LOAD_UPWARD_DYLIB',
]);

/** Parses `otool -l` output for a thin file into id, dependencies, rpaths and minimum OS. */
function parseLoadCommands(text) {
  const result = { id: null, deps: [], rpaths: [], minos: null, platform: null };
  let cmd = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const cmdMatch = line.match(/^cmd (\S+)/);
    if (cmdMatch) {
      cmd = cmdMatch[1];
      continue;
    }
    const nameMatch = line.match(/^name (.+) \(offset \d+\)$/);
    if (nameMatch && cmd === 'LC_ID_DYLIB') result.id = nameMatch[1];
    if (nameMatch && DYLIB_COMMANDS.has(cmd)) {
      result.deps.push({ name: nameMatch[1], weak: cmd === 'LC_LOAD_WEAK_DYLIB' });
    }
    const pathMatch = line.match(/^path (.+) \(offset \d+\)$/);
    if (pathMatch && cmd === 'LC_RPATH') result.rpaths.push(pathMatch[1]);
    if (cmd === 'LC_BUILD_VERSION') {
      const platform = line.match(/^platform (\S+)/);
      // Newer otool prints the numeric PLATFORM_MACOS (1).
      if (platform) result.platform = platform[1] === '1' ? 'MACOS' : platform[1];
      const minos = line.match(/^minos (\S+)/);
      if (minos) result.minos = minos[1];
    }
    if (cmd === 'LC_VERSION_MIN_MACOSX') {
      const version = line.match(/^version (\S+)/);
      if (version) {
        result.minos = version[1];
        result.platform = 'MACOS';
      }
    }
  }
  return result;
}

function inspectMachO(filePath) {
  const kind = machOKind(filePath);
  if (!kind) throw new Error(`${filePath} is not a Mach-O file`);
  const archs = run('lipo', ['-archs', filePath]).trim().split(/\s+/).filter(Boolean);
  // Fat files are reported but never parsed further; the contract rejects them.
  const commands = kind === 'thin' ? parseLoadCommands(run('otool', ['-l', filePath])) : parseLoadCommands('');
  return { kind, archs, ...commands };
}

/** Contract errors for one Mach-O (architecture, slice layout, minimum OS). */
function contractErrors(label, info, minMacOS) {
  const errors = [];
  if (info.kind === 'fat') {
    errors.push(`${label}: universal/fat Mach-O (${info.archs.join(', ')}) is not allowed; contract is thin ${MACOS_CONTRACT.arch}`);
    return errors;
  }
  if (info.archs.length !== 1 || info.archs[0] !== MACOS_CONTRACT.arch) {
    errors.push(`${label}: architecture ${info.archs.join(', ') || 'unknown'} does not match contract ${MACOS_CONTRACT.arch}`);
  }
  if (info.platform && info.platform !== 'MACOS') {
    errors.push(`${label}: built for platform ${info.platform}, expected MACOS`);
  }
  if (!info.minos) {
    errors.push(`${label}: no minimum macOS load command`);
  } else if (compareVersions(info.minos, minMacOS) > 0) {
    errors.push(`${label}: minimum macOS ${info.minos} exceeds selected target ${minMacOS}`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Dependency closure

function expandLoaderTokens(value, loaderDir, executableDir) {
  if (value.startsWith('@loader_path')) return path.join(loaderDir, value.slice('@loader_path'.length));
  if (value.startsWith('@executable_path')) {
    return executableDir ? path.join(executableDir, value.slice('@executable_path'.length)) : null;
  }
  return value;
}

/** Candidate on-disk paths dyld would try for an install name. */
function candidatePaths(installName, { loaderPath, executableDir, rpaths }) {
  const loaderDir = path.dirname(loaderPath);
  if (installName.startsWith('@rpath/')) {
    const rest = installName.slice('@rpath/'.length);
    return rpaths
      .map((rpath) => expandLoaderTokens(rpath, loaderDir, executableDir))
      .filter(Boolean)
      .map((dir) => path.join(dir, rest));
  }
  const expanded = expandLoaderTokens(installName, loaderDir, executableDir);
  return expanded ? [expanded] : [];
}

/**
 * Walks every non-system dependency of the roots (executables, plugins, scanner),
 * keyed by realpath so Cellar/opt aliases and cycles collapse to one bundled copy.
 * roots: [{ source, dest, executable }] with dest relative to the bundle root.
 */
function collectClosure(roots, { inspect = inspectMachO, minMacOS } = {}) {
  const byReal = new Map();
  const byDest = new Map();
  const inspected = new Map();
  const queue = [];
  const errors = [];
  const inspectOnce = (real) => {
    if (!inspected.has(real)) inspected.set(real, inspect(real));
    return inspected.get(real);
  };

  function register(real, dest, executableDir, root) {
    const owner = byDest.get(dest);
    if (owner && owner.real !== real) {
      throw new Error(`Bundle name collision at ${dest}: ${owner.real} and ${real}`);
    }
    if (byReal.has(real)) return byReal.get(real);
    const entry = { real, dest, executableDir, root, info: inspectOnce(real), deps: [] };
    errors.push(...contractErrors(entry.dest, entry.info, minMacOS));
    byReal.set(real, entry);
    byDest.set(dest, entry);
    queue.push(entry);
    return entry;
  }

  for (const root of roots) {
    if (!fs.existsSync(root.source)) throw new Error(`Required input missing: ${root.source}`);
    const real = fs.realpathSync(root.source);
    register(real, root.dest, root.executable ? path.dirname(real) : null, root);
  }

  while (queue.length > 0) {
    const entry = queue.shift();
    for (const dep of entry.info.deps) {
      if (isSystemPath(dep.name)) continue;
      if (dep.name.includes('.framework/')) {
        throw new Error(`${entry.dest}: non-system framework dependency ${dep.name} is not supported`);
      }
      const found = candidatePaths(dep.name, {
        loaderPath: entry.real,
        executableDir: entry.executableDir,
        rpaths: entry.info.rpaths,
      }).find((candidate) => fs.existsSync(candidate));
      if (!found) {
        throw new Error(`${entry.dest}: unresolved dependency ${dep.name}`);
      }
      const depReal = fs.realpathSync(found);
      let target = byReal.get(depReal);
      if (!target) {
        const depInfo = inspectOnce(depReal);
        const base = path.basename(depInfo.id || dep.name);
        target = register(depReal, `${BRIDGE_LAYOUT.libDir}/${base}`, entry.executableDir, null);
      }
      entry.deps.push({ name: dep.name, target });
    }
  }

  if (errors.length > 0) {
    throw new Error(`Dependency closure violates the macOS contract:\n- ${errors.join('\n- ')}`);
  }
  return [...byReal.values()];
}

/** Relative rpath from a bundled file back to lib/, valid for executables and libraries alike. */
function bundleRpathFor(dest) {
  const rel = path.posix.relative(path.posix.dirname(dest), BRIDGE_LAYOUT.libDir);
  return rel ? `@loader_path/${rel}` : '@loader_path';
}

/** install_name_tool arguments that make one closure entry relocatable. */
function planRewrite(entry) {
  const args = [];
  if (entry.info.id) args.push('-id', `@rpath/${path.posix.basename(entry.dest)}`);
  for (const dep of entry.deps) {
    const replacement = `@rpath/${path.posix.basename(dep.target.dest)}`;
    if (dep.name !== replacement) args.push('-change', dep.name, replacement);
  }
  const rpath = bundleRpathFor(entry.dest);
  for (const existing of entry.info.rpaths) {
    if (existing !== rpath) args.push('-delete_rpath', existing);
  }
  if (!entry.info.rpaths.includes(rpath)) args.push('-add_rpath', rpath);
  return args;
}

/** Copies dereferenced inputs into the bundle, rewrites load commands and ad-hoc signs them. */
function materializeClosure(entries, bundleDir) {
  for (const entry of entries) {
    const target = path.join(bundleDir, entry.dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(entry.real, target);
    fs.chmodSync(target, entry.root && entry.root.executable ? 0o755 : 0o644);
  }
  for (const entry of entries) {
    const target = path.join(bundleDir, entry.dest);
    const args = planRewrite(entry);
    if (args.length > 0) run('install_name_tool', [...args, target]);
    // Rewriting invalidates the existing signature; arm64 requires a valid (ad-hoc) one.
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', target]);
  }
}

// ---------------------------------------------------------------------------
// Bundle file inventory and zip handling

function listFiles(rootDir) {
  const files = [];
  const walk = (dir) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name);
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      if (dirent.isSymbolicLink()) throw new Error(`Symlinks are not allowed in the bundle: ${rel}`);
      if (dirent.isDirectory()) walk(full);
      else if (dirent.isFile()) files.push(rel);
      else throw new Error(`Unsupported file type in bundle: ${rel}`);
    }
  };
  walk(rootDir);
  return files.sort();
}

function hashTree(rootDir, exclude = []) {
  const hashes = {};
  for (const rel of listFiles(rootDir)) {
    if (!exclude.includes(rel)) hashes[rel] = sha256File(path.join(rootDir, rel));
  }
  return hashes;
}

/**
 * Extracts a zip after checking every entry: relative, no traversal or symlinks,
 * optional single top-level directory, and bounded entry count/size.
 */
function safeExtractZip(zipPath, destDir, { topDir = null, maxEntries = 5000, maxBytes = 512 * 1024 * 1024 } = {}) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (entries.length > maxEntries) throw new Error(`${zipPath}: ${entries.length} entries exceeds limit ${maxEntries}`);
  let declared = 0;
  for (const entry of entries) {
    const name = entry.entryName;
    const segments = name.split('/');
    if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0') || /^[A-Za-z]:/.test(name)
      || segments.some((segment) => segment === '..' || segment === '.')) {
      throw new Error(`${zipPath}: unsafe entry name ${JSON.stringify(name)}`);
    }
    if (topDir && segments[0] !== topDir) throw new Error(`${zipPath}: entry ${name} is outside ${topDir}/`);
    const mode = (entry.header.attr >>> 16) & 0o170000;
    if (mode === 0o120000) throw new Error(`${zipPath}: symlink entry ${name} is not allowed`);
    declared += entry.header.size;
    if (declared > maxBytes) throw new Error(`${zipPath}: uncompressed size exceeds limit ${maxBytes}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const root = path.resolve(destDir);
  for (const entry of entries) {
    const target = path.resolve(root, entry.entryName);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`${zipPath}: entry ${entry.entryName} escapes destination`);
    }
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    const data = entry.getData();
    if (data.length !== entry.header.size) throw new Error(`${zipPath}: size mismatch for ${entry.entryName}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mode = (entry.header.attr >>> 16) & 0o111 ? 0o755 : 0o644;
    fs.writeFileSync(target, data, { mode });
    fs.chmodSync(target, mode);
  }
  return zip;
}

/** Zips the contents of sourceDir into outputZip via a .partial file so failures never leave a final zip. */
function writeZipAtomically(sourceDir, outputZip) {
  const partial = `${outputZip}.partial`;
  fs.rmSync(partial, { force: true });
  fs.mkdirSync(path.dirname(outputZip), { recursive: true });
  run('zip', ['-r', '-X', '-q', partial, '.'], { cwd: sourceDir });
  return {
    partial,
    commit() {
      fs.renameSync(partial, outputZip);
      return outputZip;
    },
  };
}

// ---------------------------------------------------------------------------
// Homebrew keg provenance (build inputs only; never a runtime dependency)

const LICENSE_FILE_PATTERN = /^(COPYING|LICEN[CS]E)|^[A-Za-z0-9.+-]*GPL[A-Za-z0-9.+-]*\.txt$/i;

/** Finds the Homebrew keg (dir containing INSTALL_RECEIPT.json) for a real path and reads its SBOM. */
function kegForPath(realPath) {
  let dir = path.dirname(realPath);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'INSTALL_RECEIPT.json'))) break;
    dir = path.dirname(dir);
  }
  if (!fs.existsSync(path.join(dir, 'INSTALL_RECEIPT.json'))) {
    throw new Error(`No Homebrew keg provenance for ${realPath}`);
  }
  const formula = path.basename(path.dirname(dir));
  const kegVersion = path.basename(dir);
  const sbomPath = path.join(dir, 'sbom.spdx.json');
  if (!fs.existsSync(sbomPath)) throw new Error(`Keg ${formula} ${kegVersion} has no sbom.spdx.json`);
  const sbom = JSON.parse(fs.readFileSync(sbomPath, 'utf8'));
  const describes = (sbom.documentDescribes || [])[0];
  const source = (sbom.packages || []).find((pkg) => pkg.SPDXID === describes);
  if (!source) throw new Error(`Keg ${formula} ${kegVersion} SBOM does not describe its source package`);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'INSTALL_RECEIPT.json'), 'utf8'));
  const sha = (source.checksums || []).find((checksum) => checksum.algorithm === 'SHA256');
  const license = [source.licenseConcluded, source.licenseDeclared].find((value) => value && value !== 'NOASSERTION') || 'NOASSERTION';
  return {
    kegDir: dir,
    formula,
    version: kegVersion,
    upstreamVersion: source.versionInfo || null,
    tap: receipt.source && receipt.source.tap ? receipt.source.tap : null,
    pouredFromBottle: Boolean(receipt.poured_from_bottle),
    license,
    sourceUrl: source.downloadLocation || null,
    sourceSha256: sha ? sha.checksumValue : null,
    licenseFiles: fs.readdirSync(dir).filter((name) => LICENSE_FILE_PATTERN.test(name)
      && fs.statSync(path.join(dir, name)).isFile()).sort(),
  };
}

module.exports = {
  BRIDGE_LAYOUT,
  MACOS_CONTRACT,
  MIN_MACOS_ENV,
  PROBE_PIPELINES,
  REQUIRED_FACTORIES,
  REQUIRED_PLUGINS,
  UXPLAY_PIN,
  buildKindFor,
  bundleRpathFor,
  candidatePaths,
  collectClosure,
  compareVersions,
  contractErrors,
  hashTree,
  inspectMachO,
  isSystemPath,
  kegForPath,
  listFiles,
  machOKind,
  materializeClosure,
  parseLoadCommands,
  planRewrite,
  requireMinMacOS,
  run,
  safeExtractZip,
  sha256File,
  writeZipAtomically,
};
