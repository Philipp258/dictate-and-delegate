'use strict';
// Headless check of the main window: a minimal Electron main with a real context (data in a
// temporary folder, sample notes), the real API with a stub shell, and app.html walked page by
// page in light and dark mode. Fails on console errors; screenshots go to /tmp/dd-ui/*.png.
//
//   xvfb-run -a node_modules/.bin/electron --no-sandbox scripts/ui-smoke.js
// (--no-sandbox only when running as root, which Chromium refuses otherwise.) DD_UI_FULL=1 takes
// whole-page pictures instead of the 980×720 window; DD_UI_VERBOSE=1 logs each page.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, nativeTheme } = require('electron');

const OUT = process.env.DD_UI_OUT || '/tmp/dd-ui';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-ui-data-'));
app.setPath('userData', DATA);
app.disableHardwareAcceleration();
// No network for the models catalog and bb: answers come back fast as failures.
process.env.DD_OPENROUTER_URL = process.env.DD_OPENROUTER_URL || 'http://127.0.0.1:9/api/v1';

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seed(ctx) {
  const { HistoryEntry } = require('../src/core/history-entry');
  const now = Date.now();
  const save = (json) => ctx.history.save(new HistoryEntry(json));
  const base = (id, minutesAgo, text, extra = {}) => ({
    id,
    created: now - minutesAgo * 60_000,
    model: 'microsoft/mai-transcribe-2',
    duration: 24,
    text,
    raw: text,
    offset: 0,
    knownCost: '0.00084',
    unpriced: 0,
    unconfirmed: 0,
    requests: 1,
    status: 'complete',
    processingMs: 2400,
    steps: [
      { kind: 'speech', model: 'microsoft/mai-transcribe-2', ms: 1700, cost: '0.00082' },
      { kind: 'jev', model: '~typesafe/jev-latest', ms: 400, cost: '0.00002', answer: '' },
    ],
    jevCost: '0.00002',
    ...extra,
  });
  save(base('11111111-1111-4111-8111-111111111111', 30, 'Call Jana tomorrow at ten, then send the invoice for September.'));
  const said = "um so Mr Weber the kitchen tap is dripping since Monday, could someone come, I'm home after five, make that a polite email please";
  const email = "Dear Mr. Weber,\n\nThe kitchen tap has been dripping since Monday. Could someone take a look this week? I'm home after 5 pm on most days.\n\nBest regards";
  save(
    base('22222222-2222-4222-8222-222222222222', 90, email, {
      raw: said,
      original: said,
      processed: email,
      version: 'processed',
      knownCost: '0.00107',
      textModel: 'anthropic/claude-sonnet-5.5',
      textCost: '0.000323',
      steps: [
        { kind: 'speech', model: 'microsoft/mai-transcribe-2', ms: 1900, cost: '0.000727' },
        { kind: 'jev', model: '~typesafe/jev-latest', ms: 400, cost: '0.00002', answer: '' },
        { kind: 'refine', model: 'anthropic/claude-sonnet-5.5', ms: 2100, cost: '0.000323', provider: 'openrouter' },
      ],
    }),
  );
  save(
    base('33333333-3333-4333-8333-333333333333', 26 * 60, 'Look at the flat listing I attached and tell me whether the rent is fair for the area.', {
      route: 'chief',
      chiefThread: 'thr_chief1',
      chiefLink: 'https://example.getbb.app/threads/thr_chief1',
      chiefSent: now - 26 * 3600_000,
      chiefRequest: 'k3x9',
      chiefReply: 'The rent is about 8% above the median for the street. Ask for €1,150 instead.',
      steps: [
        { kind: 'speech', model: 'microsoft/mai-transcribe-2', ms: 1500, cost: '0.0008' },
        { kind: 'jev', model: '~typesafe/jev-latest', ms: 380, cost: '0.00002', answer: '' },
        { kind: 'bb', model: 'chief of staff', ms: 900, files: 2, filesHow: 'upload' },
      ],
    }),
  );
  for (const [i, text] of ['What did the landlord say about the deposit? Over.', 'Then draft a short reply that we accept. Over.'].entries())
    save(base(`4444444${i}-4444-4444-8444-444444444444`, 50 * 60 + i * 2, text, { call: 'call-1', voiceModel: 'hexgrad/kokoro-82m', voiceCost: '0.00004', knownCost: '0.0006' }));
  save(base('55555555-5555-4555-8555-555555555555', 40 * 24 * 60, 'Idea for the onboarding: show the button first, explain the key later.', { knownCost: '0.0021' }));
  ctx.templates.save(null, 'Apartment application', 'Dear landlord,\n\nI am interested in the flat at …');
  ctx.profile.addWord('Dictate & Delegate');
  ctx.profile.addWord('Jana');
  ctx.profile.setTopics(['Messages', 'Emails']);
  ctx.prefs.set('onboarded', true);
  ctx.prefs.set('bbMode', 'custom');
  ctx.prefs.set('bbUrl', 'http://127.0.0.1:9/mcp');
  ctx.prefs.set('bbLinkBase', 'https://example.getbb.app');
  ctx.prefs.set('chiefId', 'thr_chief1');
  ctx.prefs.set('chiefTitle', 'Chief of staff');
  ctx.vault.set('openrouterKey', 'sk-or-v1-test');
  ctx.vault.set('ntfyTopic', 'dd-test-topic-abcdefghijklmnop');
  fs.writeFileSync(
    ctx.files.handsFreeLog,
    ['── call started 14:05 ──', '14:05:01 listening (gate 3.0, take 400 ms)', '14:05:04 speech 1.2 s · level 0.21 / bg 0.03', '14:05:06 → Sent: you asked your question (98%)', '14:05:09 reply 1/2 · Kokoro 0.6 s'].join('\n') + '\n',
  );
}

function stubShell(state) {
  const listeners = new Set();
  const snapshot = () =>
    state.callActive
      ? {
          active: true,
          live: 'WAITING_SEND',
          liveLabel: 'Listening · not sent yet',
          shortLabel: 'Not sent yet',
          phase: 'LISTENING',
          pending: 'What did the landlord say about the deposit',
          reply: '',
          reasons: [
            { at: Date.now() - 2000, text: 'Not sent: you seem mid-sentence (4% done)', times: 1 },
            { at: Date.now() - 9000, text: "Didn't count as speech: too short (260 ms, 400 ms needed)", times: 3 },
          ],
          cost: 0.000412,
          canSend: true,
          canEnd: true,
          liveOff: 'Live transcription is off: no AssemblyAI key (Settings → Hands-free)',
        }
      : null;
  return {
    calls: [],
    startDictation() {},
    toggleDictation() {
      this.calls.push('toggleDictation');
    },
    startCall() {
      state.callActive = true;
      for (const fn of listeners) fn(snapshot());
    },
    endCall() {
      state.callActive = false;
      for (const fn of listeners) fn({ active: false });
    },
    sendNow() {},
    callAvailable: () => true,
    suspendHotkeys(on) {
      state.suspended = on;
    },
    attach() {
      state.attached = (state.attached || 0) + 1;
    },
    async redo(noteId, model) {
      state.redo = [noteId, model];
    },
    callSnapshot: snapshot,
    onCallChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    hotkey: () => state.hotkey,
    setHotkey: (a) => {
      state.hotkey = a;
      return { ok: true };
    },
    callHotkey: () => 'Alt+Shift+Space',
    setCallHotkey: () => ({ ok: false, error: 'Alt+Shift+Space is taken by another app' }),
    hotkeyProblems: () => ({}),
    notifierState: () => 'retrying',
    permissions: () => ({ microphone: 'granted', accessibility: false, notifications: true }),
    requestMicrophone: async () => true,
    requestAccessibility: () => false,
    openPrivacySettings() {},
    signIn: async () => true,
    micDevices: async () => [{ id: 'mic-1', label: 'MacBook Pro Microphone' }, { id: 'mic-2', label: 'AirPods Pro' }],
    systemVoices: async () => [{ name: 'Samantha', lang: 'en-US' }, { name: 'Daniel', lang: 'en-GB' }],
    openExternal(url) {
      state.opened.push(url);
    },
    copy: async (text) => {
      state.copied = text;
    },
    chooseFile: async () => state.file,
    saveFile: async () => state.file,
    testInsert: async () => ({ how: 'copied' }),
    dictationState: () => ({ state: 'ready', busy: false, detail: '', hasSavedRecording: false }),
  };
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });
  const { createContext } = require('../src/main/context');
  const ctx = await createContext({});
  seed(ctx);
  const state = { hotkey: 'Alt+Space', callActive: false, opened: [], copied: '', file: path.join(DATA, 'export.json') };
  const shell = stubShell(state);
  require('../src/main/api').registerApi(ctx, shell);

  const win = new BrowserWindow({
    width: 980,
    height: 720,
    show: false,
    webPreferences: { preload: path.join(RENDERER, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.webContents.on('console-message', (event) => {
    const level = event.level !== undefined ? event.level : event;
    const message = event.message || '';
    if (level === 'error' || level === 'warning' || level === 3 || level === 2) problems.push(`console ${level}: ${message}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => problems.push('renderer gone: ' + d.reason));
  win.webContents.on('preload-error', (_e, p, err) => problems.push('preload: ' + err.message));
  await win.loadFile(path.join(RENDERER, 'app.html'), { query: { page: 'home' } });

  const js = (code) =>
    win.webContents.executeJavaScript(`(async () => { try { return await (${code}); } catch (e) { return { __error: String(e && e.stack || e) }; } })()`, true).then((v) => {
      if (v && v.__error) {
        problems.push('script: ' + v.__error.split('\n')[0] + ' in ' + code.slice(0, 80));
        return null;
      }
      return v;
    });
  const t0 = Date.now();
  const log = (m) => process.env.DD_UI_VERBOSE && console.log(((Date.now() - t0) / 1000).toFixed(1) + 's ' + m);
  const shown = () => js("(document.querySelector('#content .page')||{dataset:{}}).dataset.page || ''");
  async function waitPage(page, ms = 6000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if ((await shown()) === page) {
        await sleep(350); // Async parts of the page (lists, catalog) fill in.
        return true;
      }
      await sleep(50);
    }
    problems.push(`page ${page} did not show (showing ${await shown()})`);
    return false;
  }
  /** The whole page: the window grows to the content's height for the picture (DD_UI_FULL=1). */
  async function shot(name) {
    if (process.env.DD_UI_FULL) {
      const h = (await js("document.getElementById('content').scrollHeight + 38")) || 720;
      win.setSize(980, Math.min(4000, Math.max(720, h)));
      await sleep(250);
    }
    const img = await win.webContents.capturePage();
    if (process.env.DD_UI_FULL) win.setSize(980, 720);
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
  }
  async function visit(page, mode, name = page) {
    log(mode + ' ' + name);
    win.webContents.send('navigate', page);
    await waitPage(page);
    const text = (await js("document.querySelector('#content').innerText")) || '';
    if (/Could not show this page/.test(text)) problems.push(`${page}: ${text.match(/Could not show this page[^\n]*/)[0]}`);
    await shot(`${mode}-${name}`);
  }
  async function click(selector, expectPage) {
    const ok = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
    if (!ok) problems.push('nothing to click: ' + selector);
    if (expectPage) await waitPage(expectPage);
  }

  const PAGES = ['welcome', 'key1', 'allow1', 'how1', 'start1', 'insert1', 'try1', 'bb1', 'chief1', 'ntfy1', 'home', 'notes', 'activity', 'usage', 'handsfree', 'hfsettings', 'live', 'settings', 'key', 'anthropic', 'models', 'voices', 'refineModel', 'refine', 'templates', 'template', 'words', 'aboutyou', 'bb', 'chief', 'ntfy', 'start'];

  for (const mode of ['light', 'dark']) {
    nativeTheme.themeSource = mode;
    await sleep(200);
    for (const page of PAGES) await visit(page, mode);
    // A note, opened from All notes; then a call opened in the list.
    await visit('notes', mode);
    await click('#notes-list .note-row:not(.turn) .note-text', 'note');
    await shot(`${mode}-note`);
    await visit('notes', mode, 'notes-call');
    await js("[...document.querySelectorAll('#notes-list .call-title')].forEach((e) => e.click())");
    await sleep(400);
    await shot(`${mode}-notes-call`);
    // The refined email: both versions.
    await js("[...document.querySelectorAll('#notes-list .note-text')].find((e) => e.textContent.startsWith('Dear Mr. Weber')).click()");
    await waitPage('note');
    await shot(`${mode}-note-refined`);
    // Hands-free during a call (the stub's snapshot), then ended.
    await visit('handsfree', mode, 'handsfree');
    await click('#hf-area .btn.primary');
    await sleep(400);
    await shot(`${mode}-handsfree-active`);
    const live = await js("(document.getElementById('hf-live')||{}).textContent || ''");
    if (!/not sent yet/.test(live)) problems.push('hands-free live line missing: ' + live);
    await js("document.querySelector('#hf-area .btn.danger').click()");
    await sleep(300);
    // A confirmation dialog.
    await visit('settings', mode);
    await js("[...document.querySelectorAll('.row')].find((r) => r.textContent.includes('Delete local data')).click()");
    await sleep(250);
    await shot(`${mode}-dialog`);
    await js("document.querySelector('.dialog .btn.outline').click()");
  }

  // The shortcut recorder turns the app's shortcuts off while it listens, and back on.
  win.webContents.send('navigate', 'start');
  await waitPage('start');
  await js("document.querySelector('.keycap').click()");
  await sleep(200);
  const suspended = state.suspended;
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await sleep(300);
  if (suspended !== true || state.suspended !== false) problems.push(`recorder: hotkeys suspended ${suspended}, after Esc ${state.suspended}`);
  // Many renders of Home leave one poller, not one each.
  win.webContents.send('navigate', 'home');
  await waitPage('home');
  const pollers = await js("(async () => { for (let i = 0; i < 5; i++) { render(); await new Promise((r) => setTimeout(r, 120)); } return ui.timers.length; })()");
  if (pollers !== 1) problems.push('Home pollers after 5 renders: ' + pollers);
  // Redo reaches the shell with the note's id (the seeded note has no audio, so it's refused first).
  const redo = await js("dd.invoke('api', 'redo', '11111111-1111-4111-8111-111111111111')");
  if (!redo || (redo.ok && !state.redo)) problems.push('redo: ' + JSON.stringify(redo));

  // The API from the window: export (confirmed) and import back, usage, a pref, the shortcut.
  const r = await js(`(async () => {
    const call = (m, ...a) => dd.invoke('api', m, ...a);
    const out = {};
    out.refused = await call('exportSettings', {});
    out.exported = await call('exportSettings', { confirmed: true });
    out.imported = await call('importSettings');
    out.badPref = await call('setPref', 'bbUrl', 'http://evil');
    out.pref = await call('setPref', 'hfTurnPauseMs', 2500);
    out.hotkey = await call('setHotkey', 'Command+Shift+D');
    out.sameHotkey = await call('setCallHotkey', 'Shift+Command+D');
    out.plainHttp = await call('bbSaveCustom', 'http://bb.example.com/mcp', '', '');
    out.plainServer = await call('setNtfyServer', 'http://ntfy.example.com');
    out.attach = await call('attach');
    out.usage = await call('usage', 0);
    out.notes = await call('notes', 'invoice');
    out.copied = await call('copyHandsFreeLog', 1);
    return out;
  })()`);
  const file = JSON.parse(fs.readFileSync(state.file, 'utf8'));
  const expect = (cond, what) => cond || problems.push('api: ' + what);
  expect(r.refused.ok === false, 'export without confirmation was not refused');
  expect(r.exported.ok && file.app === 'dictate-and-delegate', 'export did not write the file');
  expect(file.keys.openrouterKey === 'sk-or-v1-test' && file.prefs.chiefId === 'thr_chief1', 'export misses keys or settings');
  expect(r.imported.ok && /Imported/.test(r.imported.value), 'import failed: ' + JSON.stringify(r.imported));
  expect(r.badPref.ok === false, 'setPref took a key outside the list');
  expect(r.pref.ok && ctx.prefs.get('hfTurnPauseMs') === 2500, 'setPref did not save');
  expect(r.hotkey.ok && state.hotkey === 'Command+Shift+D', 'setHotkey did not reach the shell');
  expect(r.sameHotkey.ok && r.sameHotkey.value.ok === false && /dictation shortcut/.test(r.sameHotkey.value.error), 'same shortcut twice: ' + JSON.stringify(r.sameHotkey));
  expect(r.plainHttp.ok && r.plainHttp.value.ok === false && /Plain HTTP/.test(r.plainHttp.value.message), 'plain http bb address taken');
  expect(r.plainServer.ok && r.plainServer.value.ok === false, 'plain http ntfy server taken');
  expect(r.attach.ok && state.attached === 1, '📎 Add did not reach the shell');
  expect(r.usage.ok && r.usage.value.byModel.length > 0, 'usage is empty');
  expect(r.notes.ok && r.notes.value.items.length === 1, 'search found ' + JSON.stringify(r.notes.value && r.notes.value.items.length));
  expect(/call started/.test(state.copied), 'Copy last call copied nothing');

  win.destroy();
  console.log(`screenshots: ${OUT} (${fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).length})`);
  if (problems.length) {
    console.log('PROBLEMS:\n' + problems.map((p) => '  ' + p).join('\n'));
    app.exit(1);
  } else {
    console.log('ui-smoke: all pages shown, no console errors');
    app.exit(0);
  }
}

main().catch((e) => {
  console.error(e);
  app.exit(2);
});
