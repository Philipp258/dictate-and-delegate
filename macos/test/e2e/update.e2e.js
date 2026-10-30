'use strict';
// End to end in the real app (headless on Linux): a check against a fake GitHub finds a newer Mac
// release and Home shows the update banner; with the same version out, Settings → About → Check
// for updates says it's up to date. Installing (the swap and restart) is macOS-only: unit-tested.
// Run: scripts/e2e.sh update

const assert = require('assert/strict');
const { app } = require('electron');
const { waitFor } = require('../../src/core/util');
const { startFakeGithub } = require('../support/fake-github');

function release(version, arch) {
  const tag = 'mac-v' + version;
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    body: `Version ${version}: in-app updates.\n\n## Download\n- zip`,
    html_url: 'https://github.com/x/releases/tag/' + tag,
    assets: [
      { name: `Dictate-and-Delegate-${version}-mac-${arch}.zip`, browser_download_url: `https://dl.test/${tag}.zip`, size: 1000 },
      { name: 'SHA256SUMS', browser_download_url: `https://dl.test/${tag}/SHA256SUMS`, size: 100 },
    ],
  };
}

module.exports = async function (dd) {
  const gh = await startFakeGithub();
  process.env.DD_GITHUB_API = gh.url;
  try {
    const current = app.getVersion();
    const u = dd.updater();
    gh.releases([release('9.0.0', process.arch), release(current, process.arch)]);
    const s = await u.check({ manual: true });
    assert.equal(s.available && s.available.version, '9.0.0');
    assert.match(gh.requests[0].agent, /^Dictate-and-Delegate-mac\//);
    assert.equal(gh.requests[0].auth, '', 'anonymous: no token');

    // Home shows the banner, with the notes and the Keychain line.
    const win = dd.openMain('home');
    const text = () => win.webContents.executeJavaScript('document.body.innerText').catch(() => '');
    const banner = (t) => /Update to 9\.0\.0/.test(t) && /Version 9\.0\.0: in-app updates\./.test(t) && /click Always Allow/.test(t);
    await waitFor(async () => banner(await text()), 15000, 'the update banner on Home, with the notes and the Keychain line');

    // The same version out: Check for updates in Settings says it's up to date.
    gh.releases([release(current, process.arch)]);
    win.webContents.send('navigate', 'settings');
    // Found and clicked in one step: the page may render again in between.
    const click = "(() => { const b = document.getElementById('check-updates'); if (!b) return false; b.click(); return true; })()";
    await waitFor(() => win.webContents.executeJavaScript(click).catch(() => false), 10000, 'Settings → About → Check for updates');
    await waitFor(async () => new RegExp('Up to date \\(' + current.replace(/\./g, '\\.') + '\\)').test(await text()), 10000, 'up to date');
    assert.equal(u.state().available, null);
    assert.equal(gh.requests.length, 2);
  } finally {
    gh.close();
  }
};
