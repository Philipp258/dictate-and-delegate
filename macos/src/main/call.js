'use strict';
// Hands-free calls on the Mac: the call controller (src/core/handsfree-call.js, Android's
// HandsFreeService without Android) wired to the Mac's pieces: the microphone in call mode (echo
// cancelling on), the voice played by the audio window, live transcription, Jev, bb, the ntfy
// replies, the sounds, the notes, and a small call bar floating over other apps.

const path = require('path');
const { BrowserWindow, ipcMain, screen, powerSaveBlocker } = require('electron');
const HandsFree = require('../core/handsfree');
const { HandsFreeCall } = require('../core/handsfree-call');
const { Voice, choice: voiceChoice, createSpeaker, DEFAULT: DEFAULT_VOICE } = require('../core/voice');
const streaming = require('../core/streaming-speech');
const jev = require('../core/jev');
const cues = require('../core/cues');
const chiefText = require('../core/chief-text');

const RENDERER = path.join(__dirname, '..', 'renderer');

/** The voice's player on top of the audio window (what voice.js asks of a player). */
function makePlayer(audio, prefs) {
  return {
    stream(vs, { onStarted, onEnded }) {
      let format;
      if (vs.encoding === 'pcm') format = { type: 'pcm', rate: vs.rate(), channels: vs.channels() };
      else if (vs.encoding === 'mp3' || /mpeg|mp3/i.test(vs.mime || '')) format = { type: 'mp3' };
      else format = { type: 'mp3' };
      let stopData = null;
      const handle = audio.play(format, {
        onStarted: () => onStarted && onStarted(vs.audioMs ? vs.audioMs() : 0),
        onEnded: (played) => {
          if (stopData) stopData();
          onEnded && onEnded(!!played && !vs.failed());
        },
      });
      const isWav = vs.encoding === 'file' && /wav/i.test(vs.mime || '');
      if (vs.encoding === 'file') {
        // A whole file of another type: played once it's all there.
        vs.whenDone((s) => {
          let bytes = s.data();
          if (isWav && bytes.length > 44) bytes = bytes.subarray(44);
          if (!s.failed()) handle.push(bytes);
          handle.end();
        });
      } else {
        const first = vs.data();
        if (first.length) handle.push(first);
        stopData = vs.onData((chunk) => handle.push(chunk));
        vs.whenDone(() => {
          if (stopData) stopData();
          stopData = null;
          handle.end();
        });
      }
      return { stop: () => handle.stop(), playedMs: () => handle.playedMs(), playing: () => handle.playing() };
    },

    speak(text, callbacks) {
      if (process.platform === 'darwin') return sayThrough(audio, text, prefs.get('macVoice', ''), callbacks);
      const { onStarted, onRange, onEnded, onError } = callbacks;
      const h = audio.speak(
        text,
        {
          onStarted,
          onRange,
          onEnded: (played, why) => {
            if (!played && why && why !== 'stopped' && why !== 'interrupted' && why !== 'canceled' && onError) onError(why);
            else onEnded && onEnded(!!played);
          },
        },
        prefs.get('macVoice', ''),
      );
      return { stop: () => h.stop(), playing: () => h.playing() };
    },

    warm(ms) {
      return new Promise((resolve) => {
        const h = audio.play({ type: 'pcm', rate: 16000, channels: 1 }, { onEnded: () => resolve() });
        h.push(Buffer.alloc(Math.round((16000 * 2 * ms) / 1000)));
        h.end();
        setTimeout(resolve, ms + 1500); // Never wait on a stuck output.
      });
    },

    open: () => audio.openCall(),
    close: () => audio.closeCall(),
  };
}

/**
 * The Mac's voice for a reply: macOS's `say` renders it to audio, which plays in the audio window
 * like the other voices, so the call's echo cancelling hears it and talking over it works (Web
 * speechSynthesis would play it outside Chromium, where its echo would count as your speech).
 * How far you heard follows the playback position.
 */
function sayThrough(audio, text, voiceName, { onStarted, onRange, onEnded, onError }) {
  const fs = require('fs');
  const os = require('os');
  const { execFile } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-say-'));
  const input = path.join(dir, 'reply.txt');
  const output = path.join(dir, 'reply.wav');
  fs.writeFileSync(input, text);
  let handle = null, stopped = false, timer = null, ended = false;
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});
  const finish = (played, why) => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    cleanup();
    if (!played && why && onError) onError(why);
    else onEnded && onEnded(!!played);
  };
  const render = (withVoice) =>
    execFile('/usr/bin/say', [...(withVoice ? ['-v', withVoice] : []), '--data-format=LEI16@22050', '-o', output, '-f', input], { timeout: 30_000 }, (err) => {
      if (stopped) return finish(false);
      if (err && withVoice) return render(''); // A voice macOS doesn't have: its default one.
      if (err) return finish(false, err.message);
      let pcm, rate = 22050;
      try {
        ({ pcm, rate } = wavData(fs.readFileSync(output)));
      } catch (e) {
        return finish(false, e.message);
      }
      const durationMs = (pcm.length / 2 / rate) * 1000;
      handle = audio.play(
        { type: 'pcm', rate, channels: 1 },
        {
          onStarted: () => {
            onStarted && onStarted();
            timer = setInterval(() => onRange && onRange(Math.min(text.length, Math.floor((text.length * handle.playedMs()) / durationMs))), 100);
          },
          onEnded: (played) => finish(played),
        },
      );
      handle.push(pcm);
      handle.end();
    });
  render(voiceName);
  return {
    stop: () => {
      stopped = true;
      if (handle) handle.stop();
    },
    playing: () => !!handle && handle.playing(),
  };
}

/** The samples of a WAV file (16-bit), and their rate. */
function wavData(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let rate = 22050;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(at + 12);
    if (id === 'data') return { pcm: buf.subarray(at + 8, Math.min(buf.length, at + 8 + size)), rate };
    at += 8 + size + (size % 2);
  }
  throw new Error('no audio in the WAV file');
}

function createCall({ ctx, audio, shell }) {
  const listeners = new Set();
  const player = makePlayer(audio, ctx.prefs);
  let controller = null;
  let voice = null;
  let bar = null;
  let blocker = -1;
  /** The end of the last call, while it's still being told to the chief (quitting waits for it). */
  let ending = null;

  /** Android's wake lock: released however the call ends (End, "end the call", a failed microphone). */
  function release(id = blocker) {
    if (id >= 0 && powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
    if (id === blocker) blocker = -1;
  }

  const changed = () => {
    const snap = api.snapshot();
    for (const fn of listeners) fn(snap);
    if (bar && !bar.isDestroyed()) bar.webContents.send('call', snap);
  };

  function newController(ownBlocker) {
    const { prefs, vault, bb, openRouter, profile, history } = ctx;
    voice = new Voice({ vault, player, log: (l) => ctx.log('voice: ' + l) });
    const choice = voiceChoice(prefs.get(HandsFree.VOICE, DEFAULT_VOICE.id));
    return new HandsFreeCall({
      prefs,
      bb,
      transcribe: (wav, { model, hints }) => openRouter.transcribe(wav, model, hints),
      speechModel: profile.fixedModel(),
      sendFailed: (request, why, partly) =>
        ctx.outbox && ctx.outbox.failure('call:' + request, 'call', 'Hands-free message ' + request + (partly ? ' (the talker got it)' : ''), why),
      hintWords: profile.hintWords(),
      judge: (said, { sendWords, endWords }) => jev.turn(openRouter, said, sendWords, endWords),
      createLive: (keyterms, { onText, onFailure, log }) => {
        const c = streaming.choice(prefs.get(HandsFree.LIVE_MODEL, streaming.DEFAULT.id));
        const key = vault.get(streaming.keyName(c));
        if (!key) return { missingKey: c.provider === 'elevenlabs' ? 'ElevenLabs' : 'AssemblyAI' };
        return streaming.create(c, key, keyterms, { changed: onText, onFailure, events: log });
      },
      createSpeaker: (o) => createSpeaker({ voice, prefs, ...o }),
      voice,
      voiceChoice: choice,
      playCue: (name) => {
        const { pcm, rate } = cues.pcm(name);
        audio.tone(pcm, rate);
        return true;
      },
      microphone: {
        start: (onFrame) =>
          audio.micStart({ call: true, deviceId: prefs.get('micDevice', '') }, onFrame, (why) => {
            ctx.log('hands-free: ' + why);
            api.end();
          }),
        stop: () => audio.micStop(),
      },
      replies: ({ sinceSeconds, ours, untagged, onReply }) => {
        const r = new chiefText.Replies({ server: bb.ntfyServer(), topic: bb.ntfyTopic(), sinceSeconds, ours, untagged, onReply });
        r.start();
        return { close: () => r.finish() };
      },
      logFile: ctx.files.handsFreeLog,
      saveNote: async (entry) => {
        history.save(entry);
        prefs.set('historyRevision', Number(prefs.get('historyRevision', 0)) + 1);
        ctx.emit('notes', entry.json.id);
      },
      updateNote: async (request, fn) => {
        const e = history.all().find((n) => n.json.chiefRequest === request);
        if (!e) throw new Error('no note for request ' + request);
        fn(e);
        history.save(e);
        ctx.emit('notes', e.json.id);
      },
      tellTalkerSkill: () => ctx.skills.safelyTellTalker(),
      onChange: changed,
      onEnded: () => {
        if (!api.active()) audio.mediaButtons(null);
        release(ownBlocker); // This call's own: a new call may hold another by now.
        changed();
        setTimeout(() => {
          if (!api.active() && bar && !bar.isDestroyed()) bar.hide();
        }, 4000);
      },
    });
  }

  // ---------------------------------------------------------------- the call bar

  function createBar() {
    const win = new BrowserWindow({
      type: 'panel',
      width: 300,
      height: 52,
      frame: false,
      transparent: true,
      resizable: false,
      hasShadow: false,
      focusable: false,
      acceptFirstMouse: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
      webPreferences: { preload: path.join(RENDERER, 'preload.js'), contextIsolation: true, sandbox: true },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.loadFile(path.join(RENDERER, 'callbar.html'));
    win.on('moved', () => {
      const [x, y] = win.getPosition();
      ctx.prefs.set('hfPanelX', x);
      ctx.prefs.set('hfPanelY', y);
    });
    const mine = (e) => e.sender === win.webContents;
    ipcMain.on('callbar:ready', (e) => mine(e) && win.webContents.send('call', api.snapshot()));
    ipcMain.on('callbar:action', (e, what) => {
      if (!mine(e)) return;
      if (what === 'send') api.sendNow();
      else if (what === 'end') api.end();
      else if (what === 'open') shell.openMain('handsfree');
    });
    ipcMain.on('callbar:size', (e, w, h) => {
      if (!mine(e)) return;
      const [x, y] = win.getPosition();
      win.setBounds({ x, y, width: Math.max(120, w), height: Math.max(36, h) });
    });
    return win;
  }

  function showBar(at) {
    if (!bar || bar.isDestroyed()) bar = createBar();
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    let x = ctx.prefs.get('hfPanelX', null);
    let y = ctx.prefs.get('hfPanelY', null);
    // Switched over with 📞: where the dictation panel was.
    if (at) [x, y] = at;
    if (x === null || y === null) {
      x = area.x + area.width - 340;
      y = area.y + 12;
    }
    bar.setPosition(Math.round(x), Math.round(y));
    bar.showInactive();
  }

  // ---------------------------------------------------------------- what main calls

  const api = {
    active: () => !!(controller && controller.current()),

    start({ seed = null } = {}) {
      if (api.active()) return;
      const at = shell.panelPosition ? shell.panelPosition() : null;
      blocker = powerSaveBlocker.start('prevent-app-suspension'); // Android's wake lock.
      controller = newController(blocker);
      controller.start({ seed });
      audio.mediaButtons(() => api.sendNow()); // The headset button sends, as on Android.
      showBar(seed ? at : null);
      changed();
    },

    async end() {
      if (!controller) return;
      const id = blocker;
      const done = controller.finish();
      audio.mediaButtons(null);
      ending = done;
      changed();
      await done;
      release(id); // Only this call's: a new call may have started meanwhile.
      if (ending === done) ending = null;
    },

    /** Resolves once the last call's end was told (or given up): quitting waits for it. */
    settled() {
      const c = controller;
      if (c && c.ended) return c.ended;
      return ending || Promise.resolve();
    },

    sendNow() {
      if (controller) controller.sendNow();
    },

    snapshot() {
      return controller ? controller.snapshot() : { active: false, liveLabel: 'Ended', shortLabel: 'Ended', reasons: [], canSend: false, canEnd: false, cost: 0, pending: '', reply: '' };
    },

    shortState() {
      return controller && api.active() ? controller.snapshot().shortLabel : '';
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** For tests: frames instead of the microphone. */
    controller: () => controller,
  };
  return api;
}

module.exports = { createCall, makePlayer, wavData };
