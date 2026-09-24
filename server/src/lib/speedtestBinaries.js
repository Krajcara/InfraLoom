'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const decompress = require('decompress');
const decompressTargz = require('decompress-targz');
const decompressUnzip = require('decompress-unzip');

const BIN_DIR = path.join(__dirname, '../../../data/bin');
fs.mkdirSync(BIN_DIR, { recursive: true });

const OOKLA_VERSION = '1.2.0';
const OOKLA_LIST = [
  { os: 'linux', arch: 'x64', suffix: 'linux-x86_64.tgz' },
  { os: 'linux', arch: 'arm64', suffix: 'linux-aarch64.tgz' },
  { os: 'linux', arch: 'arm', suffix: 'linux-armhf.tgz' },
  { os: 'darwin', arch: 'x64', suffix: 'macosx-x86_64.tgz' },
  { os: 'darwin', arch: 'arm64', suffix: 'macosx-x86_64.tgz' }, // Ookla ships a universal-ish x64 build that runs under Rosetta
  { os: 'win32', arch: 'x64', suffix: 'win64.zip' },
];
const OOKLA_URL_BASE = `https://install.speedtest.net/app/cli/ookla-speedtest-${OOKLA_VERSION}-`;

const LIBRE_VERSION = '1.0.10';
const LIBRE_LIST = [
  { os: 'linux', arch: 'x64', suffix: 'linux_amd64.tar.gz' },
  { os: 'linux', arch: 'arm64', suffix: 'linux_arm64.tar.gz' },
  { os: 'linux', arch: 'arm', suffix: 'linux_armv7.tar.gz' },
  { os: 'darwin', arch: 'x64', suffix: 'darwin_amd64.tar.gz' },
  { os: 'darwin', arch: 'arm64', suffix: 'darwin_arm64.tar.gz' },
  { os: 'win32', arch: 'x64', suffix: 'windows_amd64.zip' },
];
const LIBRE_URL_BASE = `https://github.com/librespeed/speedtest-cli/releases/download/v${LIBRE_VERSION}/librespeed-cli_${LIBRE_VERSION}_`;

function tmpFile(suffix = '') {
  return path.join(os.tmpdir(), crypto.randomBytes(16).toString('hex') + suffix);
}

function downloadToFile(url, destPath, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(downloadToFile(res.headers.location, destPath, redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed: ${url} returned ${res.statusCode}`));
        }
        const ws = fs.createWriteStream(destPath);
        res.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function ensureBinary({ name, list, urlBase, binaryRegex }) {
  const binaryName = `${name}${process.platform === 'win32' ? '.exe' : ''}`;
  const binaryPath = path.join(BIN_DIR, binaryName);
  if (fs.existsSync(binaryPath)) return binaryPath;

  const match = list.find((b) => b.os === process.platform && b.arch === process.arch);
  if (!match) {
    throw new Error(`${name}: platform ${process.platform}-${process.arch} is not supported by the official CLI`);
  }

  const archivePath = tmpFile(`-${match.suffix}`);
  await downloadToFile(urlBase + match.suffix, archivePath);
  await decompress(archivePath, BIN_DIR, {
    plugins: [decompressTargz(), decompressUnzip()],
    filter: (file) => binaryRegex.test(file.path),
    map: (file) => {
      file.path = binaryName;
      return file;
    },
  });
  fs.rmSync(archivePath, { force: true });

  // Explicit defense-in-depth against decompress's disclosed Zip Slip CVE
  // (GHSA-mp2f-45pm-3cg9, no upstream fix available): even though the
  // anchored filter regex above already rejects any path-traversal entry
  // before it's written, this makes the containment check explicit rather
  // than relying solely on that regex being correct forever.
  if (path.resolve(binaryPath) !== path.resolve(BIN_DIR, binaryName) || !path.resolve(binaryPath).startsWith(path.resolve(BIN_DIR) + path.sep)) {
    fs.rmSync(binaryPath, { force: true });
    throw new Error(`${name}: extracted file resolved outside the expected binary directory — refusing to use it`);
  }
  fs.chmodSync(binaryPath, 0o755);

  if (!fs.existsSync(binaryPath)) throw new Error(`${name}: extraction did not produce a binary`);
  return binaryPath;
}

async function ensureOokla() {
  return ensureBinary({ name: 'speedtest', list: OOKLA_LIST, urlBase: OOKLA_URL_BASE, binaryRegex: /^speedtest(\.exe)?$/ });
}

async function ensureLibrespeed() {
  return ensureBinary({ name: 'librespeed-cli', list: LIBRE_LIST, urlBase: LIBRE_URL_BASE, binaryRegex: /^librespeed-cli(\.exe)?$/ });
}

module.exports = { ensureOokla, ensureLibrespeed, BIN_DIR };
