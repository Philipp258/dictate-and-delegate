'use strict';
// The main window's API: one IPC channel, "api", with a table of methods the window calls
// (dd.invoke('api', method, ...args)). It reads and writes the settings under the Android keys,
// checks and saves keys into the vault, and lists notes, activity and usage the way MainActivity
// does. Changes are pushed to the window as ('event', name, payload): notes, skills, settings, call.
//
// Results go back as { ok: true, value } or { ok: false, error } with a readable message, so the
// window shows what went wrong instead of Electron's "Error invoking remote method".
//
// Keys never leave the vault here, except into an exported settings file the user confirmed.

const fs = require('fs');
const path = require('path');
const { tr } = require('../core/util');
const decimal = require('../core/decimal');
const openrouter = require('../core/openrouter');
const anthropic = require('../core/anthropic');
const textModel = require('../core/text-model');
const jev = require('../core/jev');
const profileLib = require('../core/profile');
const { ModelCatalog } = require('../core/model-catalog');
const ModelRanking = require('../core/model-ranking');
const feedback = require('../core/feedback');
const NoteList = require('../core/note-list');
const voiceLib = require('../core/voice');
const streaming = require('../core/streaming-speech');
const HandsFree = require('../core/handsfree');
const HandsFreeLog = require('../core/handsfree-log');
const netLog = require('../core/net-log');
const bridgeLib = require('../core/bb-bridge');
const oauthLib = require('../core/bb-oauth');
const skillsLib = require('../core/chief-skills');
const { friendly, CHIEF_STEP } = require('../core/dictation');
const { elapsed } = require('../core/audio-files');
const templatesLib = require('../core/templates');

const SOURCE_URL = 'https://github.com/Philipp258/dictate-and-delegate';

/** The request check of versions 2.0 and 2.1, in older notes' activity. */
const LEGACY_CHECK = 'deepseek/deepseek-v4.1-flash';
const LEGACY_CHECK_NAME = 'DeepSeek V4.1 Flash';

/** Mac settings (main.js reads the same keys). */
const HOTKEY_DEFAULT = 'Control+Shift+Space';
const CALL_HOTKEY_DEFAULT = 'Control+Alt+Shift+Space';
/** Mac: which of the Mac's voices reads replies when "The Mac's voice" is chosen ("" = the default English one). */
const MAC_VOICE = 'macVoice';

/** The settings file this app exports (Android has none). */
const APP_ID = 'dictate-and-delegate';
/** Vault entries an export carries: the keys, the custom bb token and the ntfy topic. Not the bb Connect sign-in. */
const EXPORT_KEYS = [
  openrouter.KEY,
  anthropic.KEY,
  streaming.ASSEMBLYAI_KEY,
  streaming.ELEVENLABS_KEY,
  bridgeLib.TOKEN,
  bridgeLib.NTFY_TOPIC,
];
/** Settings that describe this Mac's running state rather than choices: never exported or imported. */
const RUNTIME_PREFS = new Set([
  'state',
  'detail',
  'sessionId',
  'recordingId',
  'sessionModel',
  'sessionCreated',
  'historyRevision',
  'panelX',
  'panelY',
  'hfPanelX',
  'hfPanelY',
  'permissionsRequested',
  skillsLib.INSTALLED,
  skillsLib.CHECKED_VERSION,
]);
const MAX_IMPORT_BYTES = 2_000_000;

const DAY = 86_400_000;
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const str = (v) => (v === undefined || v === null ? '' : String(v));

// ------------------------------------------------------------------ money and time (pure)

/** US dollars with this many decimals ("$7.14"); the texts are English, so is the format. */
function money(value, decimals) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number(value) || 0);
}

/** Spending: cents for a dollar and more, otherwise four decimals so small notes don't read $0.00. */
function amount(value) {
  const v = Number(value) || 0;
  return money(v, Math.abs(v) >= 1 || v === 0 ? 2 : 4);
}

/** A note's cost; "–" when OpenRouter reported none, never a misleading $0.00. */
function cost(value, incomplete) {
  return (Number(value) || 0) === 0 && incomplete ? '–' : money(value, 4);
}

/** Charges to the last cent fraction that isn't zero, up to six decimals ("$0.000015"). */
function exact(value) {
  const s = (Number(value) || 0).toFixed(6).replace(/0+$/, '');
  const dot = s.indexOf('.');
  const scale = dot < 0 ? 0 : s.length - dot - 1;
  return money(value, Math.max(4, Math.min(6, scale)));
}

function duration(seconds) {
  if (seconds > 0 && seconds < 60) return tr('%1$d s', Math.round(seconds));
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? tr('%1$d h %2$d min', Math.floor(minutes / 60), minutes % 60) : tr('%1$d min', minutes);
}

function dayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function monthStart(monthsAgo, now = Date.now()) {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() - monthsAgo);
  return d.getTime();
}

const plus = (a, b) => Number(decimal.sum(a, b));

/**
 * Usage for one month (MainActivity.usagePage): what was spent (OpenRouter), the Anthropic credits
 * kept apart, minutes talked and notes, and each model's share. entries: HistoryEntry objects.
 */
function usageForMonth(entries, from, to) {
  let spent = 0,
    credits = 0,
    seconds = 0,
    count = 0,
    partial = false;
  const byModel = new Map();
  const slot = (id) => {
    if (!byModel.has(id)) byModel.set(id, { id, seconds: 0, cost: 0 });
    return byModel.get(id);
  };
  for (const e of entries) {
    if (e.created() < from || e.created() >= to) continue;
    spent = plus(spent, e.cost());
    credits = plus(credits, e.anthropicCost());
    partial = partial || e.incompleteCost();
    if (e.recordingId() === e.id()) {
      seconds += e.duration();
      count++;
    }
    const m = slot(e.model());
    m.seconds += e.duration();
    m.cost = plus(m.cost, Number(decimal.sum(e.cost(), -e.textCost(), -e.routeCost(), -e.jevCost(), -e.voiceCost())));
    if (e.voiceCost() > 0) slot(str(e.json.voiceModel)).cost = plus(slot(str(e.json.voiceModel)).cost, e.voiceCost());
    if (e.textCost() > 0) slot(str(e.json.textModel)).cost = plus(slot(str(e.json.textModel)).cost, e.textCost());
    if (e.routeCost() > 0) slot(LEGACY_CHECK).cost = plus(slot(LEGACY_CHECK).cost, e.routeCost());
    if (e.jevCost() > 0) slot(jev.MODEL).cost = plus(slot(jev.MODEL).cost, e.jevCost());
  }
  // TreeMap order: by model id.
  const models = [...byModel.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { spent, credits, seconds, count, partial, byModel: models };
}

/** Home's card: this month's spending and minutes, and each of the last 14 days' cost (oldest first). */
function homeStats(entries, now = Date.now()) {
  const from = monthStart(0, now);
  const today = dayStart(now);
  let spent = 0,
    seconds = 0;
  const days = new Array(14).fill(0);
  for (const e of entries) {
    if (e.created() >= from) {
      spent = plus(spent, e.cost());
      if (e.recordingId() === e.id()) seconds += e.duration();
    }
    const ago = Math.round((today - dayStart(e.created())) / DAY);
    if (ago >= 0 && ago < 14) days[13 - ago] = plus(days[13 - ago], e.cost());
  }
  return { spent, seconds, days };
}

/** The settings the window (and an imported file) may set, each with what it takes; throws for a bad value. */
function validators() {
  const bool = (v) => {
    if (typeof v !== 'boolean') throw new Error('expected true or false');
    return v;
  };
  const text = (max) => (v) => String(v == null ? '' : v).substring(0, max);
  const int = (lo, hi) => (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(tr('Enter a number between %1$s and %2$s.', lo, hi));
    return n;
  };
  const num = (lo, hi) => (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(tr('Enter a number between %1$s and %2$s.', lo, hi));
    return n;
  };
  const oneOf = (values) => (v) => {
    if (!values.includes(v)) throw new Error('not one of the choices');
    return v;
  };
  return {
    onboarded: bool,
    [profileLib.AUTO_REFINE]: bool,
    [profileLib.AUTO_CHIEF]: bool,
    retainAudio: bool,
    model: oneOf([...profileLib.OFFERED]),
    [textModel.PREF_CLAUDE]: oneOf(anthropic.MODELS.map((c) => c.id)),
    [HandsFree.VOICE]: oneOf(voiceLib.CHOICES.map((c) => c.id)),
    [HandsFree.SEND_WORDS]: text(400),
    [HandsFree.END_WORDS]: text(400),
    // Stored as typed (in range); the getters clamp, as on Android.
    [HandsFree.PAUSE_MS]: int(0, 600_000),
    [HandsFree.SILENCE_SEND_MS]: int(0, 3_600_000),
    [HandsFree.GATE]: num(0, 100),
    [HandsFree.TAKE_MS]: int(0, 60_000),
    [HandsFree.SOUNDS]: bool,
    [HandsFree.VOICE_WAIT_MS]: int(0, 600_000),
    [HandsFree.OPEN_AUDIO]: bool,
    [HandsFree.LIVE]: bool,
    [HandsFree.LIVE_MODEL]: oneOf(streaming.CHOICES.map((c) => c.id)),
    insertMethod: oneOf(['paste', 'direct']),
    autoInsert: bool,
    micDevice: text(300),
    bubbleOpacity: int(20, 100),
    macNotifications: bool,
    [MAC_VOICE]: text(200),
  };
}

/**
 * Settings without a validator that an export carries, by their type: a value of another type is
 * skipped on import. Anything not here or in validators() is skipped too.
 */
const STRING_PREFS = new Set([
  'chiefName', 'processingPrompt', 'profileTopics', 'profileWords', 'profileAbout', 'templates',
  textModel.PREF_MODEL, textModel.PREF_NAME, bridgeLib.MODE, bridgeLib.HANDLE, bridgeLib.URL, bridgeLib.LINK_BASE,
  bridgeLib.CHIEF_ID, bridgeLib.CHIEF_NAME, bridgeLib.TALKER_ID, bridgeLib.NTFY_SERVER, skillsLib.USER_NAME,
  skillsLib.TALKER_TOLD, 'hotkey', 'callHotkey',
]);
const BOOLEAN_PREFS = new Set([bridgeLib.TALKER_ON, skillsLib.CHIEF_TOLD]);
/** Long values an export may hold (the file itself is capped at MAX_IMPORT_BYTES). */
const LONG_PREFS = new Set(['templates']);

/**
 * Plain http:// only to this computer, as Android's network_security_config allows only 127.0.0.1
 * (the Mac adds localhost and ::1); everything else must be https://.
 */
function plainHttpAllowed(url) {
  if (!/^http:\/\//i.test(String(url))) return true;
  try {
    const host = new URL(String(url)).hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ settings files (pure)

/** The exported file: the app's settings and, confirmed by the user, its keys. */
function buildExport(prefsAll, vault, version = '') {
  const prefs = {};
  for (const [k, v] of Object.entries(prefsAll || {})) if (!RUNTIME_PREFS.has(k) && v !== undefined && v !== null) prefs[k] = v;
  const keys = {};
  for (const name of EXPORT_KEYS) {
    let v = null;
    try {
      v = vault.get(name);
    } catch {
      v = null;
    }
    if (typeof v === 'string' && v !== '') keys[name] = v;
  }
  return { app: APP_ID, version, exported: new Date().toISOString(), prefs, keys };
}

/**
 * Reads an exported settings file (text): { prefs, keys } to apply, or an Error with a readable
 * message. Only plain values are taken; keys only under the names an export writes.
 */
function parseImport(text) {
  if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) throw new Error(tr("This file isn't a Dictate & Delegate settings file."));
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error(tr("This file isn't a Dictate & Delegate settings file."));
  }
  if (!root || typeof root !== 'object' || Array.isArray(root) || root.app !== APP_ID)
    throw new Error(tr("This file isn't a Dictate & Delegate settings file."));
  const inPrefs = root.prefs === undefined ? {} : root.prefs;
  const inKeys = root.keys === undefined ? {} : root.keys;
  if (!inPrefs || typeof inPrefs !== 'object' || Array.isArray(inPrefs) || !inKeys || typeof inKeys !== 'object' || Array.isArray(inKeys))
    throw new Error(tr('The settings file is damaged.'));
  // One bad entry doesn't stop the import: it's skipped, and the window says which.
  const prefs = {};
  const skipped = [];
  const check = validators();
  for (const [k, v] of Object.entries(inPrefs)) {
    if (RUNTIME_PREFS.has(k)) continue;
    try {
      if (has(check, k)) prefs[k] = check[k](v);
      else if (STRING_PREFS.has(k) && typeof v === 'string' && v.length <= (LONG_PREFS.has(k) ? MAX_IMPORT_BYTES : 100_000)) prefs[k] = v;
      else if (BOOLEAN_PREFS.has(k) && typeof v === 'boolean') prefs[k] = v;
      else skipped.push(k);
    } catch {
      skipped.push(k);
    }
  }
  const keys = {};
  for (const [k, v] of Object.entries(inKeys)) {
    if (!EXPORT_KEYS.includes(k) || typeof v !== 'string' || v.trim() === '' || v.length > 10_000) {
      skipped.push(k);
      continue;
    }
    keys[k] = v.trim();
  }
  return { prefs, keys, skipped };
}

// ------------------------------------------------------------------ notes (pure, from MainActivity)

/** The note was sent to the chief of staff, or sending it failed. */
function chiefNote(e) {
  return has(e.json, 'chiefThread') || has(e.json, 'chiefFailed') || str(e.json.route) === 'chief';
}

function sentToChief(e) {
  return has(e.json, 'chiefThread') && !has(e.json, 'chiefFailed');
}

/** What happened to this note: refined, sent to the chief, or the transcript as said. */
function routeLabel(e) {
  if (chiefNote(e)) return sentToChief(e) ? tr('Sent to chief of staff') : tr('Not sent to chief of staff');
  if (has(e.json, 'processed')) return tr('Refined');
  if (has(e.json, 'routeFailed')) return tr('Request check failed, kept as said');
  return tr('Transcript only');
}

function badge(n) {
  const s = str(n.shown.json.status);
  if (s !== 'complete') return s === 'pending' ? tr('in progress') : s === 'no speech' ? tr('no speech') : tr('unfinished');
  if (chiefNote(n.shown)) return sentToChief(n.shown) ? tr('chief of staff') : tr('not sent');
  if (n.versions.length > 1) return tr('redone');
  return str(n.shown.json.version) === 'original' ? tr('as said') : null;
}

function preview(n) {
  const t = n.shown.text().replace(/\n/g, ' ').trim();
  return t === '' ? tr('No text yet') : t;
}

function callTitle(c) {
  const n = c.turns.length;
  return '📞 ' + tr('Call with your chief') + ' · ' + (n === 1 ? tr('1 message') : tr('%1$d messages', n));
}

function noteSummary(n) {
  const p = preview(n);
  return {
    type: 'note',
    id: n.id(),
    created: n.created(),
    preview: p.length > 400 ? p.substring(0, 400) : p,
    elapsed: elapsed(Math.round(n.shown.duration() * 1000)),
    cost: cost(n.cost(), n.incompleteCost()),
    badge: badge(n),
  };
}

function callSummary(c) {
  const first = preview(c.turns[c.turns.length - 1]);
  return {
    type: 'call',
    id: c.id,
    title: callTitle(c),
    created: c.created(),
    latest: c.latest(),
    first: first.length > 200 ? first.substring(0, 200) : first,
    elapsed: elapsed(Math.round(c.duration() * 1000)),
    cost: cost(c.cost(), c.incompleteCost()),
    // First to last, as an opened call lists them.
    turns: c.turns.slice().reverse().map(noteSummary),
  };
}

/** Notes and calls, newest first, as All notes and Home list them. */
function listItems(notes) {
  return NoteList.withCalls(notes).map((item) => (item instanceof NoteList.Call ? callSummary(item) : noteSummary(item)));
}

// ------------------------------------------------------------------ the API

/**
 * The method table. ctx: the app context (context.js); shell: what main.js offers (every method
 * optional, guarded). push(name, payload): sends an event to the window.
 */
function createMethods(ctx, shell = {}, push = () => {}) {
  const { prefs, vault, profile, templates, history, attachments, archive, bb, skills } = ctx;
  let catalog = null;
  try {
    catalog = new ModelCatalog();
  } catch (e) {
    ctx.log(`api: models.json not read (${e.message})`);
  }
  let refineCatalog = null;
  let skillsTimer = null;

  const call = (name, ...args) => (typeof shell[name] === 'function' ? shell[name](...args) : undefined);
  const hasKey = (name) => {
    try {
      const k = vault.get(name);
      return typeof k === 'string' && k.trim() !== '';
    } catch {
      return false;
    }
  };
  const dictationBusy = () => {
    const s = call('dictationState');
    return !!(s && s.busy);
  };
  /** The name field and the talker wait for a pause in typing before the skills are updated in bb. */
  const skillsSoon = () => {
    clearTimeout(skillsTimer);
    skillsTimer = setTimeout(() => skills.sync(false), 1500);
  };
  /** Vault writes are on disk before the window hears "saved" (Electron 45's safeStorage is async). */
  const flush = async () => {
    if (typeof vault.flush === 'function') await vault.flush();
  };
  const notesChanged = (id) => {
    prefs.set('historyRevision', Date.now());
    ctx.emit('notes', id);
  };

  // ---- names and labels (MainActivity's helpers)

  const textModelName = (id) => {
    if (LEGACY_CHECK === id) return tr('Request check · %1$s', LEGACY_CHECK_NAME);
    if (jev.MODEL === id) return 'Jev';
    if (textModel.MODEL === id) return textModel.NAME;
    if (textModel.model(prefs) === id) return textModel.modelName(prefs);
    const c = anthropic.claude(id);
    if (c) return c.name + ' · Anthropic';
    return id;
  };
  const modelName = (id) => {
    const m = catalog && catalog.find(id);
    return m ? ModelRanking.name(m) : textModelName(str(id));
  };
  const voiceName = (model) => {
    const c = voiceLib.CHOICES.find((v) => v.model === model && model !== '');
    return c ? c.name : model;
  };
  const perMinute = (id) => {
    const m = catalog && catalog.find(id);
    const p = m ? ModelRanking.minuteCost(m) : NaN;
    return Number.isFinite(p) ? tr('%1$s/min', money(p, 4)) : '';
  };
  const estimate = (m, seconds) => {
    const p = ModelRanking.minuteCost(m);
    return Number.isFinite(p) ? tr('about %1$s', money((p * seconds) / 60, 4)) : tr('price shown afterwards');
  };
  const voiceNote = (c) => {
    const notes = {
      'best voice': tr('best voice'),
      'offline, free': tr('offline, free'),
      fastest: tr('fastest'),
      fast: tr('fast'),
      'fast, cheap': tr('fast, cheap'),
      cheap: tr('cheap'),
    };
    const note = notes[c.note] || tr('cheapest');
    if (!c.model) return note;
    // OpenRouter's price; Gemini's is per token, so about.
    const price = decimal.plain(decimal.strip(decimal.shift(decimal.of(c.pricePerCharacter), 6)));
    return note + ' · ' + (c.model === voiceLib.GEMINI ? tr('about $%1$s per million characters', price) : tr('$%1$s per million characters', price));
  };
  const voiceLabel = () => {
    const c = voiceLib.choice(prefs.get(HandsFree.VOICE, voiceLib.DEFAULT.id));
    return c.name + ' · ' + voiceNote(c);
  };
  const liveNote = (c) =>
    c.note === 'most accurate' ? tr('most accurate') : c.note === 'second best' ? tr('second best') : tr('fastest, cheapest, less accurate');
  const liveLabel = () => {
    const c = streaming.choice(prefs.get(HandsFree.LIVE_MODEL, streaming.DEFAULT.id));
    return c.name + ' · ' + (hasKey(streaming.keyName(c)) ? tr('key saved') : tr('no key yet'));
  };
  const decisionsLabel = () => {
    if (profile.autoRefine() && profile.autoChief()) return tr('Jev · refines and sends to your chief by itself');
    if (profile.autoRefine()) return tr('Jev · refines by itself');
    if (profile.autoChief()) return tr('Jev · sends to your chief by itself');
    return tr('Jev · nothing starts by itself');
  };
  const refineModelLabel = () =>
    anthropic.hasKey(vault)
      ? tr('%1$s · Anthropic, your key', textModel.claude(prefs).name)
      : textModel.modelName(prefs) + ' · OpenRouter';
  const refineLabel = () =>
    profile.autoRefine()
      ? tr('Automatic · %1$s', textModel.name(prefs, vault))
      : tr('When you tap ✨ Refine · %1$s', textModel.name(prefs, vault));
  const connectionLabel = () => {
    if (!bb.connected()) return tr('Not connected');
    if (bb.mode() === bridgeLib.CUSTOM) {
      let host = bb.url();
      try {
        host = new URL(bb.url()).host;
      } catch {
        /* Shown as saved. */
      }
      return tr('Custom address · %1$s', host);
    }
    return tr('bb Connect · %1$s.getbb.app', bb.handle());
  };
  const chiefLabel = () =>
    !bb.chiefId() ? tr('Not set') : (bb.chiefTitle() || tr('Chief of staff')) + ' · ' + bb.chiefId();
  const skillsLine = () => {
    switch (skills.state) {
      case skillsLib.State.CHECKING:
        return { text: tr("Checking the chief's skills in bb…"), tone: 'muted' };
      case skillsLib.State.INSTALLING:
        return { text: tr("Installing the chief's skills in bb…"), tone: 'muted' };
      case skillsLib.State.INSTALLED:
        return { text: tr('✓  Installed in bb'), tone: 'ok' };
      case skillsLib.State.FAILED:
        return { text: tr("Couldn't install the chief's skills: %1$s", skills.problem), tone: 'warn' };
      default:
        return { text: '', tone: 'muted' };
    }
  };
  const permissions = async () => {
    const p = (await call('permissions')) || {};
    return { microphone: p.microphone || 'not-determined', accessibility: !!p.accessibility, notifications: p.notifications !== false };
  };

  /** "Jev · 0.4 s · $0.00002 → refine 0.97", "Refine · Claude Sonnet 5.5 · 2.1 s · $0.0003". */
  const stepLine = (step) => {
    const kind = str(step.kind),
      model = str(step.model),
      detail = str(step.detail);
    const labels = { speech: tr('Transcription'), jev: 'Jev', check: tr('Request check'), voice: tr('Read aloud') };
    labels[CHIEF_STEP] = 'bb';
    const label = labels[kind] || (['refine', 'text', 'simple', 'smart'].includes(kind) ? tr('Refine') : kind);
    const name =
      kind === 'speech' ? modelName(model) : kind === 'jev' ? '' : kind === 'check' ? LEGACY_CHECK_NAME : kind === CHIEF_STEP ? tr('Chief of staff') : kind === 'voice' ? voiceName(model) : textModelName(model);
    const answer = kind === 'check' ? checkDetail(detail) : has(step, 'answer') ? str(step.answer) : null;
    const failed = detail !== '' && kind !== 'check';
    const n = (v) => (typeof v === 'number' ? v : Number(v) || 0);
    let line = label + (name ? ' · ' + name : '') + ' · ' + (n(step.ms) / 1000).toFixed(1) + ' s';
    if (has(step, 'cost')) line += ' · ' + (step.approx ? '≈' : '') + exact(Number(step.cost));
    if (step.approx) line += ' ' + tr('(Anthropic credits)');
    line += failed ? ' · ' + detail : answer ? ' → ' + answer : '';
    if (has(step, 'fallback')) line += ' · ' + tr('via OpenRouter: %1$s', str(step.fallback));
    if (has(step, 'files'))
      line +=
        ' · ' +
        (n(step.files) === 1 ? tr('%1$d file', 1) : tr('%1$d files', n(step.files))) +
        (str(step.filesHow).includes('base64') ? ' ' + tr('(as base64)') : '');
    if (has(step, 'uploadRefused')) line += ' · ' + tr('bb refused the upload (HTTP %1$d)', n(step.uploadRefused));
    if (has(step, 'filesFailed')) line += ' · ' + tr('not passed on: %1$s', str(step.filesFailed));
    return { line, failed, model };
  };

  const currentNote = (id) => {
    const group = NoteList.group(history.versions(id));
    return group.length ? group[0] : null;
  };
  const audioOf = (id) => {
    try {
      return archive.get(id) != null;
    } catch {
      return false;
    }
  };
  const smarterModel = (n) => {
    if (!catalog) return null;
    const tried = new Set(n.versions.map((v) => v.model()));
    return feedback.alternative(catalog.models, catalog.find(n.shown.model()), feedback.ACCURACY, tried);
  };

  // ---- bb helpers

  const bbMessage = (ex) => (ex && ex.message && ex.name !== 'TypeError' && ex.name !== 'AbortError' ? ex.message : friendly(ex));
  const bbAction = async (work) => {
    try {
      return { ok: true, message: await work() };
    } catch (ex) {
      return { ok: false, message: bbMessage(ex) };
    }
  };
  const topic = async () => {
    // Mac: before making a topic of its own, take the phone's from bb if it set bb up.
    if (!bb.hasNtfyTopic() && bb.connected()) await skills.adoptIfNew();
    return bb.ntfyTopic();
  };

  // ---- settings anyone may set from the window, with what each takes (validators())
  const SETTABLE = validators();

  const methods = {
    // ---------------------------------------------------------------- the whole picture

    /** Everything the pages show in their rows, in one call. */
    async state() {
      const words = profile.words();
      const topics = profile.topics();
      const tmpl = templates.all().length;
      const liveChoice = streaming.choice(prefs.get(HandsFree.LIVE_MODEL, streaming.DEFAULT.id));
      return {
        version: ctx.version,
        sourceUrl: SOURCE_URL,
        onboarded: prefs.get('onboarded', false) === true,
        keys: {
          openrouter: openrouter.hasKey(vault),
          anthropic: anthropic.hasKey(vault),
          assemblyai: hasKey(streaming.ASSEMBLYAI_KEY),
          elevenlabs: hasKey(streaming.ELEVENLABS_KEY),
        },
        permissions: await permissions(),
        hotkey: (await call('hotkey')) ?? prefs.get('hotkey', HOTKEY_DEFAULT),
        callHotkey: (await call('callHotkey')) ?? prefs.get('callHotkey', CALL_HOTKEY_DEFAULT),
        hotkeyProblems: (await call('hotkeyProblems')) || {},
        notifier: (await call('notifierState')) || '',
        labels: {
          speech: modelName(profile.fixedModel()),
          speechPerMinute: perMinute(profile.fixedModel()),
          voice: voiceLabel(),
          decisions: decisionsLabel(),
          refineModel: refineModelLabel(),
          refine: refineLabel(),
          refineName: textModel.name(prefs, vault),
          refinePrompt: profile.refinePrompt() === textModel.DEFAULT_PROMPT ? tr('Default') : tr('Your own'),
          templates: tmpl === 0 ? tr('Texts you reuse, adapted by voice') : tmpl === 1 ? tr('1 template') : tr('%1$d templates', tmpl),
          words: words.length === 1 ? tr('1 word') : tr('%1$d words', words.length),
          about: topics.length === 0 ? tr('Not set') : topics.join(', '),
          connection: connectionLabel(),
          chief: chiefLabel(),
          ntfy: 'ntfy · ' + bb.ntfyServer().replace(/^https?:\/\//, ''),
          live: liveLabel(),
        },
        profile: {
          autoRefine: profile.autoRefine(),
          autoChief: profile.autoChief(),
          chiefName: profile.chiefName(),
          jevModel: jev.MODEL,
        },
        bb: {
          connected: bb.connected(),
          ready: bb.ready(),
          mode: bb.mode(),
          handle: bb.handle(),
          url: bb.mode() === bridgeLib.CUSTOM ? bb.url() : '',
          linkBase: bb.mode() === bridgeLib.CUSTOM ? bb.linkBase() : bb.handle() ? oauthLib.origin(bb.handle()) : '',
          hasToken: !!bb.customToken(),
          chiefId: bb.chiefId(),
          chiefTitle: bb.chiefTitle(),
          chiefLink: bb.chiefId() ? bb.threadLink(bb.chiefId()) : '',
          ntfyServer: bb.ntfyServer(),
          ntfyDefault: bridgeLib.NTFY_DEFAULT,
          userName: prefs.get(skillsLib.USER_NAME, ''),
          talkerId: bb.savedTalker(),
          talkerOn: bb.talkerOn(),
          talkerProblem: skills.talkerProblem(),
        },
        skills: { state: skills.state, line: skillsLine() },
        handsFree: {
          sendWords: prefs.get(HandsFree.SEND_WORDS, HandsFree.DEFAULT_SEND),
          endWords: HandsFree.endSetting(prefs),
          defaultSend: HandsFree.DEFAULT_SEND,
          defaultEnd: HandsFree.DEFAULT_END,
          sendList: HandsFree.words(prefs, HandsFree.SEND_WORDS, HandsFree.DEFAULT_SEND),
          endList: HandsFree.list(HandsFree.endSetting(prefs)),
          pauseMs: HandsFree.pauseMs(prefs),
          silenceSendMs: HandsFree.silenceSendMs(prefs),
          gate: HandsFree.gate(prefs),
          takeMs: HandsFree.takeMs(prefs),
          sounds: prefs.get(HandsFree.SOUNDS, true) !== false,
          voiceWaitMs: HandsFree.voiceWaitMs(prefs),
          openAudio: prefs.get(HandsFree.OPEN_AUDIO, true) !== false,
          live: prefs.get(HandsFree.LIVE, true) !== false,
          liveModel: liveChoice.id,
          liveKeySaved: hasKey(streaming.keyName(liveChoice)),
        },
        mac: {
          insertMethod: prefs.get('insertMethod', 'paste'),
          autoInsert: prefs.get('autoInsert', false) === true,
          micDevice: prefs.get('micDevice', ''),
          bubbleOpacity: Number(prefs.get('bubbleOpacity', 65)),
          macNotifications: prefs.get('macNotifications', true) !== false,
          macVoice: prefs.get(MAC_VOICE, ''),
        },
        retainAudio: prefs.get('retainAudio', true) !== false,
        dictation: (await call('dictationState')) || null,
        handsFreeAvailable: typeof shell.callAvailable === 'function' ? !!(await shell.callAvailable()) : typeof shell.startCall === 'function',
        attachmentsPending: (() => {
          try {
            return attachments.pending().length;
          } catch {
            return 0;
          }
        })(),
      };
    },

    /** One setting from the allowed list, checked; the getters clamp further, as on Android. */
    setPref(key, value) {
      if (!has(SETTABLE, key)) throw new Error('This setting cannot be changed here: ' + key);
      prefs.set(key, SETTABLE[key](value));
      if (key === 'retainAudio') {
        try {
          archive.prune();
        } catch {
          /* Pruning runs again on next launch. */
        }
      }
      return true;
    },

    // ---------------------------------------------------------------- keys

    async checkOpenRouterKey(key) {
      const k = String(key || '').trim();
      if (!k) throw new Error(tr('Paste your key first'));
      try {
        await openrouter.check(k);
      } catch (ex) {
        throw new Error(friendly(ex));
      }
      vault.set(openrouter.KEY, k);
      await flush();
      ctx.emit('settings', 'openrouterKey');
      return tr('Key saved');
    },
    removeOpenRouterKey() {
      vault.remove(openrouter.KEY);
      ctx.emit('settings', 'openrouterKey');
      return true;
    },
    async checkAnthropicKey(key) {
      const k = String(key || '').trim();
      if (!k) throw new Error(tr('Paste your key first'));
      try {
        await anthropic.check(k);
      } catch (ex) {
        throw new Error(friendly(ex));
      }
      vault.set(anthropic.KEY, k);
      await flush();
      ctx.emit('settings', 'anthropicKey');
      return tr('Key saved');
    },
    removeAnthropicKey() {
      vault.remove(anthropic.KEY);
      ctx.emit('settings', 'anthropicKey');
      return true;
    },
    /** Live transcription keys (AssemblyAI, ElevenLabs): saved as given; the provider checks them on first use. */
    async saveLiveKey(provider, key) {
      const name = provider === streaming.ELEVENLABS ? streaming.ELEVENLABS_KEY : provider === streaming.ASSEMBLYAI ? streaming.ASSEMBLYAI_KEY : null;
      if (!name) throw new Error('unknown provider');
      const k = String(key || '').trim();
      if (!k) throw new Error(tr('Paste your key first'));
      vault.set(name, k);
      await flush();
      ctx.emit('settings', name);
      return tr('Key saved');
    },
    removeLiveKey(provider) {
      const name = provider === streaming.ELEVENLABS ? streaming.ELEVENLABS_KEY : streaming.ASSEMBLYAI_KEY;
      vault.remove(name);
      ctx.emit('settings', name);
      return true;
    },

    // ---------------------------------------------------------------- notes

    /** Home: the three most recent notes or calls, and the month card. */
    home() {
      const entries = history.all();
      const grouped = NoteList.group(entries);
      const stats = homeStats(entries);
      return {
        recent: listItems(grouped).slice(0, 3),
        month: {
          spent: amount(stats.spent),
          talked: duration(stats.seconds),
          days: stats.days,
          today: stats.days[13],
        },
      };
    },

    /** All notes (search: their shown text), calls as one entry with their messages. */
    notes(query = '') {
      const grouped = NoteList.group(history.all());
      const shown = NoteList.search(grouped, String(query || ''));
      return { total: grouped.length, items: listItems(shown) };
    },

    /** One note, as its page shows it. */
    note(id) {
      const n = currentNote(String(id));
      if (!n) return null;
      const e = n.shown;
      const j = e.json;
      const status = str(j.status);
      const s = call('dictationState');
      const redoing = !!(s && s.busy && s.recordingId === n.id());
      let warning = '';
      if (status !== 'complete' && !redoing) {
        if (status === 'pending') warning = tr('Still transcribing.');
        else if (status === 'no speech') warning = tr('No speech was recognized in this recording.');
        else {
          const why = { 'needs attention': tr('needs attention'), 'audio discarded': tr('audio discarded'), imported: tr('imported') }[status] || status;
          warning = tr("This recording didn't finish (%1$s). Retry it from Home.", why);
        }
      }
      const chief = chiefNote(e);
      const sent = chief && sentToChief(e);
      const twoVersions = has(j, 'processed') && str(j.processed) !== str(j.original);
      let files = [];
      try {
        files = attachments.of(n.id()).map((f) => (f.kind === 'text' ? tr('pasted text') : f.name));
      } catch {
        files = [];
      }
      const audio = audioOf(n.id());
      const smarter = smarterModel(n);
      const ms = Number(j.processingMs) || 0;
      const costText = !n.incompleteCost()
        ? tr('This note cost %1$s.', money(n.cost(), 4))
        : n.cost() > 0
          ? tr('This note cost %1$s so far.', money(n.cost(), 4))
          : tr('OpenRouter reported no cost for this note yet.');
      return {
        id: n.id(),
        created: n.created(),
        recorded: tr('%1$s recorded', elapsed(Math.round(e.duration() * 1000))),
        status,
        warning,
        redoing,
        chief: chief ? { sent, link: str(j.chiefLink), failed: str(j.chiefFailed) } : null,
        chiefReply: has(j, 'chiefReply') ? str(j.chiefReply) : '',
        processingFailed: has(j, 'processingFailed') ? str(j.processingFailed) : '',
        twoVersions,
        version: str(j.version),
        text: e.text(),
        original: has(j, 'original') ? str(j.original) : e.raw(),
        files,
        cost: costText,
        anthropicCost: n.anthropicCost() > 0 ? tr('Refine: Anthropic credits ≈%1$s', exact(n.anthropicCost())) : '',
        anthropicWarning: str(j.anthropicWarning) ? tr('Refined through OpenRouter instead of Anthropic: %1$s', str(j.anthropicWarning)) : '',
        audio,
        smarter: smarter ? { id: str(smarter.id), name: modelName(str(smarter.id)) } : null,
        canRedo: audio && !!smarter && !redoing && typeof shell.redo === 'function',
        redoNote: !audio
          ? tr("Audio for this note wasn't kept, so it can't be redone.")
          : !smarter
            ? tr('This note already used the most accurate model.')
            : modelName(str(smarter.id)) + ' · ' + estimate(smarter, e.duration()),
        details:
          routeLabel(e) +
          ' · ' +
          e.model() +
          (has(j, 'textModel') ? ' + ' + str(j.textModel) : '') +
          (has(j, 'template') ? ' · ' + str(j.template) : '') +
          (ms > 0 ? ' · ' + (ms / 1000).toFixed(1) + ' s' : '') +
          (n.versions.length > 1 ? ' · ' + tr('%1$d versions', n.versions.length) : ''),
        versions: n.versions
          .slice()
          .sort((a, b) => a.created() - b.created())
          .map((v) => ({ id: v.id(), model: modelName(v.model()), created: v.created(), shown: v.id() === e.id() })),
        steps: Array.isArray(j.steps) ? j.steps.filter((x) => x && typeof x === 'object').map(stepLine) : [],
        canRefineAgain: typeof shell.refineNote === 'function',
        canSendAgain: typeof shell.sendNote === 'function',
      };
    },

    /** Saves typed changes to the version shown: "What you said" (original) or the note's text. */
    editNote(id, { original = false, text: value = '' } = {}) {
      const n = currentNote(String(id));
      if (!n) throw new Error(tr('This note was deleted.'));
      const e = n.shown;
      const now = String(value).trim();
      // Edits belong to the version you are looking at; "raw" stays what the speech model wrote.
      if (original) e.json.original = now;
      else {
        e.json.text = now;
        e.json[str(e.json.version) === 'processed' ? 'processed' : 'original'] = now;
      }
      history.save(e);
      notesChanged(n.id());
      return true;
    },

    /** Keeps this version of a redone note as the one shown. */
    preferVersion(versionId) {
      const v = history.get(String(versionId));
      if (!v) throw new Error(tr('This note was deleted.'));
      history.prefer(v);
      notesChanged(v.recordingId());
      return true;
    },

    deleteNote(id) {
      const s = call('dictationState');
      if (s && s.busy && s.recordingId === id) throw new Error(tr('Wait until this note finishes'));
      let failed = false;
      for (const v of history.versions(String(id))) {
        try {
          history.delete(v.id());
        } catch {
          failed = true;
        }
      }
      try {
        archive.delete(String(id));
      } catch {
        failed = true;
      }
      try {
        attachments.deleteNote(String(id));
      } catch {
        /* None, or an ID attachments don't take. */
      }
      vault.remove('transcript');
      notesChanged(String(id));
      if (failed) throw new Error(tr('Could not delete everything'));
      return true;
    },

    deleteNoteAudio(id) {
      try {
        archive.delete(String(id));
      } catch {
        throw new Error(tr('Could not delete audio'));
      }
      notesChanged(String(id));
      return true;
    },

    /** Refine again, Send again, Redo: main's dictation does them (optional shell hooks). */
    async refineAgain(id) {
      if (typeof shell.refineNote !== 'function') throw new Error(tr('Not available yet.'));
      if (!openrouter.hasKey(vault)) throw new Error(tr("Add your OpenRouter key in Dictate & Delegate's Settings first."));
      const n = currentNote(String(id));
      if (!n) throw new Error(tr('This note was deleted.'));
      const failed = await shell.refineNote(n.shown.id(), str(n.shown.json.template));
      notesChanged(String(id));
      if (failed) throw new Error(failed);
      return tr('Refined');
    },
    async sendAgain(id) {
      if (typeof shell.sendNote !== 'function') throw new Error(tr('Not available yet.'));
      const n = currentNote(String(id));
      if (!n) throw new Error(tr('This note was deleted.'));
      const failed = await shell.sendNote(n.shown.id());
      notesChanged(String(id));
      if (failed) throw new Error(failed);
      return tr('Sent to chief of staff');
    },
    async redo(id) {
      if (typeof shell.redo !== 'function') throw new Error(tr('Not available yet.'));
      const n = currentNote(String(id));
      if (!n) throw new Error(tr('This note was deleted.'));
      const smarter = smarterModel(n);
      if (!smarter) throw new Error(tr('This note already used the most accurate model.'));
      if (dictationBusy()) throw new Error(tr('Finish or discard the pending recording first'));
      await shell.redo(n.id(), str(smarter.id));
      return tr('Redoing with a smarter model… You can leave this screen.');
    },

    /** Every note's steps, newest first (the latest 100 versions). */
    activity() {
      return history.list(100, 0).map((e) => {
        const routed = has(e.json, 'route') || has(e.json, 'routeFailed') || has(e.json, 'textModel') || chiefNote(e);
        const t = e.text().replace(/\s+/g, ' ').trim();
        const steps = Array.isArray(e.json.steps) ? e.json.steps.filter((x) => x && typeof x === 'object') : [];
        return {
          id: e.id(),
          recordingId: e.recordingId(),
          created: e.created(),
          route: routed ? routeLabel(e) : '',
          cost: e.cost() === 0 && e.incompleteCost() ? '–' : exact(e.cost()),
          preview: t === '' ? tr('No text yet') : t.length > 400 ? t.substring(0, 400) : t,
          // Notes from before the activity log: only the models are known.
          models: steps.length ? '' : e.model() + (has(e.json, 'textModel') ? ' + ' + str(e.json.textModel) : ''),
          steps: steps.map(stepLine),
        };
      });
    },

    /** One month's usage (0: this month). */
    usage(monthsAgo = 0) {
      const m = Math.max(0, Math.trunc(Number(monthsAgo) || 0));
      const from = monthStart(m),
        to = monthStart(m - 1);
      const u = usageForMonth(history.all(), from, to);
      const max = u.byModel.reduce((a, x) => Math.max(a, x.cost), 0);
      return {
        from,
        monthsAgo: m,
        spent: amount(u.spent),
        talked: duration(u.seconds),
        notes: String(u.count),
        byModel: u.byModel.map((x) => ({
          id: x.id,
          name: voiceName(x.id) === x.id ? modelName(x.id) : voiceName(x.id),
          value: (x.seconds > 0 ? duration(x.seconds) + ' · ' : '') + amount(x.cost),
          share: max <= 0 ? 0 : x.cost / max,
        })),
        footnote: u.partial
          ? tr('What OpenRouter charged for each call. Some calls reported no cost, so the real total is a little higher.')
          : tr('What OpenRouter charged for each call.'),
        anthropic:
          u.credits > 0
            ? tr('Anthropic credits used this month ≈%1$s (Refine with your Anthropic key, at list price; not in the total)', exact(u.credits))
            : '',
      };
    },

    // ---------------------------------------------------------------- dictation settings

    templates() {
      return templates.all().map((t) => {
        const p = t.text.replace(/\n/g, ' ');
        return { id: t.id, name: t.name, preview: p.length > 80 ? p.substring(0, 80) + '…' : p };
      });
    },
    template(id) {
      return templates.get(String(id)) || null;
    },
    saveTemplate(id, name, value) {
      if (!String(name || '').trim() || !String(value || '').trim()) throw new Error(tr('Give the template a name and a text'));
      try {
        return templates.save(id ? String(id) : null, String(name), String(value));
      } catch {
        throw new Error(tr('Could not save the template'));
      }
    },
    deleteTemplate(id) {
      try {
        templates.delete(String(id));
      } catch {
        throw new Error(tr('Could not delete the template'));
      }
      return true;
    },
    templateMax() {
      return templatesLib.MAX_TEXT;
    },

    words() {
      return profile.words();
    },
    addWord(word) {
      profile.addWord(String(word || ''));
      return profile.words();
    },
    removeWord(word) {
      profile.removeWord(String(word || ''));
      return profile.words();
    },

    aboutYou() {
      return { topics: profileLib.TOPICS, selected: profile.topics(), about: profile.about() };
    },
    setTopics(list) {
      const allowed = Array.isArray(list) ? list.filter((t) => profileLib.TOPICS.includes(t)) : [];
      profile.setTopics(allowed);
      return profile.topics();
    },
    setAbout(value) {
      profile.setAbout(String(value || '').substring(0, 2000));
      return true;
    },
    setChiefName(name) {
      profile.setChiefName(String(name || '').substring(0, 40));
      return true;
    },

    refinePrompt() {
      return { prompt: profile.refinePrompt(), isDefault: profile.refinePrompt() === textModel.DEFAULT_PROMPT };
    },
    setRefinePrompt(value) {
      const t = String(value || '').substring(0, 4000);
      prefs.set('processingPrompt', t.trim() === textModel.DEFAULT_PROMPT ? '' : t);
      return true;
    },
    resetRefinePrompt() {
      prefs.remove('processingPrompt');
      return profile.refinePrompt();
    },

    // ---------------------------------------------------------------- models

    /** Speech models from models.json, searched and sorted ("recommended", "accuracy", "cost", "speed"). */
    speechModels(query = '', sort = 'recommended') {
      if (!catalog) return { priceDate: '—', selected: profile.fixedModel(), models: [] };
      const selected = profile.fixedModel();
      return {
        priceDate: catalog.priceDate,
        selected,
        models: ModelRanking.filter(catalog.models, String(query || ''), String(sort || 'recommended')).map((m) => ({
          id: str(m.id),
          name: ModelRanking.name(m),
          perMinute: perMinute(str(m.id)),
          meta:
            str(m.id).split('/')[0] +
            ' · ' +
            ModelRanking.languages(m) +
            '   ' +
            tr('words %1$s  speed %2$s', ModelRanking.dots(ModelRanking.accuracy(m)), ModelRanking.dots(ModelRanking.speed(m))),
        })),
      };
    },
    setSpeechModel(id) {
      if (dictationBusy()) throw new Error(tr('Finish recording or upload first'));
      if (!profileLib.OFFERED.has(id)) throw new Error('not offered');
      prefs.set('model', id);
      const m = catalog && catalog.find(id);
      return tr('Dictate & Delegate now always uses %1$s', m ? ModelRanking.name(m) : id);
    },

    /** Text-to-speech choices (Voice.CHOICES) with their notes and prices. */
    voices() {
      const current = voiceLib.choice(prefs.get(HandsFree.VOICE, voiceLib.DEFAULT.id)).id;
      return {
        current,
        choices: voiceLib.CHOICES.map((c) => ({
          id: c.id,
          name: c.name,
          note: voiceNote(c) + (c.model ? ' · ' + c.model : ''),
          system: !c.model,
        })),
        macVoice: prefs.get(MAC_VOICE, ''),
      };
    },
    async systemVoices() {
      const list = (await call('systemVoices')) || [];
      return Array.isArray(list) ? list.filter((v) => v && v.name).map((v) => ({ name: String(v.name), lang: str(v.lang) })) : [];
    },

    /** Live transcription models (StreamingSpeech.CHOICES), and whether each provider's key is saved. */
    liveModels() {
      const current = streaming.choice(prefs.get(HandsFree.LIVE_MODEL, streaming.DEFAULT.id)).id;
      return {
        current,
        choices: streaming.CHOICES.map((c) => ({
          id: c.id,
          name: c.name,
          note: liveNote(c) + ' · ' + (hasKey(streaming.keyName(c)) ? tr('key saved') : tr('no key yet')),
        })),
        keys: [
          { provider: streaming.ASSEMBLYAI, label: tr('AssemblyAI key'), saved: hasKey(streaming.ASSEMBLYAI_KEY), url: 'https://www.assemblyai.com/dashboard/api-keys' },
          { provider: streaming.ELEVENLABS, label: tr('ElevenLabs key'), saved: hasKey(streaming.ELEVENLABS_KEY), url: 'https://elevenlabs.io/app/settings/api-keys' },
        ],
      };
    },

    /** Refine's models: the Claude models on the Anthropic key, and OpenRouter's text models (loaded once). */
    async refineModels({ reload = false } = {}) {
      const direct = anthropic.hasKey(vault);
      const claudeSelected = textModel.claude(prefs).id;
      const out = {
        direct,
        claudeName: textModel.claude(prefs).name,
        openRouterName: textModel.modelName(prefs),
        selected: textModel.model(prefs),
        claude: anthropic.MODELS.map((c, i) => ({
          id: c.id,
          name: c.name,
          price: textModel.dollars(c.input) + ' / ' + textModel.dollars(c.output),
          meta: c.id + (i === 0 ? ' · ' + tr('default') : ''),
          selected: c.id === claudeSelected,
        })),
        openRouter: null,
        error: '',
      };
      if (!refineCatalog || reload) {
        try {
          refineCatalog = textModel.catalog(await openrouter.models());
        } catch (ex) {
          out.error = friendly(ex);
        }
      }
      if (refineCatalog)
        out.openRouter = refineCatalog.map((m) => ({
          id: str(m.id),
          name: str(m.name) || str(m.id),
          price: textModel.price(m),
          meta: str(m.id) + (str(m.id) === textModel.MODEL ? ' · ' + tr('default') : ''),
        }));
      return out;
    },
    setRefineModel(id, name) {
      const i = String(id || '').trim();
      if (!i || i.length > 200) throw new Error('no model');
      prefs.set(textModel.PREF_MODEL, i);
      prefs.set(textModel.PREF_NAME, String(name || i).substring(0, 200));
      return tr('Refine now uses %1$s', String(name || i));
    },
    setClaudeModel(id) {
      const c = anthropic.claude(id);
      if (!c) throw new Error('no model');
      prefs.set(textModel.PREF_CLAUDE, c.id);
      return tr('Refine now uses %1$s', c.name);
    },

    // ---------------------------------------------------------------- bb

    /** bb Connect: the browser opens bb's account page; main finishes the sign-in when it comes back. */
    async bbConnect(handleInput) {
      const h = oauthLib.handle(String(handleInput || ''));
      if (!h) return { ok: false, message: tr('Enter your bb Connect handle') };
      if (typeof shell.signIn !== 'function') return { ok: false, message: tr('Not available yet.') };
      return bbAction(async () => {
        await shell.signIn(h);
        return tr('Approve Dictate & Delegate in your browser, then come back.');
      });
    },
    async bbSaveCustom(url, token, linkBase) {
      const address = String(url || '').trim();
      const base = String(linkBase || '').trim();
      if (!/^https?:\/\/\S+$/i.test(address)) return { ok: false, message: tr('Enter the MCP address, starting with https:// or http://') };
      if (!plainHttpAllowed(address)) return { ok: false, message: tr('Plain HTTP is allowed only to 127.0.0.1. Use https://.') };
      if (base && !/^https?:\/\/\S+$/i.test(base)) return { ok: false, message: tr('The web address starts with https://') };
      return bbAction(async () => {
        // An unchanged (hidden) token field keeps the saved token.
        const keep = token === null || token === undefined;
        bb.useCustom(address, keep ? bb.customToken() : String(token), base);
        await bb.test();
        // Connected, or new links: the skills get checked and, if needed, updated.
        skills.sync(true);
        return tr('✓  bb answers.');
      });
    },
    bbTest() {
      return bbAction(async () => {
        await bb.test();
        return tr('✓  bb answers.');
      });
    },
    bbSignOut() {
      return bbAction(async () => {
        await bb.disconnect();
        ctx.emit('settings', 'bbAuth');
        return tr('Signed out of bb.');
      });
    },
    async bbForgetAddress() {
      await bb.disconnect();
      ctx.emit('settings', 'bbUrl');
      return true;
    },
    createChief() {
      return bbAction(async () => {
        const t = await bb.createChief();
        return tr('✓  Created %1$s (%2$s).', t.title, t.id);
      });
    },
    useChief(input) {
      return bbAction(async () => {
        const t = await bb.useExistingChief(String(input || ''));
        return tr('✓  Using %1$s (%2$s). It was told to use the skills.', t.title || t.id, t.id);
      });
    },
    forgetChief() {
      bb.forgetChief();
      return true;
    },
    openChief() {
      const link = bb.chiefId() ? bb.threadLink(bb.chiefId()) : '';
      if (!link) throw new Error(tr('Set the bb web address for links in Settings → bb.'));
      call('openExternal', link);
      return true;
    },
    setUserName(name) {
      prefs.set(skillsLib.USER_NAME, String(name || '').trim().substring(0, 40));
      skillsSoon();
      return true;
    },
    /** The talker thread (Settings → Hands-free): saved as its id; returns what's wrong with it, "" if nothing. */
    setTalker(input) {
      const t = String(input || '');
      const id = bridgeLib.threadId(t);
      prefs.set(bridgeLib.TALKER_ID, id);
      // Told once to use its skill, when the typing paused: not each half-typed id.
      skillsSoon();
      if (t.trim() && !id) return tr("That isn't a bb thread link or id (it starts with thr_).");
      if (id && id === bb.chiefId()) return tr("That's your chief of staff. The talker must be another thread.");
      return '';
    },
    setTalkerOn(on) {
      prefs.set(bridgeLib.TALKER_ON, bool(on));
      skillsSoon();
      return true;
    },

    /** ntfy: the topic (made once, or the phone's from bb), the server and the links. */
    async ntfy() {
      let t = '';
      try {
        t = await topic();
      } catch {
        t = '';
      }
      const server = bb.ntfyServer();
      return { topic: t, server, web: t ? server + '/' + t : '', app: t ? bridgeLib.ntfyLink(server, t) : '', isDefault: server === bridgeLib.NTFY_DEFAULT };
    },
    async ntfyTest() {
      return bbAction(async () => {
        await topic();
        await bb.ntfyTest();
        return tr('✓  Sent. It should show up as a notification.');
      });
    },
    async setNtfyServer(value) {
      const v = String(value || '').trim();
      if (v && !/^https?:\/\/\S+$/i.test(v)) return { ok: false, message: tr('The server address starts with https://') };
      if (v && !plainHttpAllowed(v)) return { ok: false, message: tr('Plain HTTP is allowed only to 127.0.0.1. Use https://.') };
      return bbAction(async () => {
        bb.setNtfyServer(v);
        // The dictate-and-delegate skill holds the server: it's updated in bb.
        skills.sync(false);
        return tr('✓  Saved.');
      });
    },
    async openNtfy() {
      const n = await methods.ntfy();
      if (n.web) call('openExternal', n.web);
      return true;
    },

    skills() {
      return { state: skills.state, line: skillsLine(), talkerProblem: skills.talkerProblem() };
    },
    /** "Check the skills in bb" (force), or the quiet check a page does when it opens: the state follows as 'skills' events. */
    checkSkills(force = true) {
      skills.sync(force !== false);
      return true;
    },
    /** "Take the topic and name from bb": what the phone filled the skills with. */
    async adoptSkills() {
      return bbAction(async () => {
        const r = await skills.adoptFromBb({ force: true });
        if (!r.found) throw new Error(tr("bb has no Dictate & Delegate skills yet. Create your chief of staff first."));
        const names = { topic: tr('the ntfy topic'), server: tr('the ntfy server'), name: tr('your name'), linkBase: tr('the bb links') };
        const took = r.adopted.map((a) => names[a] || a);
        skills.sync(false);
        ctx.emit('settings', 'ntfyTopic');
        return took.length ? tr('✓  Took %1$s from bb.', took.join(', ')) : tr('✓  This Mac already matches the skills in bb.');
      });
    },

    // ---------------------------------------------------------------- hands-free

    async call() {
      return (await call('callSnapshot')) || null;
    },
    startCall() {
      if (!bb.ready()) throw new Error(tr('Set up your chief of staff in Settings → bb first.'));
      if (typeof shell.startCall !== 'function') throw new Error(tr('Hands-free is not available in this build.'));
      return call('startCall') ?? true;
    },
    endCall() {
      return call('endCall') ?? true;
    },
    sendNow() {
      return call('sendNow') ?? true;
    },
    /** The recent events: the last 80 lines, and whether there are any. */
    handsFreeLog() {
      const log = HandsFreeLog.read(ctx.files.handsFreeLog).trim();
      if (!log) return { empty: true, lines: '' };
      const lines = log.split('\n');
      return { empty: false, lines: lines.slice(Math.max(0, lines.length - 80)).join('\n') };
    },
    async copyHandsFreeLog(calls = 1) {
      const n = calls === 3 ? 3 : 1;
      // With the network log's entries since those calls started, to see what didn't arrive.
      const events = HandsFreeLog.lastCalls(HandsFreeLog.read(ctx.files.handsFreeLog), n).trim();
      const network = netLog.lastCalls(netLog.read(), n).trim();
      await call('copy', events + (network ? '\n\nNetwork:\n' + network : ''));
      return tr('Copied. Paste it where you report the problem.');
    },
    /** Copy network log: every request of the last days, with a header that says how to read the times. */
    async copyNetworkLog() {
      const os = require('os');
      await call('copy', netLog.report('Dictate & Delegate ' + ctx.version + ' for macOS (Darwin ' + os.release() + ')', netLog.read()).trim());
      return tr('Copied. Paste it where you report the problem.');
    },
    async copyAppLog() {
      let log = '';
      try {
        log = fs.readFileSync(ctx.files.log, 'utf8');
      } catch {
        log = '';
      }
      await call('copy', log.trim());
      return tr('Copied. Paste it where you report the problem.');
    },

    // ---------------------------------------------------------------- start (Mac)

    startDictation() {
      if (!openrouter.hasKey(vault)) throw new Error(tr('Add your OpenRouter key to start dictating'));
      return call('startDictation') ?? true;
    },
    toggleDictation() {
      if (!openrouter.hasKey(vault)) throw new Error(tr('Add your OpenRouter key to start dictating'));
      return call('toggleDictation') ?? true;
    },
    retryRecording() {
      return call('retryRecording') ?? false;
    },
    discardRecording() {
      return call('discardRecording') ?? false;
    },
    dictationState() {
      return call('dictationState') || null;
    },
    async setHotkey(accelerator) {
      if (typeof shell.setHotkey !== 'function') throw new Error(tr('Not available yet.'));
      const a = String(accelerator || '');
      if (a && sameAccelerator(a, await call('callHotkey'))) return { ok: false, error: tr('Already used for the hands-free shortcut.') };
      return (await shell.setHotkey(a)) || { ok: true };
    },
    async setCallHotkey(accelerator) {
      if (typeof shell.setCallHotkey !== 'function') throw new Error(tr('Not available yet.'));
      const a = String(accelerator || '');
      if (a && sameAccelerator(a, await call('hotkey'))) return { ok: false, error: tr('Already used for the dictation shortcut.') };
      return (await shell.setCallHotkey(a)) || { ok: true };
    },
    /** The shortcut recorder listens: the app's own shortcuts are off meanwhile, so they can be typed. */
    async suspendHotkeys(on) {
      await call('suspendHotkeys', on === true);
      return true;
    },
    /** 📎 Add: paste what you copied, or attach a file, for the next dictation. */
    async attach() {
      if (typeof shell.attach !== 'function') throw new Error(tr('Not available yet.'));
      await shell.attach();
      return true;
    },
    permissions,
    async requestMicrophone() {
      await call('requestMicrophone');
      return permissions();
    },
    async requestAccessibility() {
      await call('requestAccessibility');
      return permissions();
    },
    openPrivacySettings(kind) {
      call('openPrivacySettings', ['microphone', 'accessibility', 'notifications'].includes(kind) ? kind : 'microphone');
      return true;
    },
    async micDevices() {
      const list = (await call('micDevices')) || [];
      return Array.isArray(list) ? list.filter((d) => d && d.id !== undefined).map((d) => ({ id: String(d.id), label: str(d.label) })) : [];
    },
    async testInsert(value) {
      return (await call('testInsert', String(value || ''))) || null;
    },
    openExternal(url) {
      if (!/^(https?:|x-apple\.systempreferences:)/.test(String(url))) throw new Error('not a web address');
      call('openExternal', String(url));
      return true;
    },
    async copy(value) {
      await call('copy', String(value == null ? '' : value));
      return tr('Copied');
    },

    // ---------------------------------------------------------------- data

    deleteSavedAudio() {
      if (dictationBusy()) throw new Error(tr('Finish recording or upload first'));
      try {
        archive.deleteAll();
      } catch {
        throw new Error(tr('Could not delete all audio'));
      }
      notesChanged('');
      return tr('Saved audio deleted');
    },

    /** Everything Dictate & Delegate keeps lives on this Mac; this removes all of it. */
    async deleteLocalData() {
      if (dictationBusy()) throw new Error(tr('Finish recording or upload first'));
      const tryTo = (fn) => {
        try {
          fn();
        } catch {
          /* Continue with what can be removed. */
        }
      };
      // A call still on would write notes and its log again.
      try {
        const snap = await call('callSnapshot');
        if (snap && snap.active) await call('endCall');
      } catch {
        /* Ending the call is best effort. */
      }
      tryTo(() => archive.deleteAll());
      tryTo(() => fs.rmSync(ctx.files.recording, { force: true }));
      tryTo(() => {
        for (const name of fs.readdirSync(ctx.files.notes)) fs.rmSync(path.join(ctx.files.notes, name), { force: true, recursive: true });
      });
      for (const k of [openrouter.KEY, anthropic.KEY, streaming.ASSEMBLYAI_KEY, streaming.ELEVENLABS_KEY, 'templates', 'transcript', 'progress'])
        tryTo(() => vault.remove(k));
      tryTo(() => attachments.deleteAll());
      tryTo(() => fs.rmSync(ctx.files.handsFreeLog, { force: true }));
      tryTo(() => fs.rmSync(ctx.files.netLog, { force: true }));
      tryTo(() => bb.forgetAll());
      tryTo(() => {
        for (const k of Object.keys(prefs.all())) prefs.remove(k);
      });
      await flush().catch(() => {});
      ctx.emit('notes', '');
      return tr('Local data deleted');
    },

    /** Exports settings and keys to a file the user picks; the window asked first that it may contain keys. */
    async exportSettings({ confirmed = false } = {}) {
      if (confirmed !== true) throw new Error(tr('Confirm that the file may contain your keys first.'));
      if (typeof shell.saveFile !== 'function') throw new Error(tr('Not available yet.'));
      const file = await shell.saveFile({
        title: tr('Export settings'),
        defaultPath: 'Dictate & Delegate settings.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!file) return null;
      const data = buildExport(prefs.all(), vault, ctx.version);
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      fs.chmodSync(file, 0o600); // mode only applies to a new file, not one written over.
      ctx.log(`api: settings exported (${Object.keys(data.prefs).length} settings, ${Object.keys(data.keys).length} keys)`);
      return tr('Exported to %1$s', path.basename(file));
    },
    async importSettings() {
      if (typeof shell.chooseFile !== 'function') throw new Error(tr('Not available yet.'));
      const file = await shell.chooseFile({ title: tr('Import settings'), filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (!file) return null;
      let raw;
      try {
        if (fs.statSync(file).size > MAX_IMPORT_BYTES) throw new Error('too big');
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        throw new Error(tr("This file isn't a Dictate & Delegate settings file."));
      }
      const { prefs: values, keys, skipped } = parseImport(raw);
      for (const [k, v] of Object.entries(values)) prefs.set(k, v);
      for (const [k, v] of Object.entries(keys)) vault.set(k, v);
      await flush();
      ctx.emit('settings', 'import');
      if (bb.connected()) skills.sync(false);
      ctx.log(`api: settings imported (${Object.keys(values).length} settings, ${Object.keys(keys).length} keys)`);
      const n = Object.keys(values).length,
        m = Object.keys(keys).length;
      return (
        tr('Imported %1$d settings and %2$d keys.', n, m) +
        (skipped.length ? ' ' + tr('Skipped, as they had unexpected values: %1$s.', skipped.join(', ')) : '')
      );
    },
  };
  return methods;
}

/** The same key combination, whatever the order of its modifiers ("Shift+Alt+A" = "Alt+Shift+A"). */
function sameAccelerator(a, b) {
  const norm = (x) => {
    const alias = { Option: 'Alt', Cmd: 'Command', CommandOrControl: 'Command', CmdOrCtrl: 'Command', Ctrl: 'Control', Return: 'Enter' };
    return String(x || '')
      .split('+')
      .map((k) => alias[k] || k)
      .map((k) => k.toLowerCase())
      .sort()
      .join('+');
  };
  return !!a && !!b && norm(a) === norm(b);
}

/** The old check's answer in words ("Text · Apartment application"); null for an error. */
function checkDetail(detail) {
  const cut = detail.indexOf(' · ');
  const rest = cut < 0 ? '' : detail.substring(cut);
  switch (cut < 0 ? detail : detail.substring(0, cut)) {
    case 'transcript':
      return tr('Transcript only') + rest;
    case 'text':
    case 'simple':
    case 'smart':
      return tr('Refine') + rest;
    case 'chief':
      return tr('Chief of staff');
    default:
      return null;
  }
}

/** Wires the API to IPC and pushes changes to the main window. Returns the method table. */
function registerApi(ctx, shell = {}) {
  const { ipcMain, BrowserWindow } = require('electron');
  const { pathToFileURL } = require('url');
  const APP_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'app.html')).href;
  /** Exactly this window's page, whatever its query (?page=…) or hash. */
  const bare = (url) => {
    const u = String(url || '').replace(/[?#].*$/, '');
    try {
      return decodeURI(u);
    } catch {
      return u;
    }
  };
  const isAppUrl = (url) => bare(url) === bare(APP_URL);
  const isAppWindow = (wc) => {
    try {
      return isAppUrl(wc.getURL());
    } catch {
      return false;
    }
  };
  const push = (name, payload) => {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed() && isAppWindow(w.webContents)) w.webContents.send('event', name, payload);
  };
  const methods = createMethods(ctx, shell, push);

  ipcMain.handle('api', async (event, method, ...args) => {
    // Only the main window may call: the panel and the audio window have their own channels.
    const url = (event.senderFrame && event.senderFrame.url) || '';
    if (!isAppUrl(url)) return { ok: false, error: 'not allowed' };
    if (typeof method !== 'string' || !has(methods, method)) return { ok: false, error: 'Unknown method: ' + method };
    try {
      return { ok: true, value: await methods[method](...args) };
    } catch (ex) {
      if (!(ex && ex.message)) ctx.log(`api: ${method} failed (${ex})`);
      return { ok: false, error: (ex && ex.message) || friendly(ex) };
    }
  });

  // Changes, pushed: a burst of settings (an import, a cleared app) becomes one event.
  let settingsTimer = null;
  const changed = new Set();
  ctx.on('settings', (key) => {
    changed.add(String(key));
    if (settingsTimer) return;
    settingsTimer = setTimeout(() => {
      settingsTimer = null;
      const keys = [...changed].filter((k) => !RUNTIME_PREFS.has(k) || k === 'historyRevision');
      changed.clear();
      if (keys.length) push('settings', keys);
    }, 80);
  });
  ctx.on('notes', (id) => push('notes', id || ''));
  ctx.on('skills', () => push('skills', methods.skills()));
  if (typeof shell.onCallChange === 'function') {
    // The call changes many times a second while it listens; the window needs a few frames of it.
    let last = 0,
      timer = null,
      latest = null;
    shell.onCallChange((snap) => {
      latest = snap;
      const wait = 100 - (Date.now() - last);
      if (wait <= 0) {
        last = Date.now();
        push('call', latest);
      } else if (!timer)
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          push('call', latest);
        }, wait);
    });
  }
  return methods;
}

module.exports = {
  registerApi,
  createMethods,
  usageForMonth,
  homeStats,
  buildExport,
  parseImport,
  plainHttpAllowed,
  sameAccelerator,
  validators,
  money,
  amount,
  cost,
  exact,
  duration,
  monthStart,
  dayStart,
  routeLabel,
  badge,
  chiefNote,
  sentToChief,
  checkDetail,
  APP_ID,
  EXPORT_KEYS,
  RUNTIME_PREFS,
};
