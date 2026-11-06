'use strict';
// What the floating panel shows, from the dictation's snapshot (FloatingPanel.render's logic
// without its views), so the renderer only draws it. Icon buttons are named for VoiceOver; the name
// is also the tooltip.
//
// While recording: ● 00:12 ■, ✨, 🧑‍💼, 📞, 📎, ✕; while transcribing: … ✨ 🧑‍💼; afterwards:
// 📥 ✨ 🧑‍💼 ✕, and 🧑‍💼 📥 (Insert from chief) on a second row once the chief sent text. The ✕ is
// always last, on the outer edge where close and cancel usually are. Ready, error and "no speech"
// show a small icon with its line instead (mode "message"), or nothing (mode "hidden").

const { tr } = require('./util');
const D = require('./dictation');

/** The small icon's name per state (OverlayIcon). */
function iconName(state) {
  switch (state) {
    case D.RECORDING:
      return tr('Stop recording');
    case D.UPLOADING:
    case D.STOPPING:
      return tr('Transcribing');
    case D.EMPTY:
      return tr('No speech recognized');
    case D.ERROR:
      return tr('Open recording recovery');
    case D.COPIED:
      return tr('Ready to insert');
    default:
      return tr('Start recording');
  }
}

const REFINE_LABEL = { queued: '✨ ✓', running: '✨ …', done: '✨ 📥', failed: '✨ ↻' };
const CHIEF_LABEL = { queued: '🧑‍💼 ✓', running: '🧑‍💼 …', done: '🧑‍💼 ↗', failed: '🧑‍💼 ↻' };

function refineName(state) {
  switch (state) {
    case D.QUEUED:
      return tr('✨ Refine ✓');
    case D.RUNNING:
      return tr('✨ Refining…');
    case D.DONE:
      return tr('Insert refined');
    case D.FAILED:
      return tr('✨ Refine again');
    default:
      return tr('✨ Refine');
  }
}

function chiefName(state) {
  switch (state) {
    case D.QUEUED:
      return tr('🧑‍💼 Chief ✓');
    case D.RUNNING:
      return tr('🧑‍💼 Sending…');
    case D.DONE:
      return tr('Open chat ↗');
    case D.FAILED:
      return tr('🧑‍💼 Send again');
    default:
      return tr('🧑‍💼 Chief');
  }
}

/**
 * snapshot: Dictation.snapshot(). Returns
 * { mode: 'hidden'|'message'|'recording'|'processing'|'result', opacity,
 *   icon: { state, name } (message mode), detail (the state's line, e.g. for message mode),
 *   timer: { elapsed: '00:12', label: '● 00:12  ■' } | null,
 *   buttons: [{ id, label, name, enabled, fill: 'pill'|'teal'|'red', ring: null|'teal', state? }],
 *   extra: the second row ([] or Insert from chief), status: the status line ('' = none) }.
 * Button ids: stop, refine, chief, call, attach, insert, close, insertFromChief; the action each
 * stands for is the Dictation method stop(), tapRefine(), tapChief(), call(), attach(), insert(),
 * close(), insertFromChief().
 */
function panelModel(snapshot) {
  const s = snapshot || {};
  const session = s.session || {};
  const opacity = typeof s.opacity === 'number' ? s.opacity : 65;
  const hidden = { mode: 'hidden', opacity, icon: null, detail: '', timer: null, buttons: [], extra: [], status: '' };
  if (!s.visible) return hidden;
  const recording = s.state === D.RECORDING;
  const working = s.state === D.STOPPING || s.state === D.UPLOADING;
  const ready = s.state === D.COPIED;
  if (!recording && !working && !ready)
    return {
      ...hidden,
      mode: 'message',
      icon: { state: s.state, name: iconName(s.state) },
      detail: s.detail || '',
    };

  const refine = session.refine || D.IDLE;
  const chief = session.chief || D.IDLE;
  const chiefBusy = chief === D.QUEUED || chief === D.RUNNING;
  const time = D.elapsed(s.elapsedMs || 0);

  const stop = { id: 'stop', label: '● ' + time + '  ■', name: tr('Stop recording'), enabled: true, fill: 'red', ring: null };
  const refineButton = {
    id: 'refine',
    label: REFINE_LABEL[refine] || '✨',
    name: refineName(refine),
    enabled: true,
    fill: refine === D.DONE ? 'teal' : 'pill',
    ring: refine === D.QUEUED || refine === D.RUNNING ? 'teal' : null,
    state: refine,
  };
  const chiefButton = {
    id: 'chief',
    label: CHIEF_LABEL[chief] || '🧑‍💼',
    name: chiefName(chief),
    enabled: true,
    fill: 'pill',
    ring: chiefBusy ? 'teal' : null,
    state: chief,
  };
  const call = { id: 'call', label: '📞', name: tr('Hands-free call with your chief'), enabled: true, fill: 'pill', ring: null };
  const attach = {
    id: 'attach',
    label: s.attached > 0 ? '📎 ' + s.attached : '📎',
    name: tr('Add context to this dictation'),
    enabled: true,
    fill: 'pill',
    ring: null,
  };
  const insert = {
    id: 'insert',
    label: working ? '…' : '📥',
    name: working ? tr('Transcribing…') : tr('Insert'),
    enabled: ready,
    fill: ready ? 'teal' : 'pill',
    ring: null,
  };
  const close = {
    id: 'close',
    label: '✕',
    name: recording ? tr('Cancel: nothing is transcribed or sent') : tr('Close'),
    enabled: true,
    fill: 'pill',
    ring: null,
  };

  const buttons = [];
  if (recording) {
    buttons.push(stop, refineButton);
    if (s.chiefAvailable) buttons.push(chiefButton, call);
    buttons.push(attach, close);
  } else {
    buttons.push(insert, refineButton);
    if (s.chiefAvailable) buttons.push(chiefButton);
    if (!working) buttons.push(close);
  }
  const extra = session.reply
    ? [{ id: 'insertFromChief', label: '🧑‍💼 📥', name: tr('Insert from chief'), enabled: true, fill: 'teal', ring: null }]
    : [];
  return {
    mode: recording ? 'recording' : working ? 'processing' : 'result',
    opacity,
    icon: null,
    detail: s.detail || '',
    timer: recording ? { elapsed: time, label: stop.label } : null,
    buttons,
    extra,
    status: session.message || '',
  };
}

module.exports = { panelModel, iconName };
