'use strict';
// The floating panel: draws what src/core/panel-model.js says and hands taps back to main. It
// never takes the keyboard focus (main makes it a non-activating panel), so Insert goes to the
// app you were typing in.
// window.dd comes from preload.js.
const root = document.getElementById('panel');

function button(b) {
  const el = document.createElement('button');
  el.textContent = b.label;
  el.title = b.name;
  el.setAttribute('aria-label', b.name);
  el.disabled = !b.enabled;
  if (b.fill === 'teal' || b.fill === 'red') el.classList.add(b.fill);
  if (b.ring) el.classList.add('ring-' + b.ring);
  el.addEventListener('click', () => dd.send('panel:action', b.id));
  return el;
}

function render(m) {
  root.innerHTML = '';
  if (!m) m = { mode: 'hidden' };
  root.style.setProperty('--alpha', String(Math.max(0.35, Math.min(1, (m.opacity || 65) / 100 + 0.27))));
  if (!m || m.mode === 'hidden') {
    root.className = 'hidden';
    return size();
  }
  root.className = '';
  if (m.mode === 'message') {
    const row = document.createElement('div');
    row.className = 'message';
    const icon = document.createElement('div');
    icon.className = 'icon' + (/error|recovery/i.test(m.icon && m.icon.name) ? ' error' : '');
    icon.textContent = m.icon && /No speech/.test(m.icon.name) ? '…' : /recovery/i.test(m.icon && m.icon.name) ? '!' : '🎙';
    icon.title = (m.icon && m.icon.name) || '';
    row.append(icon);
    const d = document.createElement('div');
    d.className = 'detail';
    d.textContent = m.detail || (m.icon && m.icon.name) || '';
    row.append(d);
    row.addEventListener('click', () => dd.send('panel:action', 'icon'));
    root.append(row);
    return size();
  }
  const row = document.createElement('div');
  row.className = 'row';
  for (const b of m.buttons) row.append(button(b));
  root.append(row);
  if (m.extra && m.extra.length) {
    const extra = document.createElement('div');
    extra.className = 'row';
    for (const b of m.extra) extra.append(button(b));
    root.append(extra);
  }
  if (m.status) {
    const s = document.createElement('div');
    s.className = 'status';
    s.textContent = m.status;
    root.append(s);
  }
  size();
}

/** Measures right away rather than in an animation frame: a hidden window gets no animation frames, so the panel would never ask to be shown again. */
function size() {
  const r = root.getBoundingClientRect();
  dd.send('panel:size', Math.ceil(r.width) + 2, Math.ceil(r.height) + 2, root.className !== 'hidden');
}

root.addEventListener('mouseenter', () => dd.send('panel:action', 'touch'));
// Before the click itself: macOS would activate the app on the mouse-down.
root.addEventListener('pointerdown', () => dd.send('panel:action', 'touch'));
dd.on('panel', render);
dd.send('panel:ready');
