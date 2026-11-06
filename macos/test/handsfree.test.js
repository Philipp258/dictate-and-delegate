'use strict';
// HandsFreeTest.java, part 1: keywords, the segmenter, the floor, talkers, the call's end.
// (Part 2: handsfree-turn.test.js; part 3: handsfree-live.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const HandsFree = require('../src/core/handsfree');
const { HandsFreeSession } = require('../src/core/handsfree-session');
const { sleep } = require('../src/core/util');
const {
  latch,
  frame,
  feed,
  clatter,
  until,
  Fake,
  FakeLive,
  reasons,
  count,
  sendTurn,
  hear,
} = require('./support/handsfree-fakes');

const { State, Floor, Phase, Live } = HandsFreeSession;
const send = HandsFree.list(HandsFree.DEFAULT_SEND);
const end = HandsFree.list(HandsFree.DEFAULT_END);

test('wordListsComeFromTheSetting', () => {
  // English, one word per action, by default: "over", which Jev confirms (see below).
  assert.deepEqual(send, ['over']);
  assert.deepEqual(end, ['end the call']);
  assert.deepEqual(HandsFree.list(' a ,, b c\n ,'), ['a', 'b c']);
  assert.deepEqual(HandsFree.list(''), []);
});

test('theEndOfTurnPauseIsFiveSecondsAndALongSilenceTwoMinutesBothConfigurable', () => {
  const prefs = (values) => ({ get: (k, d) => (k in values ? values[k] : d) });
  // A pause only asks Jev whether you're done: long enough to think (1.8 s cut Philipp off).
  assert.equal(HandsFree.DEFAULT_PAUSE_MS, 5000);
  assert.equal(HandsFree.pauseMs(prefs({})), 5000);
  assert.equal(HandsFree.pauseMs(prefs({ hfEndOfTurnPauseMs: 3000 })), 3000);
  assert.equal(HandsFree.pauseMs(prefs({ hfTurnPauseMs: 1800 })), 5000, 'the old 1.8 s setting no longer applies');
  assert.equal(HandsFree.silenceEndMs(prefs({})), 120_000);
  assert.equal(HandsFree.silenceEndMs(prefs({ hfSilenceEndMs: 300_000 })), 300_000);
  assert.equal(HandsFree.silenceEndMs(prefs({ hfSilenceEndMs: 1000 })), 30_000);
});

test('aSendWordCountsOnlyAtTheEnd', () => {
  assert.equal(HandsFree.endsWith('Book a table for Friday. Over.', send), 'Book a table for Friday.');
  assert.equal(HandsFree.endsWith('book a table, over!', send), 'book a table');
  assert.equal(HandsFree.endsWith('Buch einen Tisch. Schick ab.', HandsFree.list('over, schick ab')), 'Buch einen Tisch.');
  assert.equal(HandsFree.endsWith('Over.', send), '');
  assert.equal(HandsFree.endings('…of those options. Over. Over.', send), 2);
  assert.equal(HandsFree.endings('…of those options. Over. Over. Over.', send), 3);
  assert.equal(HandsFree.endings('Over over, over', send), 3);
  assert.equal(HandsFree.endings('…since yesterday over. Well, over.', send), 1);
  assert.equal(HandsFree.endings('Over.', send), 1);
  assert.equal(HandsFree.endings('Over the weekend I want to rest.', send), 0);
  // Not at the end, or only part of a word: keep listening.
  assert.equal(HandsFree.endsWith('Over the weekend I want to rest.', send), null);
  assert.equal(HandsFree.endsWith('We went to Hanover', send), null);
  assert.equal(HandsFree.endsWith('I\'ll hand it over to her soon', send), null);
  // "over" ending a sentence matches too: whether it was the send word is Jev's to say.
  assert.equal(
    HandsFree.endsWith('Let someone live there for 3 months until the period is over.', send),
    'Let someone live there for 3 months until the period is',
  );
  // Apostrophes, accents and case don't matter.
  assert.equal(HandsFree.endsWith('Thanks. End the call.', end), 'Thanks.');
  assert.equal(HandsFree.endsWith('Danke, das war\'s!', HandsFree.list('das wars')), 'Danke');
  // "That's all" alone no longer ends hands-free.
  assert.equal(HandsFree.endsWith('That\'s all.', end), null);
  assert.equal(HandsFree.endsWith('', send), null);
});

// ------------------------------------------------------------------ voice activity

test('speechBetweenPausesBecomesOneStretchWithoutTheSilence', () => {
  const out = [];
  const s = new HandsFree.Segmenter(3000, (pcm) => out.push(pcm));
  feed(s, 50, 2000); // Room noise.
  feed(s, 6000, 1000); // Speech.
  feed(s, 50, 1500); // A short pause: still the same stretch.
  assert.equal(out.length, 0);
  feed(s, 6000, 1000);
  feed(s, 50, 3100); // The pause that ends it.
  assert.equal(out.length, 1);
  // 2 s of speech, the 1.5 s pause inside, and 0.3 s before and after; not the 3 s pause.
  const seconds = out[0].length / HandsFree.BYTES_PER_SECOND;
  assert.ok(Math.abs(seconds - 4.1) <= 0.1, String(seconds));
  assert.ok(s.quietMs() >= 3000);
});

test('aClickIsNotSpeechAndFlushEndsAStretch', () => {
  const out = [];
  const s = new HandsFree.Segmenter(3000, (pcm) => out.push(pcm));
  feed(s, 50, 1000);
  feed(s, 9000, 20); // One loud frame.
  feed(s, 50, 4000);
  assert.equal(out.length, 0);
  feed(s, 6000, 600);
  assert.ok(s.speaking());
  s.flush();
  assert.equal(out.length, 1);
  assert.ok(!s.speaking());
});

// ------------------------------------------------------------------ the session

test('partsAddUpAndGoOnTheSendWord', async () => {
  // Each check writes down only the part that's new; the turn is the parts' texts joined.
  const f = new Fake('I was thinking about the trip.', 'Let\'s book the hotel. Over.');
  await f.talk();
  await until(() => f.session.pending() === 'I was thinking about the trip.');
  assert.equal(f.session.floor(), Floor.YOU);
  await f.talk();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'I was thinking about the trip. Let\'s book the hotel.');
  assert.equal(f.session.pending(), '');
  assert.ok(f.session.ours('r1'));
  assert.ok(!f.session.ours('other'));
  await until(() => f.session.floor() === Floor.OPEN);
});

test('theEndPhraseSendsWhatCameBeforeAndEnds', async () => {
  const f = new Fake('Cancel the meeting. End the call.');
  await f.talk();
  await until(() => f.session.state() === State.ENDED);
  assert.deepEqual(f.sent, ['Cancel the meeting.']);
});

test('chiefFirstOnAnOpenFloorIsReadAndItsEchoIsNeverYourTurn', async () => {
  const f = new Fake('Next question. Over.');
  f.quiet(1000);
  f.session.reply('r1', 'First answer from what I know.');
  f.session.reply('r1', 'The final answer.');
  await until(() => f.session.floor() === Floor.CHIEF);
  assert.deepEqual(f.spoken, ['First answer from what I know.']);
  // What's left of the voice in the microphone after echo cancellation: nothing is captured.
  for (let i = 0; i < 100; i++) f.session.frame(frame(i % 5 === 0 ? 750 : 350));
  f.quiet(1200);
  await sleep(150);
  assert.equal(f.transcripts.length, 1);
  assert.ok(!f.stopped);
  f.done(); // The first finished; the floor opens and the second, held, is read.
  await until(() => f.spoken.length === 2);
  assert.deepEqual(f.spoken, ['First answer from what I know.', 'The final answer.']);
  f.done();
  assert.equal(f.session.floor(), Floor.OPEN);
  // Its tail right after reading is dropped too.
  await f.talk();
  assert.equal(f.transcripts.length, 1);
  // After the tail, you're heard again, and nothing of the reply is in your turn.
  f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
  await f.talk();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Next question.');
});

test('aReplyPlaysAtOnceInSilenceAndRightAfterYourMessageWent', async () => {
  const f = new Fake('Is the table booked? Over.');
  f.quiet(1000);
  // Silence: it plays as soon as its voice is ready.
  f.session.reply('r0', 'Good morning.');
  await until(() => f.spoken.length === 1);
  assert.ok(!reasons(f).includes('Reply waits'), reasons(f));
  f.done();
  f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
  await sendTurn(f, 1);
  await until(() => f.session.yourTurn(f.now.get()) == null);
  // Right after your message went: silence again, no pause needed.
  f.session.reply('r1', 'Yes, for eight.');
  await until(() => f.spoken.length === 2);
});

test('aReplyArrivingWhileYourMessageIsWrittenDownIsDroppedOneForItWaitsUntilItsSent', async () => {
  const f = new Fake('Is the table booked? Over.');
  const slow = latch();
  f.slow = slow;
  const timeout = HandsFreeSession.writeTimeoutMs;
  HandsFreeSession.writeTimeoutMs = 60_000;
  try {
    f.quiet(1000);
    await f.talk();
    // From before your turn: it waits, and is dropped when your message goes; never played.
    f.session.reply('r0', 'Here\'s what I found.');
    assert.equal(f.session.held(), 1);
    f.quiet(3000);
    f.session.tick();
    assert.equal(f.spoken.length, 0);
    f.slowBb = latch();
    slow.countDown(); // Written down: now it's being sent.
    await until(() => f.session.phase() === Phase.SENDING);
    f.session.reply('r1', 'The table is booked.'); // An answer to the message on its way.
    await until(() => reasons(f).includes('Reply waits: your message is being sent'));
    f.session.tick();
    assert.equal(f.spoken.length, 0);
    f.slowBb.countDown();
    await until(() => f.sent.length === 1);
    assert.equal(f.sent[0], 'Is the table booked?\n\n[not played: "Here\'s what I found."]');
    await until(() => f.spoken.length === 1);
    assert.deepEqual(f.spoken, ['The table is booked.']);
  } finally {
    slow.countDown();
    HandsFreeSession.writeTimeoutMs = timeout;
  }
});

test('aReplyToAnOlderMessageIsntPlayedAndTheNextMessageSaysSo', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.', 'Anything else? Over.');
  f.quiet(1000);
  await sendTurn(f, 1);
  await sendTurn(f, 2);
  // The answer to the first message comes after the second went: it no longer fits.
  f.session.reply('r1', 'Yes, it\'s booked for eight.');
  f.session.reply('r2', 'The train leaves at nine.');
  await hear(f, 1);
  assert.deepEqual(f.spoken, ['The train leaves at nine.']);
  const log = f.logText();
  assert.ok(log.includes('chief message r1 dropped unplayed (27 characters): it answers an older message than your latest'), log);
  assert.ok(reasons(f).includes('A reply wasn\'t played: you\'ve said more since. Your next message tells the chief'), reasons(f));
  await sendTurn(f, 3);
  assert.equal(f.sent[2], 'Anything else?\n\n[not played: "Yes, it\'s booked for eight."]');
  // Noted once.
  f.session.end();
  assert.equal(f.session.endNote(), '');
});

test('whenYouTalkThePlayingReplyPausesAndYourMessageDropsItAndEveryQueuedOne', async () => {
  // Philipp's design, 2 November 2026: "no queuing, just always canceled"; at 22:46: dropped once
  // your message goes, not by talking alone.
  const f = new Fake('Is the table booked? Over.', 'Wait, and the train? Over.');
  f.quiet(1000);
  await sendTurn(f, 1);
  f.session.reply('r1', 'One moment, I\'m checking the booking for you now.');
  await until(() => f.spoken.length === 1);
  f.session.reply('r1', 'It\'s booked for eight.');
  f.session.reply(f.session.lastRequest(), 'The window table is free.', 0, true);
  assert.equal(f.session.held(), 2, 'queued behind the one playing');
  f.heardChars = 'One moment, I\'m checking'.length;
  for (let i = 0; i < 40 && f.session.state() === State.READING; i++) f.session.frame(frame(8000)); // You talk over it.
  assert.equal(f.session.state(), State.LISTENING, 'the playing reply stopped');
  assert.equal(f.session.held(), 3, 'its rest first, then the queued ones: waiting');
  for (let i = 0; i < 20; i++) f.session.frame(frame(8000));
  f.quiet(1200);
  await until(() => f.sent.length === 2);
  assert.ok(reasons(f).includes('3 replies weren\'t played: your new message went. It tells the chief'), reasons(f));
  assert.equal(
    f.sent[1],
    'Wait, and the train?\n\n[heard up to: "One moment, I\'m checking"] [not played from there: "the booking for you now."]' +
      '\n\n[not played: "It\'s booked for eight."]\n[not played: "The window table is free."]',
  );
  f.session.tick();
  await sleep(150);
  assert.equal(f.spoken.length, 1, 'nothing of before your turn plays afterwards');
});

test('aReplyForAnOldTurnArrivingWhileYouTalkIsNeverPlayedOnlyTheNewTurnsReplyPlays', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.');
  f.quiet(1000);
  await sendTurn(f, 1);
  f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
  f.speak(); // Your next turn starts; the answer to the first comes meanwhile.
  f.session.reply('r1', 'Yes, it\'s booked for eight.');
  assert.equal(f.session.held(), 1, 'it waits while you talk');
  f.quiet(1200);
  await until(() => f.sent.length === 2);
  assert.equal(f.sent[1], 'And the train?\n\n[not played: "Yes, it\'s booked for eight."]');
  assert.ok(f.logText().includes('chief message r1 dropped unplayed (27 characters): your new message went'), f.logText());
  // Late, after your turn ended: still the old turn's, never played.
  f.session.reply('r1', 'The window table, as you asked.');
  f.session.tick();
  await sleep(150);
  assert.equal(f.spoken.length, 0);
  // The new turn's reply plays.
  f.session.reply('r2', 'The train leaves at nine.');
  await until(() => f.spoken.length === 1);
  assert.deepEqual(f.spoken, ['The train leaves at nine.']);
});

test('aCallEndingWithDroppedRepliesNotYetNotedSaysSoAtItsEnd', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.');
  f.quiet(1000);
  await sendTurn(f, 1);
  await sendTurn(f, 2);
  f.session.reply('r1', 'Yes, it\'s booked for eight.');
  f.session.reply('r1', 'The window table, as you asked.');
  f.session.end();
  assert.equal(f.session.endNote(), '\n\n[not played: "Yes, it\'s booked for eight."]\n[not played: "The window table, as you asked."]');
  assert.equal(f.spoken.length, 0);
});

test('aReplyArrivingWhileYourNewMessageIsOnItsWayIsDroppedButOneForItPlaysOnceItsDelivered', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.');
  f.quiet(1000);
  await sendTurn(f, 1);
  f.slowBb = latch();
  await f.talk();
  await until(() => f.session.phase() === Phase.SENDING);
  f.session.reply('r1', 'Yes, it\'s booked for eight.'); // Tagged: an answer to the first message.
  // An update without a request, while your message is on its way: it answers that one.
  f.session.reply(f.session.lastRequest(), 'Let me check the trains.', 0, true);
  assert.equal(f.session.held(), 1);
  await sleep(100);
  assert.equal(f.spoken.length, 0);
  f.slowBb.countDown();
  await until(() => f.sent.length === 2);
  await until(() => f.spoken.length === 1);
  assert.deepEqual(f.spoken, ['Let me check the trains.']);
  assert.ok(f.logText().includes('chief message r1 dropped unplayed (27 characters): it answers an older message than your latest'));
});

test('aReplyToTheMessageOnItsWayIsOursAndPlaysOnceItsDelivered', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.');
  f.quiet(1000);
  // The first message of the call: the talker answers before bb is done with the chief.
  f.slowBb = latch();
  await f.talk();
  await until(() => f.session.phase() === Phase.SENDING);
  assert.ok(f.session.ours('r1'), 'ours while on its way');
  assert.equal(f.session.lastRequest(), 'r1', 'an update without a request answers it');
  f.session.reply('r1', 'Let me check.');
  f.slowBb.countDown();
  await until(() => f.sent.length === 1);
  await until(() => f.spoken.length === 1);
  f.done();
  f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
  // The second: a tagged answer to it before it's delivered isn't outdated either.
  f.slowBb = latch();
  await f.talk();
  await until(() => f.session.phase() === Phase.SENDING);
  f.session.reply('r2', 'Checking the trains.');
  f.slowBb.countDown();
  await until(() => f.sent.length === 2);
  await until(() => f.spoken.length === 2);
  assert.deepEqual(f.spoken, ['Let me check.', 'Checking the trains.']);
  assert.ok(!f.logText().includes('dropped'));
});

test('notesOfAMessageTheChiefMissedGoAgainButNotWhenOnlyTheTalkerMissedIt', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.', 'Anything else? Over.', 'Thanks. Over.');
  f.quiet(1000);
  await sendTurn(f, 1);
  await sendTurn(f, 2);
  f.session.reply('r1', 'Yes, it\'s booked for eight.');
  f.missedBy = 'chief';
  await sendTurn(f, 3);
  const note = '[not played: "Yes, it\'s booked for eight."]';
  assert.ok(f.sent[2].endsWith(note), f.sent[2]);
  // The chief didn't get it: the note goes with the next message.
  f.missedBy = 'talker';
  f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
  await sendTurn(f, 4);
  assert.equal(f.sent[3], 'Thanks.\n\n' + note);
  // The chief got that one (the talker didn't): the note is done.
  f.session.end();
  assert.equal(f.session.endNote(), '');
});

test('aMessageThatFailsAfterTheEndLeavesItsWordsAndNotesForTheEnd', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.', 'Anything else? Over.');
  f.quiet(1000);
  await sendTurn(f, 1);
  await sendTurn(f, 2);
  f.session.reply('r1', 'Yes, it\'s booked for eight.');
  f.slowBb = latch();
  await f.talk(); // Carries the note; on its way when the call ends.
  await until(() => f.session.phase() === Phase.SENDING);
  f.session.end();
  f.bbDown = true;
  f.slowBb.countDown();
  assert.ok(await f.session.awaitDelivered(5000));
  assert.equal(f.sent.length, 2);
  const note = '[not played: "Yes, it\'s booked for eight."]';
  assert.ok(f.session.endNote().includes(note), 'its note is free again');
  // Settled: its words go now, with the note; the end then has nothing left to say.
  f.bbDown = false;
  f.slowBb = null;
  assert.ok(await f.session.sendLeftover(f.now.get() + 30_000));
  assert.equal(f.sent[2], 'Anything else?\n\n' + note);
  assert.equal(f.session.endNote(), '');
});

test('aMessageThatFailsAfterTheEndSettledSendsItsWordsItselfTryingAgain', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.', 'Anything else? Over.');
  const retry = HandsFreeSession.leftoverRetryMs;
  HandsFreeSession.leftoverRetryMs = 300;
  try {
    f.quiet(1000);
    await sendTurn(f, 1);
    await sendTurn(f, 2);
    f.session.reply('r1', 'Yes, it\'s booked for eight.');
    f.slowBb = latch();
    await f.talk(); // Still in bb when the end has waited long enough.
    await until(() => f.session.phase() === Phase.SENDING);
    f.session.end();
    assert.ok(!(await f.session.awaitDelivered(100)));
    assert.ok(await f.session.sendLeftover(f.now.get() + 30_000), 'nothing left yet');
    const endLine = f.session.endNote(); // The end goes now, without the message's note: it still carries it.
    assert.ok(!endLine.includes('didn\'t hear'), endLine);
    // Then it fails: its words and note go by themselves, tried again until bb takes them.
    f.bbDown = true;
    f.slowBb.countDown();
    await until(() => f.logText().includes('a message failed after the call\'s end: its words are sent now'));
    await sleep(100);
    f.bbDown = false;
    for (let i = 0; i < 100 && f.sent.length < 3; i++) await sleep(20);
    assert.equal(f.sent[2], 'Anything else?\n\n[not played: "Yes, it\'s booked for eight."]', f.logText());
  } finally {
    HandsFreeSession.leftoverRetryMs = retry;
  }
});

test('wordsLeftAtTheEndAreTriedAFewTimesThenGivenUp', async () => {
  const f = new Fake('Is the table booked? Over.');
  const retry = HandsFreeSession.leftoverRetryMs;
  HandsFreeSession.leftoverRetryMs = 50;
  try {
    f.quiet(1000);
    f.bbDown = true;
    await f.talk();
    for (let i = 0; i < 100 && !f.session.error().startsWith('Not sent'); i++) await sleep(20);
    f.session.end(); // Your kept words go as your last words, and fail too.
    assert.ok(await f.session.awaitDelivered(5000));
    assert.ok(!(await f.session.sendLeftover(f.now.get() + 30_000)));
    const log = f.logText();
    assert.equal(count(log, 'words a message couldn\'t take before the end: sending them now'), HandsFreeSession.LEFTOVER_TRIES, log);
    assert.ok(log.includes('words left at the call\'s end couldn\'t be sent: they go with the end of the call'), log);
    // In the end line for both, so they aren't lost.
    assert.equal(f.session.endNote(), '\n\n[my last words, not sent before the end: "Is the table booked?"]');
  } finally {
    HandsFreeSession.leftoverRetryMs = retry;
  }
});

test('lastWordsOnlyTheTalkerGotGoWithTheChiefsEndLineOnly', async () => {
  const f = new Fake('Is the table booked? Over.');
  f.quiet(1000);
  f.bbDown = true;
  await f.talk();
  for (let i = 0; i < 100 && !f.session.error().startsWith('Not sent'); i++) await sleep(20);
  f.session.end(); // Kept words go as last words, and fail.
  assert.ok(await f.session.awaitDelivered(5000));
  f.bbDown = false;
  f.missedBy = 'chief'; // Now only the talker gets them.
  assert.ok(await f.session.sendLeftover(f.now.get() + 30_000));
  assert.equal(f.session.endNote(), '', 'the talker\'s end line: nothing doubled');
  assert.equal(f.session.endNoteForChief(), '\n\n[my last words, not sent before the end: "Is the table booked?"]');
});

test('aReplyAfterTheEndIsNotedWithTheEndWhileItsStillToGo', async () => {
  const f = new Fake();
  f.quiet(1000);
  f.session.end();
  f.session.reply('r1', 'The table is booked.');
  assert.equal(f.session.endNote(), '\n\n[not played: "The table is booked."]');
  f.session.reply('r1', 'And the train too.');
  assert.ok(f.logText().includes('chief message r1 after the call\'s end (18 characters): not played, and the end was already sent'));
  assert.equal(f.spoken.length, 0);
});

test('anUpdateWithoutARequestWhenNothingIsOnItsWayPlays', async () => {
  const f = new Fake('Is the table booked? Over.');
  f.quiet(1000);
  await sendTurn(f, 1);
  await until(() => f.session.yourTurn(f.now.get()) == null);
  f.session.reply(f.session.lastRequest(), 'Booked for eight.', 0, true);
  await until(() => f.spoken.length === 1);
});

test('notesOfAMessageThatCouldntBeSentGoWithTheCallsEnd', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.', 'Anything else? Over.');
  f.quiet(1000);
  await sendTurn(f, 1);
  await sendTurn(f, 2);
  f.session.reply('r1', 'Yes, it\'s booked for eight.'); // Outdated: dropped, to be noted.
  f.bbDown = true;
  await f.talk(); // Carries the note, and fails.
  for (let i = 0; i < 100 && !f.session.error().startsWith('Not sent'); i++) await sleep(20);
  assert.ok(f.session.error().startsWith('Not sent'));
  f.session.end(); // Your kept words go as your last words, and fail too.
  assert.ok(await f.session.awaitDelivered(5000));
  assert.ok(f.session.endNote().includes('[not played: "Yes, it\'s booked for eight."]'), f.session.endNote());
});

test('aNoteGoesWithOneMessageOnlyWhenTheNextGoesBeforeItsDelivered', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.', 'Anything else? Over.', 'Thanks. Over.');
  f.quiet(1000);
  await sendTurn(f, 1);
  await sendTurn(f, 2);
  f.session.reply('r1', 'Yes, it\'s booked for eight.');
  f.slowBb = latch();
  await f.talk(); // A: carries the note, on its way.
  await until(() => f.session.phase() === Phase.SENDING);
  await f.talk(); // B: handed over before A is delivered.
  await sleep(300);
  f.slowBb.countDown();
  await until(() => f.sent.length === 4);
  assert.equal(f.sent[2], 'Anything else?\n\n[not played: "Yes, it\'s booked for eight."]');
  assert.equal(f.sent[3], 'Thanks.');
});

test('withLiveTranscriptionEachStretchOfSpeechHoldsTheTurnAfreshForItsFirstWords', async () => {
  const f = new Fake();
  new FakeLive(f);
  f.quiet(1000);
  f.speak();
  f.now.addAndGet(HandsFreeSession.WORDLESS_MS + 1);
  assert.equal(f.session.yourTurn(f.now.get()), null);
  f.quiet(1200); // A pause, then you go on.
  await sleep(150);
  f.speak();
  assert.equal(f.session.yourTurn(f.now.get()), 'speaking');
});

test('aCallEndingWithRepliesStillWaitingTellsTheChiefOnce', async () => {
  const f = new Fake('Hold on');
  f.quiet(1000);
  f.speak();
  f.session.reply('r0', 'The meeting moved to three.');
  f.session.end();
  assert.equal(f.session.endNote(), '\n\n[not played: "The meeting moved to three."]');
});

test('aTurnThatComesToNothingLetsTheWaitingReplyPlay', async () => {
  // Philipp, 2 November 2026, 22:46: noise started a turn that dropped the reply, and then he
  // never heard anything. A reply is dropped only once your message goes.
  const f = new Fake('');
  f.quiet(1000);
  f.speak();
  f.session.reply('r0', 'Here\'s what I found.');
  await sleep(100);
  assert.equal(f.spoken.length, 0, 'not while you talk');
  f.quiet(1200);
  await until(() => f.transcriptions === 1);
  await until(() => f.spoken.length === 1);
  assert.deepEqual(f.spoken, ['Here\'s what I found.']);
  assert.equal(f.sent.length, 0);
  f.done();
  f.session.end();
  assert.equal(f.session.endNote(), '');
});

test('noiseBelowTheThresholdsNeverTakesTheFloor', async () => {
  const f = new Fake('should not be transcribed');
  f.quiet(2000);
  // Distant voices: not much louder than the background.
  for (let i = 0; i < 100; i++) f.session.frame(frame(120));
  // A click-like loud sound: under the 0.1 s a loud burst needs, far under the voice to take the turn.
  for (let i = 0; i < 4; i++) f.session.frame(frame(6000));
  f.quiet(1000);
  await sleep(150);
  assert.equal(f.transcripts.length, 1);
  assert.equal(f.session.floor(), Floor.OPEN);
  // So a chief message is read right away.
  f.session.reply('r0', 'An answer.');
  await until(() => f.spoken.length === 1);
  assert.deepEqual(f.spoken, ['An answer.']);
  assert.ok(f.logText().includes('noise ignored'), f.logText());
});

test('onceYouHaveTheFloorAShortOverStillCounts', async () => {
  const f = new Fake('Book the hotel', 'over');
  await f.talk();
  await until(() => f.session.pending() === 'Book the hotel');
  for (let i = 0; i < 20; i++) f.session.frame(frame(6000)); // 0.4 s: "Over."
  f.quiet(1200);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the hotel');
});

test('aDictationSwitchedToHandsFreeStartsTheFirstTurn', async () => {
  const f = new Fake('I was dictating about the trip', 'and the budget. Over.');
  const dictated = [];
  for (let i = 0; i < 50; i++) dictated.push(frame(3000)); // A second of what was dictated.
  f.session.seed(Buffer.concat(dictated));
  await until(() => f.session.pending() === 'I was dictating about the trip');
  await f.talk();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'I was dictating about the trip and the budget.');
});

test('thePhaseIsListeningWorkingOrReading', async () => {
  const f = new Fake('Book the hotel. Over.');
  assert.equal(f.session.phase(), Phase.LISTENING);
  await f.talk();
  await until(() => f.sent.length === 1);
  await until(() => f.session.phase() === Phase.WORKING);
  f.session.reply('r1', 'On it, first thoughts.');
  await until(() => f.spoken.length === 1);
  assert.equal(f.session.phase(), Phase.READING);
  f.done();
  assert.equal(f.session.phase(), Phase.WORKING);
  f.session.reply('r1', 'The hotel is booked.');
  await until(() => f.spoken.length === 2);
  f.done();
  assert.equal(f.session.phase(), Phase.LISTENING);
  assert.equal(f.session.error(), '');
});

test('theButtonSendsAndALongSilenceEndsTheCallSendingNothing', async () => {
  const f = new Fake('Remind me to call Jana', 'and buy milk');
  f.session.tick(); // The call's first tick: the silence counts from here.
  await f.talk();
  await until(() => f.session.pending() !== '');
  f.session.sendNow();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Remind me to call Jana');
  await f.talk();
  await until(() => f.session.pending() !== '');
  // Quiet: your words aren't sent, however long (no Jev here to call them done).
  f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
  f.quiet(8000);
  f.session.tick();
  await sleep(150);
  assert.equal(f.sent.length, 1);
  assert.equal(f.session.state(), State.LISTENING);
  f.now.addAndGet(f.session.silenceEndMs - 1000);
  f.session.tick();
  assert.equal(f.session.state(), State.LISTENING, 'not yet');
  f.now.addAndGet(1000);
  f.session.tick();
  assert.equal(f.session.state(), State.ENDED);
  assert.ok(await f.session.awaitDelivered(5000));
  await sleep(100);
  assert.deepEqual(f.sent, ['Remind me to call Jana'], 'nothing sent at the end');
  assert.ok(reasons(f).includes('Call ended after 120 s of silence; nothing was sent'), reasons(f));
  assert.ok(f.logText().includes('120 s of silence: ending the call, sending nothing (your unsent words "and buy milk" are let go)'), f.logText());
});

test('aReplyPlayingOrAMessageGoingResetsTheLongSilence', async () => {
  const f = new Fake('Book it. Over.');
  f.quiet(1000);
  f.session.tick();
  f.now.addAndGet(f.session.silenceEndMs - 1000);
  f.session.reply('r0', 'Good morning.');
  await until(() => f.spoken.length === 1);
  f.now.addAndGet(5000); // Still reading: no end.
  f.session.tick();
  f.done();
  f.now.addAndGet(f.session.silenceEndMs - 1000);
  f.session.tick();
  assert.equal(f.session.state(), State.LISTENING, 'counted from the reply\'s end');
  f.now.addAndGet(1000);
  f.session.tick();
  assert.equal(f.session.state(), State.ENDED);
});

test('theButtonPressedWhileTheLastPartIsBeingWrittenDownSendsIt', async () => {
  // The part ended (short pause) and the speech model is still working when the button is
  // pressed: it must go once written down, not be dropped as an empty turn.
  const f = new Fake('Book a table for four, tonight at eight');
  f.slow = latch();
  await f.talk();
  assert.equal(f.session.pending(), '');
  f.session.sendNow();
  f.slow.countDown();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book a table for four, tonight at eight');
  assert.equal(f.session.pending(), '');
});

test('theButtonWaitsForEveryPartStillBeingWrittenDown', async () => {
  const f = new Fake('First part.', 'Second part.');
  f.slow = latch();
  await f.talk();
  await f.talk();
  f.session.sendNow();
  f.slow.countDown();
  await until(() => f.sent.length === 1);
  await sleep(200);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0], 'First part. Second part.');
});

test('aPressShowsSendingAtOnceAndASecondPressDoesNothing', async () => {
  const f = new Fake('Book the table');
  f.slow = latch();
  await f.talk();
  f.session.sendNow();
  assert.equal(f.session.phase(), Phase.SENDING);
  f.session.sendNow();
  f.slow.countDown();
  await until(() => f.sent.length === 1);
  await sleep(200);
  assert.equal(f.sent.length, 1);
  assert.ok(f.log.some((l) => l.includes('send pressed again')));
});

test('aPressRightAfterAMessageWentDoesntSendTheNextWordsOnTheirOwn', async () => {
  // Philipp's "don't see the": a second press for the same message sent the next fragment.
  const f = new Fake('That was the whole thing.', 'don\'t see the');
  await f.talk();
  await until(() => f.session.pending() !== '');
  f.session.sendNow();
  await until(() => f.sent.length === 1);
  await f.talk();
  await until(() => f.session.pending() === 'don\'t see the');
  f.session.sendNow(); // Same instant on the fake clock: a repeated press.
  await sleep(200);
  assert.equal(f.sent.length, 1);
  assert.equal(f.session.pending(), 'don\'t see the');
  f.now.addAndGet(HandsFreeSession.REPRESS_MS + 1);
  f.session.sendNow();
  await until(() => f.sent.length === 2);
  assert.equal(f.sent[1], 'don\'t see the');
});

test('whatYouSayNextIsWrittenDownWhileBbIsSlow', async () => {
  // Delivering a message must not hold up writing down the next turn, and messages keep their order.
  const f = new Fake('First message. Over.', 'Second message. Over.');
  f.slowBb = latch();
  await f.talk();
  await until(() => f.session.phase() === Phase.SENDING);
  await f.talk();
  await until(() => f.log.some((l) => l.includes('Second message')));
  assert.equal(f.sent.length, 0);
  f.slowBb.countDown();
  await until(() => f.sent.length === 2);
  assert.equal(f.sent[0], 'First message.');
  assert.equal(f.sent[1], 'Second message.');
});

test('theLastMessageStillGoesWhenTheCallEndsWithIt', async () => {
  const f = new Fake('Order the parts, end the call');
  f.slowBb = latch();
  await f.talk();
  await until(() => f.session.state() === State.ENDED);
  f.slowBb.countDown();
  assert.ok(await f.session.awaitDelivered(2000));
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0], 'Order the parts');
});

