#!/usr/bin/env node
'use strict';
// Builds the signed macOS app on Linux: stages the app, wraps it in Electron for macOS with
// @electron/packager (no signing there), signs everything with rcodesign and the one stable
// self-made certificate, and zips it (symlinks kept, as Electron's frameworks need them).
//
//   node scripts/package.js [--arch arm64,x64] [--out <dir>]
//
// Environment: DD_SIGNING_PEM (certificate + key, PEM), RCODESIGN (path to rcodesign).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const BUNDLE_ID = 'app.driftdictation.mac';
const NAME = 'Dictate & Delegate';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const arches = arg('arch', 'arm64,x64').split(',');
const outDir = path.resolve(arg('out', path.join(ROOT, 'dist')));
const pem = process.env.DD_SIGNING_PEM;
const rcodesign = process.env.RCODESIGN || 'rcodesign';

function run(cmd, args, opts = {}) {
  const out = execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts });
  return out ? out.toString() : '';
}

function copy(from, to, filter = () => true) {
  fs.cpSync(from, to, { recursive: true, filter, verbatimSymlinks: true });
}

/** The app as it goes into Resources/app.asar: code, assets, production modules only. */
function stage() {
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  run('python3', [path.join(__dirname, 'make-icons.py'), path.join(ROOT, 'build')]);
  const dir = path.join(ROOT, 'build', 'stage');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { devDependencies, scripts, ...rest } = pkg;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(rest, null, 2));
  copy(path.join(ROOT, 'src'), path.join(dir, 'src'));
  copy(path.join(ROOT, '..', 'app', 'src', 'main', 'assets'), path.join(dir, 'assets'));
  for (const f of ['trayTemplate.png', 'trayTemplate@2x.png', 'icon.png'])
    fs.copyFileSync(path.join(ROOT, 'build', f), path.join(dir, 'src', 'renderer', f));
  // ws is plain JS; koffi only needs its loader and the two macOS builds.
  copy(path.join(ROOT, 'node_modules', 'ws'), path.join(dir, 'node_modules', 'ws'));
  const koffi = path.join(ROOT, 'node_modules', 'koffi');
  copy(koffi, path.join(dir, 'node_modules', 'koffi'), (src) => {
    const rel = path.relative(koffi, src);
    if (rel.startsWith('src') || rel.startsWith('vendor') || rel.startsWith('doc')) return false;
    const m = /^build[/\\]koffi[/\\]([^/\\]+)/.exec(rel);
    return !m || m[1].startsWith('darwin_');
  });
  return dir;
}

async function wrap(dir, arch) {
  const { packager } = require('@electron/packager');
  const [appPath] = await packager({
    dir,
    out: path.join(ROOT, 'build', 'out'),
    overwrite: true,
    platform: 'darwin',
    arch,
    name: NAME,
    executableName: NAME,
    appBundleId: BUNDLE_ID,
    helperBundleId: BUNDLE_ID + '.helper',
    appVersion: pkg.version,
    buildVersion: pkg.version,
    appCategoryType: 'public.app-category.productivity',
    appCopyright: 'MIT License, Philipp258',
    icon: path.join(ROOT, 'build', 'icon.icns'),
    electronVersion: require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version,
    asar: { unpack: '**/*.node' },
    prune: false,
    osxSign: false,
    darwinDarkModeSupport: true,
    protocols: [{ name: 'Dictate & Delegate sign-in', schemes: ['talkrouter'] }],
    extendInfo: {
      LSUIElement: true,
      LSMinimumSystemVersion: '12.0',
      NSMicrophoneUsageDescription:
        'Dictate & Delegate records your voice while you dictate or are in a hands-free call, and sends it to the speech model you chose.',
      NSHumanReadableCopyright: 'MIT License',
      // Alerts (not banners): notifications with buttons (Insert / Copy) need this.
      NSUserNotificationAlertStyle: 'alert',
    },
  });
  return path.join(appPath, NAME + '.app');
}

/** Every Mach-O in the bundle (koffi's .node files too: arm64 Macs load only signed code). */
function sign(app) {
  if (!pem) throw new Error('DD_SIGNING_PEM is not set');
  const tmp = path.join(ROOT, 'build', 'req');
  fs.mkdirSync(tmp, { recursive: true });
  const { requirement, derOf } = require('./requirement');
  const der = derOf(fs.readFileSync(pem, 'utf8'));
  const crypto = require('crypto');
  const leaf = crypto.createHash('sha1').update(der).digest('hex');
  // The main app: identifier + our certificate. Nested code (helpers, frameworks, dylibs,
  // koffi): our certificate, whatever its identifier.
  const mainReq = path.join(tmp, 'main.bin');
  fs.writeFileSync(mainReq, requirement(BUNDLE_ID, der));
  const nestedReq = path.join(tmp, 'nested.bin');
  fs.writeFileSync(nestedReq, leafOnly(leaf));
  const args = ['sign', '--pem-file', pem, '--code-requirements-file', nestedReq];
  for (const nested of nestedPaths(app)) args.push('--code-requirements-file', `${nested}:${nestedReq}`);
  args.push('--code-requirements-file', `${path.join('Contents', 'MacOS', NAME)}:${mainReq}`);
  args.push(app);
  run(rcodesign, args, { stdio: 'inherit' });
}

/** certificate leaf = H"…", in Apple's binary form. */
function leafOnly(sha1hex) {
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
  };
  const hash = Buffer.from(sha1hex, 'hex');
  const expr = Buffer.concat([u32(4), u32(0), u32(hash.length), hash]);
  return Buffer.concat([u32(0xfade0c00 | 0), u32(12 + expr.length), u32(1), expr]);
}

function nestedPaths(app) {
  const out = [];
  const fw = path.join(app, 'Contents', 'Frameworks');
  for (const f of fs.readdirSync(fw)) out.push(path.join('Contents', 'Frameworks', f));
  return out;
}

/** A zip like `ditto -c -k --keepParent`: symlinks stored as links, modes kept. */
function zip(app, file) {
  run('python3', [path.join(__dirname, 'zip-app.py'), app, file], { stdio: 'inherit' });
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const dir = stage();
  if (process.argv.includes('--stage-only')) return console.log('staged', dir);
  for (const arch of arches) {
    const app = await wrap(dir, arch);
    sign(app);
    const name = `Dictate-and-Delegate-${pkg.version}-mac-${arch}`;
    zip(app, path.join(outDir, name + '.zip'));
    console.log('built', path.join(outDir, name + '.zip'));
    if (process.argv.includes('--dmg')) {
      run(path.join(__dirname, 'make-dmg.sh'), [app, path.join(outDir, name + '.dmg')], { stdio: 'inherit' });
      console.log('built', path.join(outDir, name + '.dmg'));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
