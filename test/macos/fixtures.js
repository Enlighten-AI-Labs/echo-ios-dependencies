// Builds a tiny fake Homebrew prefix with real Mach-O files so the production packaging and
// validation code can run end to end without touching the host's Homebrew.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { UXPLAY_PIN, sha256File } = require('../../uxplay/scripts/macos-gstreamer-runtime');

// Companion checkout identity recorded by fixture packaging and bundling (must match between them).
const FIXTURE_COMPANION = Object.freeze({ commit: '0123456789abcdef0123456789abcdef01234567', dirty: false });

function clang(args, { arch = ['arm64'], minMacOS = '13.0' } = {}) {
  execFileSync('clang', [
    ...arch.flatMap((a) => ['-arch', a]), `-mmacosx-version-min=${minMacOS}`,
    '-Wl,-headerpad_max_install_names', ...args,
  ], { stdio: 'pipe' });
}

function writeSource(dir, name, code) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, code);
  return file;
}

function makeKeg(prefix, formula, version, { license = 'MIT', sourceSha256 = 'a'.repeat(64) } = {}) {
  const kegDir = path.join(prefix, 'Cellar', formula, version);
  fs.mkdirSync(path.join(kegDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(kegDir, 'INSTALL_RECEIPT.json'), JSON.stringify({ poured_from_bottle: true, source: { tap: 'homebrew/core' } }));
  fs.writeFileSync(path.join(kegDir, 'sbom.spdx.json'), JSON.stringify({
    documentDescribes: [`SPDXRef-Archive-${formula}-src`],
    packages: [{
      SPDXID: `SPDXRef-Archive-${formula}-src`,
      versionInfo: version,
      licenseConcluded: license,
      downloadLocation: `https://example.invalid/${formula}-${version}.tar.gz`,
      checksums: [{ algorithm: 'SHA256', checksumValue: sourceSha256 }],
    }],
  }));
  fs.writeFileSync(path.join(kegDir, 'COPYING'), `${formula} license text\n`);
  fs.mkdirSync(path.join(prefix, 'opt'), { recursive: true });
  fs.symlinkSync(path.relative(path.join(prefix, 'opt'), kegDir), path.join(prefix, 'opt', formula));
  return kegDir;
}

/**
 * Layout:
 *   uxplay (exe) -> opt/alpha/lib/libalpha.1.dylib
 *   libalpha <-> libbeta (cycle; beta referenced via its Cellar path)
 *   libalpha -> @rpath/libgamma.1.dylib (absolute LC_RPATH into the gamma keg)
 *   plugin libgstfake.dylib -> opt alpha; scanner -> Cellar alpha (same file, different alias)
 */
function buildFixture(root) {
  const prefix = path.join(root, 'brew prefix');
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });

  const alphaKeg = makeKeg(prefix, 'alpha', '1.0', { license: 'LGPL-2.1-or-later' });
  const betaKeg = makeKeg(prefix, 'beta', '2.0');
  const gammaKeg = makeKeg(prefix, 'gamma', '1.0');
  const gstKeg = makeKeg(prefix, 'gstfake', '1.0');
  const staticKeg = makeKeg(prefix, 'staticdep', '3.0', { license: 'Apache-2.0' });
  fs.writeFileSync(path.join(staticKeg, 'lib', 'libstaticdep.a'), 'static archive placeholder');

  const optAlpha = path.join(prefix, 'opt', 'alpha', 'lib', 'libalpha.1.dylib');
  const cellarAlpha = path.join(alphaKeg, 'lib', 'libalpha.1.dylib');
  const cellarBeta = path.join(betaKeg, 'lib', 'libbeta.2.dylib');
  const gamma = path.join(gammaKeg, 'lib', 'libgamma.1.dylib');

  clang(['-dynamiclib', writeSource(src, 'gamma.c', 'int gamma_v(void){return 3;}'), '-install_name', '@rpath/libgamma.1.dylib', '-o', gamma]);
  clang(['-dynamiclib', writeSource(src, 'alpha_stub.c', 'int alpha(void){return 1;}'), '-install_name', optAlpha, '-o', cellarAlpha]);
  clang(['-dynamiclib', writeSource(src, 'beta.c', 'int alpha(void); int beta(void){return alpha()+1;}'), cellarAlpha, '-install_name', cellarBeta, '-o', cellarBeta]);
  clang(['-dynamiclib', writeSource(src, 'alpha.c', 'int beta(void); int gamma_v(void); int alpha(void){return 1;} int alpha_all(void){return beta()+gamma_v();}'),
    cellarBeta, gamma, `-Wl,-rpath,${path.dirname(gamma)}`, '-install_name', optAlpha, '-o', cellarAlpha]);

  const pluginDir = path.join(gstKeg, 'lib', 'gstreamer-1.0');
  fs.mkdirSync(pluginDir, { recursive: true });
  const pluginSource = writeSource(src, 'plugin.c', 'int alpha(void); int plugin_init(void){return alpha();}');
  clang(['-dynamiclib', pluginSource, optAlpha, '-install_name', path.join(pluginDir, 'libgstfake.dylib'), '-o', path.join(pluginDir, 'libgstfake.dylib')]);

  const scanner = path.join(gstKeg, 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner');
  fs.mkdirSync(path.dirname(scanner), { recursive: true });
  clang([writeSource(src, 'scanner.c', 'int alpha(void); int main(void){return alpha()-1;}'), optAlpha, '-o', scanner]);
  execFileSync('install_name_tool', ['-change', optAlpha, cellarAlpha, scanner], { stdio: 'pipe' });
  execFileSync('codesign', ['--force', '--sign', '-', scanner], { stdio: 'pipe' });

  // Fake pinned UxPlay build: binary, vendored notices and build-info.json.
  const workDir = path.join(root, 'uxplay-build');
  const sourceDir = path.join(workDir, 'src', `UxPlay-${UXPLAY_PIN.commit}`);
  for (const rel of ['LICENSE', 'lib/llhttp/LICENSE-MIT', 'lib/playfair/LICENSE.md']) {
    fs.mkdirSync(path.dirname(path.join(sourceDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, rel), `${rel}\n`);
  }
  const binary = path.join(workDir, 'build', 'uxplay');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  clang([writeSource(src, 'main.c', '#include <stdio.h>\n#include <string.h>\nint alpha_all(void);\n'
    + 'int main(int c,char**v){if(c>1&&!strcmp(v[1],"-h")){printf("fixture %d\\n",alpha_all());return 0;}return 2;}'),
  optAlpha, '-o', binary]);

  const buildInfoPath = path.join(workDir, 'build-info.json');
  fs.writeFileSync(buildInfoPath, JSON.stringify({
    schema: 1,
    uxplay: { version: UXPLAY_PIN.version, commit: UXPLAY_PIN.commit, archiveSha256: UXPLAY_PIN.archiveSha256 },
    arch: 'arm64',
    minimumMacOS: '13.0',
    binary: 'build/uxplay',
    binarySha256: sha256File(binary),
    sourceDir: path.relative(workDir, sourceDir),
    staticLibraries: [path.join(staticKeg, 'lib', 'libstaticdep.a')],
    toolchain: { fixture: true },
  }));

  const ffmpegDir = path.join(root, 'ffmpeg');
  fs.mkdirSync(ffmpegDir, { recursive: true });
  clang([writeSource(src, 'ffmpeg.c', 'int main(void){return 0;}'), '-o', path.join(ffmpegDir, 'ffmpeg')]);
  fs.writeFileSync(path.join(ffmpegDir, 'LICENSE'), 'ffmpeg license\n');
  fs.writeFileSync(path.join(ffmpegDir, 'ffmpeg.LICENSE'), 'ffmpeg project license\n');

  return {
    root,
    prefix,
    src,
    buildInfoPath,
    binary,
    optAlpha,
    pluginDir,
    scanner,
    ffmpegDir,
    gamma,
    kegs: { alpha: alphaKeg, beta: betaKeg, gamma: gammaKeg, gst: gstKeg },
    packageOptions(extra = {}) {
      return {
        minMacOS: '13.0',
        buildInfoPath,
        pluginSourceDir: pluginDir,
        scannerSource: scanner,
        requiredPlugins: ['libgstfake.dylib'],
        outputZip: path.join(root, 'out', 'airplay-bridge.zip'),
        stagingDir: path.join(root, 'out', 'staging'),
        downstreamArtifacts: [path.join(root, 'out', 'echo-ios-dependencies-macos.zip')],
        companion: FIXTURE_COMPANION,
        ...extra,
      };
    },
  };
}

/** Recompiles the fixture's UxPlay binary (`-h` must exit 0) and records it in build-info.json. */
function rebuildBinary(fixture, code, linkArgs) {
  clang([writeSource(fixture.src, 'main-rebuilt.c', code), ...linkArgs, '-o', fixture.binary]);
  const info = JSON.parse(fs.readFileSync(fixture.buildInfoPath, 'utf8'));
  info.binarySha256 = sha256File(fixture.binary);
  fs.writeFileSync(fixture.buildInfoPath, JSON.stringify(info));
}

/** Adds an extra plugin to the fixture's plugin dir with custom compile settings. */
function addPlugin(fixture, name, { arch, minMacOS, extraArgs = [] } = {}) {
  const pluginPath = path.join(fixture.pluginDir, name);
  const source = writeSource(fixture.src, `${name}.c`, 'int extra_plugin(void){return 0;}');
  clang(['-dynamiclib', source, ...extraArgs, '-install_name', pluginPath, '-o', pluginPath], { arch, minMacOS });
  return pluginPath;
}

module.exports = { FIXTURE_COMPANION, addPlugin, buildFixture, clang, makeKeg, rebuildBinary, writeSource };
