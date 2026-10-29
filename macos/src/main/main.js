'use strict';
// Dictate & Delegate for macOS. A global shortcut starts and stops a dictation
// (like the Android volume key), a floating panel offers Insert / Refine / Chief, a second
// shortcut (or 📞) starts a hands-free call with the chief, and the chief's ntfy messages show
// as notifications. The logic is the Android app's, ported to src/core; this file wires it to
// macOS.

const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  Menu,
  globalShortcut,
  ipcMain,
  screen,
  shell,
  clipboard,
  dialog,
  systemPreferences,
} = require('electron');

const { createContext } = require('./context');
const { AudioBridge } = require('./audio-bridge');
const insertion = require('./insert');
const { Notifier } = require('./notifier');
const { Dictation, FilePendingAudio } = require('../core/dictation');
const { panelModel } = require('../core/panel-model');
const chiefText = require('../core/chief-text');
const openrouter = require('../core/openrouter');
const { ActivationGate, giveFocusBack } = require('../core/activation');
const { caller } = require('../core/window-log');
const { sleep } = require('../core/util');
const nativeMac = require('./macos-native');

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(RENDERER, 'preload.js');

/** Settings of the Mac app (Android keeps these keys for its own start options). */
const HOTKEY = 'hotkey', CALL_HOTKEY = 'callHotkey', INSERT_METHOD = 'insertMethod', MIC = 'micDevice';
// Not ⌥ or ⌥⇧ alone: macOS 15 refuses global shortcuts with only those modifiers.
const DEFAULT_HOTKEY = 'Control+Shift+Space', DEFAULT_CALL_HOTKEY = 'Control+Alt+Shift+Space';

// End-to-end tests on Linux (scripts/e2e.js): their own data folder, a WAV file as the microphone.
if (process.env.DD_E2E) {
  if (process.env.DD_TRACE) fs.appendFileSync(process.env.DD_TRACE, `main: loaded ${Date.now()}\n`);
  app.whenReady().then(() => process.env.DD_TRACE && fs.appendFileSync(process.env.DD_TRACE, `main: ready ${Date.now()}\n`));
  if (process.env.DD_USER_DATA) app.setPath('userData', process.env.DD_USER_DATA);
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  if (process.env.DD_FAKE_MIC) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.DD_FAKE_MIC);
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAsDefaultProtocolClient('talkrouter');
  start();
}

function start() {
  let ctx, audio, dictation, panel, mainWindow, notifier, call;
  let pendingUrls = [];
  const callListeners = new Set();

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (ctx) handleUrl(url);
    else pendingUrls.push(url);
  });
  app.on('second-instance', () => openMain());
  // A Dock click opens the window. A click on the panel or a notification activates the app too;
  // then it stays closed (decided a moment later, when the click's own handler has run).
  const activation = new ActivationGate({ quietMs: 1500 });
  app.on('activate', (_e, hasVisibleWindows) => {
    if (!ctx) return;
    wlog('macOS: activate (Dock click or reopen)', `visible windows: ${hasVisibleWindows}`);
    setTimeout(() => {
      if (activation.opensWindow()) openMain();
      else wlog('activate: window stays closed', 'the panel or a notification was just used');
    }, 250);
  });
  // The window log (opt-in, Settings → Data): what opened windows and took the focus.
  const wlog = (what, detail) => ctx && ctx.windowLog.log(what, detail);
  const winName = (w) => (!w ? 'none' : w === mainWindow ? 'main window' : w === panel ? 'panel' : `window ${w.id} "${w.getTitle()}"`);
  const activeNow = () => {
    try {
      const mac = nativeMac.load();
      return mac ? (mac.appActive() ? 'app active' : 'app not active') : '';
    } catch {
      return '';
    }
  };
  app.on('did-become-active', () => {
    if (!ctx) return;
    wlog('macOS: app became active');
    // Should a click on the panel still activate the app, hand the focus straight back, so macOS
    // doesn't keep the main window in front of the app you're typing in. Decided a moment later,
    // when the panel's mouse-down has arrived.
    setTimeout(() => {
      const mac = nativeMac.load();
      if (activation.opensWindow() || !mac || !mac.appActive()) return;
      mac.deactivate();
      wlog('app: activated by the panel or a notification; gave the focus back', activeNow());
    }, 150);
  });
  app.on('did-resign-active', () => wlog('macOS: app no longer active'));
  app.on('browser-window-focus', (_e, w) => wlog('window focused', winName(w)));
  app.on('browser-window-blur', (_e, w) => wlog('window lost the focus', winName(w)));
  app.on('window-all-closed', () => {
    /* The app keeps running without windows: the shortcut and the panel work on their own. */
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  let readyToQuit = false;
  app.on('before-quit', (event) => {
    // A call's end (your last words, then the end for the chief and the talker) is told first, as
    // Android's service stays up until it's delivered: at most END_BUDGET_MS.
    if (!readyToQuit && call) {
      event.preventDefault();
      readyToQuit = true;
      const ending = call.active() ? call.end() : call.settled();
      Promise.race([Promise.resolve(ending).catch(() => {}), new Promise((r) => setTimeout(r, 46_000))]).then(() => app.quit());
      return;
    }
    // Then the microphone and the audio window: a renderer holding the microphone can hold up quitting.
    try {
      // A recording stays on disk: the next start offers to retry or discard it.
      if (dictation && dictation.busy()) dictation.stopMicrophone();
      audio.micStop();
      audio.win.destroy();
    } catch {}
  });

  app.whenReady().then(() => ready().catch((e) => {
    dialog.showErrorBox('Dictate & Delegate could not start', String((e && e.stack) || e));
    app.exit(1);
  }));

  async function ready() {
    ctx = await createContext({ log: (line) => process.env.DD_TRACE && fs.appendFileSync(process.env.DD_TRACE, line + '\n') });
    ctx.log(`app: Dictate & Delegate ${app.getVersion()} started (Electron ${process.versions.electron}, macOS ${process.getSystemVersion ? process.getSystemVersion() : ''})`);
    audio = new AudioBridge({ log: ctx.log });
    dictation = createDictation();
    panel = createPanel();
    notifier = new Notifier(ctx, {
      openUrl: (url) => openExternal(url),
      insert: (text) => insertFromNotification(text),
      copy: (text) => clipboard.writeText(text),
      pasteArrived: () => false,
      clicked: () => {
        activation.quiet();
        wlog('notification clicked', activeNow());
      },
    });
    try {
      call = require('./call').createCall({ ctx, audio, shell: callShell() });
      let wasActive = false;
      call.onChange((snap) => {
        for (const fn of callListeners) fn(snap);
        if (!!snap.active !== wasActive) {
          wasActive = !!snap.active;
          registerHotkeys(); // The headset's play/pause key sends only during a call.
        }
      });
    } catch (e) {
      ctx.log(`app: hands-free unavailable (${e.message})`);
      call = null;
    }
    try {
      require('./api').registerApi(ctx, appShell());
    } catch (e) {
      ctx.log(`app: settings API not loaded (${e.message})`);
    }
    registerHotkeys();
    ctx.on('settings', (key) => {
      if (key === HOTKEY || key === CALL_HOTKEY) registerHotkeys();
      if (['ntfyServer', 'bbMode', 'bbHandle', 'bbUrl', 'chiefId', 'macNotifications'].includes(key)) notifier.refresh();
    });
    ctx.on('skills', () => notifier.refresh());
    notifier.refresh();
    // Keep the chief's skills current (they carry the topic, name and links), as Android does on start.
    if (ctx.bb.connected()) ctx.skills.sync(false);
    for (const url of pendingUrls.splice(0)) handleUrl(url);
    if (process.env.DD_E2E) {
      global.__dd = { ctx, audio, dictation: () => dictation, panel: () => panel, call: () => call, openMain, panelAction, startCall, toggleDictation, notifier: () => notifier, mainWindow: () => mainWindow, activation };
      const done = (code, message) => {
        const line = message + '\n';
        if (process.env.DD_TRACE) fs.appendFileSync(process.env.DD_TRACE, line);
        // A normal quit can wait on a renderer (a microphone, a capture); a test run mustn't.
        try {
          fs.writeSync(1, line);
        } catch {}
        process.reallyExit(code);
      };
      require(process.env.DD_E2E)(global.__dd).then(
        () => done(0, `E2E ${path.basename(process.env.DD_E2E)}: OK`),
        (e) => done(1, 'E2E FAILED: ' + (e && e.stack ? e.stack : e)),
      );
      return;
    }
    if (!ctx.prefs.get('onboarded', false) || !openrouter.hasKey(ctx.vault)) openMain('welcome');
    setInterval(() => {
      try {
        ctx.attachments.prune();
        ctx.archive.prune();
      } catch {}
    }, 6 * 3600_000);
  }

  // ---------------------------------------------------------------- dictation

  function createDictation() {
    const d = new Dictation({
      prefs: ctx.prefs,
      vault: ctx.vault,
      log: ctx.log,
      pending: new FilePendingAudio(ctx.files.recording),
      microphone: {
        start: (onFrame, onFail) =>
          audio.micStart({ call: false, deviceId: ctx.prefs.get(MIC, '') }, onFrame, (why) => onFail(new Error(why))),
        stop: () => audio.micStop(),
      },
      hasKey: () => openrouter.hasKey(ctx.vault),
      transcribe: (wav, words, model) => ctx.openRouter.transcribe(wav, model || ctx.profile.fixedModel(), words),
      decide: (t, o) => ctx.decide(t, o),
      templates: () => ctx.templates.names(),
      refine: (text, o) => ctx.refine(text, o),
      refineModel: () => require('../core/text-model').model(ctx.prefs),
      chiefReady: () => ctx.bb.ready(),
      chiefThread: () => {
        const id = ctx.bb.chiefId();
        return id ? { id, link: ctx.bb.threadLink(id) } : null;
      },
      sendToChief: async (text, { request, recordingId, chiefId }) =>
        ctx.bb.sendRequest(chiefId || ctx.bb.chiefId(), text, ctx.attachments.texts(recordingId), ctx.attachments.binaries(recordingId), request),
      waitForChiefText: (request, since, onText) => {
        const l = new chiefText.Listener(ctx.bb.ntfyServer(), ctx.bb.ntfyTopic(), request, since, onText);
        l.start();
        return { stop: () => l.finish() };
      },
      openLink: (url) => openExternal(url),
      insert: async (text) => {
        await focusBack();
        const r = await insertion.insert(text, { method: ctx.prefs.get(INSERT_METHOD, 'paste'), log: ctx.log });
        if (r.how === 'copied') return { how: 'copied', reason: r.why === 'no-field' ? undefined : 'permission' };
        return { how: r.how, clipboard: false };
      },
      replaceInPlace: async (oldText, newText) => {
        await focusBack();
        const r = await insertion.replace(oldText, newText, { method: ctx.prefs.get(INSERT_METHOD, 'paste'), log: ctx.log });
        return r ? { how: r.how, clipboard: false } : null;
      },
      copy: (text) => clipboard.writeText(text),
      loadNote: (id) => ctx.history.load(id),
      saveNote: (note) => {
        ctx.history.saveJson(note);
      },
      attachments: {
        pendingCount: () => ctx.attachments.pending().length,
        claimPending: (id) => ctx.attachments.claimPending(id),
        clearPending: () => ctx.attachments.clearPending(),
      },
      openAttach: () => attachMenu(),
      archiveAudio: (id, pending) => {
        const file = pending && (pending.file || pending.path);
        if (file && fs.existsSync(file)) ctx.archive.retain(id, file);
      },
      startCall: ({ pcm }) => startCall({ seed: pcm }),
    });
    d.on('change', (snap) => {
      showPanel(panelModel(snap));
    });
    d.on('notice', (text) => ctx.log(`dictation: ${text}`));
    d.on('notes', (id) => ctx.emit('notes', id));
    return d;
  }

  function toggleDictation() {
    if (call && call.active()) return call.sendNow();
    dictation.toggle();
  }

  /** 📎 while recording: paste what you copied, or attach a file. */
  async function attachMenu() {
    const copied = await clipboard.readText().catch(() => '');
    const menu = Menu.buildFromTemplate([
      {
        label: 'Paste what you copied',
        enabled: !!copied.trim(),
        click: () => {
          try {
            ctx.attachments.addText(copied);
            dictation.touch && dictation.touch();
          } catch (e) {
            ctx.log(`attach: ${e.message}`);
          }
        },
      },
      {
        label: 'Attach a file…',
        click: async () => {
          app.focus({ steal: true });
          const r = await dialog.showOpenDialog({
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Images, PDFs, text', extensions: ['png', 'jpg', 'jpeg', 'heic', 'gif', 'webp', 'pdf', 'txt', 'md', 'csv', 'json'] }, { name: 'All files', extensions: ['*'] }],
          });
          for (const f of r.filePaths || []) {
            try {
              await ctx.attachments.addFile(f);
            } catch (e) {
              dialog.showMessageBox({ type: 'warning', message: e.message });
            }
          }
          if (!mainWindow || !mainWindow.isVisible()) app.hide(); // Back to the app you dictate into.
          dictation.touch && dictation.touch();
        },
      },
    ]);
    menu.popup({ window: panel });
  }

  // ---------------------------------------------------------------- the floating panel

  function createPanel() {
    const win = new BrowserWindow({
      type: 'panel',
      width: 320,
      height: 60,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      hasShadow: false,
      focusable: false,
      acceptFirstMouse: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    // A click on the panel must never make the app active: that brought its main window in front
    // of the app you're typing in, and Insert's ⌘V went to it.
    const nonActivating = (when) => {
      try {
        const mac = nativeMac.load();
        if (mac) wlog(`panel: non-activating (${when})`, mac.preventActivation(win.getNativeWindowHandle()));
      } catch (e) {
        wlog(`panel: couldn't make it non-activating (${when})`, e.message);
      }
    };
    nonActivating('created');
    win.on('show', () => nonActivating('shown'));
    win.loadFile(path.join(RENDERER, 'panel.html'));
    win.on('moved', () => {
      const [x, y] = win.getPosition();
      ctx.prefs.set('panelX', x);
      ctx.prefs.set('panelY', y);
    });
    const mine = (e) => e.sender === win.webContents;
    ipcMain.on('panel:ready', (e) => mine(e) && showPanel(panelModel(dictation.snapshot())));
    ipcMain.on('panel:action', (e, id) => {
      if (!mine(e)) return;
      activation.quiet(); // Should a click on the panel still activate the app: no window for that.
      wlog(`panel: ${id === 'touch' ? 'cursor on it' : 'click on ' + id}`, activeNow());
      panelAction(id);
    });
    ipcMain.on('panel:size', (e, w, h, visible) => {
      if (!mine(e)) return;
      if (!visible) return win.isVisible() && win.hide();
      placePanel(win, w, h);
      if (!win.isVisible()) win.showInactive();
    });
    return win;
  }

  function placePanel(win, w, h) {
    const x0 = ctx.prefs.get('panelX', null);
    const y0 = ctx.prefs.get('panelY', null);
    let x, y;
    if (x0 === null || y0 === null) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      x = Math.round(area.x + (area.width - w) / 2);
      y = Math.round(area.y + area.height - h - 28);
    } else {
      const area = screen.getDisplayNearestPoint({ x: x0, y: y0 }).workArea;
      x = Math.min(Math.max(x0, area.x), area.x + area.width - w);
      y = Math.min(Math.max(y0, area.y), area.y + area.height - h);
    }
    win.setBounds({ x, y, width: Math.max(60, w), height: Math.max(30, h) });
  }

  function showPanel(model) {
    if (panel && !panel.isDestroyed()) panel.webContents.send('panel', model);
  }

  function panelAction(id) {
    const d = dictation;
    switch (id) {
      case 'stop':
        return d.stop();
      case 'refine':
        return d.tapRefine();
      case 'chief':
        return d.tapChief();
      case 'call':
        return d.call();
      case 'attach':
        return d.attach();
      case 'insert':
        return d.insert();
      case 'insertFromChief':
        return d.insertFromChief();
      case 'close':
        return d.close();
      case 'touch':
        return d.touch && d.touch();
      case 'icon':
        if (d.hasSavedRecording && d.hasSavedRecording()) return openMain('home');
        return d.toggle();
    }
  }

  // ---------------------------------------------------------------- hands-free

  function startCall({ seed = null } = {}) {
    if (!call) return dialog.showMessageBox({ type: 'warning', message: 'Hands-free is not available in this build.' });
    // While dictating, the call takes the dictation over (as 📞 does), so they never share the microphone.
    if (!seed && dictation.snapshot().state === 'recording') return dictation.call();
    if (call.active()) return;
    if (!ctx.bb.ready()) {
      openMain('chief');
      return;
    }
    call.start({ seed });
  }

  /** What the call controller gets from the Mac. */
  function callShell() {
    return {
      openMain: (page) => openMain(page),
      panelPosition: () => (panel && panel.isVisible() ? panel.getPosition() : null),
      log: ctx && ctx.log,
    };
  }

  // ---------------------------------------------------------------- hotkeys

  function registerHotkeys() {
    globalShortcut.unregisterAll();
    const problems = {};
    const add = (key, fallback, fn) => {
      const accel = ctx.prefs.get(key, fallback);
      if (!accel) return;
      try {
        if (optionOnly(accel)) problems[key] = `macOS doesn't allow a shortcut with only ⌥ or ⌥⇧: add ⌃ or ⌘`;
        else if (!globalShortcut.register(accel, fn)) problems[key] = `${accel} couldn't be set: another app uses it, or macOS doesn't allow it`;
      } catch (e) {
        problems[key] = `${accel}: ${e.message}`;
      }
    };
    add(HOTKEY, DEFAULT_HOTKEY, () => toggleDictation());
    add(CALL_HOTKEY, DEFAULT_CALL_HOTKEY, () => (call && call.active() ? call.end() : startCall()));
    // The headset's play/pause key sends during a call, as on Android (macOS needs Accessibility).
    if (call && call.active() && insertion.accessibility(false)) {
      try {
        globalShortcut.register('MediaPlayPause', () => call.sendNow());
      } catch {}
    }
    for (const [k, v] of Object.entries(problems)) ctx.log(`hotkey: ${v}`);
    hotkeyProblems = problems;
    return problems;
  }
  let hotkeyProblems = {};

  /** ⌥ or ⌥⇧ as the only modifiers: macOS 15 refuses such global shortcuts. */
  function optionOnly(accel) {
    const parts = String(accel).split('+').slice(0, -1).map((p) => p.toLowerCase());
    const mods = parts.filter((p) => !['alt', 'option', 'shift'].includes(p));
    return parts.some((p) => p === 'alt' || p === 'option') && mods.length === 0;
  }

  function setHotkey(key, fallback, accel) {
    const before = ctx.prefs.get(key, fallback);
    ctx.prefs.set(key, accel || '');
    const problems = registerHotkeys();
    if (problems[key]) {
      ctx.prefs.set(key, before);
      registerHotkeys();
      return { ok: false, error: problems[key] };
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- the main window

  function openMain(page = 'home') {
    wlog(`main window: open (${page})`, caller(new Error().stack));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('navigate', page);
      mainWindow.show();
      mainWindow.focus();
      app.focus({ steal: true });
      return mainWindow;
    }
    mainWindow = new BrowserWindow({
      width: 980,
      height: 720,
      minWidth: 720,
      minHeight: 520,
      title: 'Dictate & Delegate',
      titleBarStyle: 'hiddenInset',
      show: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
    });
    mainWindow.loadFile(path.join(RENDERER, 'app.html'), { query: { page } });
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      app.focus({ steal: true });
    });
    // Links open in the browser, never inside the app.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });
    // Only the app's own page: a dropped file or a link mustn't replace it (or get its API).
    const appPage = require('url').pathToFileURL(path.join(RENDERER, 'app.html')).href;
    mainWindow.webContents.on('will-navigate', (e, url) => {
      if (url.split(/[?#]/)[0] === appPage) return;
      e.preventDefault();
      if (!url.startsWith('file:')) openExternal(url);
    });
    for (const ev of ['show', 'focus', 'restore']) mainWindow.on(ev, () => wlog(`main window: ${ev}`, activeNow()));
    mainWindow.on('closed', () => {
      mainWindow = null;
      registerHotkeys(); // In case the shortcut recorder was still listening.
    });
    mainWindow.webContents.on('did-start-navigation', (e) => e.isMainFrame && !e.isSameDocument && registerHotkeys());
    return mainWindow;
  }

  function openExternal(url) {
    if (/^(https?:|x-apple\.systempreferences:|mailto:)/.test(String(url))) shell.openExternal(url);
  }

  /** Insert from a notification: give the focus back to the app before, then paste. */
  async function insertFromNotification(text) {
    activation.quiet();
    await sleep(150); // macOS activates the app for the click: let that happen first.
    await focusBack();
    const r = await insertion.insert(text, { method: ctx.prefs.get(INSERT_METHOD, 'paste'), log: ctx.log });
    if (r.how === 'copied') ctx.log(`notification: text copied instead of inserted (${r.why})`);
  }

  /**
   * A click on the panel or a notification made this app the active one: the focus goes back to
   * the app you were typing in before Insert presses ⌘V, so the text lands in your field.
   */
  async function focusBack() {
    const how = await giveFocusBack({ mac: nativeMac.load(), hide: () => app.hide(), sleep });
    if (how === 'deactivated' || how === 'hidden') ctx.log(`insert: gave the focus back to your app first (${how})`);
    wlog('insert: focus', how === 'not-active' ? 'your app had it' : how);
  }

  // ---------------------------------------------------------------- bb sign-in

  async function handleUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (u.protocol !== 'talkrouter:' || !/oauth\/callback/.test(u.host + u.pathname)) return;
    const query = Object.fromEntries(u.searchParams.entries());
    let message, ok = false;
    try {
      const handle = await ctx.oauth.complete(query);
      ctx.bb.useConnect(handle);
      ctx.skills.sync(true);
      message = `Signed in to ${handle}.getbb.app`;
      ok = true;
    } catch (e) {
      message = e && e.message ? (/^Sign-in/.test(e.message) ? e.message : `Sign-in failed: ${e.message}`) : 'Sign-in failed';
    }
    ctx.log(`bb: ${message}`);
    ctx.emit('settings', 'bbAuth');
    const w = openMain('bb');
    const send = () => w.webContents.send('event', 'signin', { ok, message });
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
    else send();
    notifier.refresh();
  }

  // ---------------------------------------------------------------- what the settings window may ask

  function appShell() {
    return {
      startDictation: () => (call && call.active() ? null : dictation.start()),
      toggleDictation: () => toggleDictation(),
      startCall: () => startCall(),
      callAvailable: () => !!call,
      // The shortcut recorder listens: the app's own shortcuts mustn't fire meanwhile.
      suspendHotkeys: (on) => {
        if (on) globalShortcut.unregisterAll();
        else registerHotkeys();
        return true;
      },
      endCall: () => call && call.end(),
      sendNow: () => call && call.sendNow(),
      callSnapshot: () => (call ? call.snapshot() : null),
      onCallChange: (fn) => {
        callListeners.add(fn);
        return () => callListeners.delete(fn);
      },
      hotkey: () => ctx.prefs.get(HOTKEY, DEFAULT_HOTKEY),
      setHotkey: (a) => setHotkey(HOTKEY, DEFAULT_HOTKEY, a),
      callHotkey: () => ctx.prefs.get(CALL_HOTKEY, DEFAULT_CALL_HOTKEY),
      setCallHotkey: (a) => setHotkey(CALL_HOTKEY, DEFAULT_CALL_HOTKEY, a),
      hotkeyProblems: () => hotkeyProblems,
      permissions: () => ({
        microphone: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted',
        accessibility: insertion.accessibility(false),
        notifications: require('electron').Notification.isSupported(),
      }),
      requestMicrophone: async () => (process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : true),
      requestAccessibility: () => insertion.accessibility(true),
      openPrivacySettings: (kind) => {
        const pane = { microphone: 'Privacy_Microphone', accessibility: 'Privacy_Accessibility' }[kind];
        openExternal(pane ? `x-apple.systempreferences:com.apple.preference.security?${pane}` : 'x-apple.systempreferences:com.apple.preference.notifications');
      },
      signIn: async (handle) => {
        const url = await ctx.oauth.begin(handle);
        shell.openExternal(url);
        return true;
      },
      micDevices: () => audio.micDevices(),
      systemVoices: () => audio.voices(),
      openExternal: (url) => openExternal(url),
      copy: (text) => clipboard.writeText(String(text)),
      chooseFile: async (opts = {}) => {
        const r = await dialog.showOpenDialog(mainWindow || undefined, { properties: ['openFile'], ...opts });
        return r.canceled ? null : r.filePaths[0];
      },
      saveFile: async (opts = {}) => {
        const r = await dialog.showSaveDialog(mainWindow || undefined, opts);
        return r.canceled ? null : r.filePath;
      },
      testInsert: async (text) => {
        app.hide();
        await new Promise((r) => setTimeout(r, 400));
        return insertion.insert(text, { method: ctx.prefs.get(INSERT_METHOD, 'paste'), log: ctx.log });
      },
      notifierState: () => (notifier ? notifier.state : 'off'),
      dictationState: () => ({ ...dictation.snapshot(), hasSavedRecording: dictation.hasSavedRecording(), recordingId: ctx.prefs.get('recordingId', '') }),
      refineNote: (id, template) => dictation.refineNote(id, template),
      sendNote: (id) => dictation.sendNote(id),
      retryRecording: () => dictation.retry().then(() => true),
      discardRecording: () => dictation.discard().then(() => true),
      attach: () => attachMenu(),
      // Redo with a smarter model (Android's COMPARE): the kept audio becomes the pending recording
      // again, transcribed with the chosen model as a new version of the note.
      redo: async (noteId, model) => {
        if (dictation.busy() || dictation.hasSavedRecording()) throw new Error('Finish or discard the pending recording first.');
        const note = ctx.history.load(noteId);
        const recordingId = (note && note.recordingId) || noteId;
        const saved = ctx.archive.get(recordingId);
        if (!saved) throw new Error('Audio has expired or was deleted. Text is still saved.');
        fs.copyFileSync(saved, ctx.files.recording);
        ctx.prefs.set('recordingId', recordingId);
        ctx.prefs.set('sessionModel', model);
        ctx.prefs.set('sessionId', require('crypto').randomUUID());
        ctx.prefs.set('sessionCreated', Date.now());
        dictation.retry();
        return true;
      },
    };
  }
}
