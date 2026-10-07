const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { after, before, describe, test } = require('node:test');
const AdmZip = require('adm-zip');

const { FIXTURE_COMPANION, addPlugin, buildFixture, clang, makeKeg, rebuildBinary, writeSource } = require('./fixtures');
const { packageBridge } = require('../../uxplay/scripts/package-uxplay-macos');
const { bundleMacosCompanion } = require('../../scripts/bundle-macos-companion');
const { buildUxPlay, parseBuildJobs, verifyArchive } = require('../../uxplay/scripts/download-and-build-uxplay-macos');
const {
  validateBridgeDir, validateCompanionDir, validateFfmpeg, validateZip,
} = require('../../uxplay/scripts/validate-macos-package');
const {
  parseLoadCommands,
  requireMinMacOS,
  safeExtractZip,
  sha256File,
} = require('../../uxplay/scripts/macos-gstreamer-runtime');

const skip = process.platform !== 'darwin' && 'macOS toolchain required';
const PLUGINS = ['libgstfake.dylib'];

let tmpRoot;
let counter = 0;
const scratch = (name) => {
  counter += 1;
  const dir = path.join(tmpRoot, `${counter}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-macos-test-'));
});
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function assertNoArtifact(options) {
  assert.equal(fs.existsSync(options.outputZip), false, 'final zip must not exist');
  assert.equal(fs.existsSync(`${options.outputZip}.partial`), false, 'partial zip must be cleaned up');
}

describe('bridge packaging', { skip }, () => {
  test('packages a deduplicated, relocatable closure that still runs after being moved', () => {
    const fixture = buildFixture(scratch('happy'));
    const options = fixture.packageOptions();
    const result = packageBridge(options);

    const files = Object.keys(result.provenance.files);
    for (const rel of ['echo-airplay', 'libexec/gstreamer-1.0/gst-plugin-scanner', 'lib/gstreamer-1.0/libgstfake.dylib',
      'lib/libalpha.1.dylib', 'lib/libbeta.2.dylib', 'lib/libgamma.1.dylib', 'THIRD_PARTY_NOTICES.md']) {
      assert.ok(files.includes(rel), `${rel} is bundled`);
    }
    // Cellar and opt aliases of libalpha, and the alpha<->beta cycle, collapse to single copies.
    assert.equal(files.filter((rel) => rel.startsWith('lib/') && rel.endsWith('.dylib') && !rel.includes('gstreamer-1.0')).length, 3);

    const components = Object.fromEntries(result.provenance.components.map((c) => [c.name, c]));
    assert.equal(components.staticdep.linkage, 'static');
    assert.equal(components.alpha.license, 'LGPL-2.1-or-later');
    assert.deepEqual(components.alpha.licenseFiles, ['licenses/alpha/COPYING']);
    assert.equal(components.UxPlay.sourceRevision, result.provenance.uxplay.commit);
    assert.equal(result.provenance.buildKind, 'development');
    assert.match(result.provenance.releaseGaps[0], /Development build: macOS 13\.0/);

    const moved = path.join(scratch('moved'), 'Moved Output', 'renamed bridge.zip');
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(options.outputZip, moved);
    const validation = validateZip(moved, { runtime: true, gstProbe: false, requiredPlugins: PLUGINS });
    assert.equal(validation.kind, 'bridge');
    assert.ok(validation.runtime.helpImages > 0);
  });

  test('rejects unusable dependency closures without writing an artifact', async (t) => {
    const shared = buildFixture(scratch('shared'));

    await t.test('unresolved @rpath dependency', () => {
      const fixture = buildFixture(scratch('unresolved'));
      fs.rmSync(fixture.gamma);
      const options = fixture.packageOptions();
      assert.throws(() => packageBridge(options), /unresolved dependency @rpath\/libgamma\.1\.dylib/);
      assertNoArtifact(options);
    });

    await t.test('two different libraries with the same bundle name', () => {
      const fixture = buildFixture(scratch('collision'));
      const libs = ['dupx', 'dupy'].map((formula) => {
        const keg = makeKeg(fixture.prefix, formula, '1.0');
        const lib = path.join(keg, 'lib', 'libdup.1.dylib');
        clang(['-dynamiclib', writeSource(fixture.src, `${formula}.c`, `int ${formula}(void){return 0;}`), '-install_name', lib, '-o', lib]);
        return lib;
      });
      addPlugin(fixture, 'libgstdup.dylib', { extraArgs: libs });
      const options = fixture.packageOptions({ requiredPlugins: [...PLUGINS, 'libgstdup.dylib'] });
      assert.throws(() => packageBridge(options), /Bundle name collision at lib\/libdup\.1\.dylib/);
      assertNoArtifact(options);
    });

    const contractCases = [
      ['Intel plugin', 'libgstintel.dylib', { arch: ['x86_64'] }, /architecture x86_64 does not match contract arm64/],
      ['universal plugin', 'libgstfat.dylib', { arch: ['arm64', 'x86_64'] }, /universal\/fat Mach-O/],
      ['plugin requiring a newer macOS', 'libgstnewer.dylib', { minMacOS: '14.0' }, /minimum macOS 14\.0 exceeds selected target 13\.0/],
    ];
    for (const [label, plugin, settings, pattern] of contractCases) {
      await t.test(label, () => {
        addPlugin(shared, plugin, settings);
        const options = shared.packageOptions({ requiredPlugins: [...PLUGINS, plugin] });
        assert.throws(() => packageBridge(options), pattern);
        assertNoArtifact(options);
      });
    }

    await t.test('missing required plugin', () => {
      const options = shared.packageOptions({ requiredPlugins: [...PLUGINS, 'libgstnope.dylib'] });
      assert.throws(() => packageBridge(options), /Required GStreamer plugin libgstnope\.dylib not found/);
      assertNoArtifact(options);
    });

    await t.test('dependency without a license notice', () => {
      const fixture = buildFixture(scratch('nolicense'));
      fs.rmSync(path.join(fixture.kegs.beta, 'COPYING'));
      const options = fixture.packageOptions();
      assert.throws(() => packageBridge(options), /No license text found in keg beta@2\.0/);
      assertNoArtifact(options);
    });

    await t.test('no explicit minimum macOS', () => {
      const options = shared.packageOptions({ minMacOS: undefined });
      assert.throws(() => packageBridge(options), /must be set explicitly/);
      assertNoArtifact(options);
    });
  });

  test('resolves @rpath through the run paths of the images that loaded it', async (t) => {
    // libinherit imports @rpath/libgamma.1.dylib but has no LC_RPATH; only the executable does.
    const fixture = buildFixture(scratch('inherited'));
    const keg = makeKeg(fixture.prefix, 'inherit', '1.0');
    const inherit = path.join(keg, 'lib', 'libinherit.1.dylib');
    clang(['-dynamiclib', writeSource(fixture.src, 'inherit.c', 'int gamma_v(void); int inherited(void){return gamma_v();}'),
      fixture.gamma, '-install_name', inherit, '-o', inherit]);
    assert.deepEqual(execFileSync('otool', ['-l', inherit], { encoding: 'utf8' }).includes('LC_RPATH'), false);
    rebuildBinary(fixture, '#include <string.h>\nint inherited(void); int alpha_all(void);\n'
      + 'int main(int c,char**v){return (c>1&&!strcmp(v[1],"-h")&&inherited()==3&&alpha_all()==5)?0:2;}',
    [inherit, fixture.optAlpha, `-Wl,-rpath,${path.dirname(fixture.gamma)}`]);
    // dyld itself accepts this layout.
    execFileSync(fixture.binary, ['-h'], { env: { PATH: '/usr/bin:/bin' } });

    await t.test('from the executable', () => {
      const options = fixture.packageOptions();
      const result = packageBridge(options);
      assert.ok(result.provenance.files['lib/libinherit.1.dylib']);
      assert.equal(Object.keys(result.provenance.files).filter((rel) => rel.endsWith('libgamma.1.dylib')).length, 1);
      validateZip(options.outputZip, { runtime: true, gstProbe: false, requiredPlugins: PLUGINS });
    });

    await t.test('but not for a plugin whose loader is unknown', () => {
      addPlugin(fixture, 'libgstinherit.dylib', { extraArgs: [inherit] });
      const options = fixture.packageOptions({ requiredPlugins: [...PLUGINS, 'libgstinherit.dylib'] });
      assert.throws(() => packageBridge(options), /lib\/libinherit\.1\.dylib: unresolved dependency @rpath\/libgamma\.1\.dylib/);
      assertNoArtifact(options);
    });
  });

  test('rejects a library whose @rpath dependency differs between load contexts', () => {
    // The executable's run path finds dupx's libdup, the scanner's finds dupy's.
    const fixture = buildFixture(scratch('contexts'));
    const [dupx, dupy] = ['dupx', 'dupy'].map((formula) => {
      const keg = makeKeg(fixture.prefix, formula, '1.0');
      const lib = path.join(keg, 'lib', 'libdup.1.dylib');
      clang(['-dynamiclib', writeSource(fixture.src, `${formula}.c`, 'int dup(void){return 0;}'), '-install_name', '@rpath/libdup.1.dylib', '-o', lib]);
      return lib;
    });
    const sharedKeg = makeKeg(fixture.prefix, 'shared', '1.0');
    const shared = path.join(sharedKeg, 'lib', 'libshared.1.dylib');
    clang(['-dynamiclib', writeSource(fixture.src, 'shared.c', 'int dup(void); int shared(void){return dup();}'), dupx, '-install_name', shared, '-o', shared]);
    rebuildBinary(fixture, 'int shared(void); int main(void){return shared();}', [shared, `-Wl,-rpath,${path.dirname(dupx)}`]);
    clang([writeSource(fixture.src, 'scanner2.c', 'int shared(void); int main(void){return shared();}'), shared, `-Wl,-rpath,${path.dirname(dupy)}`, '-o', fixture.scanner]);
    const options = fixture.packageOptions();
    assert.throws(() => packageBridge(options), /Bundle name collision at lib\/libdup\.1\.dylib|different files depending on load context/);
    assertNoArtifact(options);
  });

  test('failed or interrupted packaging never leaves a final artifact', () => {
    const fixture = buildFixture(scratch('interrupted'));
    const options = fixture.packageOptions();
    packageBridge(options);
    assert.ok(fs.existsSync(options.outputZip));

    assert.throws(() => packageBridge({ ...options, beforeCommit: () => { throw new Error('simulated interruption'); } }), /simulated interruption/);
    assertNoArtifact(options);

    // A previously bundled companion is stale once its bridge is being rebuilt.
    const [downstream] = options.downstreamArtifacts;
    fs.writeFileSync(downstream, 'old companion bundle');
    assert.throws(() => packageBridge({ ...options, requiredPlugins: ['libgstnope.dylib'] }), /not found/);
    assertNoArtifact(options);
    assert.equal(fs.existsSync(downstream), false);

    packageBridge(options);
    validateZip(options.outputZip, { requiredPlugins: PLUGINS });
  });
});

describe('bridge validation', { skip }, () => {
  let bridgeZip;
  before(() => {
    const fixture = buildFixture(scratch('validate'));
    bridgeZip = packageBridge(fixture.packageOptions()).outputZip;
  });

  function extracted() {
    const dir = scratch('bridge');
    safeExtractZip(bridgeZip, dir);
    return dir;
  }
  const validate = (dir) => validateBridgeDir(dir, { requiredPlugins: PLUGINS });

  test('accepts the untouched bundle', () => {
    validate(extracted());
  });

  test('rejects a binary-only archive like the v0.1.4 release', () => {
    const zip = new AdmZip();
    zip.addFile('uxplay', Buffer.from('binary'));
    const zipPath = path.join(scratch('stale'), 'airplay-bridge.zip');
    zip.writeZip(zipPath);
    assert.throws(() => validateZip(zipPath, { requiredPlugins: PLUGINS }), /Missing bundled lib\/ directory[\s\S]*Missing provenance\.json/);
  });

  test('rejects the downloaded v0.1.4 release when provided', { skip: !process.env.ECHO_DEV1390_RELEASED_ZIP && 'set ECHO_DEV1390_RELEASED_ZIP' }, () => {
    assert.throws(() => validateZip(process.env.ECHO_DEV1390_RELEASED_ZIP), /Missing bundled lib\/ directory/);
  });

  test('rejects a bundle built from a different UxPlay commit', () => {
    const dir = extracted();
    const provenancePath = path.join(dir, 'provenance.json');
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
    provenance.uxplay.commit = '0'.repeat(40);
    fs.writeFileSync(provenancePath, JSON.stringify(provenance));
    assert.throws(() => validate(dir), /does not match pinned 1\.73\.6/);
  });

  test('rejects a release-candidate label without an approved OS contract', () => {
    const dir = extracted();
    const provenancePath = path.join(dir, 'provenance.json');
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
    provenance.buildKind = 'release-candidate';
    fs.writeFileSync(provenancePath, JSON.stringify(provenance));
    assert.throws(() => validate(dir), /buildKind release-candidate is not valid for target macOS 13\.0/);
  });

  test('rejects a bundled dependency deleted after rewriting', () => {
    const dir = extracted();
    fs.rmSync(path.join(dir, 'lib', 'libgamma.1.dylib'));
    assert.throws(() => validate(dir), /dependency @rpath\/libgamma\.1\.dylib does not resolve inside the bundle/);
  });

  test('rejects a leftover absolute Homebrew load command', () => {
    const dir = extracted();
    const lib = path.join(dir, 'lib', 'libalpha.1.dylib');
    execFileSync('install_name_tool', ['-change', '@rpath/libbeta.2.dylib', '/opt/homebrew/lib/libbeta.2.dylib', lib], { stdio: 'pipe' });
    execFileSync('codesign', ['--force', '--sign', '-', lib], { stdio: 'pipe' });
    assert.throws(() => validate(dir), /dependency \/opt\/homebrew\/lib\/libbeta\.2\.dylib is not bundled/);
  });

  test('rejects files changed after signing and unsigned binaries', () => {
    const dir = extracted();
    execFileSync('codesign', ['--remove-signature', path.join(dir, 'lib', 'libbeta.2.dylib')], { stdio: 'pipe' });
    assert.throws(() => validate(dir), /lib\/libbeta\.2\.dylib does not match its recorded sha256[\s\S]*code signature invalid/);
  });

  // Replaces files and records their new hashes, so inventory checks cannot mask the real error.
  function substitute(dir, replacements) {
    const provenancePath = path.join(dir, 'provenance.json');
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
    for (const [rel, write] of Object.entries(replacements)) {
      const target = path.join(dir, rel);
      const mode = fs.statSync(target).mode & 0o777;
      fs.rmSync(target);
      delete provenance.files[rel];
      write(target);
      if (fs.statSync(target).isDirectory()) {
        for (const name of fs.readdirSync(target)) {
          provenance.files[`${rel}/${name}`] = { sha256: sha256File(path.join(target, name)), origin: 'test' };
        }
      } else {
        fs.chmodSync(target, mode);
        provenance.files[rel] = { sha256: sha256File(target), origin: 'test' };
      }
    }
    fs.writeFileSync(provenancePath, JSON.stringify(provenance));
  }
  const text = (target) => fs.writeFileSync(target, 'not Mach-O\n');

  test('rejects text, directory or wrong-type stand-ins for required images', async (t) => {
    await t.test('text receiver, scanner and plugin (modes kept, inventory updated)', () => {
      const dir = extracted();
      substitute(dir, {
        'echo-airplay': text,
        'libexec/gstreamer-1.0/gst-plugin-scanner': text,
        'lib/gstreamer-1.0/libgstfake.dylib': text,
      });
      assert.equal(fs.statSync(path.join(dir, 'echo-airplay')).mode & 0o777, 0o755);
      assert.throws(() => validate(dir), (e) => {
        assert.match(e.message, /echo-airplay is not a Mach-O image[\s\S]*gst-plugin-scanner is not a Mach-O image[\s\S]*libgstfake\.dylib is not a Mach-O image/);
        assert.doesNotMatch(e.message, /recorded sha256|not listed in the inventory/);
        return true;
      });
    });

    await t.test('plugin replaced by a directory', () => {
      const dir = extracted();
      substitute(dir, {
        'lib/gstreamer-1.0/libgstfake.dylib': (target) => { fs.mkdirSync(target); text(path.join(target, 'payload')); },
      });
      assert.throws(() => validate(dir), /lib\/gstreamer-1\.0\/libgstfake\.dylib is not a regular file/);
    });

    await t.test('receiver replaced by a signed arm64 dylib', () => {
      const dir = extracted();
      substitute(dir, { 'echo-airplay': (target) => fs.copyFileSync(path.join(dir, 'lib', 'libbeta.2.dylib'), target) });
      assert.throws(() => validate(dir), /echo-airplay is a Mach-O dylib, expected execute/);
    });

    await t.test('bundled dependency replaced by text', () => {
      const dir = extracted();
      substitute(dir, { 'lib/libgamma.1.dylib': text });
      assert.throws(() => validate(dir), /dependency @rpath\/libgamma\.1\.dylib resolves to a file that is not a Mach-O dylib/);
    });
  });

  test('rejects symlinks inside the bundle', () => {
    const dir = extracted();
    fs.symlinkSync('/opt/homebrew/lib', path.join(dir, 'lib', 'homebrew'));
    assert.throws(() => validate(dir), /Symlinks are not allowed in the bundle: lib\/homebrew/);
  });
});

describe('companion bundle', { skip }, () => {
  let fixture;
  let bridgeZip;
  before(() => {
    fixture = buildFixture(scratch('companion'));
    bridgeZip = packageBridge(fixture.packageOptions()).outputZip;
  });

  function bundleOptions(extra = {}) {
    const dir = scratch('dist');
    return {
      bridgeZip,
      ffmpegDir: fixture.ffmpegDir,
      outputZip: path.join(dir, 'echo-ios-dependencies-macos.zip'),
      tempDir: path.join(dir, 'staging'),
      minMacOS: '13.0',
      requiredPlugins: PLUGINS,
      gstProbe: false,
      companion: FIXTURE_COMPANION,
      ...extra,
    };
  }

  test('builds a validated bundle with a sidecar manifest naming the final zip hash', () => {
    const options = bundleOptions();
    const { summary, sidecar } = bundleMacosCompanion(options);
    assert.equal(summary.sha256, sha256File(options.outputZip));
    assert.equal(JSON.parse(fs.readFileSync(sidecar, 'utf8')).sha256, summary.sha256);
    assert.equal(summary.arch, 'arm64');
    assert.equal(summary.minimumMacOS, '13.0');
    assert.ok(summary.files['airplay-bridge/lib/libalpha.1.dylib']);
    assert.ok(summary.runtimeValidation.helpImages > 0);
    assert.ok(summary.releaseGaps.some((gap) => /ffmpeg: checked-in prebuilt binary has no source receipt/.test(gap)));

    const result = validateZip(options.outputZip, { requiredPlugins: PLUGINS });
    assert.equal(result.kind, 'companion');
  });

  test('records the bundling and bridge companion revisions separately', () => {
    // A bridge packaged at one companion revision may be bundled at another; each phase keeps its own record.
    const bundler = { commit: 'a'.repeat(40), dirty: false };
    const options = bundleOptions({ companion: bundler });
    const { summary } = bundleMacosCompanion(options);
    assert.deepEqual(summary.companion, bundler);
    assert.equal(summary.airplayBridge.archiveSha256, sha256File(bridgeZip));
    assert.equal(summary.uxplay.commit, '21eef8df25d91e12635c36d8176ad192725baca2');

    const root = path.join(scratch('phases'), 'out');
    safeExtractZip(options.outputZip, root);
    const nestedPath = path.join(root, 'echo-ios-dependencies-macos', 'airplay-bridge', 'provenance.json');
    const nested = JSON.parse(fs.readFileSync(nestedPath, 'utf8'));
    assert.deepEqual(nested.companion, FIXTURE_COMPANION);
    assert.equal(summary.files['airplay-bridge/provenance.json'], sha256File(nestedPath));

    // The bridge's own record cannot be rewritten to credit the bundling revision.
    nested.companion = bundler;
    fs.writeFileSync(nestedPath, JSON.stringify(nested));
    assert.throws(() => validateCompanionDir(path.dirname(path.dirname(nestedPath)), { requiredPlugins: PLUGINS }),
      /airplay-bridge\/provenance\.json does not match its recorded sha256/);
  });

  test('rejects an unsigned ffmpeg', () => {
    const ffmpegDir = scratch('unsigned-ffmpeg');
    for (const name of ['ffmpeg', 'LICENSE', 'ffmpeg.LICENSE']) fs.copyFileSync(path.join(fixture.ffmpegDir, name), path.join(ffmpegDir, name));
    execFileSync('codesign', ['--remove-signature', path.join(ffmpegDir, 'ffmpeg')], { stdio: 'pipe' });
    const options = bundleOptions({ ffmpegDir });
    assert.throws(() => bundleMacosCompanion(options), /ffmpeg: code signature invalid/);
    assertNoArtifact(options);
  });

  test('accepts the checked-in ffmpeg without executing it', () => {
    const info = validateFfmpeg(path.join(__dirname, '..', '..', 'ffmpeg', 'ffmpeg'), '26.0');
    assert.deepEqual(info.archs, ['arm64']);
  });

  test('rejects an ffmpeg without its license notices', () => {
    const ffmpegDir = scratch('ffmpeg-no-notice');
    fs.copyFileSync(path.join(fixture.ffmpegDir, 'ffmpeg'), path.join(ffmpegDir, 'ffmpeg'));
    fs.copyFileSync(path.join(fixture.ffmpegDir, 'LICENSE'), path.join(ffmpegDir, 'LICENSE'));
    const options = bundleOptions({ ffmpegDir });
    assert.throws(() => bundleMacosCompanion(options), /Required ffmpeg license notice ffmpeg\.LICENSE not found/);
    assertNoArtifact(options);
  });

  test('final validation checks notices, provenance agreement and execute permissions', async (t) => {
    const options = bundleOptions();
    bundleMacosCompanion(options);
    const extract = () => {
      const dir = scratch('final');
      safeExtractZip(options.outputZip, dir);
      return path.join(dir, 'echo-ios-dependencies-macos');
    };
    const editManifest = (root, edit) => {
      const manifestPath = path.join(root, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      edit(manifest);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    };
    const validate = (root) => validateCompanionDir(root, { requiredPlugins: PLUGINS });

    await t.test('missing ffmpeg notice, even when removed from the inventory', () => {
      const root = extract();
      fs.rmSync(path.join(root, 'ffmpeg', 'ffmpeg.LICENSE'));
      editManifest(root, (manifest) => { delete manifest.files['ffmpeg/ffmpeg.LICENSE']; });
      assert.throws(() => validate(root), /license file ffmpeg\/ffmpeg\.LICENSE is missing/);
    });

    await t.test('manifest that rewrites a bridge component or drops a release gap', () => {
      const root = extract();
      editManifest(root, (manifest) => {
        manifest.components.find((component) => component.name === 'alpha').license = 'MIT';
        manifest.releaseGaps = manifest.releaseGaps.slice(1);
      });
      assert.throws(() => validate(root), /Manifest component alpha 1\.0 differs from bridge provenance[\s\S]*Manifest drops bridge release gap/);
    });

    await t.test('ffmpeg whose signature was removed (inventory updated)', () => {
      const root = extract();
      const ffmpegPath = path.join(root, 'ffmpeg', 'ffmpeg');
      execFileSync('codesign', ['--remove-signature', ffmpegPath], { stdio: 'pipe' });
      editManifest(root, (manifest) => {
        manifest.files['ffmpeg/ffmpeg'] = sha256File(ffmpegPath);
        manifest.ffmpeg.sha256 = sha256File(ffmpegPath);
      });
      assert.throws(() => validate(root), (e) => {
        assert.match(e.message, /ffmpeg: code signature invalid/);
        assert.doesNotMatch(e.message, /recorded sha256|does not match the bundled ffmpeg/);
        return true;
      });
    });

    await t.test('ffmpeg replaced by a dylib', () => {
      const root = extract();
      const ffmpegPath = path.join(root, 'ffmpeg', 'ffmpeg');
      fs.copyFileSync(path.join(root, 'airplay-bridge', 'lib', 'libbeta.2.dylib'), ffmpegPath);
      fs.chmodSync(ffmpegPath, 0o755);
      editManifest(root, (manifest) => {
        manifest.files['ffmpeg/ffmpeg'] = sha256File(ffmpegPath);
        manifest.ffmpeg.sha256 = sha256File(ffmpegPath);
      });
      assert.throws(() => validate(root), /is not a Mach-O executable/);
    });

    await t.test('ffmpeg or scanner without execute permission, including in a downloaded zip', () => {
      const root = extract();
      fs.chmodSync(path.join(root, 'ffmpeg', 'ffmpeg'), 0o644);
      fs.chmodSync(path.join(root, 'airplay-bridge', 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner'), 0o644);
      assert.throws(() => validate(root), /libexec\/gstreamer-1\.0\/gst-plugin-scanner is not executable \(mode 0644\)[\s\S]*ffmpeg: ffmpeg is not executable \(mode 0644\)/);
      const rezipped = path.join(path.dirname(root), 'tampered.zip');
      execFileSync('zip', ['-r', '-X', '-q', rezipped, 'echo-ios-dependencies-macos'], { cwd: path.dirname(root) });
      assert.throws(() => validateZip(rezipped, { requiredPlugins: PLUGINS }), /ffmpeg: ffmpeg is not executable/);
    });
  });

  test('a failure while publishing leaves no final zip or sidecar', async (t) => {
    const injected = [
      ['writing the sidecar (ENOSPC)', 'writeFileSync', (file) => file.endsWith('.manifest.json.partial')],
      ['renaming the sidecar into place', 'renameSync', (from) => from.endsWith('.manifest.json.partial')],
      ['renaming the zip into place', 'renameSync', (from) => from.endsWith('.zip.partial')],
    ];
    for (const [label, method, matches] of injected) {
      await t.test(label, () => {
        const options = bundleOptions();
        const original = fs[method];
        fs[method] = function failing(file, ...args) {
          if (typeof file === 'string' && matches(file)) {
            throw Object.assign(new Error(`injected failure ${label}`), { code: 'ENOSPC' });
          }
          return original.call(this, file, ...args);
        };
        try {
          assert.throws(() => bundleMacosCompanion(options), /injected failure/);
        } finally {
          fs[method] = original;
        }
        const sidecar = options.outputZip.replace(/\.zip$/, '.manifest.json');
        for (const output of [options.outputZip, `${options.outputZip}.partial`, sidecar, `${sidecar}.partial`]) {
          assert.equal(fs.existsSync(output), false, `${path.basename(output)} must not remain`);
        }
      });
    }
  });

  test('rejects a missing ffmpeg', () => {
    const options = bundleOptions({ ffmpegDir: scratch('no-ffmpeg') });
    assert.throws(() => bundleMacosCompanion(options), /ffmpeg binary not found/);
    assertNoArtifact(options);
  });

  test('rejects an Intel ffmpeg instead of mislabeling the bundle', () => {
    const ffmpegDir = scratch('intel-ffmpeg');
    clang([writeSource(ffmpegDir, 'f.c', 'int main(void){return 0;}'), '-o', path.join(ffmpegDir, 'ffmpeg')], { arch: ['x86_64'] });
    for (const notice of ['LICENSE', 'ffmpeg.LICENSE']) fs.copyFileSync(path.join(fixture.ffmpegDir, notice), path.join(ffmpegDir, notice));
    const options = bundleOptions({ ffmpegDir });
    assert.throws(() => bundleMacosCompanion(options), /ffmpeg: architecture x86_64 does not match contract arm64/);
    assertNoArtifact(options);
  });

  test('rejects a stale binary-only bridge archive', () => {
    const zip = new AdmZip();
    zip.addFile('uxplay', Buffer.from('binary'));
    const stale = path.join(scratch('stale-bridge'), 'airplay-bridge.zip');
    zip.writeZip(stale);
    const options = bundleOptions({ bridgeZip: stale });
    assert.throws(() => bundleMacosCompanion(options), /Missing bundled lib\/ directory/);
    assertNoArtifact(options);
  });

  test('rejects a bridge built for a different macOS target', () => {
    const options = bundleOptions({ minMacOS: '26.0' });
    assert.throws(() => bundleMacosCompanion(options), /Bridge targets macOS 13\.0, expected 26\.0/);
    assertNoArtifact(options);
  });
});

describe('contract and source guards', () => {
  test('minimum macOS must be explicit and valid for Apple silicon', () => {
    assert.throws(() => requireMinMacOS(undefined), /must be set explicitly/);
    assert.throws(() => requireMinMacOS('latest'), /is not a macOS version/);
    assert.throws(() => requireMinMacOS('10.15'), /below 11\.0/);
    assert.equal(requireMinMacOS('26.0'), '26.0');
  });

  test('parses load commands including numeric platforms and weak dylibs', () => {
    const parsed = parseLoadCommands([
      '          cmd LC_ID_DYLIB', '         name /opt/homebrew/opt/x/lib/libx.1.dylib (offset 24)',
      '      cmd LC_BUILD_VERSION', ' platform 1', '    minos 26.0', '  version 1230.1',
      '          cmd LC_LOAD_WEAK_DYLIB', '         name @rpath/liby.dylib (offset 24)',
      '          cmd LC_RPATH', '         path /opt/homebrew/lib (offset 12)',
    ].join('\n'));
    assert.deepEqual(parsed, {
      id: '/opt/homebrew/opt/x/lib/libx.1.dylib',
      deps: [{ name: '@rpath/liby.dylib', weak: true }],
      rpaths: ['/opt/homebrew/lib'],
      minos: '26.0',
      platform: 'MACOS',
    });
  });

  test('build jobs default to 4 and accept only small whole numbers', () => {
    assert.equal(parseBuildJobs(undefined), 4);
    assert.equal(parseBuildJobs(''), 4);
    assert.equal(parseBuildJobs('1'), 1);
    assert.equal(parseBuildJobs('16'), 16);
    for (const bad of ['0', '17', '-2', '2.5', 'max', ' 4']) {
      assert.throws(() => parseBuildJobs(bad), /must be a whole number from 1 to 16/);
    }
  });

  test('an invalid build-jobs override fails after clearing stale artifacts', async () => {
    const dir = scratch('builder-jobs');
    const stale = path.join(dir, 'airplay-bridge.zip');
    fs.writeFileSync(stale, 'old artifact');
    await assert.rejects(
      buildUxPlay({ minMacOS: '26.0', buildJobs: '64', workDir: path.join(dir, 'work'), finalArtifacts: [stale] }),
      /ECHO_MACOS_BUILD_JOBS="64" must be a whole number from 1 to 16/,
    );
    assert.equal(fs.existsSync(stale), false);
  });

  test('source archives must match the pinned digest', () => {
    const file = path.join(scratch('archive'), 'uxplay.zip');
    fs.writeFileSync(file, 'not the pinned archive');
    assert.throws(() => verifyArchive(file), /does not match pinned/);
  });

  test('zip extraction rejects traversal and symlink entries', () => {
    const dir = scratch('zips');
    const traversal = new AdmZip();
    traversal.addFile('top/xx/evil.txt', Buffer.from('x'));
    const crafted = traversal.toBuffer().toString('latin1').split('top/xx/').join('top/../');
    fs.writeFileSync(path.join(dir, 'traversal.zip'), Buffer.from(crafted, 'latin1'));
    assert.throws(() => safeExtractZip(path.join(dir, 'traversal.zip'), path.join(dir, 'out1')), /unsafe entry name/);

    const link = new AdmZip();
    link.addFile('top/link', Buffer.from('/etc/passwd'));
    link.getEntries()[0].header.attr = (0o120777 << 16) >>> 0;
    link.writeZip(path.join(dir, 'link.zip'));
    assert.throws(() => safeExtractZip(path.join(dir, 'link.zip'), path.join(dir, 'out2')), /symlink entry top\/link/);
    assert.equal(fs.existsSync(path.join(dir, 'out2', 'top', 'link')), false);
  });

  test('a build without an explicit target clears stale bridge artifacts first', async () => {
    const dir = scratch('builder');
    const stale = path.join(dir, 'airplay-bridge.zip');
    fs.writeFileSync(stale, 'old artifact');
    await assert.rejects(
      buildUxPlay({ minMacOS: undefined, workDir: path.join(dir, 'work'), finalArtifacts: [stale] }),
      /must be set explicitly/,
    );
    assert.equal(fs.existsSync(stale), false);
  });
});
