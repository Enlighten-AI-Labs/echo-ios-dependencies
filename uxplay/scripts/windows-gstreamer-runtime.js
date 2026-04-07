const fs = require('fs');
const os = require('os');
const path = require('path');

const REQUIRED_RUNTIME_FILES = [
  'echo-airplay.exe',
  'dnssd.dll',
  'libgstreamer-1.0-0.dll',
  'libgstbase-1.0-0.dll',
  'libgstvideo-1.0-0.dll',
  'libgstaudio-1.0-0.dll',
  'libgstapp-1.0-0.dll',
  'libgstpbutils-1.0-0.dll',
  'libgstrtp-1.0-0.dll',
  'libgstsdp-1.0-0.dll',
  'libglib-2.0-0.dll',
  'libgobject-2.0-0.dll',
  'libgio-2.0-0.dll',
  'libgmodule-2.0-0.dll',
  'libgthread-2.0-0.dll',
  'libffi-8.dll',
  'libintl-8.dll',
  'libpcre2-8-0.dll',
  'libstdc++-6.dll',
  'libgcc_s_seh-1.dll',
  'libwinpthread-1.dll',
  'zlib1.dll',
  'libxml2-2.dll',
  'libiconv-2.dll',
  'libssl-3-x64.dll',
  'libcrypto-3-x64.dll',
  'libplist-2.0.dll',
  'avcodec-61.dll',
  'avformat-61.dll',
  'avutil-59.dll',
  'swscale-8.dll',
  'swresample-5.dll',
];

const REQUIRED_PLUGINS = [
  'libgstcoreelements.dll',
  'libgsttypefindfunctions.dll',
  'libgstplayback.dll',
  'libgstrawparse.dll',
  'libgstvideorate.dll',
  'libgstaudioconvert.dll',
  'libgstaudioresample.dll',
  'libgstapp.dll',
  'libgsttcp.dll',
  'libgstudp.dll',
  'libgstrtp.dll',
  'libgstrtsp.dll',
  'libgstautodetect.dll',
  'libgstlevel.dll',
  'libgstvolume.dll',
  'libgstlibav.dll',
  'libgstvideoparsersbad.dll',
];

const OPTIONAL_SCANNER_CANDIDATES = [
  'gst-plugin-scanner.exe',
  path.join('libexec', 'gstreamer-1.0', 'gst-plugin-scanner.exe'),
  path.join('lib', 'gstreamer-1.0', 'gst-plugin-scanner.exe'),
];

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFileIfChanged(sourcePath, targetPath) {
  const sourceStats = fs.statSync(sourcePath);
  if (fs.existsSync(targetPath)) {
    const targetStats = fs.statSync(targetPath);
    if (
      targetStats.size === sourceStats.size &&
      targetStats.mtimeMs >= sourceStats.mtimeMs
    ) {
      return false;
    }
  }

  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function removeUnexpectedPlugins(curatedPluginDir) {
  if (!fs.existsSync(curatedPluginDir)) {
    return;
  }

  for (const entry of fs.readdirSync(curatedPluginDir)) {
    if (!entry.toLowerCase().endsWith('.dll')) {
      continue;
    }

    if (!REQUIRED_PLUGINS.includes(entry)) {
      fs.rmSync(path.join(curatedPluginDir, entry), { force: true });
    }
  }
}

function findPluginScanner(bridgeDir) {
  for (const candidate of OPTIONAL_SCANNER_CANDIDATES) {
    const candidatePath = path.join(bridgeDir, candidate);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

function ensureCuratedPluginDirectory(bridgeDir, sourcePluginDir = null) {
  const pluginDir = sourcePluginDir || path.join(bridgeDir, 'lib', 'gstreamer-1.0');
  const curatedPluginDir = path.join(bridgeDir, 'lib', 'echo-gstreamer-plugins');

  if (!fs.existsSync(pluginDir)) {
    throw new Error(`GStreamer plugin directory not found at ${pluginDir}`);
  }

  ensureDirectory(curatedPluginDir);
  removeUnexpectedPlugins(curatedPluginDir);

  const missingPlugins = [];
  const copiedPlugins = [];

  for (const pluginName of REQUIRED_PLUGINS) {
    const sourcePath = path.join(pluginDir, pluginName);
    const targetPath = path.join(curatedPluginDir, pluginName);

    if (!fs.existsSync(sourcePath)) {
      missingPlugins.push(pluginName);
      continue;
    }

    if (copyFileIfChanged(sourcePath, targetPath)) {
      copiedPlugins.push(pluginName);
    }
  }

  return {
    pluginDir,
    curatedPluginDir,
    copiedPlugins,
    missingPlugins,
  };
}

function validateRequiredFiles(bridgeDir, pluginDir) {
  return {
    missingRuntimeFiles: REQUIRED_RUNTIME_FILES.filter((fileName) => !fs.existsSync(path.join(bridgeDir, fileName))),
    missingPlugins: REQUIRED_PLUGINS.filter((fileName) => !fs.existsSync(path.join(pluginDir, fileName))),
  };
}

function buildWindowsRuntimeEnv(bridgeExe, baseEnv = process.env) {
  const bridgeDir = path.dirname(bridgeExe);
  const runtimePaths = ensureCuratedPluginDirectory(bridgeDir);
  const missing = validateRequiredFiles(bridgeDir, runtimePaths.pluginDir);

  if (missing.missingRuntimeFiles.length || missing.missingPlugins.length) {
    const lines = [
      ...missing.missingRuntimeFiles.map((fileName) => `runtime file: ${fileName}`),
      ...missing.missingPlugins.map((fileName) => `plugin: ${fileName}`),
    ];
    throw new Error(`Windows bridge package is incomplete.\nMissing files:\n- ${lines.join('\n- ')}`);
  }

  const scannerPath = findPluginScanner(bridgeDir);
  const env = {
    ...baseEnv,
    PATH: `${bridgeDir}${path.delimiter}${baseEnv.PATH || ''}`,
    GST_PLUGIN_PATH: runtimePaths.curatedPluginDir,
    GST_PLUGIN_SYSTEM_PATH_1_0: runtimePaths.curatedPluginDir,
    GST_REGISTRY: path.join(os.tmpdir(), `gst-registry-echo-ios-dependencies-${process.pid}.bin`),
    GST_REGISTRY_FORK: 'no',
    ORC_CODE: baseEnv.ORC_CODE || 'backup',
  };

  if (scannerPath) {
    env.GST_PLUGIN_SCANNER = scannerPath;
  }

  return {
    ...runtimePaths,
    bridgeDir,
    env,
    scannerPath,
  };
}

module.exports = {
  REQUIRED_RUNTIME_FILES,
  REQUIRED_PLUGINS,
  buildWindowsRuntimeEnv,
  ensureCuratedPluginDirectory,
};
