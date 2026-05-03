#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const archiver = require('archiver');
const {
  DEFAULT_TARGET_URL,
  detectChromeExecutable,
  detectFfmpegExecutable,
} = require('./trust-checker-core');

const ROOT_DIR = __dirname;
const NODE_MODULES_DIR = path.join(ROOT_DIR, 'node_modules');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const args = minimist(process.argv.slice(2), {
  string: ['name', 'outDir', 'zipPath', 'targetUrl', 'chromePath', 'ffmpegPath', 'port'],
  boolean: ['zip', 'copyNodeModules', 'copyChrome', 'copyFfmpeg', 'help'],
  default: {
    name: `QingxiFlowTrustChecker-portable-${process.platform}-${process.arch}`,
    zip: true,
    copyNodeModules: true,
    copyChrome: true,
    copyFfmpeg: true,
    port: '3399',
    targetUrl: DEFAULT_TARGET_URL,
  },
});

function printHelp() {
  console.log(`QingxiFlow Trust Checker release builder

Usage:
  npm run trust:checker:release
  npm run trust:checker:release -- --targetUrl https://www.qingxiflow.com/app

Options:
  --name             Output folder base name
  --outDir           Release directory path
  --zipPath          Zip file output path
  --targetUrl        Default audited site URL
  --chromePath       Chrome or Chromium binary to bundle
  --ffmpegPath       ffmpeg binary to bundle
  --port             GUI default port
  --no-zip           Skip zip generation
  --no-copyNodeModules  Skip copying local node_modules
  --no-copyChrome    Skip bundling Chrome runtime
  --no-copyFfmpeg    Skip bundling ffmpeg runtime
  --help             Show this help
`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function cleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function copyFileWithMode(sourcePath, destinationPath) {
  ensureDir(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath);
  const stat = fs.statSync(sourcePath);
  fs.chmodSync(destinationPath, stat.mode);
}

function copyDirFiltered(sourcePath, destinationPath, filter) {
  fs.cpSync(sourcePath, destinationPath, {
    recursive: true,
    filter,
  });
}

function findMacAppBundle(binaryPath) {
  const normalized = path.resolve(binaryPath);
  const appIndex = normalized.indexOf('.app' + path.sep);
  if (appIndex === -1) return null;
  return normalized.slice(0, appIndex + 4);
}

function makeExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    fs.chmodSync(filePath, stat.mode | 0o111);
  } catch (_) {}
}

function detectOptionalBinary(userPath, detector, enabled) {
  if (!enabled) return null;
  if (userPath) return path.resolve(userPath);
  try {
    return detector();
  } catch (_) {
    return null;
  }
}

function copyChromeRuntime(sourcePath, runtimeDir) {
  if (!sourcePath) return null;
  const chromeDir = ensureDir(path.join(runtimeDir, 'chrome'));
  if (process.platform === 'darwin') {
    const appBundle = findMacAppBundle(sourcePath);
    if (appBundle) {
      const destinationBundle = path.join(chromeDir, path.basename(appBundle));
      copyDirFiltered(appBundle, destinationBundle, () => true);
      return path.join(destinationBundle, path.relative(appBundle, sourcePath));
    }
  }
  const destinationPath = path.join(chromeDir, path.basename(sourcePath));
  copyFileWithMode(sourcePath, destinationPath);
  return destinationPath;
}

function copyBinaryRuntime(sourcePath, runtimeDir, folderName) {
  if (!sourcePath) return null;
  const targetDir = ensureDir(path.join(runtimeDir, folderName));
  const destinationPath = path.join(targetDir, path.basename(sourcePath));
  copyFileWithMode(sourcePath, destinationPath);
  return destinationPath;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function batchQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function writeLaunchers(releaseDir, options) {
  const relativeNode = options.nodeBinary ? path.relative(releaseDir, options.nodeBinary) : null;
  const relativeChrome = options.chromeRuntimePath ? path.relative(releaseDir, options.chromeRuntimePath) : null;
  const shellChrome = relativeChrome ? `  --chromePath "$ROOT/${relativeChrome.split(path.sep).join('/')}" \\
` : '';
  const shellLauncher = `#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="${relativeNode ? `$ROOT/${relativeNode.split(path.sep).join('/')}` : ''}"

if [[ -z "${relativeNode ? 'x' : ''}" || ! -x "$NODE_BIN" ]]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  else
    echo "Node.js not found. Install Node.js or rebuild this release bundle."
    exit 1
  fi
fi

mkdir -p "$ROOT/artifacts"
cd "$ROOT"
exec "$NODE_BIN" "$ROOT/trust-checker-gui.js" \
  --host 127.0.0.1 \
  --port ${options.port} \
  --targetUrl ${shellQuote(options.targetUrl)} \
  --outputRoot "$ROOT/artifacts" \
${shellChrome}  "$@"
`;

  const batchChrome = relativeChrome ? ` --chromePath ${batchQuote(`%ROOT%${path.sep}${relativeChrome}`)}` : '';
  const batchLauncher = `@echo off
setlocal
set ROOT=%~dp0
set NODE_BIN=${relativeNode ? batchQuote(`%ROOT%${path.sep}${relativeNode}`) : 'node'}
if not exist %NODE_BIN% set NODE_BIN=node
if not exist "%ROOT%artifacts" mkdir "%ROOT%artifacts"
cd /d "%ROOT%"
%NODE_BIN% "trust-checker-gui.js" --host 127.0.0.1 --port ${options.port} --targetUrl ${batchQuote(options.targetUrl)} --outputRoot "%ROOT%artifacts"${batchChrome} %*
`;

  const macLauncher = path.join(releaseDir, 'Launch Trust Checker.command');
  const linuxLauncher = path.join(releaseDir, 'launch-trust-checker.sh');
  const windowsLauncher = path.join(releaseDir, 'Launch Trust Checker.bat');
  fs.writeFileSync(macLauncher, shellLauncher);
  fs.writeFileSync(linuxLauncher, shellLauncher);
  fs.writeFileSync(windowsLauncher, batchLauncher);
  makeExecutable(macLauncher);
  makeExecutable(linuxLauncher);
}

function writeReleaseReadme(releaseDir, options) {
  const lines = [
    'QingxiFlow Trust Checker Portable Release',
    '=========================================',
    '',
    'Use one of the launchers in this folder to start the GUI.',
    '',
    `Default target URL: ${options.targetUrl}`,
    `Default port: ${options.port}`,
    '',
    'Included components:',
    `- Node.js runtime: ${options.nodeBinary ? 'bundled' : 'not bundled'}`,
    `- Chrome/Chromium runtime: ${options.chromeRuntimePath ? 'bundled' : 'not bundled'}`,
    `- ffmpeg runtime: ${options.ffmpegRuntimePath ? 'bundled' : 'not bundled'}`,
    '',
    'Artifacts are written into the artifacts/ subfolder.',
    '',
    'Rebuild command:',
    'npm run trust:checker:release',
    '',
  ];
  fs.writeFileSync(path.join(releaseDir, 'README.txt'), `${lines.join('\n')}\n`);
}

function writeReleaseMetadata(releaseDir, options) {
  const payload = {
    createdAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    targetUrl: options.targetUrl,
    port: options.port,
    bundledNode: options.nodeBinary,
    bundledChrome: options.chromeRuntimePath,
    bundledFfmpeg: options.ffmpegRuntimePath,
  };
  fs.writeFileSync(path.join(releaseDir, 'release-meta.json'), JSON.stringify(payload, null, 2));
}

async function zipDirectory(sourceDir, zipPath) {
  ensureDir(path.dirname(zipPath));
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, path.basename(sourceDir));
    archive.finalize();
  });
}

async function main() {
  if (args.help) {
    printHelp();
    return;
  }
  if (!fs.existsSync(path.join(ROOT_DIR, 'trust-checker-core.js'))) {
    throw new Error(`Trust Checker source file not found in: ${ROOT_DIR}`);
  }
  if (!fs.existsSync(NODE_MODULES_DIR)) {
    throw new Error('node_modules is missing in docs/Trust_Checker. Run npm install in this folder before creating a release bundle.');
  }

  ensureDir(DIST_DIR);
  const releaseDir = path.resolve(args.outDir || path.join(DIST_DIR, args.name));
  const zipPath = path.resolve(args.zipPath || path.join(DIST_DIR, `${args.name}.zip`));
  const runtimeDir = path.join(releaseDir, 'runtime');

  const chromeSourcePath = detectOptionalBinary(args.chromePath, detectChromeExecutable, args.copyChrome);
  const ffmpegSourcePath = detectOptionalBinary(args.ffmpegPath, detectFfmpegExecutable, args.copyFfmpeg);
  const nodeSourcePath = fs.realpathSync(process.execPath);

  cleanDir(releaseDir);
  ensureDir(runtimeDir);
  ensureDir(path.join(releaseDir, 'artifacts'));

  for (const fileName of ['trust-checker-core.js', 'trust-checker.js', 'trust-checker-gui.js', 'README.md', 'package.json']) {
    copyFileWithMode(path.join(ROOT_DIR, fileName), path.join(releaseDir, fileName));
  }

  if (args.copyNodeModules) {
    copyDirFiltered(NODE_MODULES_DIR, path.join(releaseDir, 'node_modules'), (sourcePath) => {
      const rel = path.relative(NODE_MODULES_DIR, sourcePath);
      if (!rel) return true;
      const first = rel.split(path.sep)[0];
      if (first === '.cache' || first === '.bin' || first === 'playwright' || first === '@playwright') {
        return false;
      }
      return true;
    });
  }

  const nodeBinary = copyBinaryRuntime(nodeSourcePath, runtimeDir, 'node');
  const chromeRuntimePath = copyChromeRuntime(chromeSourcePath, runtimeDir);
  const ffmpegRuntimePath = copyBinaryRuntime(ffmpegSourcePath, runtimeDir, 'ffmpeg');

  writeLaunchers(releaseDir, {
    nodeBinary,
    chromeRuntimePath,
    ffmpegRuntimePath,
    targetUrl: args.targetUrl,
    port: args.port,
  });
  writeReleaseReadme(releaseDir, {
    nodeBinary,
    chromeRuntimePath,
    ffmpegRuntimePath,
    targetUrl: args.targetUrl,
    port: args.port,
  });
  writeReleaseMetadata(releaseDir, {
    nodeBinary,
    chromeRuntimePath,
    ffmpegRuntimePath,
    targetUrl: args.targetUrl,
    port: args.port,
  });

  if (args.zip) {
    await zipDirectory(releaseDir, zipPath);
  }

  console.log(`Release folder: ${releaseDir}`);
  if (args.zip) console.log(`Release zip: ${zipPath}`);
  console.log(`Bundled Node.js: ${nodeBinary || 'not copied'}`);
  console.log(`Bundled Chrome: ${chromeRuntimePath || 'not copied'}`);
  console.log(`Bundled ffmpeg: ${ffmpegRuntimePath || 'not copied'}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});