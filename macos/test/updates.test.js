'use strict';
// In-app updates: which release is the update, the checks a download must pass, the script that
// swaps the app, and the whole flow from a check to the install against fakes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const U = require('../src/core/updates');
const { Updater } = require('../src/main/updater');

const LEAF = U.LEAF;
const sha = (b) => require('crypto').createHash('sha256').update(b).digest('hex');

function release(tag, { prerelease = false, draft = false, arches = ['arm64', 'x64'], sums = true, body = 'What changed.' } = {}) {
  const version = tag.replace(/^mac-v|^v/, '');
  const assets = arches.map((a) => ({ name: `Dictate-and-Delegate-${version}-mac-${a}.zip`, browser_download_url: `https://dl.test/${tag}/${a}.zip`, size: 10, digest: '' }));
  if (sums) assets.push({ name: 'SHA256SUMS', browser_download_url: `https://dl.test/${tag}/SHA256SUMS`, size: 1 });
  return { tag_name: tag, prerelease, draft, body, html_url: `https://github.com/x/releases/tag/${tag}`, assets };
}

test('theUpdateIsTheNewestNormalMacReleaseForThisChip', () => {
  const releases = [
    release('mac-v0.3.0', { draft: true }),
    release('mac-v0.2.1', { prerelease: true }),
    release('v3.3.0'), // Android.
    release('mac-v0.1.3-beta.1'),
    release('mac-v0.2.0', { arches: ['x64'] }),
    release('mac-v0.1.9'),
  ];
  assert.equal(U.pick(releases, { arch: 'arm64' }).version, '0.1.9');
  const x64 = U.pick(releases, { arch: 'x64' });
  assert.equal(x64.version, '0.2.0');
  assert.equal(x64.zip.name, 'Dictate-and-Delegate-0.2.0-mac-x64.zip');
  assert.equal(x64.sums, 'https://dl.test/mac-v0.2.0/SHA256SUMS');
  assert.equal(x64.url, 'https://github.com/x/releases/tag/mac-v0.2.0');
  assert.equal(U.pick(releases, { arch: 'x64', current: '0.2.0' }), null, 'not newer than this one');
  assert.equal(U.pick(releases, { arch: 'x64', current: '0.1.3-beta.1' }).version, '0.2.0');
  assert.equal(U.pick([], { arch: 'arm64' }), null);
});

test('versionsCompareByNumberAndABetaComesBeforeItsRelease', () => {
  assert.equal(U.newer('0.2.0', '0.1.3'), true);
  assert.equal(U.newer('0.10.0', '0.9.9'), true);
  assert.equal(U.newer('0.1.3', '0.1.3'), false);
  assert.equal(U.newer('0.1.3', '0.1.3-beta.1'), true);
  assert.equal(U.newer('0.1.3-beta.1', '0.1.3'), false);
  assert.equal(U.newer('0.1.3-beta.2', '0.1.3-beta.1'), true);
  assert.equal(U.newer('1.0.0', 'nonsense'), false);
});

test('theChecksumComesFromSha256SumsOrGitHubsDigestElseThereIsNone', () => {
  const sums = `${'a'.repeat(64)}  Dictate-and-Delegate-0.2.0-mac-arm64.dmg\n${'B'.repeat(64)}  Dictate-and-Delegate-0.2.0-mac-arm64.zip\n`;
  assert.equal(U.expectedSha(sums, 'Dictate-and-Delegate-0.2.0-mac-arm64.zip'), 'b'.repeat(64));
  assert.equal(U.expectedSha('', 'x.zip', 'sha256:' + 'c'.repeat(64)), 'c'.repeat(64));
  assert.equal(U.expectedSha('garbage', 'x.zip', ''), null);
  assert.equal(U.expectedSha(sums, 'other.zip', 'md5:abc'), null);
});

test('theCertificateLeafIsReadFromCodesignAndTheNotesShortened', () => {
  const out = `Executable=/Applications/Dictate & Delegate.app/Contents/MacOS/Dictate & Delegate\ndesignated => identifier "app.driftdictation.mac" and certificate leaf = H"${LEAF.toUpperCase()}"\n`;
  assert.equal(U.leafOf(out), LEAF);
  assert.equal(U.leafOf('designated => anchor apple'), '');
  assert.equal(U.summary('## Download\nx'), '');
  assert.equal(U.summary('Fixes for 0.1.2: **Insert** works.\n\n- One\n- Two\n\n## Download\n- zip'), 'Fixes for 0.1.2: Insert works.\n- One\n- Two');
});

test('aDownloadThatIsntOursIsRefused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-verify-'));
  const app = path.join(dir, 'Dictate & Delegate.app');
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  const plist = (id, v) => `<plist><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>`;
  const exec = (leaf, verify = 0) => async (cmd, args) => (args[0] === '--verify' ? { code: verify, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: `designated => certificate leaf = H"${leaf}"` });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist('app.driftdictation.mac', '0.2.0'));
  assert.equal(await U.verifyApp(app, { exec: exec(LEAF), version: '0.2.0', leaf: LEAF }), true);
  await assert.rejects(U.verifyApp(app, { exec: exec(LEAF, 1), version: '0.2.0', leaf: LEAF }), /signature isn't valid/);
  await assert.rejects(U.verifyApp(app, { exec: exec('f'.repeat(40)), version: '0.2.0', leaf: LEAF }), /another certificate/);
  await assert.rejects(U.verifyApp(app, { exec: exec(LEAF), version: '0.2.1', leaf: LEAF }), /version 0.2.0, not 0.2.1/);
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist('com.example.other', '0.2.0'));
  await assert.rejects(U.verifyApp(app, { exec: exec(LEAF), version: '0.2.0', leaf: LEAF }), /isn't Dictate & Delegate/);
});

test('theInstallScriptSwapsTheAppAndStartsItWhateverThePathHolds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-swap-"));
  const apps = path.join(dir, "Apps & Tools 'here'");
  fs.mkdirSync(apps);
  const oldApp = path.join(apps, 'Dictate & Delegate.app');
  const newApp = path.join(dir, 'new', 'Dictate & Delegate.app');
  fs.mkdirSync(oldApp, { recursive: true });
  fs.mkdirSync(newApp, { recursive: true });
  fs.writeFileSync(path.join(oldApp, 'version'), 'old');
  fs.writeFileSync(path.join(newApp, 'version'), 'new');
  // open and xattr are stubs here: they write down what they got.
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const said = path.join(dir, 'said');
  for (const cmd of ['open', 'xattr']) fs.writeFileSync(path.join(bin, cmd), `#!/bin/sh\nprintf '%s|' ${cmd} "$@" >> '${said}'\necho >> '${said}'\n`, { mode: 0o755 });
  const script = path.join(dir, 'install.sh');
  fs.writeFileSync(script, U.installScript({ pid: 2147483646, oldApp, newApp, log: path.join(dir, 'install log.txt') }));
  execFileSync('/bin/sh', [script], { env: { ...process.env, PATH: bin + ':' + process.env.PATH } });
  assert.equal(fs.readFileSync(path.join(oldApp, 'version'), 'utf8'), 'new');
  assert.equal(fs.existsSync(newApp), false);
  assert.equal(fs.existsSync(oldApp + '.before-update'), false);
  assert.deepEqual(fs.readFileSync(said, 'utf8').trim().split('\n'), [`xattr|-dr|com.apple.quarantine|${oldApp}|`, `open|${oldApp}|`]);
  assert.match(fs.readFileSync(path.join(dir, 'install log.txt'), 'utf8'), /update: installed; starting it/);
});

/** A zip holding a minimal Dictate & Delegate.app of this version (made with Python's zipfile). */
function appZip(dir, version) {
  const src = path.join(dir, 'src');
  const app = path.join(src, 'Dictate & Delegate.app', 'Contents');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'Info.plist'), `<plist><dict><key>CFBundleIdentifier</key><string>app.driftdictation.mac</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  const zip = path.join(dir, 'app.zip');
  execFileSync('python3', ['-I', '-c', 'import shutil,sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])', zip, src]);
  return fs.readFileSync(zip);
}

function fakeGithub(files) {
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    if (!(url in files)) return new Response('not found', { status: 404 });
    const f = files[url];
    return f instanceof Response ? f : new Response(f, { status: 200, headers: { 'content-length': String(Buffer.byteLength(f)) } });
  };
  return { fetch, asked };
}

test('fromACheckToTheInstallEverythingIsCheckedBeforeTheAppQuits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-flow-'));
  const zip = appZip(dir, '0.2.0');
  const r = release('mac-v0.2.0', { body: 'In-app updates.\n\n## Download\n- zip' });
  const name = 'Dictate-and-Delegate-0.2.0-mac-arm64.zip';
  const { fetch, asked } = fakeGithub({
    'https://api.github.com/repos/Philipp258/dictate-and-delegate/releases?per_page=30': JSON.stringify([release('mac-v0.1.3-beta.1'), r]),
    'https://dl.test/mac-v0.2.0/SHA256SUMS': `${sha(zip)}  ${name}\n`,
    'https://dl.test/mac-v0.2.0/arm64.zip': zip,
  });
  const execs = [];
  const exec = async (cmd, args) => {
    execs.push(cmd + ' ' + args[0]);
    if (cmd === 'ditto') {
      execFileSync('python3', ['-I', '-m', 'zipfile', '-e', args[2], args[3]]);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === '--verify') return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: `designated => certificate leaf = H"${LEAF}"` };
  };
  const prefs = new Map();
  const apps = path.join(dir, 'Applications');
  fs.mkdirSync(path.join(apps, 'Dictate & Delegate.app'), { recursive: true });
  const notified = [], scripts = [];
  let quit = 0;
  const u = new Updater({
    prefs: { get: (k, d) => (prefs.has(k) ? prefs.get(k) : d), set: (k, v) => prefs.set(k, v) },
    version: '0.1.3',
    arch: 'arm64',
    appPath: path.join(apps, 'Dictate & Delegate.app'),
    fetch,
    exec,
    notify: (v) => notified.push(v),
    quit: () => quit++,
    platform: 'darwin',
    tmp: () => fs.mkdtempSync(path.join(dir, 'tmp-')),
    spawnScript: (f) => scripts.push(fs.readFileSync(f, 'utf8')),
  });
  const s = await u.check({ manual: false });
  assert.equal(s.available.version, '0.2.0');
  assert.equal(s.available.notes, 'In-app updates.');
  assert.deepEqual(notified, ['0.2.0'], 'announced once');
  await u.check({ manual: false });
  assert.deepEqual(notified, ['0.2.0'], 'not again for the same version');
  assert.ok(prefs.get('updateLastCheck') > 0);

  await u.install();
  assert.deepEqual(execs, ['ditto -x', 'codesign -d', 'codesign --verify', 'codesign -d']);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /mv '.*\/Applications\/Dictate & Delegate.app' /);
  assert.equal(u.state().installing, true);
  await new Promise((r2) => setTimeout(r2, 350));
  assert.equal(quit, 1, 'the app quits so the script can swap it');
  assert.ok(asked.includes('https://dl.test/mac-v0.2.0/arm64.zip'));
});

test('aDamagedDownloadOrAMissingChecksumIsNeverInstalled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-bad-'));
  const zip = appZip(dir, '0.2.0');
  const name = 'Dictate-and-Delegate-0.2.0-mac-arm64.zip';
  const api = 'https://api.github.com/repos/Philipp258/dictate-and-delegate/releases?per_page=30';
  const make = (files) =>
    new Updater({
      prefs: { get: (k, d) => d, set: () => {} },
      version: '0.1.3',
      arch: 'arm64',
      appPath: path.join(dir, 'Dictate & Delegate.app'),
      fetch: fakeGithub(files).fetch,
      exec: async () => assert.fail('nothing is unpacked'),
      platform: 'darwin',
      spawnScript: () => assert.fail('nothing is installed'),
      quit: () => assert.fail('the app stays'),
    });
  const damaged = make({ [api]: JSON.stringify([release('mac-v0.2.0')]), 'https://dl.test/mac-v0.2.0/SHA256SUMS': `${'0'.repeat(64)}  ${name}\n`, 'https://dl.test/mac-v0.2.0/arm64.zip': zip });
  await damaged.check();
  await assert.rejects(damaged.install(), /damaged/);
  assert.match(damaged.state().error, /damaged/);
  const unsummed = make({ [api]: JSON.stringify([release('mac-v0.2.0', { sums: false })]), 'https://dl.test/mac-v0.2.0/arm64.zip': zip });
  await unsummed.check();
  await assert.rejects(unsummed.install(), /no checksum/);
});

test('aFailedCheckIsQuietUnlessYouAskedForIt', async () => {
  const api = 'https://api.github.com/repos/Philipp258/dictate-and-delegate/releases?per_page=30';
  const logs = [];
  const make = (fetch) => new Updater({ prefs: { get: (k, d) => d, set: () => {} }, log: (l) => logs.push(l), version: '0.2.0', arch: 'arm64', appPath: '/x/D.app', fetch });
  const limited = make(async () => new Response('{}', { status: 403 }));
  assert.equal((await limited.check({ manual: false })).error, '');
  assert.match((await limited.check({ manual: true })).error, /GitHub limits checks/);
  const offline = make(async () => {
    throw new TypeError('fetch failed');
  });
  assert.match((await offline.check({ manual: true })).error, /No connection to GitHub/);
  assert.ok(logs.some((l) => /update: check failed \(rate-limited\)/.test(l)));
  const same = make(fakeGithub({ [api]: JSON.stringify([release('mac-v0.2.0')]) }).fetch);
  const s = await same.check();
  assert.equal(s.available, null);
  assert.equal(s.upToDate, true);
});
