'use strict';
// Updates from the app itself: the releases on GitHub (anonymous API requests, nothing else is
// sent), the newest Mac release for this Mac's chip, and the checks a download must pass before it
// replaces the app: its SHA-256 from the release's SHA256SUMS (or GitHub's digest), a valid code
// signature with the app's one certificate, the bundle ID and the version. The swap itself is a
// small shell script that runs once the app has quit (installScript). The main process drives it
// (src/main/updater.js); everything here takes its fetch and exec, so tests can fake them.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const netLog = require('./net-log');

const REPO = 'Philipp258/dictate-and-delegate';
const BUNDLE_ID = 'app.driftdictation.mac';
/** SHA-1 of the app's one signing certificate: every build is signed with it. */
const LEAF = '2943f210a642446bb0676f78109a3c8810fed11f';

function apiBase() {
  return (process.env.DD_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
}

// ------------------------------------------------------------------ versions

/** "0.2.0" → {nums: [0, 2, 0], pre: ""}; "0.1.3-beta.1" → pre "beta.1". null if it isn't one. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' } : null;
}

/** Is a newer than b? x.y.z by number; a pre-release ("-beta.1") comes before its plain version. */
function newer(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i];
  if (x.pre === y.pre) return false;
  if (!x.pre) return true;
  if (!y.pre) return false;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0;
}

// ------------------------------------------------------------------ the releases

/**
 * The repository's releases, newest first: {releases} or a quiet {error: 'rate-limited' |
 * 'offline' | 'HTTP n' | 'unexpected answer'}. Anonymous: no token, no cookie.
 */
async function fetchReleases(fetch, { version = '', timeoutMs = 15_000 } = {}) {
  const url = apiBase() + '/repos/' + REPO + '/releases?per_page=30';
  try {
    return await netLog.request('update check', 'GET', url, async (net) => {
      const res = await fetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Dictate-and-Delegate-mac/' + version },
        signal: AbortSignal.timeout(timeoutMs),
      });
      net.status(res.status);
      if (res.status === 403 || res.status === 429) return { error: 'rate-limited' };
      if (!res.ok) return { error: 'HTTP ' + res.status };
      const text = await res.text();
      net.received(Buffer.byteLength(text, 'utf8'));
      let list;
      try {
        list = JSON.parse(text);
      } catch {
        return { error: 'unexpected answer' };
      }
      return Array.isArray(list) ? { releases: list } : { error: 'unexpected answer' };
    });
  } catch {
    return { error: 'offline' };
  }
}

/** The zip a Mac with this chip installs: Dictate-and-Delegate-<version>-mac-<arch>.zip. */
function zipName(version, arch) {
  return `Dictate-and-Delegate-${version}-mac-${arch}.zip`;
}

/**
 * The newest normal Mac release with a zip for this chip (no drafts, no pre-releases, tags
 * mac-vX.Y.Z only), or null; with current, only one newer than it. {version, tag, notes, url,
 * zip: {name, url, size, digest}, sums: the SHA256SUMS asset's URL or null}.
 */
function pick(releases, { arch, current = '' } = {}) {
  let best = null;
  for (const r of releases || []) {
    if (!r || r.draft || r.prerelease) continue;
    const m = /^mac-v(\d+\.\d+\.\d+)$/.exec(String(r.tag_name || ''));
    if (!m) continue;
    const version = m[1];
    const assets = Array.isArray(r.assets) ? r.assets : [];
    const zip = assets.find((a) => a && a.name === zipName(version, arch));
    if (!zip) continue;
    if (best && !newer(version, best.version)) continue;
    const sums = assets.find((a) => a && a.name === 'SHA256SUMS');
    best = {
      version,
      tag: r.tag_name,
      notes: String(r.body || ''),
      url: String(r.html_url || ''),
      zip: { name: zip.name, url: zip.browser_download_url, size: Number(zip.size) || 0, digest: String(zip.digest || '') },
      sums: sums ? sums.browser_download_url : null,
    };
  }
  if (best && current && !newer(best.version, current)) return null;
  return best;
}

/**
 * The SHA-256 a file must have: from SHA256SUMS ("<hex>  <name>" lines), else from GitHub's
 * asset digest ("sha256:<hex>"); null when neither says, and then it isn't installed.
 */
function expectedSha(sumsText, name, digest = '') {
  for (const l of String(sumsText || '').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(l.trim());
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  const d = /^sha256:([0-9a-f]{64})$/i.exec(String(digest || '').trim());
  return d ? d[1].toLowerCase() : null;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** The first lines of the release notes, for the banner: plain text, at most max characters. */
function summary(notes, max = 280) {
  const lines = String(notes || '')
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/`/g, '').trim())
    .filter((l) => l && !/^```/.test(l));
  let out = '';
  for (const l of lines) {
    if (/^(download|sha256sums?)$/i.test(l)) break;
    const next = out ? out + '\n' + l : l;
    if (next.length > max) return (out || l.slice(0, max - 1)) + '…';
    out = next;
  }
  return out;
}

// ------------------------------------------------------------------ the downloaded app

/** The certificate leaf hash in `codesign -d -r-` output ("certificate leaf = H"<hex>""), or "". */
function leafOf(text) {
  const m = /certificate leaf = H"([0-9a-f]{40})"/i.exec(String(text || ''));
  return m ? m[1].toLowerCase() : '';
}

/** A plist value (XML plists, as Electron's packager writes them). */
function plistString(xml, key) {
  const m = new RegExp('<key>' + key + '</key>\\s*<string>([^<]*)</string>').exec(String(xml || ''));
  return m ? m[1] : '';
}

/**
 * The running app's certificate leaf (codesign of the .app it runs from), else LEAF: an update
 * must be signed with the same certificate, or macOS would treat it as another app.
 */
async function runningLeaf(appPath, exec) {
  try {
    const r = await exec('codesign', ['-d', '-r-', appPath]);
    return leafOf(r.stdout + '\n' + r.stderr) || LEAF;
  } catch {
    return LEAF;
  }
}

/**
 * Checks an unpacked .app before it replaces this one: a valid signature (codesign --verify
 * --deep --strict), the same certificate, the bundle ID and the release's version. Throws a
 * readable error when one fails.
 */
async function verifyApp(appPath, { exec, version, leaf, readFile = (f) => fs.readFileSync(f, 'utf8') }) {
  const check = await exec('codesign', ['--verify', '--deep', '--strict', appPath]);
  if (check.code !== 0) throw new Error('The download\'s code signature isn\'t valid; the update wasn\'t installed.');
  const req = await exec('codesign', ['-d', '-r-', appPath]);
  const got = leafOf(req.stdout + '\n' + req.stderr);
  if (!got || got !== String(leaf || LEAF).toLowerCase())
    throw new Error('The download is signed with another certificate; the update wasn\'t installed.');
  const plist = readFile(path.join(appPath, 'Contents', 'Info.plist'));
  if (plistString(plist, 'CFBundleIdentifier') !== BUNDLE_ID) throw new Error('The download isn\'t Dictate & Delegate; the update wasn\'t installed.');
  const v = plistString(plist, 'CFBundleShortVersionString');
  if (v !== version) throw new Error(`The download is version ${v || '?'}, not ${version}; the update wasn't installed.`);
  return true;
}

// ------------------------------------------------------------------ the swap

/** A string as one shell word, whatever it holds (spaces, &, quotes). */
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * The script that swaps the app once it has quit: waits for pid to end (at most two minutes),
 * moves the old .app aside, moves the new one in (puts the old one back if that fails), removes
 * the old one, clears the download's quarantine flag and starts the app again. Its output goes to
 * log.
 */
function installScript({ pid, oldApp, newApp, log }) {
  const OLD = shellQuote(oldApp), NEW = shellQuote(newApp), BAK = shellQuote(oldApp + '.before-update'), LOG = shellQuote(log);
  return [
    '#!/bin/sh',
    '# Dictate & Delegate: installs an update once the app has quit, then starts it again.',
    `exec >>${LOG} 2>&1`,
    `echo "$(date) update: waiting for the app (pid ${Number(pid)}) to quit"`,
    'i=0',
    `while kill -0 ${Number(pid)} 2>/dev/null; do`,
    '  i=$((i+1))',
    '  if [ "$i" -gt 1200 ]; then echo "update: the app is still running; not installed"; exit 1; fi',
    '  sleep 0.1',
    'done',
    `rm -rf ${BAK}`,
    `if ! mv ${OLD} ${BAK}; then echo "update: couldn't move the old app aside"; open ${OLD}; exit 1; fi`,
    `if ! mv ${NEW} ${OLD}; then echo "update: couldn't move the new app in; the old one is back"; rm -rf ${OLD}; mv ${BAK} ${OLD}; open ${OLD}; exit 1; fi`,
    `rm -rf ${BAK}`,
    `xattr -dr com.apple.quarantine ${OLD} 2>/dev/null || true`,
    'echo "$(date) update: installed; starting it"',
    `open ${OLD}`,
    '',
  ].join('\n');
}

module.exports = {
  REPO,
  BUNDLE_ID,
  LEAF,
  apiBase,
  parseVersion,
  newer,
  fetchReleases,
  zipName,
  pick,
  expectedSha,
  sha256,
  summary,
  leafOf,
  plistString,
  runningLeaf,
  verifyApp,
  shellQuote,
  installScript,
};
