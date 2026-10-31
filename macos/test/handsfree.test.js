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

test('aSendWordCountsOnlyAtTheEnd', () => {
  assert.equal(HandsFree.endsWith('Book a table for Friday. Over.', send), 'Book a table for Friday.');
  assert.equal(HandsFree.endsWith('book a table, over!', send), 'book a table');
  assert.equal(HandsFree.endsWith('Buch einen Tisch. Schick ab.', HandsFree.list('over, schick ab')), 'Buch einen Tisch.');
  assert.equal(HandsFree.endsWith('Over.', send), '');
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

test('aReplyWaitsWhileYouTalkIsNotDroppedBySendingAndPlaysAtThePause', async () => {
  const f = new Fake('Also check the train', 'to Lisbon. Over.');
  f.quiet(1000);
  f.speak(); // You take the floor.
  assert.equal(f.session.floor(), Floor.YOU);
  f.session.reply('r0', 'The flight leaves at nine in the morning and costs about two hundred euros, I think.');
  await sleep(100);
  assert.equal(f.spoken.length, 0);
  assert.equal(f.session.held(), 1);
  assert.ok(reasons(f).includes('Reply waits: you\'re talking'), reasons(f));
  assert.equal(f.session.liveState(), Live.HEARING);
  f.quiet(1200); // A pause, with your words unsent: still your turn, it waits.
  await sleep(150);
  assert.equal(f.spoken.length, 0);
  await f.talk();
  await until(() => f.sent.length === 1);
  // Your message as said: nothing about the reply, which isn't dropped.
  assert.equal(f.sent[0], `Also check the train to Lisbon.\n\n[your reply hasn't played yet, it plays after this message: "The flight leaves at nine in the morning and costs about two…"]`);
  // Your turn is over: it plays now.
  await until(() => f.spoken.length === 1);
  assert.equal(f.spoken[0], 'The flight leaves at nine in the morning and costs about two hundred euros, I think.');
  f.done();
  assert.equal(f.session.unheard(), 0);
  assert.equal(f.session.endNote(), '');
});

test('aReplyNeverPlaysInALongThinkingPauseWithUnsentWordsOnlyOnceTheyreSent', async () => {
  const f = new Fake('Book the hotel');
  f.quiet(1000);
  f.speak();
  f.session.reply('r0', 'Here\'s what I found.');
  f.quiet(1200);
  await until(() => f.session.pending() === 'Book the hotel');
  // You think, quiet, your words unsent (no Jev here to say you're done): your turn goes on.
  f.quiet(6000);
  f.session.tick();
  await sleep(100);
  assert.equal(f.spoken.length, 0);
  assert.equal(f.session.liveState(), Live.REPLY_WAITING);
  assert.ok(reasons(f).includes('Reply waits: your turn (unsent words)'), reasons(f));
  // The silence send (8 s here) ends your turn: your words go, then it plays.
  f.quiet(2000);
  f.session.tick();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], `Book the hotel\n\n[your reply hasn't played yet, it plays after this message: "Here's what I found."]`);
  await until(() => f.spoken.length === 1);
  assert.ok(reasons(f).includes('Reply plays: your turn is over'), reasons(f));
  const log = f.logText();
  const yours = log.indexOf('turn: yours (unsent words)');
  const silence = log.indexOf('turn: silence (sent)');
  const ours = log.indexOf('turn: ours (a reply plays)');
  assert.ok(yours >= 0 && silence > yours && ours > silence, log);
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

test('aReplyArrivingWhileYourMessageIsWrittenDownOrSentWaitsUntilItsGone', async () => {
  const f = new Fake('Is the table booked? Over.');
  const slow = latch();
  f.slow = slow;
  const timeout = HandsFreeSession.writeTimeoutMs;
  HandsFreeSession.writeTimeoutMs = 60_000;
  try {
    f.quiet(1000);
    await f.talk();
    f.session.reply('r0', 'Here\'s what I found.');
    await until(() => reasons(f).includes('Reply waits: checking whether you\'re done'));
    f.quiet(3000);
    f.session.tick();
    assert.equal(f.spoken.length, 0);
    f.slowBb = latch();
    slow.countDown(); // Written down: now it's being sent.
    await until(() => reasons(f).includes('Reply waits: your message is being sent'));
    f.session.tick();
    assert.equal(f.spoken.length, 0);
    f.slowBb.countDown();
    await until(() => f.sent.length === 1);
    await until(() => f.spoken.length === 1);
  } finally {
    slow.countDown();
    HandsFreeSession.writeTimeoutMs = timeout;
  }
});

test('withATalkerAReplyToAnOlderMessageIsntPlayedAndTheNextMessageSaysSo', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.', 'Anything else? Over.');
  f.session.dropsOutdated = true;
  f.quiet(1000);
  await sendTurn(f, 1);
  await sendTurn(f, 2);
  // The answer to the first message comes after the second went: it no longer fits.
  f.session.reply('r1', 'Yes, it\'s booked for eight.');
  f.session.reply('r2', 'The train leaves at nine.');
  await hear(f, 1);
  assert.deepEqual(f.spoken, ['The train leaves at nine.']);
  const log = f.logText();
  assert.ok(log.includes('chief message r1 dropped (27 characters): it answers an older message than your latest'), log);
  assert.ok(reasons(f).includes('An older reply wasn\'t played: you\'ve said more since. Your next message says so'), reasons(f));
  await sendTurn(f, 3);
  assert.equal(f.sent[2], 'Anything else?\n\n[didn\'t hear your reply: "Yes, it\'s booked for eight."]');
  // Noted once.
  f.session.end();
  assert.equal(f.session.endNote(), '');
});

test('withATalkerRepliesStillWaitingWhenYourMessageGoesArentPlayedAndTheNextMessageSaysSo', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.', 'Anything else? Over.');
  f.session.dropsOutdated = true;
  f.quiet(1000);
  await sendTurn(f, 1);
  // You talk on; three answers to the first message (one an update without a request) wait.
  f.speak();
  f.session.reply('r1', 'One moment, I\'m checking the booking for you now.');
  f.session.reply('r1', 'It\'s booked for eight.');
  f.session.reply(f.session.lastRequest(), 'The chief says the window table is free.', 0, true);
  assert.equal(f.session.held(), 3);
  f.quiet(1200);
  await until(() => f.sent.length === 2);
  // Dropped once your message was delivered; that message didn't know of it yet.
  assert.equal(f.sent[1], 'And the train?');
  await until(() => f.session.held() === 0);
  await sleep(200);
  assert.equal(f.spoken.length, 0, String(f.spoken));
  assert.equal(f.dropped.length, 3, 'their voices let go');
  assert.ok(reasons(f).includes('3 older replies weren\'t played: you\'ve said more since'), reasons(f));
  const log = f.logText();
  assert.ok(log.includes('chief message r1 dropped (22 characters): it was waiting when your newer message r2 went'), log);
  f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
  await sendTurn(f, 3);
  assert.equal(f.sent[2], 'Anything else?\n\n[didn\'t hear 3 replies: "One moment, I\'m checking the booking for you…" and 2 more]');
  f.session.end();
  assert.equal(f.session.endNote(), '');
});

test('withATalkerACallEndingWithDroppedRepliesNotYetNotedSaysSoAtItsEnd', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.');
  f.session.dropsOutdated = true;
  f.quiet(1000);
  await sendTurn(f, 1);
  await sendTurn(f, 2);
  f.session.reply('r1', 'Yes, it\'s booked for eight.');
  f.session.reply('r1', 'The window table, as you asked.');
  f.session.end();
  assert.equal(f.session.endNote(), '\n\n[didn\'t hear 2 replies: "Yes, it\'s booked for eight." and 1 more]');
  assert.equal(f.spoken.length, 0);
});

test('withoutATalkerAReplyToAnOlderMessageStillPlays', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.', 'Anything else? Over.');
  f.quiet(1000);
  await sendTurn(f, 1);
  await sendTurn(f, 2);
  f.session.reply('r1', 'Yes, it\'s booked for eight.');
  await hear(f, 1);
  await sendTurn(f, 3);
  assert.equal(f.sent[2], 'Anything else?');
  assert.ok(!f.logText().includes('dropped'));
});

test('withoutATalkerAReplyStillWaitingWhenYourNextMessageGoesIsNotedInItAndStillPlays', async () => {
  // Philipp's call, 31 October 2026: "Hi, can you hear me?" asked again before the first answer
  // played; the chief answered it again, and he heard "Yes, I can hear you" twice.
  const f = new Fake('Hi, can you hear me? Over.', 'Hi, can you hear me? Over.', 'Book the table. Over.');
  f.quiet(1000);
  await sendTurn(f, 1);
  f.speak(); // You ask again; the answer to the first comes meanwhile and waits.
  f.session.reply('r1', 'Yes, I hear you. Go ahead.');
  assert.equal(f.session.held(), 1);
  f.quiet(1200);
  await until(() => f.sent.length === 2);
  // The chief hears that its answer is still to play: it doesn't answer the same again.
  assert.equal(f.sent[1], 'Hi, can you hear me?\n\n[your reply hasn\'t played yet, it plays after this message: "Yes, I hear you. Go ahead."]');
  await hear(f, 1);
  assert.deepEqual(f.spoken, ['Yes, I hear you. Go ahead.']);
  await sendTurn(f, 3);
  assert.equal(f.sent[2], 'Book the table.', 'played: not noted again');
  assert.ok(!f.logText().includes('dropped'));
});

test('withATalkerNoMessageSaysAReplyHasntPlayedYet', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.');
  f.session.dropsOutdated = true;
  f.quiet(1000);
  await sendTurn(f, 1);
  f.speak();
  f.session.reply('r1', 'Yes, it\'s booked for eight.');
  f.quiet(1200);
  await until(() => f.sent.length === 2);
  assert.equal(f.sent[1], 'And the train?');
});

test('severalRepliesNotPlayedYetAreNotedAsOne', () => {
  assert.equal(
    HandsFreeSession.notPlayedYet(['One moment, I\'m checking the booking for you now.', 'It\'s booked.']),
    '[2 replies haven\'t played yet, they play after this message: "One moment, I\'m checking the booking for you…" and 1 more]',
  );
});

test('withATalkerAReplyArrivingWhileYourNewMessageIsOnItsWayWaitsAndIsOutdatedOnceItsDelivered', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.');
  f.session.dropsOutdated = true;
  f.quiet(1000);
  await sendTurn(f, 1);
  f.slowBb = latch();
  await f.talk();
  await until(() => f.session.phase() === Phase.SENDING);
  f.session.reply('r1', 'Yes, it\'s booked for eight.'); // Tagged: an answer to the first message.
  // The talker's update without a request, while your message is on its way: it answers that one.
  f.session.reply(f.session.lastRequest(), 'Let me check the trains.', 0, true);
  assert.equal(f.session.held(), 2);
  await sleep(100);
  assert.equal(f.spoken.length, 0);
  f.slowBb.countDown();
  await until(() => f.sent.length === 2);
  await until(() => f.spoken.length === 1);
  assert.deepEqual(f.spoken, ['Let me check the trains.']);
  assert.ok(f.logText().includes('chief message r1 dropped (27 characters): it was waiting when your newer message r2 went'));
});

test('withATalkerAReplyToTheMessageOnItsWayIsOursAndPlaysOnceItsDelivered', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.');
  f.session.dropsOutdated = true;
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
  f.session.dropsOutdated = true;
  f.quiet(1000);
  await sendTurn(f, 1);
  await sendTurn(f, 2);
  f.session.reply('r1', 'Yes, it\'s booked for eight.');
  f.missedBy = 'chief';
  await sendTurn(f, 3);
  const note = '[didn\'t hear your reply: "Yes, it\'s booked for eight."]';
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
  f.session.dropsOutdated = true;
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
  const note = '[didn\'t hear your reply: "Yes, it\'s booked for eight."]';
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
  f.session.dropsOutdated = true;
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
    assert.equal(f.sent[2], 'Anything else?\n\n[didn\'t hear your reply: "Yes, it\'s booked for eight."]', f.logText());
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
  assert.equal(f.session.endNote(), '\n\n[didn\'t hear your reply: "The table is booked."]');
  f.session.reply('r1', 'And the train too.');
  assert.ok(f.logText().includes('chief message r1 after the call\'s end (18 characters): not played, and the end was already sent'));
  assert.equal(f.spoken.length, 0);
});

test('pastAMinuteAReplyStillWaitsForASentenceButNotForEndlessSpeech', async () => {
  const f = new Fake('Book the hotel');
  f.quiet(1000);
  await f.talk();
  await until(() => f.session.pending() === 'Book the hotel');
  f.session.reply('r0', 'Here\'s what I found.');
  await until(() => f.log.some((l) => l.startsWith('voice ready for r0')));
  f.session.tick();
  f.now.addAndGet(HandsFreeSession.HOLD_MAX_MS);
  f.speak(); // You start a sentence just as the minute is up.
  f.now.addAndGet(1000);
  f.session.tick();
  await sleep(100);
  assert.equal(f.spoken.length, 0, 'not over your sentence');
  // Speech going on without a pause for 20 s: a TV, not you.
  f.now.addAndGet(HandsFreeSession.LONG_STRETCH_MS);
  f.speak();
  for (let i = 0; i < 50 && f.spoken.length === 0; i++) {
    f.session.tick();
    await sleep(20);
  }
  assert.equal(f.spoken.length, 1, f.logText());
});

test('pastTwiceTheCapASoundThatNeverBecomesSpeechNoLongerHoldsAReply', async () => {
  const f = new Fake('Book the hotel');
  f.quiet(1000);
  await f.talk();
  await until(() => f.session.pending() === 'Book the hotel');
  f.session.reply('r0', 'Here\'s what I found.');
  await until(() => f.log.some((l) => l.startsWith('voice ready for r0')));
  // In the car: a click again and again, gaps shorter than a pause, never speech.
  f.now.addAndGet(HandsFreeSession.HOLD_MAX_MS + 1000);
  for (let i = 0; i < 6; i++) {
    clatter(f.session, 2100, 3);
    clatter(f.session, 50, 22);
    f.session.tick();
  }
  await sleep(100);
  assert.equal(f.spoken.length, 0, 'a sound just starting still holds it');
  f.now.addAndGet(HandsFreeSession.HOLD_MAX_MS);
  for (let i = 0; i < 50 && f.spoken.length === 0; i++) {
    clatter(f.session, 2100, 3);
    clatter(f.session, 50, 22);
    f.session.tick();
    await sleep(20);
  }
  assert.deepEqual(f.spoken, ['Here\'s what I found.'], f.logText());
  assert.equal(f.transcriptions - 1, 0); // The clicks were never written down.
});

test('speechAReplyStartsOverPastItsCapIsKeptInYourTurn', async () => {
  const f = new Fake('Book the hotel', 'and the train');
  f.quiet(1000);
  await f.talk();
  await until(() => f.session.pending() === 'Book the hotel');
  f.session.reply('r0', 'Here\'s what I found.');
  await until(() => f.log.some((l) => l.startsWith('voice ready for r0')));
  f.now.addAndGet(HandsFreeSession.HOLD_MAX_MS);
  f.speak(); // Speech going on, then on past 20 s.
  f.now.addAndGet(HandsFreeSession.LONG_STRETCH_MS);
  f.speak();
  for (let i = 0; i < 50 && f.spoken.length === 0; i++) {
    f.session.tick();
    await sleep(20);
  }
  assert.equal(f.spoken.length, 1);
  // What was said up to the reply is a part of your turn, written down, not lost.
  await until(() => f.session.pending() === 'Book the hotel and the train');
});

test('withATalkerAnUpdateWithoutARequestWhenNothingIsOnItsWayPlays', async () => {
  const f = new Fake('Is the table booked? Over.');
  f.session.dropsOutdated = true;
  f.quiet(1000);
  await sendTurn(f, 1);
  await until(() => f.session.yourTurn(f.now.get()) == null);
  f.session.reply(f.session.lastRequest(), 'Booked for eight.', 0, true);
  await until(() => f.spoken.length === 1);
});

test('withATalkerASendThatFailsDropsNoWaitingReply', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.');
  f.session.dropsOutdated = true;
  f.quiet(1000);
  await sendTurn(f, 1);
  f.speak();
  f.session.reply('r1', 'Yes, it\'s booked for eight.');
  f.bbDown = true;
  f.quiet(1200);
  for (let i = 0; i < 100 && !f.session.error().startsWith('Not sent'); i++) await sleep(20);
  assert.ok(f.session.error().startsWith('Not sent'), f.logText());
  assert.equal(f.session.held(), 1, 'still waiting, not dropped');
  assert.equal(f.dropped.length, 0);
  assert.ok(!f.logText().includes('dropped'));
  // The call ends: it was never heard, and says so as a reply still waiting.
  f.session.end();
  assert.equal(f.session.endNote(), '\n\n[didn\'t hear your reply: "Yes, it\'s booked for eight."]');
});

test('notesOfAMessageThatCouldntBeSentGoWithTheCallsEnd', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.', 'Anything else? Over.');
  f.session.dropsOutdated = true;
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
  assert.ok(f.session.endNote().includes('[didn\'t hear your reply: "Yes, it\'s booked for eight."]'), f.session.endNote());
});

test('aNoteGoesWithOneMessageOnlyWhenTheNextGoesBeforeItsDelivered', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.', 'Anything else? Over.', 'Thanks. Over.');
  f.session.dropsOutdated = true;
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
  assert.equal(f.sent[2], 'Anything else?\n\n[didn\'t hear your reply: "Yes, it\'s booked for eight."]');
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

test('aSilenceSendThatFailsIsTriedAgainLaterNotEverySecond', async () => {
  const f = new Fake('Remind me to call Jana');
  f.quiet(1000);
  await f.talk();
  await until(() => f.session.pending() !== '');
  f.bbDown = true;
  f.quiet(8000);
  f.session.tick();
  await until(() => f.logText().includes('not sent (silence)'));
  for (let i = 0; i < 10; i++) {
    f.quiet(1000);
    f.now.addAndGet(1000);
    f.session.tick();
  }
  await sleep(200);
  assert.equal(count(f.logText(), 'not sent (silence)'), 1);
  f.now.addAndGet(HandsFreeSession.SILENCE_RETRY_MS);
  f.bbDown = false;
  f.session.tick();
  await until(() => f.sent.length === 1);
  assert.ok(f.logText().includes('silence send: trying again (2)'));
});

test('aReadyReplyWaitsAMinuteAtMostThroughATurnWithoutNewWords', async () => {
  const f = new Fake('Book the hotel');
  f.quiet(1000);
  await f.talk();
  await until(() => f.session.pending() === 'Book the hotel');
  f.session.reply('r0', 'Here\'s what I found.');
  await until(() => f.log.some((l) => l.startsWith('voice ready for r0')));
  f.session.tick();
  await sleep(100);
  assert.equal(f.spoken.length, 0);
  f.now.addAndGet(HandsFreeSession.HOLD_MAX_MS - 1000);
  f.session.tick();
  await sleep(100);
  assert.equal(f.spoken.length, 0);
  f.now.addAndGet(1000);
  f.session.tick();
  await until(() => f.spoken.length === 1);
  assert.ok(reasons(f).includes('Reply plays: it waited 60 s without new words from you'), reasons(f));
});

test('withATalkerAMessageThatCouldntBeSentDoesntMakeTheRepliesBeforeItOutdated', async () => {
  const f = new Fake('Is the table booked? Over.', 'And the train? Over.');
  f.session.dropsOutdated = true;
  f.quiet(1000);
  await sendTurn(f, 1);
  f.bbDown = true;
  await f.talk();
  for (let i = 0; i < 100 && !f.session.error().startsWith('Not sent'); i++) await sleep(20);
  assert.ok(f.session.error().startsWith('Not sent'), f.logText());
  // Your words are kept (your turn): the reply waits, but isn't dropped.
  f.session.reply('r1', 'Yes, it\'s booked for eight.');
  assert.equal(f.session.held(), 1);
  assert.ok(!f.logText().includes('dropped'));
});

test('aCallEndingWithRepliesStillWaitingTellsTheChiefOnce', async () => {
  const f = new Fake('Hold on');
  f.quiet(1000);
  f.speak();
  f.session.reply('r0', 'The meeting moved to three.');
  f.session.end();
  assert.equal(f.session.endNote(), '\n\n[didn\'t hear your reply: "The meeting moved to three."]');
});

test('aTurnThatComesToNothingReleasesTheFloorAndTheHeldMessageIsRead', async () => {
  const f = new Fake('');
  f.quiet(1000);
  f.speak();
  f.session.reply('r0', 'Here\'s what I found.');
  assert.equal(f.spoken.length, 0);
  f.quiet(1200);
  await until(() => f.spoken.length === 1);
  assert.equal(f.spoken[0], 'Here\'s what I found.');
  assert.equal(f.sent.length, 0);
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

test('theButtonSendsAndALongSilenceSendsToo', async () => {
  const f = new Fake('Remind me to call Jana', 'and buy milk');
  await f.talk();
  await until(() => f.session.pending() !== '');
  f.session.sendNow();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Remind me to call Jana');
  await f.talk();
  await until(() => f.session.pending() !== '');
  f.quiet(8000);
  f.session.tick();
  await until(() => f.sent.length === 2);
  assert.equal(f.sent[1], 'and buy milk');
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

