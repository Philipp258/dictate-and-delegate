'use strict';
// The call bar: the call's state in short (a level meter in the state's colour and a word or two,
// with the last words heard under it), Send now whenever you can send, and the red hang-up. A tap
// on the state opens the full call in the main window. It gets the call's state ten times a second
// while a call is on (for the meter); it's laid out again only when its text changed.
const $ = (id) => document.getElementById(id);
const WEIGHT = [0.75, 1, 0.6];
let shown = '';

function meter(el, level, hearing) {
  const l = hearing === 'QUIET' ? 0 : Math.max(0, Math.min(1, Number(level) || 0));
  el.classList.toggle('sound', hearing === 'SOUND');
  el.classList.toggle('voice', hearing === 'VOICE');
  [...el.children].forEach((bar, i) => {
    bar.style.height = Math.max(3, Math.round(16 * Math.min(1, l * WEIGHT[i] * 1.4))) + 'px';
  });
}

function render(s) {
  if (!s) return;
  const label = s.shortLabel || s.liveLabel || '';
  const words = s.words || '';
  $('label').textContent = label;
  // Marks at both ends keep the quotes in place while the line is cut at its start.
  $('words').textContent = words ? '‎' + words + '‎' : '';
  $('words').hidden = !words;
  $('state').title = (s.troubleShown ? s.trouble : s.liveLabel || '') + (words ? '. ' + words : '');
  const dot = $('dot');
  dot.className = 'meter';
  const live = String(s.live || '');
  if (s.voiceError || /fail/i.test(s.shortLabel || '')) dot.classList.add('failed');
  else if (s.troubleShown || s.liveOff) dot.classList.add('busy'); // Your words may not be coming through.
  else if (['HEARING', 'WAITING_SEND', 'WRITING'].includes(live)) dot.classList.add('you');
  else if (['PLAYING', 'REPLY_COMING', 'REPLY_WAITING'].includes(live)) dot.classList.add('chief');
  else if (['SENDING', 'WAITING_CHIEF'].includes(live)) dot.classList.add('busy');
  meter(dot, s.meter, s.hearing);
  $('send').hidden = !s.canSend;
  $('end').disabled = !s.canEnd;
  const key = label + '\n' + words + '\n' + !!s.canSend;
  if (key === shown) return;
  shown = key;
  requestAnimationFrame(() => {
    const r = $('bar').getBoundingClientRect();
    dd.send('callbar:size', Math.ceil(r.width) + 2, Math.ceil(r.height) + 2);
  });
}

$('send').addEventListener('click', () => dd.send('callbar:action', 'send'));
$('end').addEventListener('click', () => dd.send('callbar:action', 'end'));
$('state').addEventListener('click', () => dd.send('callbar:action', 'open'));
dd.on('call', render);
dd.send('callbar:ready');
