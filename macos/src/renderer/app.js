'use strict';
// The main window: setup, Home, Notes, Hands-free and Settings, the pages of the Android app's
// MainActivity adapted to the Mac (a shortcut instead of the volume key, ⌘V instead of a long
// press, System Settings instead of Android's). Everything goes through dd.invoke('api', …)
// (src/main/api.js); changes arrive as dd.on('event', name, payload).
// `dd` is the global the preload exposes; it must not be redeclared here.

// ------------------------------------------------------------------ plumbing

const contentEl = document.getElementById('content');
const toastEl = document.getElementById('toast');
const modalEl = document.getElementById('modal');

/** The app's state from main (api.state()), refreshed on each render. */
let S = null;

const ui = {
  page: '',
  params: {},
  stack: [],
  renderToken: 0,
  openCalls: new Set(),
  notesQuery: '',
  usageMonth: 0,
  modelsSort: 'recommended',
  modelsQuery: '',
  refineOpenRouterTab: false,
  refineQuery: '',
  refineData: null,
  bbModeShown: '',
  changingChief: false,
  showOriginal: false,
  bbNotice: null,
  beforeLeave: null,
  timers: [],
  callArea: null,
  callActive: null,
};

async function api(method, ...args) {
  const r = await dd.invoke('api', method, ...args);
  if (!r || r.ok !== true) throw new Error((r && r.error) || 'No answer');
  return r.value;
}

/** Runs an API call for a button: disabled meanwhile; a failure is shown as a toast. */
async function attempt(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message);
    return undefined;
  } finally {
    if (button && button.isConnected) button.disabled = false;
  }
}

/** A click that calls the API: a failure toasts, then `then` runs (the page again, by default). */
const openUrl = (url) => act(() => api('openExternal', url), null);

async function act(fn, then = () => render()) {
  const r = await attempt(null, fn);
  if (then) then(r);
  return r;
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props)
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v; // CSSOM, which the CSP allows (a style attribute it doesn't).
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const k of (Array.isArray(kids) ? kids : [kids]).flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

/** "%1$s" and "%s" in a text, as the Android texts write them. */
function fmt(text, ...args) {
  let i = 0;
  return text.replace(/%(?:(\d+)\$)?([sd])/g, (m, n) => String(args[n ? Number(n) - 1 : i++]));
}

function toast(message) {
  if (!message) return;
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove('show'), Math.min(8000, 2600 + message.length * 30));
}

/** A small dialog: resolves true for the first button, false for Cancel/Keep or Escape. */
function confirmDialog({ title, message = '', ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const done = (v) => {
      modalEl.classList.add('hidden');
      modalEl.replaceChildren();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        done(false);
      }
    };
    const okBtn = h('button', { class: 'btn primary' + (danger ? ' recording' : ''), onclick: () => done(true) }, ok);
    modalEl.replaceChildren(
      h('div', { class: 'dialog' }, h('h2', { text: title }), message ? h('p', { class: 'pre', text: message }) : null, h('div', { class: 'btns' }, h('button', { class: 'btn outline', onclick: () => done(false) }, cancel), okBtn)),
    );
    modalEl.classList.remove('hidden');
    document.addEventListener('keydown', onKey, true);
    okBtn.focus();
  });
}

// ------------------------------------------------------------------ money, time, keys

function money(value, decimals) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Number(value) || 0);
}

function exact(value) {
  const s = (Number(value) || 0).toFixed(6).replace(/0+$/, '');
  const dot = s.indexOf('.');
  return money(value, Math.max(4, Math.min(6, dot < 0 ? 0 : s.length - dot - 1)));
}

const two = (n) => String(n).padStart(2, '0');
const clock = (ms) => {
  const d = new Date(ms);
  return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
};
const timeShort = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dateTime = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const dateTimeShort = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

function dayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayLabel(ms) {
  const days = Math.round((dayStart(Date.now()) - dayStart(ms)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(ms).toLocaleDateString([], { dateStyle: 'medium' });
}

function monthName(monthsAgo) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  const name = d.toLocaleDateString('en-US', { month: 'long' });
  return monthsAgo === 0 ? name : name + ' ' + d.getFullYear();
}

/** "Alt+Shift+Space" → "⌥⇧Space", in the Mac's order (⌃⌥⇧⌘). */
function accelLabel(accel) {
  if (!accel) return 'Off';
  const parts = String(accel).split('+');
  const mods = { Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Command: '⌘', Cmd: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘', Super: '⌘', Meta: '⌘' };
  const order = '⌃⌥⇧⌘';
  const keys = { Return: '↩', Enter: '↩', Up: '↑', Down: '↓', Left: '←', Right: '→', Backspace: '⌫', Delete: '⌦', Tab: '⇥', Escape: '⎋', Plus: '+' };
  const m = [];
  let key = '';
  for (const p of parts) {
    if (mods[p]) m.push(mods[p]);
    else key = keys[p] || p;
  }
  m.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return m.join('') + key;
}

const KEY_CODES = {
  Space: 'Space', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down',
  ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Minus: '-',
  Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Backslash: '\\', Backquote: '`',
};

/** The key combination of a keydown as an Electron accelerator: {accel}, {error}, or null (only modifiers so far). */
function accelFromEvent(e) {
  const code = e.code || '';
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else key = KEY_CODES[code] || null;
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Command');
  if (!mods.length && !/^F\d+$/.test(key)) return { error: 'Use the key with at least one of ⌘ ⌥ ⌃ ⇧.' };
  return { accel: [...mods, key].join('+') };
}

// ------------------------------------------------------------------ building blocks

const p = (text, cls = 'body') => h('p', { class: 'text ' + cls }, text);
const label = (text) => h('div', { class: 'label' }, text);
const strong = (text, cls = '') => h('div', { class: 'strong ' + cls }, text);
const card = (cls, ...kids) => h('div', { class: 'card ' + (cls || '') }, ...kids);

function btn(text, kind, onclick, extra = {}) {
  return h('button', { class: 'btn ' + kind + (extra.block ? ' block' : '') + (extra.tall ? ' tall' : '') + (extra.danger ? ' danger' : ''), onclick, ...extra.attrs }, text);
}

function back() {
  if (!ui.stack.length) return null;
  const prev = ui.stack[ui.stack.length - 1].page;
  const names = { home: 'Home', settings: 'Settings', notes: 'Notes', handsfree: 'Hands-free', hfsettings: 'Hands-free', templates: 'Templates', activity: 'Activity', bb: 'bb', start: 'Start and insert' };
  return h('button', { class: 'back', onclick: goBack }, '‹ ' + (names[prev] || 'Back'));
}

function heading(root, title, subtitle) {
  add(root, [back(), h('h1', { class: 'title' }, title), subtitle ? h('p', { class: 'subtitle' }, subtitle) : null]);
}

function row({ title, sub, onclick, control, warn, id }) {
  const text = h('div', { class: 'row-text' }, h('div', { class: 'row-title' + (warn ? ' warn' : '') }, title), sub ? h('div', { class: 'row-sub' }, sub) : null);
  if (onclick && !control) return h('button', { class: 'row', onclick, id }, text, h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'));
  return h('div', { class: 'row', id }, text, control || null);
}

function switchEl(checked, onchange, name) {
  const input = h('input', { type: 'checkbox', checked, 'aria-label': name || 'Switch' });
  input.addEventListener('change', () => onchange(input.checked, input));
  return h('label', { class: 'switch' }, input, h('span', { class: 'knob' }));
}

/** A row with a switch that saves a setting. */
function prefRow(title, sub, key, value) {
  return row({
    title,
    sub,
    control: switchEl(value, (on, input) =>
      api('setPref', key, on).catch((e) => {
        input.checked = !on;
        toast(e.message);
      }), title),
  });
}

function chips(options, selected, onpick) {
  return h('div', { class: 'chips' }, options.map(([value, text]) => h('button', { class: 'chip' + (value === selected ? ' on' : ''), onclick: () => onpick(value) }, text)));
}

function input({ value = '', placeholder = '', type = 'text', id, maxlength, cls } = {}) {
  return h('input', { type, value, placeholder, id, maxlength, class: cls, spellcheck: 'false', autocomplete: 'off' });
}

/** Text settings save as you type; "✓ Saved" under the field says so after each change. */
function autosave(field, save, delay = 400) {
  const saved = h('div', { class: 'saved' }, '✓ Saved');
  let timer = null;
  const flush = async () => {
    clearTimeout(timer);
    timer = null;
    try {
      const r = await save(field.value);
      saved.textContent = typeof r === 'string' && r ? r : '✓ Saved';
      saved.className = 'saved show' + (typeof r === 'string' && r ? ' warn' : '');
    } catch (e) {
      saved.textContent = e.message;
      saved.className = 'saved show warn';
    }
  };
  field.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  });
  field.addEventListener('blur', () => timer && flush());
  return [field, saved];
}

/**
 * A line under an action: what happened, in green or as a warning. slot names the action, so an
 * outcome shows under the button that ran it after the page is drawn again.
 */
function resultLine(slot) {
  const el = h('div', { class: 'text gap-8 hidden', 'data-slot': slot });
  if (ui.bbNotice && ui.bbNotice.slot === slot) {
    el.textContent = ui.bbNotice.message;
    el.className = 'text gap-8 ' + (ui.bbNotice.ok ? 'ok' : 'warn');
    ui.bbNotice = null;
  }
  return el;
}

function showResult(el, r) {
  el.textContent = r.message;
  el.className = 'text gap-8 ' + (r.ok === false ? 'warn' : r.ok ? 'ok' : 'muted');
}

/** Runs a bb action that returns {ok, message}: "working…" meanwhile, then the page again with the outcome. */
async function bbAction(button, resultEl, working, fn) {
  const page = ui.page;
  if (button) button.disabled = true;
  showResult(resultEl, { message: working });
  let r;
  try {
    r = await fn();
  } catch (e) {
    r = { ok: false, message: e.message };
  }
  if (page !== ui.page) return toast(r.message);
  ui.bbNotice = { ...r, slot: resultEl.dataset.slot };
  render();
}

function example(root) {
  add(root, [
    card('panel gap-16', label('You say'), p('“Dear Mr. Weber, uh, the tap in the kitchen, no actually the one in the bathroom, has been dripping since Monday. Oh and make that a bit more formal please.”', 'body gap-4')),
    card('tint gap-8', label('Dictate & Delegate writes'), p('Dear Mr. Weber,\n\nI would like to let you know that the bathroom tap has been dripping since Monday.', 'pre gap-4')),
  ]);
}

// ------------------------------------------------------------------ navigation

const SETUP = ['key1', 'allow1', 'how1', 'start1', 'insert1', 'try1', 'bb1', 'chief1', 'ntfy1'];
const SECTION = { home: 'home', usage: 'home', notes: 'notes', note: 'notes', handsfree: 'handsfree' };

function leave() {
  ui.noteShown = null;
  for (const t of ui.timers) clearInterval(t);
  ui.timers = [];
  ui.callArea = null;
  if (ui.beforeLeave) {
    const f = ui.beforeLeave;
    ui.beforeLeave = null;
    f();
  }
}

function go(page, params = {}) {
  leave();
  ui.stack = [];
  ui.page = page;
  ui.params = params;
  render(true);
}

function open(page, params = {}) {
  leave();
  ui.stack.push({ page: ui.page, params: ui.params });
  ui.page = page;
  ui.params = params;
  render(true);
}

function goBack() {
  leave();
  const prev = ui.stack.pop() || { page: S && S.onboarded ? 'home' : 'welcome', params: {} };
  ui.page = prev.page;
  ui.params = prev.params || {};
  render(true);
}

function nextSetupPage() {
  const i = SETUP.indexOf(ui.page);
  if (i >= 0 && i + 1 < SETUP.length) open(SETUP[i + 1]);
  else finishSetup();
}

async function finishSetup() {
  await api('setPref', 'onboarded', true).catch(() => {});
  go('home');
}

/** Progress dots for the setup page shown now, and an optional Skip. */
function steps(root, skippable) {
  const current = Math.max(0, SETUP.indexOf(ui.page));
  add(root, h('div', { class: 'steps' }, SETUP.map((_, i) => h('div', { class: 'dot' + (i < current ? ' done' : i === current ? ' now' : '') })), skippable ? btn('Skip', 'quiet skip', nextSetupPage) : null));
}

function continueButton(root, text = 'Continue') {
  add(root, [h('div', { class: 'grow' }), btn(text, 'primary', nextSetupPage, { block: true, tall: true })]);
}

function laterButton(root) {
  add(root, btn('Later', 'quiet', finishSetup, { block: true, attrs: { style: 'margin-top:6px' } }));
}

async function render(fresh = false) {
  const token = ++ui.renderToken;
  // A shortcut recorder still listening stops (its shortcuts come back).
  if (ui.recorderCancel) ui.recorderCancel();
  // The page's pollers belong to this drawing of it: the old ones stop, a stale drawing's too.
  for (const t of ui.timers) clearInterval(t);
  const timers = [];
  ui.timers = timers;
  const page = ui.page;
  const fn = PAGES[page] || PAGES.home;
  let state;
  try {
    state = await api('state');
  } catch (e) {
    state = S;
    toast(e.message);
  }
  if (token !== ui.renderToken) return;
  S = state;
  const root = h('div', { class: 'page', 'data-page': page });
  try {
    await fn(root);
  } catch (e) {
    console.warn('page ' + page + ': ' + e.message);
    add(root, p('Could not show this page: ' + e.message, 'warn gap-16'));
  }
  if (token !== ui.renderToken) {
    for (const t of timers) clearInterval(t);
    return;
  }
  const scroll = contentEl.scrollTop;
  contentEl.replaceChildren(root);
  contentEl.scrollTop = fresh ? 0 : scroll;
  document.body.classList.toggle('setup', page === 'welcome' || SETUP.includes(page));
  document.body.classList.toggle('soft', page === 'settings');
  const section = SECTION[page] || 'settings';
  // A file dropped on the window must not replace the app with it.
for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault());

for (const b of document.querySelectorAll('#sidebar .nav')) b.classList.toggle('on', b.dataset.section === section);
  const foot = document.getElementById('sidebar-foot');
  foot.replaceChildren(
    S && S.hotkey ? h('div', null, 'Dictate: ', h('kbd', null, accelLabel(S.hotkey))) : null,
    S && S.callHotkey && S.bb && S.bb.ready ? h('div', { class: 'gap-4' }, 'Hands-free: ', h('kbd', null, accelLabel(S.callHotkey))) : null,
  );
}

/** Re-renders when nothing is being typed on the page (typing would lose its place). */
function refreshSoon() {
  const a = document.activeElement;
  if (a && contentEl.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) return;
  if (!modalEl.classList.contains('hidden')) return;
  clearTimeout(refreshSoon.timer);
  refreshSoon.timer = setTimeout(() => render(), 60);
}

// ------------------------------------------------------------------ setup

function pageWelcome(root) {
  const keys = accelLabel(S.hotkey).split('').filter((c) => '⌃⌥⇧⌘'.includes(c));
  const key = accelLabel(S.hotkey).replace(/[⌃⌥⇧⌘]/g, '');
  add(root, [
    h(
      'div',
      { class: 'art', 'aria-hidden': 'true' },
      h('div', { class: 'page1' }, h('div', { class: 'label', style: 'margin:0' }, 'Article'), h('div', { class: 'ph' }), h('div', { class: 'ln' }), h('div', { class: 'ln', style: 'width:70%' }), h('div', { class: 'ln', style: 'width:85%' })),
      h('div', { class: 'keys' }, keys.map((k) => h('kbd', null, k)), key ? h('kbd', null, key) : null),
      h('div', { class: 'pill' }, '●   2:14    ■'),
    ),
    h('h1', { class: 'title big gap-24' }, 'Talk anywhere.'),
    p('Start Dictate & Delegate, then keep using any app: read, look things up, switch. When you stop, your words are written down, ready to insert where you type. Then decide: ✨ Refine makes them the text you need, and your chief of staff takes on tasks.', 'muted gap-12'),
    h('div', { class: 'grow' }),
    btn('Get started', 'primary', () => open(SETUP[0]), { block: true, tall: true }),
    p('Open source. Your own OpenRouter key, no Dictate & Delegate server in between.', 'muted small center gap-12'),
  ]);
}

/** The OpenRouter key: the first setup page, and Settings → Models & providers → OpenRouter key. */
function pageKey(root, onboarding) {
  const saved = S.keys.openrouter;
  if (onboarding) {
    steps(root, false);
    heading(root, 'Your OpenRouter key', 'Dictate & Delegate calls the speech and text models through OpenRouter, with your own key. You pay OpenRouter for what you use; Dictate & Delegate has no server and takes no cut.');
  } else heading(root, 'OpenRouter key', 'Dictate & Delegate calls the speech and text models through OpenRouter with this key.');
  if (saved) add(root, p('✓  A key is saved on this Mac, encrypted in the Keychain.', 'ok gap-16'));
  const field = input({ type: 'password', placeholder: saved ? 'Paste a new key to replace it' : 'sk-or-v1-…', id: 'key-input' });
  const result = h('div', { class: 'text gap-8 hidden' });
  const check = btn('Check and save', saved ? 'outline' : 'primary', async () => {
    const key = field.value.trim();
    if (!key) return toast('Paste your key first');
    check.disabled = true;
    showResult(result, { message: 'Checking…' });
    try {
      toast(await api('checkOpenRouterKey', key));
      if (onboarding) nextSetupPage();
      else render();
    } catch (e) {
      check.disabled = false;
      showResult(result, { ok: false, message: e.message });
    }
  });
  field.addEventListener('keydown', (e) => e.key === 'Enter' && check.click());
  add(root, [
    h('div', { class: 'gap-16' }, field),
    result,
    h('div', { class: 'btns gap-12' }, check, btn('Get a key on openrouter.ai', 'quiet', () => openUrl('https://openrouter.ai/keys'))),
    p('Create a key there and copy it, then paste it above. Add a few dollars of credits on OpenRouter too: a one-minute note usually costs well under one cent.', 'muted small gap-8'),
  ]);
  if (onboarding) {
    if (saved) continueButton(root);
    return;
  }
  const actions = h('div', { class: 'btns gap-16' });
  if (saved)
    actions.append(
      btn('Remove key', 'quiet', async () => {
        if (await confirmDialog({ title: 'Remove your OpenRouter key?', message: "Dictate & Delegate can't dictate until you add a key again.", ok: 'Remove', cancel: 'Keep', danger: true })) {
          act(() => api('removeOpenRouterKey'));
        }
      }, { danger: true }),
    );
  actions.append(btn('Credits and usage on openrouter.ai', 'quiet', () => openUrl('https://openrouter.ai/settings/credits')));
  add(root, actions);
}

/** Settings → Models & providers → Anthropic key (optional). */
function pageAnthropic(root) {
  const saved = S.keys.anthropic;
  heading(root, 'Anthropic key', 'Optional. With your own Anthropic key, ✨ Refine goes to Claude directly and is paid from your Anthropic credits. Speech and Jev stay on OpenRouter. If Anthropic fails, Refine goes through OpenRouter instead.');
  if (saved) add(root, p('✓  A key is saved on this Mac, encrypted in the Keychain.', 'ok gap-16'));
  const field = input({ type: 'password', placeholder: saved ? 'Paste a new key to replace it' : 'sk-ant-…' });
  const result = h('div', { class: 'text gap-8 hidden' });
  const check = btn('Check and save', saved ? 'outline' : 'primary', async () => {
    const key = field.value.trim();
    if (!key) return toast('Paste your key first');
    check.disabled = true;
    showResult(result, { message: 'Checking…' });
    try {
      toast(await api('checkAnthropicKey', key));
      render();
    } catch (e) {
      check.disabled = false;
      showResult(result, { ok: false, message: e.message });
    }
  });
  const actions = h('div', { class: 'btns gap-12' }, check, btn('Get a key on console.anthropic.com', 'quiet', () => openUrl('https://console.anthropic.com/settings/keys')));
  add(root, [h('div', { class: 'gap-16' }, field), result, actions]);
  if (saved)
    add(
      root,
      h(
        'div',
        { class: 'btns gap-16' },
        btn('Remove key', 'quiet', async () => {
          if (await confirmDialog({ title: 'Remove your Anthropic key?', message: 'Refine goes through OpenRouter again.', ok: 'Remove', cancel: 'Keep', danger: true })) {
            act(() => api('removeAnthropicKey'));
          }
        }, { danger: true }),
      ),
    );
}

function microphoneCard() {
  const mic = S.permissions.microphone;
  const c = card('gap-12', strong('Microphone'), p('Only while you record.', 'muted gap-4'));
  if (mic === 'granted') c.append(p('✓  Allowed', 'ok gap-8'));
  else if (mic === 'denied' || mic === 'restricted') {
    add(c, [
      p('macOS has the microphone turned off for Dictate & Delegate.', 'warn gap-8'),
      h('div', { class: 'btns gap-8' }, btn('Open System Settings', 'primary', () => act(() => api('openPrivacySettings', 'microphone'), null)), btn('Check again', 'quiet', () => render())),
      p('System Settings → Privacy & Security → Microphone: turn on Dictate & Delegate.', 'muted small gap-8'),
    ]);
  } else
    c.append(
      h('div', { class: 'btns gap-12' }, btn('Allow microphone', 'primary', async (e) => {
        await attempt(e.currentTarget, () => api('requestMicrophone'));
        render();
      })),
    );
  return c;
}

/** What leaves the Mac, and where it goes. */
function dataCard() {
  return card(
    'tint gap-12',
    strong('What leaves your Mac'),
    p("• Your notes, audio, words and templates stay on this Mac.\n• To write down what you said, your recording goes straight to OpenRouter with your key, and on to the speech model's provider. The text goes the same way to Jev, a fast model that decides whether to refine it, with your template names. When it's refined, it goes to the text model, with what you told Dictate & Delegate about you, your words, the template you named and what you attached.\n• If you connect bb, a task you hand to your chief of staff goes to your bb, with the text you pasted.\n• Dictate & Delegate has no server and collects nothing. OpenRouter and the model providers handle the data under their own policies.", 'body pre gap-8'),
  );
}

function pageAllow(root) {
  steps(root, false);
  heading(root, 'Microphone and privacy');
  add(root, [microphoneCard(), dataCard(), h('div', { class: 'grow' })]);
  const granted = S.permissions.microphone === 'granted';
  add(root, btn('Continue', 'primary', () => (granted ? nextSetupPage() : toast('Allow the microphone first')), { block: true, tall: true, attrs: { style: granted ? '' : 'opacity:.5' } }));
}

function pageHow(root) {
  steps(root, false);
  heading(root, 'Transcript first, then you decide', "When you stop, your words are written down and a small panel floats over the app you're in.");
  const rows = [
    ['Insert', "Puts the text at the cursor, where you're typing."],
    ['✨ Refine', fmt('%1$s makes it the text you need: an email, a reply, a tidy note, your template. Then Insert refined.', S.labels.refineName)],
    ['🧑‍💼 Chief', 'Hands it to your chief of staff in bb, if you set one up. Then Open chat ↗.'],
    ['✕', 'Closes the panel. The note stays in Dictate & Delegate.'],
  ];
  add(root, card('gap-16', rows.map(([t, s], i) => [strong(t, i ? 'gap-12' : ''), p(s, 'muted gap-4')])));
  add(root, p('You can click Refine or Chief while you\'re still talking. Ask in the same breath (“make this an email”, “use my apartment application”) and Refine starts by itself. Tasks go to your chief by themselves only when you address it: “chief of staff, …”.', 'body gap-16'));
  example(root);
  add(root, p("Each note shows what it cost, as OpenRouter reports it. Jev's decision costs about $0.00002, a minute of speech with the default model about $0.002.", 'muted small gap-12'));
  continueButton(root);
}

/** The global shortcut: shown, and a field that records the next key combination. */
function recorder(kind) {
  const current = kind === 'call' ? S.callHotkey : S.hotkey;
  const fallback = kind === 'call' ? 'Control+Alt+Shift+Space' : 'Control+Shift+Space';
  const problem = (S.hotkeyProblems || {})[kind === 'call' ? 'callHotkey' : 'hotkey'];
  const msg = h('div', { class: 'small gap-4 ' + (problem ? 'warn' : 'muted') }, problem || '');
  const cap = h('button', { class: 'keycap', 'aria-label': 'Shortcut, click to change' }, accelLabel(current));
  let listening = false;
  const stop = () => {
    if (listening) api('suspendHotkeys', false).catch(() => {});
    if (ui.recorderCancel === cancel) ui.recorderCancel = null;
    listening = false;
    cap.classList.remove('recording');
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', cancel);
  };
  const cancel = () => {
    stop();
    cap.textContent = accelLabel(current);
  };
  const save = async (accel) => {
    stop();
    cap.textContent = accelLabel(accel);
    try {
      const r = await api(kind === 'call' ? 'setCallHotkey' : 'setHotkey', accel);
      if (r && r.ok === false) {
        msg.className = 'small gap-4 warn';
        msg.textContent = r.error || 'That shortcut is taken.';
        cap.textContent = accelLabel(current);
        return;
      }
      render();
    } catch (e) {
      msg.className = 'small gap-4 warn';
      msg.textContent = e.message;
      cap.textContent = accelLabel(current);
    }
  };
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return cancel();
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) return save('');
    const r = accelFromEvent(e);
    if (!r) return;
    if (r.error) {
      msg.className = 'small gap-4 warn';
      msg.textContent = r.error;
      return;
    }
    save(r.accel);
  };
  cap.addEventListener('click', () => {
    if (listening) return cancel();
    if (ui.recorderCancel) ui.recorderCancel(); // The other recorder stops listening.
    listening = true;
    ui.recorderCancel = cancel;
    // The app's own shortcuts are off while it listens, so the current one can be typed too.
    api('suspendHotkeys', true).catch(() => {});
    cap.classList.add('recording');
    cap.textContent = 'Type the shortcut…';
    msg.className = 'small gap-4 muted';
    msg.textContent = 'Press the keys together. Esc cancels, ⌫ turns it off.';
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', cancel);
  });
  const reset = current !== fallback ? btn('Reset', 'quiet', () => save(fallback)) : null;
  return h('div', null, h('div', { class: 'btns' }, cap, reset), msg);
}

function shortcutCard(title) {
  return card('gap-16', strong(title), p('Press the shortcut in any app to start, press it again to stop. While you record, the panel shows the time; nothing stops on silence.', 'muted gap-4'), h('div', { class: 'gap-12' }, recorder('dictate')));
}

function panelCard(title) {
  return card('gap-12', strong(title), p('While you dictate, a small panel stays on top of other apps: click ■ to stop, then Insert, Refine or Chief. It never takes the focus, so the cursor stays where you type. Drag it anywhere.', 'muted gap-4'));
}

function pageStart1(root) {
  steps(root, true);
  heading(root, 'Start from any app', "You don't need to open Dictate & Delegate. Start and stop wherever you are.");
  add(root, [shortcutCard('1 · Your shortcut'), panelCard('2 · Floating panel')]);
  continueButton(root);
}

/** The Accessibility permission: what it's for, what it doesn't do, and where to turn it on. */
function accessCard() {
  const c = card(
    'tint gap-12',
    strong('Insert · Accessibility permission'),
    p("Dictate & Delegate uses macOS's Accessibility permission for one thing only: to put your text at the cursor when you click Insert, by pressing ⌘V for you (or typing it directly, if you choose that in Settings). It reads nothing on your screen and looks up the text field you're typing in only when you click Insert. Dictate & Delegate is open source, so you can check.", 'body gap-4'),
  );
  if (S.permissions.accessibility) {
    c.append(p('✓  On', 'ok gap-8'));
    return c;
  }
  add(c, [
    h(
      'div',
      { class: 'btns gap-12' },
      btn('Open Accessibility settings', 'primary', async () => {
        await api('requestAccessibility').catch(() => {});
        await api('openPrivacySettings', 'accessibility').catch(() => {});
      }),
      btn('Check again', 'quiet', () => render()),
    ),
    p("System Settings → Privacy & Security → Accessibility: turn on Dictate & Delegate. If it's listed but Insert still copies, remove it with − and add it again. Without it, Insert copies the text and you paste it with ⌘V.", 'muted small gap-8'),
  ]);
  return c;
}

function pageInsert1(root) {
  steps(root, true);
  heading(root, 'Insert where you type', 'With one permission, Insert puts your text right at the cursor. Without it, Dictate & Delegate copies the text and you paste it with ⌘V.');
  add(root, accessCard());
  continueButton(root);
}

/** The record button and its status line, kept current while the page shows (Home, Try it once). */
function recordControls(root, startLabel) {
  const button = btn(startLabel, 'primary', async () => {
    if (!S.keys.openrouter) {
      toast('Add your OpenRouter key to start dictating');
      return open('key');
    }
    if (S.permissions.microphone !== 'granted' && S.permissions.microphone !== 'not-determined') {
      toast('Finish setup to start dictating');
      return open('start');
    }
    await attempt(null, () => api('toggleDictation'));
  }, { block: true, tall: true, attrs: { id: 'record' } });
  const status = h('div', { class: 'record-hint', id: 'record-status' }, S.hotkey ? ['or press ', h('kbd', null, accelLabel(S.hotkey)), ' in any app'] : '');
  const recovery = h('div', { class: 'btns gap-8 hidden', id: 'recovery' }, btn('Retry saved recording', 'outline', () => act(() => api('retryRecording'), null)), btn('Discard saved audio', 'quiet', async () => {
    if (await confirmDialog({ title: 'Discard the saved audio?', message: 'Partial text and reported costs stay in your notes.', ok: 'Discard', cancel: 'Keep', danger: true })) act(() => api('discardRecording'), null);
  }));
  add(root, [button, status, recovery]);
  const hint = status.cloneNode(true);
  let last = '';
  const update = (s) => {
    if (!s || !button.isConnected) return;
    const recording = s.state === 'recording';
    const busy = !!s.busy;
    const pending = !!s.hasSavedRecording;
    const line = busy && !recording ? s.detail || '' : pending ? (s.state === 'error' ? fmt('%1$s The recording is saved.', s.detail || '') : 'A recording was saved but not transcribed.') : s.state === 'empty' ? 'No speech recognized. Ready to try again.' : '';
    const key = [recording, busy, pending, line].join('|');
    if (key === last) return;
    last = key;
    button.textContent = recording ? 'Stop' : busy ? 'Transcribing…' : startLabel;
    button.classList.toggle('recording', recording);
    button.disabled = !recording && (busy || pending);
    recovery.classList.toggle('hidden', !pending);
    if (line) status.textContent = line;
    else status.replaceChildren(...hint.cloneNode(true).childNodes);
  };
  update(S.dictation);
  if (S.dictation) ui.timers.push(setInterval(() => api('dictationState').then(update, () => {}), 750));
}

function pageTry(root) {
  steps(root, false);
  heading(root, 'Try it once');
  add(root, p(fmt('1. Press %1$s (or click Start) and say a sentence.\n2. Press it again to stop. Dictate & Delegate writes it down.\n3. Click into the box below, then 📥 Insert on the floating panel. Your clipboard stays as it was.', accelLabel(S.hotkey)), 'body pre gap-8'));
  const box = h('div', { class: 'gap-16' });
  recordControls(box, 'Start');
  root.append(box);
  const practice = h('textarea', { class: 'editor gap-16', placeholder: 'Insert here', rows: 3 });
  const done = p('That\'s it. It works the same in any app: start, talk, stop, insert. Your notes are saved in Dictate & Delegate, where you can also copy them or switch back to exactly what you said.', 'ok gap-12 hidden');
  const finish = btn('Continue', 'primary hidden', nextSetupPage, { block: true, tall: true });
  const skip = btn('Skip', 'quiet', nextSetupPage, { block: true });
  practice.addEventListener('input', () => {
    const pasted = practice.value.trim() !== '';
    done.classList.toggle('hidden', !pasted);
    finish.classList.toggle('hidden', !pasted);
    skip.classList.toggle('hidden', pasted);
  });
  add(root, [h('div', { class: 'gap-16' }, practice), done, h('div', { class: 'grow' }), finish, skip]);
}

// ------------------------------------------------------------------ bb

function pageBb(root, onboarding) {
  const bb = S.bb;
  if (!ui.bbModeShown) ui.bbModeShown = bb.mode;
  if (onboarding) {
    steps(root, false);
    heading(root, 'Connect bb', 'Optional. bb (getbb.app) runs coding agents on your own computer. Connected, Dictate & Delegate hands a task you speak to your chief-of-staff thread there. Without bb, Dictate & Delegate is a dictation app.');
  } else heading(root, 'bb', "Dictate & Delegate reaches bb through bb's MCP server (plugin bb--mcp), which has to be on in bb.");
  const connected = bb.connected && bb.mode === ui.bbModeShown;
  add(root, h('div', { class: 'gap-12' }, chips([['connect', 'bb Connect'], ['custom', 'Custom address']], ui.bbModeShown, (m) => {
    ui.bbModeShown = m;
    render();
  })));
  if (ui.bbModeShown === 'connect') connectCard(root, connected);
  else customCard(root, connected);
  if (bb.connected) skillsCard(root);
  if (onboarding) {
    add(root, h('div', { class: 'grow' }));
    if (bb.connected) add(root, btn('Continue', 'primary', nextSetupPage, { block: true, tall: true }));
    laterButton(root);
  }
}

function connectCard(root, connected) {
  const bb = S.bb;
  if (connected) {
    add(root, card('gap-16', strong(fmt('✓  Signed in to %1$s.getbb.app', bb.handle))));
    const result = resultLine('connect');
    const test = btn('Test connection', 'outline', () => bbAction(test, result, 'Asking bb…', () => api('bbTest')));
    const out = btn('Sign out', 'quiet', () => bbAction(test, result, 'Signing out…', () => api('bbSignOut')), { danger: true });
    add(root, [result, h('div', { class: 'btns gap-12' }, test, out)]);
    return;
  }
  const handle = input({ value: bb.handle, placeholder: 'handle', id: 'bb-handle' });
  const result = resultLine('connect');
  const signIn = btn('Sign in with bb', 'primary', async () => {
    const value = handle.value.trim();
    if (!value) return toast('Enter your bb Connect handle');
    signIn.disabled = true;
    showResult(result, { message: 'Finding your bb…' });
    const r = await api('bbConnect', value).catch((e) => ({ ok: false, message: e.message }));
    signIn.disabled = false;
    showResult(result, r.ok ? { message: r.message } : r);
  });
  handle.addEventListener('keydown', (e) => e.key === 'Enter' && signIn.click());
  add(root, [
    card('gap-16', strong('Your bb Connect handle'), p("The name in your bb address: <handle>.getbb.app. Your browser opens bb's account page; approve Dictate & Delegate there and you come back signed in.", 'muted gap-4'), h('div', { class: 'field-row gap-12' }, handle, h('span', { class: 'muted' }, '.getbb.app'))),
    result,
    h('div', { class: 'btns gap-12' }, signIn),
  ]);
}

function customCard(root, connected) {
  const bb = S.bb;
  const url = input({ value: bb.mode === 'custom' ? bb.url : '', placeholder: 'https://…/mcp' });
  const token = input({ type: 'password', placeholder: bb.hasToken ? 'Saved · paste a new token to replace it' : 'Sent as a bearer token' });
  let tokenTouched = false;
  token.addEventListener('input', () => (tokenTouched = true));
  const links = input({ value: bb.linkBase, placeholder: 'https://<handle>.getbb.app' });
  add(root, card(
    'gap-16',
    strong('MCP address'),
    p("bb's local address is http://127.0.0.1:38886/api/v1/plugins/bb--mcp/http/mcp. If bb runs on another computer, reach it through your tailnet (Tailscale Serve, HTTPS). Plain HTTP is allowed only to 127.0.0.1.", 'muted small gap-4'),
    h('div', { class: 'gap-8' }, url),
    strong('Token (optional)', 'gap-12'),
    h('div', { class: 'gap-8' }, token),
    strong('bb web address for links', 'gap-12'),
    p('Where thread links open, usually https://<handle>.getbb.app.', 'muted small gap-4'),
    h('div', { class: 'gap-8' }, links),
    connected ? p('✓  Saved', 'ok gap-8') : null,
  ));
  const result = resultLine('custom');
  const save = btn('Save and test', connected ? 'outline' : 'primary', () => {
    const address = url.value.trim();
    const base = links.value.trim();
    if (!/^https?:\/\/\S+$/i.test(address)) return toast('Enter the MCP address, starting with https:// or http://');
    if (!plainHttpAllowed(address)) return toast(PLAIN_HTTP);
    if (base && !/^https?:\/\/\S+$/i.test(base)) return toast('The web address starts with https://');
    bbAction(save, result, 'Asking bb…', () => api('bbSaveCustom', address, tokenTouched || !bb.hasToken ? token.value : null, base));
  });
  const actions = h('div', { class: 'btns gap-12' }, save);
  if (connected)
    actions.append(btn('Forget this address', 'quiet', async () => {
      act(() => api('bbForgetAddress'));
    }, { danger: true }));
  add(root, [result, actions]);
}

/** The chief's instructions live in bb skills: whether bb has the current ones, and the name it calls you. */
function skillsCard(root) {
  const name = input({ value: S.bb.userName, placeholder: 'Optional: what your chief calls you', maxlength: 40, id: 'user-name' });
  const line = h('div', { class: 'text gap-12 ' + toneClass(S.skills.line.tone), id: 'skills-line' }, S.skills.line.text);
  const result = resultLine('skills');
  const adopt = btn('Take the topic and name from bb', 'quiet', () => bbAction(adopt, result, 'Reading the skills in bb…', () => api('adoptSkills')));
  add(root, [
    strong("Your chief's skills", 'gap-24'),
    p("Your chief of staff follows two skills in bb, chief-of-staff and dictate-and-delegate: how to work for you, and how to notify you and send text back. Dictate & Delegate installs and updates them in bb through a short thread.", 'muted small gap-4'),
    strong('Your name', 'gap-16'),
    h('div', { class: 'gap-8' }, autosave(name, (v) => api('setUserName', v))),
    line,
    h('div', { class: 'btns gap-8' }, btn('Check the skills in bb', 'quiet', () => act(() => api('checkSkills', true), null)), adopt, btn('Copy network log', 'quiet', () => act(() => api('copyNetworkLog'), toast))),
    result,
    p('Set bb up on your phone first? “Take the topic and name from bb” uses the ntfy topic, server and name the phone filled the skills with, so both get the same notifications.', 'muted small gap-4'),
  ]);
  api('checkSkills', false).catch(() => {});
}

/** Plain http:// only to this computer (api.js checks the same). */
const PLAIN_HTTP = 'Plain HTTP is allowed only to 127.0.0.1. Use https://.';
function plainHttpAllowed(url) {
  if (!/^http:\/\//i.test(url)) return true;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

const toneClass = (tone) => (tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'muted');

function chiefNameField(root) {
  const field = input({ value: S.profile.chiefName, placeholder: 'For example: Ada', maxlength: 40 });
  add(root, [
    strong("Your chief's name", 'gap-24'),
    p('Say it to send a dictation to your chief: "Ada, …", "this is for Ada". Just mentioning the name in a message doesn\'t send it. Without a name, click 🧑‍💼.', 'muted small gap-4'),
    h('div', { class: 'gap-8' }, autosave(field, (v) => api('setChiefName', v))),
  ]);
}

function pageChief(root, onboarding) {
  const bb = S.bb;
  if (onboarding) steps(root, false);
  heading(root, 'Chief of staff', "One bb thread gets every task you hand over by voice. It does small things itself, starts child threads for bigger work, and notifies you through ntfy when it's done or needs you.");
  if (!bb.connected) {
    add(root, [p('Connect bb first.', 'warn gap-16'), h('div', { class: 'btns gap-12' }, btn('Connect bb', 'outline', () => open(onboarding ? 'bb1' : 'bb')))]);
    if (onboarding) {
      add(root, h('div', { class: 'grow' }));
      laterButton(root);
    }
    return;
  }
  const id = bb.chiefId;
  if (id) {
    add(root, card('tint gap-16', strong(bb.chiefTitle || 'Chief of staff'), h('div', { class: 'mono gap-4' }, id), bb.chiefLink ? h('div', { class: 'btns gap-8' }, btn('Open in bb ↗', 'quiet', () => openUrl(bb.chiefLink))) : null));
    if (!ui.changingChief)
      add(root, h('div', { class: 'btns gap-12' }, btn('Change', 'outline', () => {
        ui.changingChief = true;
        render();
      }), btn('Forget this chief', 'quiet', async () => {
        if (await confirmDialog({ title: 'Forget your chief of staff?', message: 'The thread stays in bb. Dictate & Delegate stops sending tasks to it until you set a chief again.', ok: 'Forget', cancel: 'Keep', danger: true })) {
          act(() => api('forgetChief'));
        }
      }, { danger: true })));
    chiefNameField(root);
  }
  const result = resultLine('chief');
  root.append(result);
  if (!id || ui.changingChief) {
    const create = btn('Create chief of staff', id ? 'outline' : 'primary', () =>
      bbAction(create, result, 'Installing the skills and creating the thread in bb…', async () => {
        const r = await api('createChief');
        if (r.ok) ui.changingChief = false;
        return r;
      }));
    const existing = input({ placeholder: 'Thread link or id (thr_…)' });
    const use = btn('Use this thread', 'outline', () =>
      bbAction(use, result, 'Checking the thread and the skills in bb…', async () => {
        const r = await api('useChief', existing.value);
        if (r.ok) ui.changingChief = false;
        return r;
      }));
    add(root, [
      h('div', { class: 'btns gap-16' }, create),
      p('Installs the chief\'s skills in bb if needed, then creates a thread called “Chief of staff” in Personal (no project) that uses them.', 'muted small gap-4'),
      strong('Or use a thread you have', 'gap-24'),
      h('div', { class: 'gap-8' }, existing),
      h('div', { class: 'btns gap-8' }, use),
    ]);
  }
  if (onboarding) {
    add(root, h('div', { class: 'grow' }));
    if (id) add(root, btn('Continue', 'primary', nextSetupPage, { block: true, tall: true }));
    laterButton(root);
  }
}

async function pageNtfy(root, onboarding) {
  if (onboarding) steps(root, false);
  heading(root, 'Notifications', 'Your chief of staff notifies you through ntfy when a task is done or needs you; clicking a notification opens its thread in bb. On this Mac, Dictate & Delegate shows them as notifications. On your phone, install the ntfy app and subscribe to your topic.');
  const n = await api('ntfy').catch(() => ({ topic: '', server: S.bb.ntfyServer, web: '' }));
  const states = { open: '✓  Listening for your chief', retrying: 'Connection lost, trying again', off: 'Off' };
  add(root, [
    card('gap-16', label('Your topic'), h('div', { class: 'mono pre', style: 'font-size:14px;color:var(--ink);user-select:text' }, n.topic || '—'), h('div', { class: 'mono gap-4' }, n.server), p("Anyone who knows the topic can read these notifications, so it's long and random. Keep it to yourself.", 'muted small gap-8')),
    card('list gap-12', prefRow("Show the chief's notifications on this Mac", S.notifier ? states[S.notifier] || S.notifier : 'Text to paste comes with Insert and Copy', 'macNotifications', S.mac.macNotifications)),
  ]);
  const result = resultLine('ntfy');
  const test = btn('Send test', 'outline', () => bbAction(test, result, 'Sending…', () => api('ntfyTest')));
  add(root, [
    h('div', { class: 'btns gap-16' }, btn('Open in the browser', 'primary', () => act(() => api('openNtfy'), null)), test, n.topic ? btn('Copy topic', 'quiet', () => act(() => api('copy', n.topic), toast)) : null),
    result,
  ]);
  const server = input({ value: n.server, placeholder: S.bb.ntfyDefault });
  const serverResult = resultLine('ntfy-server');
  const save = btn('Save server', 'quiet', () => {
    const v = server.value.trim();
    if (v && !/^https?:\/\/\S+$/i.test(v)) return toast('The server address starts with https://');
    if (v && !plainHttpAllowed(v)) return toast(PLAIN_HTTP);
    bbAction(save, serverResult, 'Saving…', () => api('setNtfyServer', v));
  });
  add(root, [strong('ntfy server', 'gap-24'), p('ntfy.sh, or your own ntfy server.', 'muted small gap-4'), h('div', { class: 'field-row gap-8' }, server, save), serverResult]);
  if (onboarding) add(root, [h('div', { class: 'grow' }), btn('Done', 'primary', finishSetup, { block: true, tall: true })]);
}

// ------------------------------------------------------------------ home and notes

async function pageHome(root) {
  add(root, h('h1', { class: 'title' }, 'Dictate & Delegate'));
  if (!S.keys.openrouter) add(root, h('button', { class: 'card warncard clickable gap-12 btn block', style: 'height:auto;padding:14px 16px;justify-content:flex-start', onclick: () => open('key') }, strong('Add your OpenRouter key to start dictating')));
  else if (S.permissions.microphone === 'denied' || S.permissions.microphone === 'restricted')
    add(root, h('button', { class: 'card warncard clickable gap-12 btn block', style: 'height:auto;padding:14px 16px;justify-content:flex-start', onclick: () => open('start') }, strong('Finish setup to start dictating')));
  const rec = h('div', { class: 'gap-16' });
  recordControls(rec, 'Start dictating');
  root.append(rec);
  if (S.bb.ready && S.handsFreeAvailable) {
    const snap = await api('call').catch(() => null);
    add(root, h('div', { class: 'gap-12' }, btn(snap && snap.active ? '🎧 Hands-free is on' : '🎧 Hands-free with your chief', 'outline', () => go('handsfree'), { block: true })));
  }
  add(root, h('div', { class: 'head-row gap-8' },
    p(S.attachmentsPending ? (S.attachmentsPending === 1 ? '1 attachment for this dictation' : fmt('%1$d attachments for this dictation', S.attachmentsPending)) : 'Talking about something? Add it, like an offer you reply to.', 'muted small'),
    btn('📎 Add', 'quiet', () => act(() => api('attach')), { attrs: { id: 'attach' } })));
  const data = await api('home');
  const max = Math.max(0, ...data.month.days);
  add(root, h(
    'button',
    { class: 'card panel month gap-16 btn block', style: 'height:auto;display:block;text-align:left;font-weight:400', onclick: () => open('usage') },
    h('div', { class: 'head-row' }, h('span', { class: 'muted' }, fmt('%1$s so far', monthName(0))), h('span', { class: 'muted small' }, data.month.talked)),
    h('div', { class: 'amount' }, data.month.spent),
    h('div', { class: 'bars', 'aria-hidden': 'true' }, data.month.days.map((d, i) => h('div', { class: i === 13 ? 'today' : '', style: 'height:' + (max <= 0 ? 2 : Math.max(2, Math.round((40 * d) / max))) + 'px' }))),
    p('Days without dictation cost nothing.', 'muted small gap-8'),
  ));
  add(root, card(
    'list gap-8',
    row({ title: 'Voice-to-text model', sub: S.labels.speech + (S.labels.speechPerMinute ? ' · ' + S.labels.speechPerMinute : ''), onclick: () => open('models') }),
    row({ title: 'Text-to-speech model', sub: S.labels.voice, onclick: () => open('voices') }),
    row({ title: 'Refine', sub: S.labels.refine, onclick: () => open('refineModel') }),
  ));
  add(root, h('div', { class: 'head-row gap-16' }, h('div', { class: 'label', style: 'margin:0' }, 'Recent'), btn('All notes', 'quiet', () => go('notes'))));
  const list = h('div', { class: 'gap-4' });
  if (!data.recent.length) list.append(p('Your first note will appear here.', 'muted gap-8'));
  for (const item of data.recent)
    list.append(item.type === 'call'
      ? h('div', { class: 'note-row', onclick: () => {
        ui.openCalls.add(item.id);
        go('notes');
      } }, h('div', { class: 'note-main' }, h('div', { class: 'note-text one' }, item.title)), h('span', { class: 'cost' }, item.cost))
      : h('div', { class: 'note-row', onclick: () => open('note', { id: item.id }) }, h('div', { class: 'note-main' }, h('div', { class: 'note-text one' }, item.preview)), h('span', { class: 'cost' }, item.cost)));
  root.append(list);
}

function noteRow(n, turn) {
  return h(
    'div',
    { class: 'note-row' + (turn ? ' turn' : ''), onclick: () => open('note', { id: n.id }) },
    h('div', { class: 'note-main' }, h('div', { class: 'note-text' }, n.preview), h('div', { class: 'meta' }, h('span', { class: 'mono' }, timeShort(n.created) + ' · ' + n.elapsed + ' · ' + n.cost), n.badge ? h('span', { class: 'badge' }, n.badge) : null)),
  );
}

function callRow(c, redraw) {
  const opened = ui.openCalls.has(c.id);
  return h(
    'div',
    { class: 'note-row', onclick: () => {
      if (!ui.openCalls.delete(c.id)) ui.openCalls.add(c.id);
      redraw();
    } },
    h('div', { class: 'note-main' }, h('div', { class: 'call-title' }, (opened ? '▾ ' : '▸ ') + c.title), h('div', { class: 'note-text one muted', style: 'color:var(--muted);font-size:13px' }, c.first), h('div', { class: 'mono gap-4' }, timeShort(c.created) + ' · ' + c.elapsed + ' · ' + c.cost)),
  );
}

function pageNotes(root) {
  heading(root, 'Notes');
  const search = input({ type: 'search', value: ui.notesQuery, placeholder: 'Search your notes', cls: 'search', id: 'notes-search' });
  const list = h('div', { class: 'gap-8', id: 'notes-list' });
  const draw = async () => {
    const data = await api('notes', ui.notesQuery).catch((e) => (toast(e.message), { items: [] }));
    const out = [];
    if (!data.items.length) out.push(p(ui.notesQuery.trim() ? 'Nothing matches.' : 'No notes yet.', 'muted gap-12'));
    let dayFrom = Infinity;
    for (const item of data.items) {
      const at = item.type === 'call' ? item.latest : item.created;
      if (at < dayFrom) {
        dayFrom = dayStart(at);
        out.push(h('div', { class: 'label day' }, dayLabel(at)));
      }
      if (item.type === 'call') {
        out.push(callRow(item, draw));
        if (ui.openCalls.has(item.id)) for (const t of item.turns) out.push(noteRow(t, true));
      } else out.push(noteRow(item, false));
    }
    list.replaceChildren(...out);
  };
  search.addEventListener('input', () => {
    ui.notesQuery = search.value;
    clearTimeout(draw.timer);
    draw.timer = setTimeout(draw, 120);
  });
  add(root, [h('div', { class: 'gap-12' }, search), list]);
  return draw();
}

async function pageNote(root) {
  const id = ui.params.id;
  // Another note opens with its kept version, as Android's openNote.
  if (ui.noteShown !== id) ui.showOriginal = false;
  ui.noteShown = id;
  const n = await api('note', id);
  if (!n) {
    heading(root, 'Note not found');
    return;
  }
  add(root, [back(), p(dateTime(n.created) + ' · ' + n.recorded, 'muted small')]);
  if (n.warning) add(root, card('warncard gap-12', p(n.warning, 'warn')));
  if (n.chief) {
    if (n.chief.sent)
      add(root, [
        h('div', { class: 'btns gap-16' }, btn('Sent to chief of staff ↗', 'primary', () => (n.chief.link ? openUrl(n.chief.link) : toast('Set the bb web address for links in Settings → bb.')))),
        p("Your chief of staff works on it in bb and notifies you through ntfy when it's done or needs you. The button opens the thread.", 'muted small gap-8'),
      ]);
    else
      add(root, [
        p(fmt('Not sent to your chief of staff: %1$s Below is what you said.', n.chief.failed), 'warn gap-12'),
        n.canSendAgain ? h('div', { class: 'btns gap-8' }, btn('Send again', 'outline', async (e) => {
          toast('Sending to your chief of staff…');
          const r = await attempt(e.currentTarget, () => api('sendAgain', id));
          if (r) toast(r);
          render();
        })) : null,
      ]);
  }
  if (n.chiefReply)
    add(root, card('tint gap-16', label('From your chief of staff'), h('div', { class: 'text pre gap-4', style: 'font-size:15px;user-select:text' }, n.chiefReply), h('div', { class: 'btns gap-8' }, btn('Copy', 'quiet', () => act(() => api('copy', n.chiefReply), toast)))));
  if (n.processingFailed)
    add(root, [
      p(fmt("Couldn't refine this note: %1$s Below is what you said.", n.processingFailed), 'warn gap-12'),
      n.canRefineAgain ? h('div', { class: 'btns gap-8' }, btn('Refine again', 'outline', async (e) => {
        await saveEdits();
        toast('Refining your text…');
        const r = await attempt(e.currentTarget, () => api('refineAgain', id));
        if (r) toast(r);
        render();
      })) : null,
    ]);
  const original = n.twoVersions && (ui.showOriginal || n.version === 'original');
  const shown = original ? n.original : n.text;
  if (n.twoVersions)
    add(root, h('div', { class: 'gap-16' }, chips([['refined', 'Refined'], ['original', 'What you said']], original ? 'original' : 'refined', async (v) => {
      await saveEdits();
      ui.showOriginal = v === 'original';
      render();
    })));
  else if (n.chief && n.chief.sent) add(root, strong('What you said', 'gap-16'));
  const editor = h('textarea', { class: 'editor', placeholder: 'No text yet', id: 'note-editor', disabled: n.redoing });
  editor.value = shown;
  let base = shown;
  let timer = null;
  const saveEdits = async () => {
    clearTimeout(timer);
    timer = null;
    const now = editor.value.trim();
    if (now === base.trim()) return;
    base = now;
    try {
      // Edits belong to the version you are looking at, as Android's saveEdits decides it.
      await api('editNote', id, { original: ui.showOriginal, text: now });
    } catch (e) {
      toast('Could not save your changes');
    }
  };
  editor.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(saveEdits, 900);
  });
  editor.addEventListener('blur', saveEdits);
  ui.beforeLeave = saveEdits;
  ui.noteDirty = () => editor.value.trim() !== base.trim();
  add(root, [
    h('div', { class: 'gap-12' }, editor),
    h('div', { class: 'btns gap-12' }, btn('Copy', 'primary', async () => {
      await saveEdits();
      act(() => api('copy', editor.value), toast);
    })),
  ]);
  if (n.files.length) add(root, p('📎 ' + n.files.join(', '), 'muted small gap-12'));
  add(root, p(n.cost, 'muted small gap-12'));
  if (n.anthropicCost) add(root, p(n.anthropicCost, 'muted small gap-4'));
  if (n.anthropicWarning) add(root, p(n.anthropicWarning, 'warn small gap-4'));
  if (n.redoing) add(root, p('Redoing with a smarter model… You can leave this screen.', 'ok gap-8'));
  const redo = btn('Redo with a smarter model', 'outline', async (e) => {
    await saveEdits();
    const r = await attempt(e.currentTarget, () => api('redo', id));
    if (r) toast(r);
    setTimeout(() => ui.page === 'note' && render(), 300);
  });
  redo.disabled = !n.canRedo;
  add(root, [h('div', { class: 'btns gap-16' }, redo), p(n.redoNote, 'muted small gap-4'), h('div', { class: 'mono gap-16', style: 'font-size:11px' }, n.details)]);
  if (n.versions.length > 1) {
    add(root, label('Versions'));
    add(root, card('list', n.versions.map((v, i) => row({
      title: fmt('Version %1$d', i + 1) + (v.shown ? '  ✓' : ''),
      sub: v.model + ' · ' + dateTimeShort(v.created),
      control: v.shown ? h('span', { class: 'small ok' }, 'Shown') : btn('Keep this version', 'quiet', async () => {
        await saveEdits();
        act(() => api('preferVersion', v.id));
      }),
    }))));
  }
  if (n.steps.length) {
    add(root, label('Steps'));
    add(root, card('', n.steps.map((s, i) => p(s.line, (s.failed ? 'warn' : 'body') + ' small' + (i ? ' gap-4' : '')))));
  }
  const links = h('div', { class: 'btns gap-16' });
  if (n.audio)
    links.append(btn('Delete audio', 'quiet', async () => {
      await attempt(null, () => api('deleteNoteAudio', id));
      render();
    }));
  links.append(btn('Delete note', 'quiet', async () => {
    if (!(await confirmDialog({ title: 'Delete this note?', message: "Its text, versions, costs and audio are removed. This can't be undone.", ok: 'Delete', cancel: 'Keep', danger: true }))) return;
    ui.beforeLeave = null;
    try {
      await api('deleteNote', id);
    } catch (e) {
      toast(e.message);
    }
    goBack();
  }, { danger: true }));
  root.append(links);
}

async function pageActivity(root) {
  heading(root, 'Activity', "Every note's steps: which model did what, how long it took and what it cost. Kept on this Mac with your notes; times include the connection.");
  const entries = await api('activity');
  if (!entries.length) add(root, p('No notes yet.', 'muted gap-16'));
  for (const e of entries)
    root.append(h(
      'div',
      { class: 'card clickable gap-12', onclick: () => open('note', { id: e.recordingId }) },
      h('div', { class: 'head-row' }, h('span', { class: 'muted small' }, dateTimeShort(e.created) + (e.route ? ' · ' + e.route : '')), h('span', { class: 'cost', style: 'color:var(--ink)' }, e.cost)),
      h('div', { class: 'note-text gap-4' }, e.preview),
      e.steps.length ? e.steps.map((s) => p(s.line, (s.failed ? 'warn' : 'body') + ' small gap-4')) : h('div', { class: 'mono gap-8', style: 'font-size:11px' }, e.models),
    ));
}

async function pageUsage(root) {
  const m = ui.usageMonth;
  add(root, back());
  add(root, h('div', { class: 'head-row' }, h('h1', { class: 'title' }, monthName(m)), h('div', { class: 'btns' }, btn('‹ Earlier', 'quiet', () => {
    ui.usageMonth++;
    render();
  }, { attrs: { 'aria-label': 'Previous month' } }), m > 0 ? btn('Later ›', 'quiet', () => {
    ui.usageMonth--;
    render();
  }, { attrs: { 'aria-label': 'Next month' } }) : null)));
  const u = await api('usage', m);
  add(root, h('div', { class: 'tiles gap-12' }, [['Spent', u.spent], ['Talked', u.talked], ['Notes', u.notes]].map(([k, v]) => h('div', { class: 'tile' }, h('div', { class: 'muted small' }, k), h('div', { class: 'v' }, v)))));
  const models = card('gap-16', strong('By model'));
  if (!u.byModel.length) models.append(p('Nothing this month.', 'muted gap-8'));
  for (const x of u.byModel)
    add(models, [h('div', { class: 'head-row gap-12' }, h('span', { class: 'small', style: 'color:var(--ink)' }, x.name), h('span', { class: 'muted small' }, x.value)), h('div', { class: 'track' }, h('div', { style: 'width:' + Math.max(2, Math.round(x.share * 100)) + '%' }))]);
  add(root, [models, p(u.footnote, 'muted small gap-16'), u.anthropic ? p(u.anthropic, 'muted small gap-8') : null]);
}

// ------------------------------------------------------------------ settings

function pageSettings(root) {
  heading(root, 'Settings');
  const L = S.labels;
  add(root, [
    label('Models & providers'),
    card('list',
      row({ title: 'OpenRouter key', sub: S.keys.openrouter ? 'Saved, encrypted · speech, decisions and Refine' : 'Not set', onclick: () => open('key') }),
      row({ title: 'Anthropic key', sub: S.keys.anthropic ? 'Saved, encrypted · Refine uses your Anthropic credits' : 'Optional · Refine on your Anthropic credits', onclick: () => open('anthropic') }),
      row({ title: 'Voice-to-text', sub: L.speech, onclick: () => open('models') }),
      row({ title: 'Text-to-speech', sub: L.voice, onclick: () => open('voices') }),
      row({ title: 'Decisions', sub: L.decisions, onclick: () => open('decisions') }),
      row({ title: 'Refine', sub: L.refineModel, onclick: () => open('refineModel') })),
    label('Costs and activity'),
    card('list',
      row({ title: 'Usage', sub: 'What each month cost', onclick: () => open('usage') }),
      row({ title: 'Activity', sub: 'Which model did what, how long it took, what it cost', onclick: () => open('activity') })),
    label('Dictation'),
    card('list',
      row({ title: 'Refine instructions', sub: L.refinePrompt, onclick: () => open('refine') }),
      row({ title: 'Templates', sub: L.templates, onclick: () => open('templates') }),
      row({ title: 'Words', sub: L.words, onclick: () => open('words') }),
      row({ title: 'About you', sub: L.about, onclick: () => open('aboutyou') })),
    label('bb'),
    card('list',
      row({ title: 'Connection', sub: L.connection, onclick: () => open('bb') }),
      row({ title: 'Chief of staff', sub: L.chief, onclick: () => open('chief') }),
      S.bb.connected ? row({ title: 'Your name', sub: S.bb.userName || 'Optional: what your chief calls you', onclick: () => open('bb') }) : null,
      row({ title: 'Notifications', sub: L.ntfy, onclick: () => open('ntfy') }),
      S.bb.connected ? row({ title: "Your chief's skills", sub: S.skills.line.text || 'chief-of-staff, dictate-and-delegate', onclick: () => open('bb') }) : null),
    label('Using Dictate & Delegate'),
    card('list',
      row({ title: 'Start and insert', sub: fmt('Shortcut %1$s · %2$s', accelLabel(S.hotkey), S.permissions.accessibility ? (S.mac.insertMethod === 'direct' ? 'Insert types directly' : 'Insert pastes with ⌘V') : 'Insert copies'), onclick: () => open('start') }),
      row({ title: 'Hands-free', sub: 'Send words and timing', onclick: () => open('hfsettings') }),
      row({ title: 'Permissions', sub: (S.permissions.microphone === 'granted' ? 'Microphone allowed' : 'Microphone not allowed') + ' · ' + (S.permissions.accessibility ? 'Accessibility on' : 'Accessibility off'), onclick: () => open('start') })),
    label('Data on this Mac'),
    card('list',
      prefRow('Keep audio for 7 days', 'Needed to redo a note with a smarter model', 'retainAudio', S.retainAudio),
      row({ title: 'Delete saved audio', onclick: deleteAudio }),
      row({ title: 'Export settings', sub: 'Settings and keys as a file, to move to another Mac', onclick: exportSettings }),
      row({ title: 'Import settings', sub: 'From a file exported on another Mac', onclick: importSettings }),
      row({ title: 'App log', sub: 'Copy it for a bug report', onclick: () => act(() => api('copyAppLog'), toast) }),
      row({ title: 'Network log', sub: "Every connection to bb, ntfy and the models: copy it when something didn't arrive", onclick: () => act(() => api('copyNetworkLog'), toast) }),
      row({ title: 'Delete local data', sub: 'Notes, audio, templates, keys, bb sign-in and settings', onclick: deleteLocalData, warn: true })),
    label('About'),
    card('list',
      h('div', { class: 'row' }, p("Your voice and text go only to the providers you choose. There's no Dictate & Delegate server.", 'muted')),
      row({ title: 'Source code', sub: 'Open source, MIT License · github.com/Philipp258/dictate-and-delegate', onclick: () => openUrl(S.sourceUrl) }),
      row({ title: 'Report a problem', sub: 'On GitHub', onclick: () => openUrl(S.sourceUrl + '/issues') })),
    p('Dictate & Delegate ' + S.version, 'muted small center gap-16'),
  ]);
}

async function deleteAudio() {
  if (!(await confirmDialog({ title: 'Delete all saved audio?', message: 'Text and costs stay. Notes can no longer be redone.', ok: 'Delete', cancel: 'Keep', danger: true }))) return;
  const r = await attempt(null, () => api('deleteSavedAudio'));
  if (r) toast(r);
}

async function deleteLocalData() {
  const ok = await confirmDialog({
    title: 'Delete local data?',
    message: "Dictate & Delegate has no server, so everything it keeps is on this Mac. This deletes your notes, audio, templates, words, About you, your OpenRouter, Anthropic and live transcription keys, your bb sign-in and settings. It can't be undone. Your accounts at OpenRouter, Anthropic and bb stay as they are.",
    ok: 'Delete everything',
    cancel: 'Keep',
    danger: true,
  });
  if (!ok) return;
  const r = await attempt(null, () => api('deleteLocalData'));
  if (r) {
    toast(r);
    go('welcome');
  }
}

async function exportSettings() {
  const ok = await confirmDialog({
    title: 'Export settings with your keys?',
    message: 'The file holds your settings and, unencrypted, your OpenRouter, Anthropic and live transcription keys, your bb token and your ntfy topic. Keep it somewhere safe, and delete it once it is imported. Your bb Connect sign-in is not in it: sign in again on the other Mac.',
    ok: 'Export',
    cancel: 'Cancel',
  });
  if (!ok) return;
  const r = await attempt(null, () => api('exportSettings', { confirmed: true }));
  if (r) toast(r);
}

async function importSettings() {
  const ok = await confirmDialog({ title: 'Import settings?', message: 'The settings and keys in the file replace the ones on this Mac. Your notes stay as they are.', ok: 'Choose file…', cancel: 'Cancel' });
  if (!ok) return;
  const r = await attempt(null, () => api('importSettings'));
  if (r) {
    toast(r);
    render();
  }
}

async function pageModels(root) {
  heading(root, 'Speech model', 'Dictate & Delegate uses this model for every note.');
  const list = h('div', { class: 'gap-8' });
  const foot = p('', 'muted small gap-16');
  const draw = async () => {
    const data = await api('speechModels', ui.modelsQuery, ui.modelsSort);
    foot.textContent = fmt('Word and speed dots are editorial estimates, not measurements of your voice. Prices per minute from %1$s.', data.priceDate);
    const out = data.models.map((m) =>
      h('div', { class: 'card clickable gap-8' + (m.id === data.selected ? ' selected' : ''), onclick: async () => {
        const r = await attempt(null, () => api('setSpeechModel', m.id));
        if (r) {
          toast(r);
          goBack();
        }
      } }, h('div', { class: 'head-row' }, strong(m.name), h('span', { class: 'cost', style: 'color:var(--ink)' }, m.perMinute)), h('div', { class: 'mono gap-4', style: 'font-size:11px' }, m.meta)));
    list.replaceChildren(...(out.length ? out : [p('No models match.', 'muted gap-8')]));
  };
  const sorts = chips([['recommended', 'Best overall'], ['accuracy', 'Most accurate'], ['cost', 'Cheapest'], ['speed', 'Fastest']], ui.modelsSort, (v) => {
    ui.modelsSort = v;
    render();
  });
  const search = input({ type: 'search', value: ui.modelsQuery, placeholder: 'Search models', cls: 'search' });
  search.addEventListener('input', () => {
    ui.modelsQuery = search.value;
    draw();
  });
  add(root, [h('div', { class: 'gap-12' }, sorts), h('div', { class: 'gap-12' }, search), list, foot]);
  await draw();
}

async function pageVoices(root) {
  heading(root, 'Text-to-speech', "Reads your chief's replies aloud in hands-free mode, which is English only for now.");
  const v = await api('voices');
  add(root, card('list gap-12', v.choices.map((c) => row({
    title: (c.id === v.current ? '✓  ' : '') + c.name,
    sub: c.note,
    onclick: async () => {
      await attempt(null, () => api('setPref', 'hfVoice', c.id));
      render();
    },
  }))));
  const current = v.choices.find((c) => c.id === v.current);
  if (current && current.system) {
    const voices = await api('systemVoices').catch(() => []);
    const select = h('select', { 'aria-label': "The Mac's voice" }, h('option', { value: '' }, 'Default English voice'), voices.map((x) => h('option', { value: x.name }, x.name + (x.lang ? ' · ' + x.lang : ''))));
    select.value = v.macVoice;
    select.addEventListener('change', () => api('setPref', 'macVoice', select.value).then(() => toast('✓ Saved'), (e) => toast(e.message)));
    add(root, [strong("The Mac's voice", 'gap-16'), h('div', { class: 'gap-8' }, select)]);
  }
  add(root, p("The voice models run through OpenRouter with your key; what they cost shows on each note and in Usage. The Mac's voice works offline, and takes over when OpenRouter fails. When a voice model fails, the call bar says why.", 'muted small gap-12'));
}

function pageDecisions(root) {
  heading(root, 'Decisions', 'After each transcript, Jev, a fast decision model, decides what happens next: whether you asked for a text, which template you named, and whether you were talking to your chief of staff. It takes about a third of a second and runs on your OpenRouter key.');
  add(root, [
    card('list gap-16',
      prefRow('Refine automatically', 'When you ask for a text, name a template, or the dictation needs tidying', 'autoRefine', S.profile.autoRefine),
      prefRow('Send to chief when addressed', 'When you speak to your chief by name (Settings → Chief of staff); otherwise click 🧑‍💼', 'autoChief', S.profile.autoChief),
      row({ title: 'Model', sub: 'Jev · ' + S.profile.jevModel })),
    p('The ✨ and 🧑‍💼 buttons always work, whatever is set here.', 'muted small gap-12'),
  ]);
}

function pageRefineModel(root) {
  const direct = S.keys.anthropic;
  const openRouterTab = !direct || ui.refineOpenRouterTab;
  heading(root, 'Refine model', direct
    ? 'With your Anthropic key, ✨ Refine goes to the Claude model you pick here. If Anthropic fails, it goes through OpenRouter, to the OpenRouter model.'
    : '✨ Refine goes through OpenRouter to the model you pick here. Add an Anthropic key under Models & providers to use Claude on your Anthropic credits.');
  if (direct)
    add(root, h('div', { class: 'gap-12' }, chips([['anthropic', 'Anthropic · ' + (ui.refineData ? ui.refineData.claudeName : 'Claude')], ['openrouter', 'OpenRouter · ' + (ui.refineData ? ui.refineData.openRouterName : '…')]], openRouterTab ? 'openrouter' : 'anthropic', (v) => {
      ui.refineOpenRouterTab = v === 'openrouter';
      render();
    })));
  const list = h('div', { class: 'gap-8' }, p("Loading OpenRouter's models…", 'muted gap-8'));
  const modelCard = (m, selected, onpick) => h('div', { class: 'card clickable gap-8' + (selected ? ' selected' : ''), onclick: onpick }, h('div', { class: 'head-row' }, strong(m.name), h('span', { class: 'cost', style: 'color:var(--ink)' }, m.price)), h('div', { class: 'mono gap-4', style: 'font-size:11px' }, m.meta));
  const fill = async () => {
    const data = await api('refineModels').catch((e) => ({ error: e.message, claude: [], openRouter: null }));
    const first = !ui.refineData;
    ui.refineData = data;
    if (!list.isConnected && !first) return;
    if (!openRouterTab) {
      list.replaceChildren(...data.claude.map((c) => modelCard(c, c.selected, async () => {
        act(() => api('setClaudeModel', c.id), (r) => (toast(r), render()));
      })), p("Prices per million tokens in / out, Anthropic's list prices.", 'muted small gap-12'));
      return;
    }
    if (!data.openRouter) return list.replaceChildren(p(data.error || 'Could not load the models.', 'warn gap-8'));
    const draw = () => {
      const q = ui.refineQuery.trim().toLowerCase();
      let shown = 0;
      const out = [];
      for (const m of data.openRouter) {
        if (q && !m.id.toLowerCase().includes(q) && !m.name.toLowerCase().includes(q)) continue;
        // The whole catalog is long; without a search, the first 40 (the default comes first).
        if (!q && shown >= 40 && m.id !== data.selected) continue;
        shown++;
        out.push(modelCard(m, m.id === data.selected, async () => {
          act(() => api('setRefineModel', m.id, m.name), (r) => (toast(r), render()));
        }));
      }
      rows.replaceChildren(...(out.length ? out : [p('No models match.', 'muted gap-8')]));
    };
    const search = input({ type: 'search', value: ui.refineQuery, placeholder: 'Search models', cls: 'search' });
    search.addEventListener('input', () => {
      ui.refineQuery = search.value;
      draw();
    });
    const rows = h('div');
    list.replaceChildren(search, rows, p('Prices per million tokens in / out, from OpenRouter.', 'muted small gap-12'));
    draw();
    if (first && direct) render();
  };
  root.append(list);
  fill();
}

function pageRefine(root) {
  heading(root, 'Refine instructions', "Your words come first, always. Then ✨ Refine turns them into the text you need: it works out what it's for (a message, an email, a note), follows what you asked for and fills in your templates.");
  example(root);
  const prompt = h('textarea', { rows: 12, maxlength: 4000, id: 'refine-prompt', style: 'font-size:13px' });
  api('refinePrompt').then((r) => (prompt.value = r.prompt));
  add(root, [
    strong('Instructions for Refine', 'gap-24'),
    p('About you, your words and the template you name are added automatically.', 'muted small gap-4'),
    h('div', { class: 'gap-8' }, autosave(prompt, (v) => api('setRefinePrompt', v))),
    h('div', { class: 'btns gap-8' }, btn('Reset to default', 'quiet', async () => {
      act(() => api('resetRefinePrompt'));
    })),
  ]);
}

async function pageTemplates(root) {
  heading(root, 'Templates', "Keep texts you write again and again, like an application for an apartment. Then dictate which one you want and what's different this time.");
  add(root, card('panel gap-16', label('You say'), p('“Use my apartment application for the two-room flat on Hauptstraße 5, the viewing is on Saturday, and mention that I work from home.”', 'body gap-4'), p('Dictate & Delegate writes your application with these details, ready to paste.', 'muted gap-4')));
  if (!S.profile.autoRefine) add(root, p('Refine automatically is off: a template is used when you click ✨ Refine.', 'muted gap-12'));
  const all = await api('templates');
  if (!all.length) add(root, p('No templates yet.', 'muted gap-16'));
  else add(root, card('list gap-16', all.map((t) => row({ title: t.name.trim() ? t.name : 'Untitled', sub: t.preview, onclick: () => open('template', { id: t.id }) }))));
  add(root, [
    h('div', { class: 'btns gap-16' }, btn('New template', 'primary', () => open('template', { id: '' }))),
    p('Your templates stay on this Mac. Only the one you ask for is sent to the AI, together with your dictation.', 'muted small gap-12'),
  ]);
}

async function pageTemplate(root) {
  const id = ui.params.id || '';
  const t = id ? await api('template', id) : null;
  const max = await api('templateMax').catch(() => 8000);
  heading(root, t ? 'Edit template' : 'New template');
  const name = input({ value: t ? t.name : '', placeholder: 'For example: Apartment application' });
  const text = h('textarea', { rows: 14, maxlength: max, placeholder: 'Your template' });
  text.value = t ? t.text : '';
  const save = btn('Save', 'primary', async () => {
    if (!name.value.trim() || !text.value.trim()) return toast('Give the template a name and a text');
    const r = await attempt(save, () => api('saveTemplate', t ? t.id : null, name.value, text.value));
    if (r) {
      toast('Template saved');
      goBack();
    }
  });
  add(root, [
    strong('Name', 'gap-16'),
    h('div', { class: 'gap-8' }, name),
    strong('Text', 'gap-16'),
    p("Paste or type the text as you'd send it.", 'muted small gap-4'),
    h('div', { class: 'gap-8' }, text),
    h('div', { class: 'btns gap-16' }, save, t ? btn('Delete template', 'quiet', async () => {
      if (!(await confirmDialog({ title: 'Delete this template?', ok: 'Delete', cancel: 'Keep', danger: true }))) return;
      await attempt(null, () => api('deleteTemplate', t.id));
      goBack();
    }, { danger: true }) : null),
  ]);
}

async function pageWords(root) {
  heading(root, 'Words', 'Used to spell names and terms right, in transcription and processing.');
  const field = input({ placeholder: 'Add a word or name', id: 'word-input' });
  const box = h('div');
  const draw = (words) => {
    box.replaceChildren(label('Your words'), words.length ? h('div', { class: 'chips' }, words.map((w) => h('button', { class: 'chip word', 'aria-label': fmt('Remove %1$s', w), onclick: () => act(() => api('removeWord', w), (r) => (r ? draw(r) : render())) }, w + '   ✕'))) : p('No words yet.', 'muted'));
  };
  const addWord = async () => {
    const w = field.value;
    field.value = '';
    const r = await attempt(null, () => api('addWord', w));
    if (r) draw(r);
    field.focus();
  };
  field.addEventListener('keydown', (e) => e.key === 'Enter' && addWord());
  add(root, [h('div', { class: 'field-row gap-16' }, field, btn('Add', 'outline', addWord)), box]);
  draw(await api('words'));
}

async function pageAboutYou(root) {
  heading(root, 'About you', 'Helps Dictate & Delegate spell names right and process each note for its purpose.');
  const a = await api('aboutYou');
  let selected = a.selected.slice();
  const topics = h('div', { class: 'chips gap-12' }, a.topics.map((t) => {
    const chip = h('button', { class: 'chip' + (selected.includes(t) ? ' on' : '') }, t);
    chip.addEventListener('click', async () => {
      selected = selected.includes(t) ? selected.filter((x) => x !== t) : [...selected, t];
      chip.classList.toggle('on', selected.includes(t));
      const r = await attempt(null, () => api('setTopics', selected));
      if (r) selected = r;
      else render();
    });
    return chip;
  }));
  const about = h('textarea', { rows: 5, maxlength: 2000, placeholder: 'For example: I build an app called Dictate & Delegate. Jana is a colleague. Write numbers as digits.' });
  about.value = a.about;
  add(root, [strong('What you usually dictate', 'gap-16'), topics, strong('Anything else Dictate & Delegate should know?', 'gap-24'), h('div', { class: 'gap-8' }, autosave(about, (v) => api('setAbout', v)))]);
}

// ------------------------------------------------------------------ start (Mac)

async function pageStart(root) {
  heading(root, 'Start and insert', 'Start with your shortcut in any app; Insert puts the text where you type.');
  add(root, card('gap-16',
    strong('Dictation shortcut'),
    p('Starts and stops a dictation in any app. During a hands-free call it sends what you said at once.', 'muted small gap-4'),
    h('div', { class: 'gap-8' }, recorder('dictate')),
    strong('Hands-free shortcut', 'gap-16'),
    p('Starts a hands-free call with your chief; pressed during a call, it ends it.', 'muted small gap-4'),
    h('div', { class: 'gap-8' }, recorder('call'))));
  const method = S.mac.insertMethod;
  const pick = (v) => async () => {
    await attempt(null, () => api('setPref', 'insertMethod', v));
    render();
  };
  add(root, [
    label('Insert'),
    card('list',
      row({ title: (method === 'paste' ? '✓  ' : '') + 'Paste — recommended', sub: 'Puts the text on the clipboard, presses ⌘V, then puts back what you had copied. Works in every app that takes ⌘V.', onclick: pick('paste') }),
      row({ title: (method === 'direct' ? '✓  ' : '') + 'Type directly through Accessibility', sub: "Sets the text in the field without the clipboard. Works in the Mac's own text fields; where it doesn't land, it pastes instead.", onclick: pick('direct') }),
      prefRow('Insert automatically when the transcript is ready', 'The transcript goes to the cursor by itself, without clicking Insert. Refine and Chief still wait for you.', 'autoInsert', S.mac.autoInsert)),
  ]);
  const devices = await api('micDevices').catch(() => []);
  const select = h('select', { 'aria-label': 'Microphone' }, h('option', { value: '' }, 'System default'), devices.map((d) => h('option', { value: d.id }, d.label || 'Microphone')));
  select.value = devices.some((d) => d.id === S.mac.micDevice) ? S.mac.micDevice : '';
  select.addEventListener('change', () => api('setPref', 'micDevice', select.value).then(() => toast('✓ Saved'), (e) => toast(e.message)));
  const opacityValue = h('span', { class: 'muted small' }, S.mac.bubbleOpacity + ' %');
  const opacity = h('input', { type: 'range', min: 20, max: 100, step: 5, value: S.mac.bubbleOpacity, 'aria-label': 'Panel opacity' });
  opacity.addEventListener('input', () => (opacityValue.textContent = opacity.value + ' %'));
  opacity.addEventListener('change', () => api('setPref', 'bubbleOpacity', Number(opacity.value)).catch((e) => toast(e.message)));
  add(root, [
    label('Microphone and panel'),
    card('',
      strong('Microphone'),
      h('div', { class: 'gap-8' }, select),
      h('div', { class: 'head-row gap-16' }, strong('Panel opacity'), opacityValue),
      h('div', { class: 'gap-8' }, opacity),
      p('How solid the floating panel looks over other apps.', 'muted small gap-4')),
    label('Permissions'),
    microphoneCard(),
    accessCard(),
    h('div', { class: 'btns gap-12' }, btn('Test Insert in the app behind', 'quiet', async () => {
      const r = await attempt(null, () => api('testInsert', 'Dictate & Delegate inserted this.'));
      if (r && r.how) toast(r.how === 'copied' ? 'Copied instead, paste with ⌘V' : '✓ Inserted');
    })),
    p('Not needed: screen recording, contacts, location.', 'muted small gap-12'),
  ]);
}

// ------------------------------------------------------------------ hands-free

const quoteList = (words) => (words && words.length ? words.map((w) => '"' + w + '"').join(', ') : '–');

function liveLook(live) {
  switch (live) {
    case 'PLAYING':
    case 'REPLY_COMING':
      return ['🔊  ', 'play'];
    case 'SENDING':
      return ['📨  ', 'wait'];
    case 'SENT':
      return ['📨  ', ''];
    case 'REPLY_WAITING':
      return ['⏸  ', 'wait'];
    case 'WRITING':
      return ['✍️  ', 'wait'];
    case 'MUTED':
      return ['🔇  ', 'muted'];
    default:
      return ['🎙  ', ''];
  }
}

/** The call's part of the page, from a snapshot: started or not, the live line, reasons, words, cost. */
function callArea(snap) {
  const active = !!(snap && snap.active);
  ui.callActive = active;
  if (!active) {
    const start = btn('Start hands-free', 'primary', async () => {
      if (S.permissions.microphone !== 'granted' && S.permissions.microphone !== 'not-determined') {
        toast('Allow the microphone first');
        return open('start');
      }
      await attempt(start, () => api('startCall'));
    }, { block: true, tall: true });
    return h('div', null, p('Talk with your chief while you drive or cook. Pause as long as you like; answers are read aloud.', 'body gap-4'), h('div', { class: 'gap-16' }, start), h('div', { class: 'record-hint' }, 'or press ', h('kbd', null, accelLabel(S.callHotkey)), ' in any app'));
  }
  const live = h('div', { class: 'live', id: 'hf-live', role: 'status' });
  const off = p('', 'warn gap-8 hidden');
  const pending = p('', 'body gap-12 pre');
  const reasons = h('div', { class: 'reasons gap-4', id: 'hf-reasons' });
  const send = btn('Send now', 'primary', () => api('sendNow').catch((e) => toast(e.message)), { block: true, tall: true });
  const end = btn('End hands-free', 'quiet', () => api('endCall').catch((e) => toast(e.message)), { block: true, danger: true });
  const costLine = p('', 'muted small center gap-8');
  const area = h('div', null, live, off, pending, strong('What it decided, and why', 'gap-16'), reasons, h('div', { class: 'gap-16' }, send), h('div', { class: 'gap-8' }, end), costLine, h('div', { class: 'record-hint' }, 'Send now: ', h('kbd', null, accelLabel(S.hotkey)), '   End: ', h('kbd', null, accelLabel(S.callHotkey))));
  area.update = (s) => {
    const [icon, cls] = liveLook(s.live);
    live.textContent = icon + (s.liveLabel || '');
    live.className = 'live ' + cls;
    off.textContent = s.liveOff || '';
    off.classList.toggle('hidden', !s.liveOff);
    const reasonList = Array.isArray(s.reasons) ? s.reasons.slice(0, 5) : [];
    reasons.replaceChildren(...(reasonList.length ? reasonList.map((r) => h('div', null, h('span', { class: 't' }, r.at ? clock(r.at) : ''), r.text, r.times > 1 ? '  ×' + r.times : '')) : [h('div', { class: 'muted' }, 'Nothing yet.')]));
    // Below it, always labelled: your words so far while listening, the chief's while reading, or an error.
    const error = s.error || '';
    pending.textContent = error ? error : s.phase === 'READING' && s.reply ? fmt('Chief: %1$s', s.reply) : s.pending ? fmt('You: %1$s', s.pending) : '';
    pending.className = 'text gap-12 pre ' + (error ? 'warn' : 'body');
    costLine.textContent = s.cost ? fmt('This call so far: %1$s', exact(s.cost)) : '';
    send.classList.toggle('hidden', !s.canSend);
  };
  area.update(snap);
  return area;
}

async function recentEvents(root) {
  const log = await api('handsFreeLog').catch(() => ({ empty: true }));
  add(root, strong('Recent events', 'gap-24'));
  const network = btn('Copy network log', 'outline', () => act(() => api('copyNetworkLog'), toast));
  if (log.empty) return add(root, [p("No events yet. They appear here once you've made a hands-free call.", 'muted small gap-4'), h('div', { class: 'btns gap-8' }, network)]);
  add(root, [
    h('div', { class: 'btns gap-8' }, btn('Copy last call', 'outline', () => act(() => api('copyHandsFreeLog', 1), toast)), btn('Copy last 3 calls', 'outline', () => act(() => api('copyHandsFreeLog', 3), toast)), network),
    h('div', { class: 'events gap-8', id: 'hf-events' }, log.lines),
  ]);
}

async function pageHandsFree(root) {
  heading(root, 'Hands-free');
  if (!S.bb.ready) {
    add(root, [p('Set up your chief of staff in Settings → bb first.', 'warn gap-16'), h('div', { class: 'btns gap-12' }, btn(S.bb.connected ? 'Set up your chief of staff' : 'Connect bb', 'outline', () => open(S.bb.connected ? 'chief' : 'bb')))]);
    return;
  }
  if (!S.handsFreeAvailable) add(root, p('Hands-free is not available in this build.', 'warn gap-12'));
  const snap = await api('call').catch(() => null);
  const holder = h('div', { id: 'hf-area' }, callArea(snap));
  ui.callArea = holder;
  root.append(holder);
  add(root, p(fmt('Talk, then pause: when you\'re clearly done (a question asked, %1$s), it\'s sent; say %2$s to end. Send now and your shortcut send at once. A reply waits while you talk and plays when you pause; talk over it to stop it.', quoteList(S.handsFree.sendList), quoteList(S.handsFree.endList)), 'muted small gap-16'));
  add(root, h('div', { class: 'btns gap-8' }, btn('Hands-free settings', 'quiet', () => open('hfsettings'))));
  await recentEvents(root);
}

/** A 'call' event: the live parts update in place; a call that started or ended rebuilds them. */
function onCall(snap) {
  if (ui.page !== 'handsfree' || !ui.callArea || !ui.callArea.isConnected) return;
  const active = !!(snap && snap.active);
  const area = ui.callArea.firstChild;
  if (active !== ui.callActive || !area || !area.update) ui.callArea.replaceChildren(callArea(snap));
  else area.update(snap);
}

function wordsField(root, title, key, value, fallback) {
  const field = input({ value, placeholder: fallback });
  add(root, [strong(title, 'gap-16'), h('div', { class: 'gap-8' }, autosave(field, (v) => api('setPref', key, v)))]);
}

/** A number field in seconds, saved in milliseconds ("0.8", "30"). */
function secondsField(root, title, key, ms) {
  const field = input({ value: String(Math.round(ms) / 1000), cls: 'num' });
  field.style.maxWidth = '140px';
  add(root, [strong(title, 'gap-16'), h('div', { class: 'gap-8' }, autosave(field, (v) => {
    const n = Number(String(v).trim().replace(',', '.'));
    if (!Number.isFinite(n) || String(v).trim() === '') return 'Not a number yet.';
    return api('setPref', key, Math.round(n * 1000));
  }))]);
}

function decimalField(root, title, save, value) {
  const field = input({ value: Number(value).toFixed(1) });
  field.style.maxWidth = '140px';
  add(root, [strong(title, 'gap-16'), h('div', { class: 'gap-8' }, autosave(field, (v) => {
    const n = Number(String(v).trim().replace(',', '.'));
    if (!Number.isFinite(n) || String(v).trim() === '') return 'Not a number yet.';
    return save(n);
  }))]);
}

async function pageHfSettings(root) {
  const hf = S.handsFree;
  heading(root, 'Hands-free settings', "At each longer pause Jev decides whether you're done; these words are clear cues for it (also used if Jev can't be asked). Separate several with commas.");
  wordsField(root, 'Send words', 'hfSendWords', hf.sendWords, hf.defaultSend);
  wordsField(root, 'End words (send what came before, then end hands-free)', 'hfEndWords', hf.endWords, hf.defaultEnd);
  secondsField(root, "Pause after which it checks whether you're done (seconds)", 'hfTurnPauseMs', hf.pauseMs);
  secondsField(root, 'Send anyway after this much silence (seconds)', 'hfSilenceSendMs', hf.silenceSendMs);
  add(root, [strong('Telling your voice from the background', 'gap-24'), p('Raise these if noise or other people take your turn; lower them if your quieter words are missed. The recent events below show each decision with its levels.', 'muted small gap-4')]);
  decimalField(root, 'Your voice must be this many times louder than the background', (v) => api('setPref', 'hfGate', v), hf.gate);
  decimalField(root, 'Speech needed to take your turn, within 1.5 seconds (seconds)', (v) => api('setPref', 'hfTakeMs', Math.round(v * 1000)), hf.takeMs / 1000);
  add(root, [strong('Sounds and voice', 'gap-24'), card('list gap-8', prefRow('Quiet sounds', 'Heard you, sent, reply coming, something failed', 'hfSounds', hf.sounds))]);
  secondsField(root, "Use the Mac's voice when the voice model takes longer than (seconds)", 'hfVoiceWaitMs', hf.voiceWaitMs);
  add(root, [
    card('list gap-12', prefRow('Keep the call audio open', "A reply starts at once; the call's audio stays on, silent, for the whole call", 'hfOpenAudio', hf.openAudio)),
    strong('Live transcription', 'gap-24'),
    card('list gap-8',
      prefRow('Live transcription', 'Your words are written down as you speak, and a send word sends at once. Off, or without a key: written down at each pause.', 'hfLive', hf.live),
      row({ title: 'Live transcription model', sub: S.labels.live, onclick: () => open('live') })),
  ]);
  talkerSetting(root);
  await recentEvents(root);
}

/** The talker: a second bb thread that talks with you while the chief does the work. */
function talkerSetting(root) {
  const field = input({ value: S.bb.talkerId, placeholder: 'Talker thread link or id (thr_…)' });
  const problem = p(S.bb.talkerProblem || '', 'muted small gap-4');
  const [f, saved] = autosave(field, async (v) => {
    const why = await api('setTalker', v); // A failure shows under the field (autosave).
    problem.textContent = why;
    problem.className = 'text small gap-4 ' + (why ? 'warn' : 'muted');
  }, 600);
  add(root, [
    strong('Talker thread', 'gap-24'),
    p('A second bb thread that answers you quickly by voice while your chief of staff does the work. When it\'s on, each hands-free message goes to both, and your chief sends its results to the talker.', 'muted small gap-4'),
    card('list gap-8', row({ title: 'Use the talker', sub: 'From your next hands-free call on', control: switchEl(S.bb.talkerOn, (on) => api('setTalkerOn', on).catch((e) => toast(e.message)), 'Use the talker') })),
    h('div', { class: 'gap-8' }, f, saved),
    problem,
  ]);
}

async function pageLive(root) {
  heading(root, 'Live transcription model', "Writes down what you say while you speak, so a send word sends at once. It runs with your own key for the provider, billed by them for the time it's listening (closed after a minute without speech).");
  const data = await api('liveModels');
  add(root, card('list gap-12', data.choices.map((c) => row({
    title: (c.id === data.current ? '✓  ' : '') + c.name,
    sub: c.note,
    onclick: async () => {
      await attempt(null, () => api('setPref', 'hfLiveModel', c.id));
      render();
    },
  }))));
  for (const k of data.keys) {
    const field = input({ type: 'password', placeholder: k.saved ? 'Paste a new key to replace it' : 'Paste your key' });
    const save = btn('Save key', 'outline', async () => {
      if (!field.value.trim()) return toast('Paste your key first');
      const r = await attempt(save, () => api('saveLiveKey', k.provider, field.value));
      if (r) {
        toast(r);
        render();
      }
    });
    add(root, [
      strong(k.label, 'gap-24'),
      k.saved ? p('✓  A key is saved on this Mac, encrypted in the Keychain.', 'ok small gap-4') : null,
      h('div', { class: 'gap-8' }, field),
      h('div', { class: 'btns gap-8' }, save, btn('Get a key', 'quiet', () => openUrl(k.url)), k.saved ? btn('Remove key', 'quiet', async () => {
        act(() => api('removeLiveKey', k.provider));
      }, { danger: true }) : null),
    ]);
  }
}

// ------------------------------------------------------------------ the page table and events

const PAGES = {
  welcome: pageWelcome,
  key1: (r) => pageKey(r, true),
  allow1: pageAllow,
  how1: pageHow,
  start1: pageStart1,
  insert1: pageInsert1,
  try1: pageTry,
  bb1: (r) => pageBb(r, true),
  chief1: (r) => pageChief(r, true),
  ntfy1: (r) => pageNtfy(r, true),
  home: pageHome,
  notes: pageNotes,
  note: pageNote,
  activity: pageActivity,
  usage: pageUsage,
  handsfree: pageHandsFree,
  hfsettings: pageHfSettings,
  live: pageLive,
  settings: pageSettings,
  key: (r) => pageKey(r, false),
  anthropic: pageAnthropic,
  models: pageModels,
  voices: pageVoices,
  decisions: pageDecisions,
  refineModel: pageRefineModel,
  refine: pageRefine,
  templates: pageTemplates,
  template: pageTemplate,
  words: pageWords,
  aboutyou: pageAboutYou,
  bb: (r) => pageBb(r, false),
  chief: (r) => pageChief(r, false),
  ntfy: (r) => pageNtfy(r, false),
  start: pageStart,
  setup: pageStart,
};

/** Pages main.js may ask for, mapped to this window's; before setup is done, the setup ones. */
function target(page) {
  const onboarded = S ? S.onboarded : true;
  if (!onboarded && page === 'bb') return 'bb1';
  if (!onboarded && page === 'chief') return 'chief1';
  if (!onboarded && page === 'key') return 'key1';
  return PAGES[page] ? page : 'home';
}

// A file dropped on the window must not replace the app with it.
for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault());

for (const b of document.querySelectorAll('#sidebar .nav')) b.addEventListener('click', () => go(b.dataset.section));

dd.on('navigate', (page) => go(target(page)));

dd.on('event', (name, payload) => {
  switch (name) {
    case 'call':
      return onCall(payload);
    case 'skills': {
      const line = document.getElementById('skills-line');
      if (line && payload && payload.line) {
        line.textContent = payload.line.text;
        line.className = 'text gap-12 ' + toneClass(payload.line.tone);
      }
      return;
    }
    case 'signin':
      ui.bbNotice = payload && { ok: !!payload.ok, message: String(payload.message || ''), slot: 'connect' };
      ui.bbModeShown = 'connect';
      if (!['bb', 'bb1'].includes(ui.page)) return go(target('bb'));
      return render();
    case 'notes':
      if (['home', 'notes', 'activity', 'usage'].includes(ui.page)) return refreshSoon();
      if (ui.page === 'note' && !(ui.noteDirty && ui.noteDirty())) return refreshSoon();
      return;
    case 'settings':
      if (ui.page === 'note' || ui.page === 'try1') return;
      return refreshSoon();
  }
});

window.addEventListener('focus', () => {
  // Back from System Settings: permissions may have changed.
  if (['allow1', 'insert1', 'start', 'start1', 'home', 'settings'].includes(ui.page)) refreshSoon();
});

(async () => {
  const first = new URLSearchParams(location.search).get('page') || '';
  try {
    S = await api('state');
  } catch (e) {
    toast(e.message);
  }
  ui.page = first ? target(first) : S && S.onboarded ? 'home' : 'welcome';
  render(true);
})();
