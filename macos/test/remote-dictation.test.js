'use strict';
// Remote dictation (Mac only): another app starts a dictation for the chief through
// <topic>-remote, and is told each state. The Dictation runs with fakes for the microphone, the
// speech model and bb; the last tests use scripts/fakes/fake_ntfy.py for the topic itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryPrefs } = require('../src/core/store');
const { waitFor } = require('../src/core/util');
const D = require('../src/core/dictation');
const flow = require('../src/core/note-flow');
const R = require('../src/core/remote-dictation');
const ChiefText = require('../src/core/chief-text');
const { startFake } = require('./support/fakes');

const CHIEF = 'thr_chief1';
const T0 = 1_700_000_000_000;

/** Timers that only move when the test says so. */
class FakeTimers {
  constructor(clock) {
    this.clock = clock;
    this.items = new Map();
    this.next = 1;
  }
  setTimeout(f, ms) {
    const id = this.next++;
    this.items.set(id, { at: this.clock.now + ms, f });
    return id;
  }
  clearTimeout(id) {
    this.items.delete(id);
  }
  advance(ms) {
    const until = this.clock.now + ms;
    for (;;) {
      let first = null;
      for (const [id, t] of this.items) if (t.at <= until && (!first || t.at < first[1].at)) first = [id, t];
      if (!first) break;
      this.items.delete(first[0]);
      this.clock.now = first[1].at;
      first[1].f();
    }
    this.clock.now = until;
  }
}

class FakeMic {
  constructor() {
    this.onFrame = null;
    this.refuse = null;
  }
  async start(onFrame) {
    if (this.refuse) throw this.refuse;
    this.onFrame = onFrame;
  }
  async stop() {}
  speak(ms) {
    for (let t = 0; t < ms; t += 20) {
      const frame = Buffer.alloc(D.FRAME_BYTES);
      for (let i = 0; i < D.FRAME_BYTES; i += 2) frame.writeInt16LE(i % 4 ? 3000 : -3000, i);
      this.onFrame(frame);
    }
  }
}

function harness(opt = {}) {
  const clock = { now: T0 };
  const timers = new FakeTimers(clock);
  const prefs = new MemoryPrefs({ model: 'microsoft/mai-transcribe-2', ...(opt.prefs || {}) });
  const notes = new Map();
  const mic = new FakeMic();
  const fx = { chief: true, key: true, chiefError: null, transcript: 'turn the tempo up to one twenty', inCall: false, microphone: 'granted', publishError: null };
  const sent = [];
  const published = [];
  const problems = [];
  const lines = [];
  let n = 0;
  const loadNote = async (id) => (notes.has(id) ? JSON.parse(JSON.stringify(notes.get(id))) : null);
  const d = new D.Dictation({
    prefs,
    microphone: mic,
    clock: () => clock.now,
    timers,
    uuid: () => 'note-' + ++n,
    requestId: () => 'req' + (sent.length + 1),
    hasKey: () => fx.key,
    transcribe: async () => ({ text: fx.transcript, cost: 0.001 }),
    chiefReady: () => fx.chief,
    chiefThread: () => (fx.chief ? { id: CHIEF, link: 'https://x.getbb.app/threads/' + CHIEF } : null),
    sendToChief: async (text, o) => {
      sent.push({ text, ...o });
      if (fx.chiefError) throw fx.chiefError;
      return { files: 0, how: '', refused: 0, failed: [] };
    },
    insert: async () => ({ how: 'inserted' }),
    loadNote,
    saveNote: async (e) => notes.set(e.id, JSON.parse(JSON.stringify(e))),
  });
  const remote = new R.RemoteDictation({
    dictation: d,
    prefs,
    loadNote,
    checks: { inCall: () => fx.inCall, chiefReady: () => fx.chief, hasKey: () => fx.key, microphone: () => fx.microphone },
    publish: async (body) => {
      if (fx.publishError) throw fx.publishError;
      published.push(body);
    },
    problem: (p) => problems.push(p),
    log: (l) => lines.push(l),
    version: '0.5.0',
    clock: () => clock.now,
    timers,
    publishWaits: [10, 20],
  });
  let ids = 0;
  const h = {
    d,
    remote,
    prefs,
    notes,
    mic,
    fx,
    sent,
    published,
    problems,
    lines,
    clock,
    timers,
    /** A request as ntfy delivers it, sent ageMs ago. */
    async request(action, session = 'drum-1', { title = 'Drum Along', body = '', ageMs = 1000, tags = null } = {}) {
      const m = {
        id: 'm' + ++ids,
        time: Math.floor((clock.now - ageMs) / 1000),
        event: 'message',
        topic: 'topic-remote',
        title,
        message: body,
        tags: tags || ['dd-remote', action, 'session-' + session],
      };
      await remote.message(m, 'https://ntfy.example');
      await h.settle();
    },
    async settle() {
      for (let i = 0; i < 3; i++) {
        await remote.idle();
        await d.idle();
        await remote.idle();
      }
    },
    states(session = 'drum-1') {
      return published.filter((b) => b.session === session).map((b) => b.state);
    },
    last(session = 'drum-1') {
      return published.filter((b) => b.session === session).pop();
    },
    note() {
      return [...notes.values()].pop();
    },
    advance(ms) {
      timers.advance(ms);
    },
  };
  return h;
}

// ---------------------------------------------------------------- reading requests

test('onlyTaggedRequestsAreRequestsAndOwnStatesAreIgnored', () => {
  assert.equal(R.parse({ event: 'message', tags: ['talkrouter-paste', 'req-abc'] }), null);
  assert.equal(R.parse({ event: 'keepalive', tags: ['dd-remote', 'dictate-start', 'session-abcd'] }), null);
  assert.equal(R.parse({ event: 'message', tags: ['dd-remote', 'dictate-state', 'session-abcd'] }), null);
  const r = R.parse({ id: 'x1', time: 1700000000, title: ' Drum   Along ', tags: ['dd-remote', 'dictate-start', 'session-Kit_42-a'] });
  assert.deepEqual(r, { id: 'x1', time: 1700000000, title: 'Drum Along', session: 'Kit_42-a', action: 'dictate-start', actions: ['dictate-start'] });
  assert.equal(R.parse({ tags: ['dd-remote', 'dictate-start', 'session-abc'] }).session, '', 'too short');
  assert.equal(R.parse({ tags: ['dd-remote', 'dictate-start', 'session-a.bc'] }).session, '', 'not a session id');
  assert.equal(R.parse({ tags: ['dd-remote', 'dictate-start', 'dictate-stop', 'session-abcd'] }).action, '', 'two actions');
  assert.equal(R.topicFor('talkrouter-x'), 'talkrouter-x-remote');
  assert.equal(R.topicFor(''), '');
});

// ---------------------------------------------------------------- the journey

test('aRemoteStartRecordsForTheChiefAndAStopSendsItWithTheContext', async () => {
  const h = harness();
  await h.request('dictate-start', 'drum-1', { body: 'Drum Along is open on song "Africa", 96 bpm.' });
  assert.equal(h.d.state, D.RECORDING, h.d.detail);
  assert.match(h.d.detail, /started by Drum Along/);
  assert.equal(h.d.session.chief, D.QUEUED, 'for the chief from the start');
  assert.ok(h.prefs.get('sessionIntent', null), 'the intent is saved at once');
  assert.equal(h.prefs.get('sessionRemote', null).by, 'Drum Along');
  assert.deepEqual(h.states(), ['listening']);
  const listening = h.last();
  assert.equal(listening.app, 'mac 0.5.0');
  assert.equal(listening.at, h.clock.now);

  h.mic.speak(1200);
  await h.remote.message({ id: 'stop1', time: Math.floor(h.clock.now / 1000), event: 'message', title: 'Drum Along', message: 'End the dictation and send it.', tags: ['dd-remote', 'dictate-stop', 'session-drum-1'] }, 'https://ntfy.example');
  await h.remote.requests.idle();
  assert.deepEqual(h.states(), ['listening', 'transcribing'], 'transcribing is told as the stop arrives');
  await h.settle();
  assert.deepEqual(h.states(), ['listening', 'transcribing', 'sent']);
  const done = h.last();
  assert.equal(done.text, 'turn the tempo up to one twenty');
  assert.equal(done.request, 'req1');
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, 'turn the tempo up to one twenty\n\n<context from="Drum Along">\nDrum Along is open on song "Africa", 96 bpm.\n</context>');
  const note = h.note();
  assert.equal(note.remote.session, 'drum-1');
  assert.ok(flow.sent(note));
  assert.equal(note.original, 'turn the tempo up to one twenty', 'the note keeps only what was said');
  assert.ok(note.log.some((e) => e.step === 'event' && /started by Drum Along for the chief \(remote dictation, session drum-1\)/.test(e.what)));
  assert.match(flow.details(note, 'x', '', 'app'), /Started by: Drum Along \(remote dictation, session drum-1.*context sent along: Drum Along is open/);
  assert.equal(h.problems.length, 0);
});

test('withoutContextOnlyWhatWasSaidGoes', async () => {
  const h = harness();
  await h.request('dictate-start');
  h.mic.speak(800);
  await h.request('dictate-stop');
  assert.equal(h.sent[0].text, 'turn the tempo up to one twenty');
  assert.equal(D.withContext('said', { by: 'A "b" <c>', context: 'x' }), "said\n\n<context from=\"A 'b' 'c'\">\nx\n</context>");
});

test('theShortcutOnTheMacEndsItTooAndTheAppIsTold', async () => {
  const h = harness();
  await h.request('dictate-start');
  h.mic.speak(800);
  await h.d.toggle(); // the shortcut
  await h.settle();
  assert.deepEqual(h.states(), ['listening', 'transcribing', 'sent']);
});

test('aNormalDictationTellsNothing', async () => {
  const h = harness();
  await h.d.start();
  h.mic.speak(800);
  await h.d.stop();
  await h.settle();
  assert.equal(h.published.length, 0);
  assert.equal(h.note().remote, undefined);
});

// ---------------------------------------------------------------- cancel

test('aRemoteCancelThrowsItAwayAndSendsNothing', async () => {
  const h = harness();
  await h.request('dictate-start');
  h.mic.speak(800);
  await h.request('dictate-cancel');
  assert.deepEqual(h.states(), ['listening', 'cancelled']);
  assert.equal(h.d.state, D.READY);
  assert.equal(h.sent.length, 0);
  assert.equal(h.prefs.get('sessionRemote', null), null);
});

test('closingThePanelOnTheMacIsToldAsCancelled', async () => {
  const h = harness();
  await h.request('dictate-start');
  h.mic.speak(800);
  await h.d.close(); // ✕
  await h.settle();
  assert.deepEqual(h.states(), ['listening', 'cancelled']);
});

test('aCancelAfterTheStopIsTooLateAndTellsWhereItIs', async () => {
  const h = harness();
  await h.request('dictate-start');
  h.mic.speak(800);
  await h.request('dictate-stop');
  await h.request('dictate-cancel');
  assert.deepEqual(h.states(), ['listening', 'transcribing', 'sent', 'sent']);
  assert.equal(h.sent.length, 1);
});

// ---------------------------------------------------------------- it can't start

test('whatStopsAStartIsSaidInPlainWords', async () => {
  const cases = [
    [(h) => h.prefs.set(R.PREF, false), /switched off on the Mac/],
    [(h) => (h.fx.chief = false), /not signed in to bb, or has no chief of staff/],
    [(h) => (h.fx.key = false), /no OpenRouter key/],
    [(h) => (h.fx.inCall = true), /hands-free call is on/],
    [(h) => (h.fx.microphone = 'denied'), /may not use the microphone/],
    [(h) => (h.fx.microphone = 'not-determined'), /hasn't been allowed the microphone yet/],
  ];
  for (const [set, why] of cases) {
    const h = harness();
    set(h);
    await h.request('dictate-start');
    assert.deepEqual(h.states(), ['failed'], String(why));
    assert.match(h.last().error, why);
    assert.equal(h.d.state, D.READY);
  }
});

test('aStartWhileRecordingFailsAndLeavesTheRecordingAlone', async () => {
  const h = harness();
  await h.d.start();
  await h.request('dictate-start');
  assert.deepEqual(h.states(), ['failed']);
  assert.match(h.last().error, /already recording/);
  assert.equal(h.d.state, D.RECORDING);
  assert.equal(h.prefs.get('sessionRemote', null), null);
});

test('aSecondRemoteSessionWaitsItsTurnButTheSameStartIsJustAnsweredAgain', async () => {
  const h = harness();
  await h.request('dictate-start');
  await h.request('dictate-start', 'other-2');
  assert.deepEqual(h.states('other-2'), ['failed']);
  assert.match(h.last('other-2').error, /Another remote dictation \(from Drum Along\)/);
  await h.request('dictate-start');
  assert.deepEqual(h.states(), ['listening', 'listening']);
  assert.equal(h.d.state, D.RECORDING);
});

test('aMicrophoneThatWontStartIsTheFailure', async () => {
  const h = harness();
  h.mic.refuse = new Error('No microphone found.');
  await h.request('dictate-start');
  assert.deepEqual(h.states(), ['failed']);
  assert.match(h.last().error, /Recording didn't start: No microphone found\./);
  // The next one can start.
  h.mic.refuse = null;
  await h.request('dictate-start', 'drum-2');
  assert.deepEqual(h.states('drum-2'), ['listening']);
});

// ---------------------------------------------------------------- old, wrong and unknown requests

test('anOldRequestExpiresAndDoesNothing', async () => {
  const h = harness();
  await h.request('dictate-start', 'drum-1', { ageMs: 25_000 });
  assert.deepEqual(h.states(), ['expired']);
  assert.match(h.last().error, /25 s old/);
  assert.equal(h.d.state, D.READY);
  // 19 s is still fine.
  await h.request('dictate-start', 'drum-2', { ageMs: 19_000 });
  assert.deepEqual(h.states('drum-2'), ['listening']);
  // An old stop doesn't stop it.
  await h.request('dictate-stop', 'drum-2', { ageMs: 60_000 });
  assert.deepEqual(h.states('drum-2'), ['listening', 'expired']);
  assert.equal(h.d.state, D.RECORDING);
});

test('aRequestWithoutOneActionIsAnsweredWithWhy', async () => {
  const h = harness();
  await h.request('', 'drum-1', { tags: ['dd-remote', 'session-drum-1'] });
  assert.deepEqual(h.states(), ['failed']);
  assert.match(h.last().error, /exactly one of dictate-start, dictate-stop or dictate-cancel/);
});

test('aRequestWithoutASessionCantBeAnsweredSoItsANotification', async () => {
  const h = harness();
  await h.request('', '', { tags: ['dd-remote', 'dictate-start'] });
  assert.equal(h.published.length, 0);
  assert.equal(h.problems.length, 1);
  assert.match(h.problems[0].text, /no session-<id> tag/);
  assert.equal(h.d.state, D.READY);
});

test('aStopForAnUnknownSessionSaysSoAndALateOneRepeatsHowItEnded', async () => {
  const h = harness();
  await h.request('dictate-stop', 'nobody-1');
  assert.deepEqual(h.states('nobody-1'), ['failed']);
  assert.match(h.last('nobody-1').error, /No dictation with this session/);
  await h.request('dictate-start');
  await h.request('dictate-cancel');
  await h.request('dictate-stop');
  assert.deepEqual(h.states(), ['listening', 'cancelled', 'cancelled']);
});

test('ownStatesOnTheTopicAreIgnored', async () => {
  const h = harness();
  await h.remote.message({ id: 's1', time: Math.floor(h.clock.now / 1000), event: 'message', tags: ['dd-remote', 'dictate-state', 'session-drum-1'], message: '{"state":"listening"}' }, 'https://ntfy.example');
  await h.settle();
  assert.equal(h.published.length, 0);
  assert.equal(h.d.state, D.READY);
});

// ---------------------------------------------------------------- no stop

test('withoutAStopWithinTwoMinutesItStopsAndTheNoteWaitsForYou', async () => {
  const h = harness();
  await h.request('dictate-start');
  h.mic.speak(1000);
  h.advance(R.STOP_WITHIN_MS - 1000);
  await h.settle();
  assert.equal(h.d.state, D.RECORDING);
  h.advance(1000);
  await h.settle();
  assert.deepEqual(h.states(), ['listening', 'failed']);
  assert.match(h.last().error, /No stop came within 2 minutes.*kept there, not sent.*Needs you/);
  await waitFor(() => h.d.state === D.COPIED, 2000, 'written down');
  await h.settle();
  assert.equal(h.sent.length, 0, 'not sent by itself');
  const note = h.note();
  assert.equal(note.text, 'turn the tempo up to one twenty');
  assert.equal(flow.delivery(note, h.clock.now), flow.Delivery.NEEDS_OK);
  assert.match(flow.status(note, h.clock.now, false, true, 'your chief of staff').line, /no stop came from Drum Along within 2 minutes, so it waits for you/);
  assert.equal(h.d.session.chief, D.FAILED);
  // A stop now only repeats how it ended.
  await h.request('dictate-stop');
  assert.deepEqual(h.states(), ['listening', 'failed', 'failed']);
  // Send on the note sends it, with the context.
  assert.equal(await h.d.sendNote(note.id, 'USER'), null);
  assert.equal(h.sent.length, 1);
});

// ---------------------------------------------------------------- failures on the way

test('aSendThatFailsIsToldWithTheRealErrorAndALaterSuccessToo', async () => {
  const h = harness();
  h.fx.chiefError = new Error('bb answered HTTP 502 bad gateway');
  await h.request('dictate-start');
  h.mic.speak(800);
  await h.request('dictate-stop');
  assert.deepEqual(h.states(), ['listening', 'transcribing', 'failed']);
  assert.match(h.last().error, /Not sent to your chief of staff: bb answered HTTP 502 bad gateway.*tried again by itself/);
  assert.equal(h.last().request, 'req1');
  // The outbox's next try gets it there: the app hears "sent" after all.
  h.fx.chiefError = null;
  h.advance(15_000);
  assert.equal(await h.d.sendNote(h.note().id, 'NOW'), null);
  await h.settle();
  assert.deepEqual(h.states(), ['listening', 'transcribing', 'failed', 'sent']);
  assert.equal(h.last().request, 'req1');
});

test('aTranscriptionThatFailsIsToldWithWhy', async () => {
  const h = harness();
  h.d.transcribeChunk = async () => {
    throw new Error('OpenRouter answered HTTP 401: No auth credentials found');
  };
  await h.request('dictate-start');
  h.mic.speak(800);
  await h.request('dictate-stop');
  assert.deepEqual(h.states(), ['listening', 'transcribing', 'failed']);
  assert.match(h.last().error, /HTTP 401: No auth credentials found/);
});

test('noSpeechIsAFailure', async () => {
  const h = harness();
  await h.request('dictate-start');
  await h.request('dictate-stop'); // nothing recorded
  assert.deepEqual(h.states(), ['listening', 'transcribing', 'failed']);
  assert.match(h.last().error, /No audio captured/);
});

test('takingBackTheChiefOnThePanelIsToldAsNotSent', async () => {
  const h = harness();
  await h.request('dictate-start');
  h.d.tapChief(); // taken back while recording
  h.mic.speak(800);
  await h.request('dictate-stop');
  assert.deepEqual(h.states(), ['listening', 'transcribing', 'failed']);
  assert.match(h.last().error, /taken back on the Mac/);
  assert.equal(h.sent.length, 0);
});

test('aStateThatCantBePublishedIsTriedAgainThenANotification', async () => {
  const h = harness();
  h.fx.publishError = new Error('ntfy answered HTTP 429');
  await h.remote.message({ id: 'p1', time: Math.floor(h.clock.now / 1000), event: 'message', title: 'Drum Along', message: '', tags: ['dd-remote', 'dictate-start', 'session-drum-1'] }, 'https://ntfy.example');
  await h.remote.requests.idle();
  // The pauses between tries run on the test's timers.
  await waitFor(async () => {
    h.advance(10);
    await new Promise((r) => setImmediate(r));
    return h.problems.length > 0;
  }, 3000, 'the notification');
  await h.remote.idle();
  assert.equal(h.published.length, 0);
  assert.equal(h.problems.length, 1);
  assert.match(h.problems[0].text, /"listening" didn't reach ntfy \(ntfy answered HTTP 429\)/);
  assert.equal(h.lines.filter((l) => /not published \(try \d\)/.test(l)).length, 3);
  // The dictation itself goes on.
  assert.equal(h.d.state, D.RECORDING);
});

test('aLongContextIsShortenedAndSaysSo', async () => {
  const h = harness();
  await h.request('dictate-start', 'drum-1', { body: 'x'.repeat(R.CONTEXT_MAX + 50) });
  assert.match(h.prefs.get('sessionRemote', null).context, /\[… shortened by Dictate & Delegate\]$/);
  assert.ok(h.lines.some((l) => /only the first 4000 go along/.test(l)));
});

// ---------------------------------------------------------------- against a fake ntfy

test('overNtfyStatesGoToTheRemoteTopicTaggedWithMinPriority', async (t) => {
  const ntfy = await startFake('fake_ntfy.py');
  t.after(() => ntfy.stop());
  const topic = 'talkrouter-TestTopic123-remote';
  await R.publishState(fetch, ntfy.url, topic, { session: 'drum-1', state: 'listening', app: 'mac 0.5.0', at: 1 });
  const log = (await ntfy.get('/test/requests')).requests;
  assert.equal(log.length, 1);
  assert.equal(log[0].topic, topic);
  assert.deepEqual(log[0].tags, ['dd-remote', 'dictate-state', 'session-drum-1']);
  assert.equal(log[0].priority, 1);
  assert.deepEqual(JSON.parse(log[0].message), { session: 'drum-1', state: 'listening', app: 'mac 0.5.0', at: 1 });
  await assert.rejects(R.publishState(fetch, ntfy.url, '', { session: 'x', state: 'failed' }), /HTTP 404/);
});

test('theSubscriptionReadsRequestsFromTheRemoteTopicAndAnswersThere', async (t) => {
  const ntfy = await startFake('fake_ntfy.py');
  t.after(() => ntfy.stop());
  const h = harness();
  const main = 'talkrouter-MainTopic456';
  h.remote.endpoint = () => ({ server: ntfy.url, topic: main });
  h.remote.publishOne = (body) => R.publishState(fetch, ntfy.url, R.topicFor(main), body);
  h.remote.fetch = fetch;
  h.remote.refresh();
  t.after(() => h.remote.stop());
  await waitFor(() => h.remote.connection === 'open', 5000, 'connected');
  // The real clock now, for the request's age.
  h.clock.now = Date.now();
  const post = (tags, body = '') => fetch(ntfy.url + '/' + main + '-remote', { method: 'POST', headers: { Title: 'Drum Along', Tags: tags }, body });
  await post('dd-remote,dictate-start,session-live-1', 'context here');
  await waitFor(() => h.d.state === D.RECORDING, 5000, 'recording');
  await waitFor(async () => (await ntfy.get('/test/requests')).requests.some((r) => r.method === 'publish' && r.tags.includes('dictate-state')), 5000, 'the state');
  const states = (await ntfy.get('/test/requests')).requests.filter((r) => r.method === 'publish' && r.tags.includes('dictate-state'));
  assert.equal(states[0].topic, main + '-remote');
  assert.equal(JSON.parse(states[0].message).state, 'listening');
  // Nothing on the main topic (the phone shows everything there).
  assert.ok(!(await ntfy.get('/test/requests')).requests.some((r) => r.method === 'publish' && r.topic === main));
  // Its own state didn't start or stop anything.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.d.state, D.RECORDING);
  assert.equal(h.remote.status().connection, 'open');
  assert.match(h.remote.status().last, /session live-1: listening/);
  void ChiefText;
});
