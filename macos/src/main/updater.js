'use strict';
// In-app updates on the Mac: checks GitHub for a newer Mac release at start (when the last check
// is over 20 hours old) and once a day while it runs, or when you press Check for updates; on
// Update it downloads the zip for this Mac's chip, checks it (SHA-256, signature with the app's
// certificate, bundle ID, version), unpacks it, hands the swap to a small script and quits; the
// script puts the new app in place once this one has quit and starts it. Settings, keys and notes
// stay where they are (the app's data folder isn't touched). After an update macOS asks once
// whether the app may use its Keychain item (the app has no Apple Team ID): Always Allow.
//
// Nothing here imports Electron: main.js passes in fetch, exec, quitting, the notification and
// where the app is, so tests can drive all of it.

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const updates = require('../core/updates');

const LAST_CHECK = 'updateLastCheck';
const NOTIFIED = 'updateNotified';
const DAY_MS = 24 * 3600_000;
const STALE_MS = 20 * 3600_000;

/** exec that never throws: {code, stdout, stderr}. */
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }),
    );
  });
}

/** What a failed check says when you asked for it. */
function readable(error) {
  if (error === 'rate-limited') return 'GitHub limits checks right now. Try again in an hour.';
  if (error === 'offline') return 'No connection to GitHub. Check your internet connection.';
  if (error === 'unexpected answer') return 'GitHub sent something unexpected. Try again later.';
  return `GitHub answered with ${error}. Try again later.`;
}

class Updater extends EventEmitter {
  /**
   * prefs, log; version (this app's), arch ('arm64'|'x64'); appPath: the .app it runs from;
   * fetch, exec (cmd, args → {code, stdout, stderr}); notify(version): the macOS notification;
   * quit(): quits the app; platform; tmp(): a fresh temp dir.
   */
  constructor({ prefs, log = () => {}, version, arch = process.arch, appPath, fetch = (...a) => globalThis.fetch(...a), exec = run, notify = () => {}, quit = () => {}, platform = process.platform, now = () => Date.now(), tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dd-update-')), spawnScript }) {
    super();
    Object.assign(this, { prefs, log, version, arch, appPath, fetch, exec, notify, quit, platform, now, tmp });
    this.spawnScript = spawnScript || ((file) => spawn('/bin/sh', [file], { detached: true, stdio: 'ignore' }).unref());
    this.s = { checking: false, available: null, downloading: null, installing: false, error: '', upToDate: false, lastCheck: Number(prefs.get(LAST_CHECK, 0)) || 0 };
    this.timer = null;
  }

  /** What the window shows. */
  state() {
    const a = this.s.available;
    return {
      current: this.version,
      checking: this.s.checking,
      available: a && { version: a.version, notes: updates.summary(a.notes), url: a.url },
      downloading: this.s.downloading,
      installing: this.s.installing,
      error: this.s.error,
      upToDate: this.s.upToDate,
      lastCheck: this.s.lastCheck,
    };
  }

  changed() {
    this.emit('change', this.state());
  }

  /** At start: a check when the last one is over 20 h old, then one a day. */
  start() {
    if (this.now() - this.s.lastCheck > STALE_MS) this.check({ manual: false }).catch(() => {});
    this.timer = setInterval(() => this.check({ manual: false }).catch(() => {}), DAY_MS);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Looks for a newer release. An automatic check fails quietly (only the log says why) and
   * announces a new version once with a notification; a manual one says what went wrong.
   */
  async check({ manual = true } = {}) {
    if (this.s.checking) return this.state();
    this.s.checking = true;
    this.s.error = '';
    this.changed();
    try {
      const r = await updates.fetchReleases(this.fetch, { version: this.version });
      if (r.error) {
        this.log(`update: check failed (${r.error})`);
        if (manual) this.s.error = readable(r.error);
        return this.state();
      }
      this.s.lastCheck = this.now();
      this.prefs.set(LAST_CHECK, this.s.lastCheck);
      const found = updates.pick(r.releases, { arch: this.arch, current: this.version });
      this.s.available = found;
      this.s.upToDate = !found;
      if (found) {
        this.log(`update: ${found.version} available (this is ${this.version})`);
        if (!manual && this.prefs.get(NOTIFIED, '') !== found.version) {
          this.prefs.set(NOTIFIED, found.version);
          try {
            this.notify(found.version);
          } catch {}
        }
      }
      return this.state();
    } finally {
      this.s.checking = false;
      this.changed();
    }
  }

  /** Downloads into a buffer with progress (received, total bytes). */
  async download(url, total) {
    const res = await this.fetch(url, { headers: { 'User-Agent': 'Dictate-and-Delegate-mac/' + this.version }, redirect: 'follow' });
    if (!res.ok) throw new Error(`The download failed (HTTP ${res.status}).`);
    const size = Number(res.headers && res.headers.get && res.headers.get('content-length')) || total || 0;
    if (!res.body || !res.body.getReader) {
      const b = Buffer.from(await res.arrayBuffer());
      this.s.downloading = { received: b.length, total: size || b.length };
      this.changed();
      return b;
    }
    const reader = res.body.getReader();
    const parts = [];
    let received = 0, shown = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
      received += value.length;
      // Every 2 % or so: enough for the bar.
      if (!size || received - shown >= size / 50) {
        shown = received;
        this.s.downloading = { received, total: size };
        this.changed();
      }
    }
    this.s.downloading = { received, total: size || received };
    this.changed();
    return Buffer.concat(parts);
  }

  /**
   * Update: download, check and unpack the new version, then hand the swap to the install script
   * and quit. Throws a readable error; nothing is replaced until every check passed.
   */
  async install() {
    const a = this.s.available;
    if (!a) throw new Error('No update to install. Check for updates first.');
    if (this.s.downloading || this.s.installing) throw new Error('The update is already on its way.');
    this.s.error = '';
    this.s.downloading = { received: 0, total: a.zip.size };
    this.changed();
    let dir = '';
    try {
      const appPath = this.appPath;
      const parent = path.dirname(appPath);
      try {
        fs.accessSync(parent, fs.constants.W_OK);
      } catch {
        throw new Error(`Dictate & Delegate can't replace itself in ${parent}. Move it to Applications, then update.`);
      }
      // The checksum first: without one the download isn't installed.
      let sums = '';
      if (a.sums) {
        const r = await this.fetch(a.sums, { headers: { 'User-Agent': 'Dictate-and-Delegate-mac/' + this.version } });
        if (r.ok) sums = await r.text();
      }
      const want = updates.expectedSha(sums, a.zip.name, a.zip.digest);
      if (!want) throw new Error('The release has no checksum for this download; the update wasn\'t installed.');
      const zip = await this.download(a.zip.url, a.zip.size);
      const got = updates.sha256(zip);
      if (got !== want) throw new Error('The download is damaged (its checksum doesn\'t match); the update wasn\'t installed. Try again.');
      dir = this.tmp();
      const file = path.join(dir, a.zip.name);
      fs.writeFileSync(file, zip);
      const unpacked = path.join(dir, 'app');
      fs.mkdirSync(unpacked);
      const x = await this.exec('ditto', ['-x', '-k', file, unpacked]);
      if (x.code !== 0) throw new Error('The download couldn\'t be unpacked; the update wasn\'t installed.');
      const name = fs.readdirSync(unpacked).find((n) => n.endsWith('.app'));
      if (!name) throw new Error('The download holds no app; the update wasn\'t installed.');
      const newApp = path.join(unpacked, name);
      const leaf = await updates.runningLeaf(appPath, this.exec);
      await updates.verifyApp(newApp, { exec: this.exec, version: a.version, leaf });
      this.log(`update: ${a.version} downloaded and checked (SHA-256, signature ${leaf.slice(0, 8)}…, bundle, version)`);
      if (this.platform !== 'darwin') throw new Error('Installing an update works on macOS only.');
      const script = path.join(dir, 'install.sh');
      fs.writeFileSync(script, updates.installScript({ pid: process.pid, oldApp: appPath, newApp, log: path.join(dir, 'install.log') }), { mode: 0o700 });
      this.s.installing = true;
      this.s.downloading = null;
      this.changed();
      this.spawnScript(script);
      this.log(`update: installing ${a.version}; quitting so it can replace the app`);
      setTimeout(() => this.quit(), 300);
      return this.state();
    } catch (e) {
      this.s.downloading = null;
      this.s.installing = false;
      this.s.error = e.message;
      this.log(`update: not installed (${e.message})`);
      if (dir && !this.s.installing) fs.rmSync(dir, { recursive: true, force: true });
      this.changed();
      throw e;
    }
  }
}

/** The .app a running Electron app is in (…/X.app/Contents/MacOS/X → …/X.app). */
function appPathOf(exe) {
  return path.resolve(exe, '..', '..', '..');
}

module.exports = { Updater, appPathOf, run, readable, LAST_CHECK, NOTIFIED };
