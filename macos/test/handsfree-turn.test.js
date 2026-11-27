'use strict';
// HandsFreeTest.java, part 2: the chief's side, the voice never leaves you stuck, talking over a
// reply, taking the turn, whole turns.
const test = require('node:test');
const assert = require('node:assert/strict');
const HandsFree = require('../src/core/handsfree');
const { HandsFreeSession } = require('../src/core/handsfree-session');
const { sleep } = require('../src/core/util');
const assets = require('../src/core/assets');
const {
  latch,
  frame,
  feed,
  until,
  Fake,
  reasons,
  verdict,
  hear,
  LONG_REPLY,
  playingReply,
  talkOverUntilStopped,
  optional,
} = require('./support/handsfree-fakes');

const { State, Live } = HandsFreeSession;

// ------------------------------------------------------------------ the chief's side

test('spokenRepliesAreFoundByTagAndRequest', () => {
  const ChiefText = require('../src/core/chief-text');
  const m = { event: 'message', tags: ['talkrouter-speak', 'req-abc234'] };
  assert.equal(ChiefText.spokenRequest(m), 'abc234');
  const paste = { tags: ['talkrouter-paste', 'req-abc234'] };
  assert.equal(ChiefText.spokenRequest(paste), '');
  assert.equal(ChiefText.spokenRequest({ event: 'keepalive' }), '');
  // The talker's updates from the chief: spoken, without a request.
  const untagged = { event: 'message', tags: ['talkrouter-speak'] };
  assert.equal(ChiefText.spokenRequest(untagged), '');
  assert.ok(ChiefText.spoken(untagged));
  assert.ok(ChiefText.spoken(m));
  assert.ok(!ChiefText.spoken(paste));
  assert.ok(!ChiefText.spoken({ event: 'keepalive' }));
});

test('handsFreeMessagesAreTaggedAndTheSkillExplainsThem', () => {
  const BbBridge = require('../src/core/bb-bridge');
  const m = BbBridge.message('Book a table', [], HandsFree.TAG, 'k3x9qa');
  assert.equal(m, 'Book a table\n\n[hands-free]\n\n[request: k3x9qa]');
  const skill = assets.read('skills/dictate-and-delegate/SKILL.md');
  assert.ok(skill.includes('[hands-free]'));
  assert.ok(skill.includes('Tags: talkrouter-speak,req-<id>'));
  assert.ok(skill.includes('send one spoken reply, soon'));
  assert.ok(!skill.includes("[your reply hasn't played yet"), 'no queue');
  assert.ok(skill.includes('A discarded reply counts as unsaid'));
  assert.ok(skill.includes('[hands-free call started]') && skill.includes('[hands-free call ended]'));
  assert.ok(skill.includes('[not played: "…"]') && skill.includes('[not played from there: "…"]'));
  assert.ok(!skill.includes('quick spoken reaction'));
});

const Voice = optional('../src/core/voice');

test('theVoiceRequestNamesModelAndVoice', { skip: Voice ? false : 'voice.js (the speech agent\'s port) not there yet' }, () => {
  const b = Voice.body(Voice.KOKORO, 'Hello');
  assert.equal(b.model, 'hexgrad/kokoro-82m');
  assert.equal(b.voice, 'af_heart');
  assert.equal(b.response_format, 'mp3');
  assert.equal(Voice.choice('nonsense'), Voice.KOKORO);
  assert.equal(Voice.choice('eleven'), Voice.ELEVEN);
});

// ------------------------------------------------------------------ the voice never leaves you stuck

test('whileAReplysAudioIsFetchedTheFloorStaysOpenAndYouCanTalk', async () => {
  const f = new Fake('Wait, one more thing. Over.');
  const fetched = latch();
  f.prepare = async (text) => {
    await fetched.promise;
    return text;
  };
  f.quiet(1000);
  f.session.reply('r0', 'Here\'s the answer.');
  await sleep(100);
  // Not read yet: the microphone is on and the floor open.
  assert.equal(f.session.state(), State.LISTENING);
  assert.equal(f.session.floor(), HandsFreeSession.Floor.OPEN);
  f.speak(); // You take it meanwhile: a new turn, the reply waits until your message goes.
  fetched.countDown();
  await sleep(100);
  assert.equal(f.spoken.length, 0);
  assert.equal(f.session.held(), 1);
  f.quiet(1200);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Wait, one more thing.\n\n[not played: "Here\'s the answer."]');
  f.session.tick();
  await sleep(150);
  assert.equal(f.spoken.length, 0, 'never played after your turn either');
  assert.ok(f.dropped.includes('Here\'s the answer.'), 'its voice let go');
});

test('audioThatNeverStartsIsGivenUpSoonAndNotedAsNotHeard', async () => {
  const f = new Fake('What did you say? Over.');
  f.audioStarts = false;
  f.quiet(1000);
  f.session.reply('r0', 'The meeting moved to three.');
  await until(() => f.spoken.length === 1);
  assert.equal(f.session.state(), State.READING);
  f.session.tick();
  assert.equal(f.session.state(), State.READING); // Not yet.
  // Tried once more (its voice fetched afresh), then it counts as not heard.
  for (let i = 1; i <= 1 + HandsFreeSession.RETRIES; i++) {
    const tries = i;
    await until(() => f.spoken.length === tries);
    f.now.addAndGet(HandsFreeSession.START_MS + 1);
    f.session.tick();
  }
  assert.equal(f.session.state(), State.LISTENING);
  assert.equal(f.session.unheard(), 1);
  assert.equal(f.spoken.length, 1 + HandsFreeSession.RETRIES);
  f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
  await f.talk();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'What did you say?\n\n[not played: "The meeting moved to three."]');
  assert.equal(f.session.unheard(), 0);
});

test('audioThatPlaysFarTooLongIsLetGo', async () => {
  const f = new Fake();
  f.quiet(1000);
  f.session.reply('r0', 'A reply of two seconds.');
  await until(() => f.spoken.length === 1);
  f.now.addAndGet(2000 + HandsFreeSession.OVERRUN_MS - 100);
  f.session.tick();
  assert.equal(f.session.state(), State.READING); // Still within its length.
  f.now.addAndGet(200);
  f.session.tick();
  assert.equal(f.session.state(), State.LISTENING);
  assert.ok(f.logText().includes('played too long'), f.logText());
});

test('aVoiceThatFailsReturnsToListeningAtOnce', async () => {
  const f = new Fake();
  f.audioStarts = false;
  f.quiet(1000);
  f.session.reply('r0', 'Can\'t be played.');
  for (let i = 1; i <= 1 + HandsFreeSession.RETRIES; i++) {
    const tries = i;
    await until(() => f.spoken.length === tries);
    f.fail(); // The player reports an error before any audio.
  }
  assert.equal(f.session.state(), State.LISTENING);
  assert.equal(f.session.unheard(), 1);
});

test('aReplyWhoseVoiceFailsIsTriedAgainAndHeard', async () => {
  const f = new Fake();
  f.audioStarts = false;
  f.quiet(1000);
  f.session.reply('r0', 'The table is booked.');
  await until(() => f.spoken.length === 1);
  f.audioStarts = true; // Played the second time.
  f.fail(); // The system voice couldn't play it.
  await until(() => f.spoken.length === 2); // Its voice fetched again, and played.
  f.done();
  assert.equal(f.session.unheard(), 0);
  assert.ok(reasons(f).includes('Reply couldn\'t be played (the voice stopped): trying again'), reasons(f));
});

test('writingDownThatHangsIsGivenUpTriedOnceMoreAndShown', async () => {
  const was = HandsFreeSession.writeTimeoutMs;
  HandsFreeSession.writeTimeoutMs = 300;
  try {
    const f = new Fake('Book the table', 'Book the table');
    f.slow = latch(); // Both tries hang.
    await f.talk();
    await until(() => f.session.checkStep() === 'writing');
    assert.equal(f.session.liveState(), Live.WRITING);
    await until(() => reasons(f).includes('Writing down took over 0 s: trying once more'));
    await until(() => reasons(f).includes('Couldn\'t write down'));
    f.slow.countDown();
    // Kept: Send writes it down and sends it.
    f.session.sendNow();
    await until(() => f.sent.length === 1);
  } finally {
    HandsFreeSession.writeTimeoutMs = was;
  }
});

test('wordsNotSentWhenTheCallEndsAreSentBeforeItsEnd', async () => {
  const f = new Fake('And also look at the latency');
  f.session.judge = async (said) => verdict('more', 0.1, 0);
  await f.talk();
  await until(() => f.session.pending() === 'And also look at the latency');
  f.session.end();
  assert.ok(await f.session.awaitDelivered(2000));
  assert.deepEqual(f.sent, ['And also look at the latency']);
  assert.ok(f.logText().includes('they\'re sent before the call\'s end'), f.logText());
});

test('wordsNotYetWrittenDownWhenTheCallEndsAreWrittenDownAndSent', async () => {
  const f = new Fake('Order the parts');
  f.quiet(1000);
  f.speak(); // Still talking when the call ends: the part ends with it.
  f.session.end();
  assert.ok(await f.session.awaitDelivered(3000));
  assert.deepEqual(f.sent, ['Order the parts']);
});

test('aTranscriptionThatFailsKeepsYourWordsAndTheNextCheckTriesAgain', async () => {
  const f = new Fake(); // No transcripts queued: the speech model fails.
  f.quiet(1000);
  await f.talk();
  await until(() => f.session.error() !== '');
  // Your turn is kept: a reply arriving now is for before it, and dropped.
  assert.equal(f.session.floor(), HandsFreeSession.Floor.YOU);
  f.session.reply('r0', 'Read now.');
  f.quiet(400);
  await sleep(100);
  assert.equal(f.spoken.length, 0);
  f.transcripts.push('Book the hotel. Over.');
  await f.talk();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the hotel.\n\n[not played: "Read now."]');
  await sleep(150);
  assert.equal(f.spoken.length, 0);
});

test('aReplyLongerThanItsEstimateIsNeverCutWhileItsAudioPlays', async () => {
  const f = new Fake();
  f.quiet(1000);
  f.session.reply('r0', 'A long reply that takes longer than the voice said.');
  await until(() => f.spoken.length === 1);
  f.audioPlaying = true;
  for (let i = 0; i < 30; i++) {
    // A minute past its two seconds, still playing.
    f.now.addAndGet(2000);
    f.session.tick();
  }
  assert.equal(f.session.state(), State.READING);
  f.done(); // Played to the end: heard.
  assert.equal(f.session.state(), State.LISTENING);
  assert.equal(f.session.unheard(), 0);
});

// ------------------------------------------------------------------ talking over a reply

test('talkingOverAReplyPausesItAndYourMessageDropsTheRestAndSaysHowFarYouHeard', async () => {
  // Without live transcription: what you say over it is written down to check for words.
  const f = await playingReply('Hold on, book', 'Hold on, book the train instead.', 'Over.');
  f.heardChars = LONG_REPLY.indexOf('Lisbon');
  const frames = await talkOverUntilStopped(f, 8000, 200); // You, over the reply.
  assert.ok(frames > 0, 'stopped once your words were heard: ' + frames);
  assert.equal(f.session.state(), State.LISTENING);
  assert.equal(f.transcriptions, 1, 'written down to check');
  const log = f.logText();
  assert.ok(log.includes('barge-in: 2 word(s) of yours heard over the reply ("Hold on, book")'), log);
  assert.ok(log.includes('it plays on from "The train to Lisbon costs'), log);
  assert.ok(reasons(f).includes('Reply paused: you\'re talking. It\'s dropped once your message goes'), reasons(f));
  assert.equal(f.session.held(), 1, 'the rest waits, from the sentence it stopped in');
  // You go on: all of it is your turn.
  for (let i = 0; i < 30; i++) f.session.frame(frame(8000));
  f.quiet(1200);
  await until(() => f.session.pending() === 'Hold on, book the train instead.');
  await f.talk();
  await until(() => f.sent.length === 1);
  assert.equal(
    f.sent[0],
    'Hold on, book the train instead.\n\n[heard up to: "…the morning from gate twelve. The train to"] [not played from there: "Lisbon costs about forty euros if you book today."]',
  );
  // Nothing of it plays again.
  f.quiet(3000);
  f.now.addAndGet(30_000);
  f.session.tick();
  await sleep(200);
  assert.deepEqual(f.spoken, [LONG_REPLY]);
  assert.equal(f.session.unheard(), 0);
});

test('aReplyTalkedOverWithNoMessageAfterItIsNotedWithTheCallsEnd', async () => {
  const f = await playingReply('Hold on', '');
  f.heardChars = LONG_REPLY.indexOf('twelve');
  assert.ok((await talkOverUntilStopped(f, 8000, 200)) > 0);
  f.quiet(1200); // Your turn's words: none in the end, nothing to send.
  await until(() => f.transcriptions === 2);
  await sleep(100);
  f.session.end();
  assert.equal(
    f.session.endNote(),
    '\n\n[heard up to: "…leaves at nine in the morning from gate"] [not played from there: "twelve. The train to Lisbon costs about forty euros if you book…"]',
  );
  assert.equal(f.sent.length, 0);
});

test('aLoudSoundWithoutWordsOverAReplyNeverStopsIt', async () => {
  // Philipp, 27 November 2026: a pan in the kitchen interrupted the reply. Loud as a voice, two
  // seconds long, but written down it has no words: the reply plays on.
  const f = await playingReply('', '', '', '');
  f.heardChars = LONG_REPLY.indexOf('Lisbon');
  assert.equal(await talkOverUntilStopped(f, 8000, 100), -1);
  f.quiet(1200);
  await until(() => f.transcriptions >= 2); // While it went on, and once it ended.
  await sleep(100);
  assert.equal(f.session.state(), State.READING);
  assert.ok(!f.stopped);
  assert.ok(reasons(f).includes('A sound over the reply had no words of yours: it plays on'), reasons(f));
  f.done();
  assert.equal(f.session.state(), State.LISTENING);
  f.session.end();
  assert.equal(f.session.endNote(), '', 'heard to its end: nothing to note');
  assert.equal(f.sent.length, 0);
});

test('oneWordOverAReplyDoesntStopItTwoDo', async () => {
  const f = await playingReply('Hmm, yes', '', 'Wait, stop');
  f.heardChars = LONG_REPLY.indexOf('Lisbon');
  // "Hmm, yes": a filler and one word.
  for (let i = 0; i < 60; i++) f.session.frame(frame(8000));
  f.quiet(1200);
  await until(() => f.transcriptions >= 1);
  await sleep(100);
  assert.ok(!f.stopped);
  // "Wait, stop": two words of yours.
  assert.ok((await talkOverUntilStopped(f, 8000, 200)) > 0);
  assert.equal(f.session.state(), State.LISTENING);
  assert.ok(f.logText().includes('barge-in: 2 word(s) of yours heard over the reply ("Wait, stop")'), f.logText());
});

test('wordsOfTheReplyItselfAreItsEchoNotYours', () => {
  const reply = LONG_REPLY;
  const at = reply.indexOf('Lisbon');
  assert.equal(HandsFreeSession.ownWords('The train to Lisbon', reply, at), 0);
  assert.equal(HandsFreeSession.ownWords('um, uh, hmm.', reply, at), 0);
  assert.equal(HandsFreeSession.ownWords('Okay.', reply, at), 1);
  assert.equal(HandsFreeSession.ownWords('Wait, stop.', reply, at), 2);
  assert.equal(HandsFreeSession.ownWords('Hold on, the train', reply, at), 2);
  const longer = 'The flight is booked. ' + 'Nothing else is planned for that day. '.repeat(10);
  assert.equal(HandsFreeSession.ownWords('flight', longer, longer.length), 1, 'far from where it plays, a word of it is yours');
  assert.equal(HandsFreeSession.ownWords('', reply, at), 0);
  assert.equal(HandsFreeSession.ownWords('don\'t go', '', 0), 2);
});

test('whenJevSaysYoureNotDoneAndYouStayQuietTheWaitingReplyPlaysAndYourWordsWait', async () => {
  const f = new Fake('I\'m still thinking about', 'the hotel. Over.');
  f.session.judge = async (said) => (said.endsWith('Over.') ? verdict('over', 0.95, 0) : verdict('unfinished', 0.1, 0));
  f.quiet(1000);
  f.speak();
  f.session.reply('r0', 'Your table is booked.');
  await sleep(100);
  assert.equal(f.spoken.length, 0, 'not while you talk');
  f.quiet(1200); // Jev: not done. You stay quiet: the reply plays.
  await until(() => f.spoken.length === 1);
  assert.equal(f.sent.length, 0);
  await hear(f, 1);
  f.quiet(500);
  // You go on: your words from before go with it, and the reply was heard: nothing noted.
  await f.talk();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'I\'m still thinking about the hotel.');
});

test('aReplyArrivingWhileYouTalkIsDroppedWhenYourMessageGoesAndNeverPlays', async () => {
  const f = new Fake('I was thinking about the trip');
  f.quiet(1000);
  f.speak();
  f.session.reply('r1', 'Your table is booked.');
  await sleep(150);
  assert.equal(f.spoken.length, 0, 'not while you talk');
  assert.equal(f.session.held(), 1, 'waiting while you talk');
  f.quiet(1600);
  f.session.sendNow();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'I was thinking about the trip\n\n[not played: "Your table is booked."]');
  f.session.tick();
  await sleep(150);
  assert.equal(f.spoken.length, 0, 'not after your turn either');
});

test('clattersAndItsOwnEchoNeverStopAReply', async () => {
  const f = await playingReply();
  for (let i = 0; i < 6; i++) {
    for (let k = 0; k < 10; k++) f.session.frame(frame(9000)); // 200 ms, far louder than the room.
    for (let k = 0; k < 80; k++) f.session.frame(frame(300)); // 1.6 s of its leftover echo.
  }
  assert.ok(!f.stopped);
  assert.equal(f.session.state(), State.READING);
  assert.equal(f.session.liveState(), Live.PLAYING);
  assert.equal(f.transcriptions, 0);
  f.done();
  assert.equal(f.session.unheard(), 0);
  assert.equal(f.session.pending(), '');
});

test('theNotesSayHowMuchOfAReplyWasHeard', () => {
  assert.equal(
    HandsFreeSession.heardUpTo(LONG_REPLY, LONG_REPLY.indexOf('twelve')),
    '[heard up to: "…leaves at nine in the morning from gate"] [not played from there: "twelve. The train to Lisbon costs about forty euros if you book…"]',
  );
  // A word cut in the middle isn't counted as heard.
  assert.ok(HandsFreeSession.heardUpTo(LONG_REPLY, LONG_REPLY.indexOf('leaves') + 3).startsWith('[heard up to: "The flight"] [not played from there: "leaves at nine'));
  // Played to its end: nothing left out.
  assert.equal(HandsFreeSession.heardUpTo('Yes, booked for eight.', 22), '[heard up to: "Yes, booked for eight."]');
  // Hardly anything heard: as if not played at all.
  assert.ok(HandsFreeSession.heardUpTo(LONG_REPLY, 3).startsWith('[not played: "The flight leaves'));
  // Several replies not played: one note each.
  assert.equal(HandsFreeSession.missed(['One.', 'Two.']), '[not played: "One."]\n[not played: "Two."]');
});

// ------------------------------------------------------------------ taking the turn, and the send word

test('speechWithLittleGapsTakesTheTurn', async () => {
  // Real dead calls: "Hi, can you hear me" in short loud bits, never a second without a gap.
  const f = new Fake('Hi, can you hear me?');
  for (let i = 0; i < 100; i++) f.session.frame(frame(212)); // A room: background about 150.
  for (let b = 0; b < 3; b++) {
    // 0.2 s bits at about 5× the background, 0.2 s gaps.
    for (let i = 0; i < 10; i++) f.session.frame(frame(1100));
    for (let i = 0; i < 10; i++) f.session.frame(frame(212));
  }
  assert.equal(f.session.floor(), HandsFreeSession.Floor.YOU);
  for (let i = 0; i < 60; i++) f.session.frame(frame(212));
  await until(() => f.session.pending() === 'Hi, can you hear me?');
});

test('aShortClearlyLoudBurstTakesTheTurn', async () => {
  const f = new Fake('Hello?');
  f.quiet(1000);
  for (let i = 0; i < 6; i++) f.session.frame(frame(6000)); // 0.12 s, far louder than the room.
  f.quiet(1200);
  await until(() => f.session.pending() === 'Hello?');
});

test('theBackgroundIsLearnedFastAtTheStart', () => {
  const s = new HandsFree.Segmenter(800, () => {});
  feed(s, 50, 600);
  assert.ok(s.background() < 60, 'background ' + s.background());
});

test('sendWritesDownSoundsThatDidntCountAsSpeech', async () => {
  const f = new Fake('Hi, can you hear me?');
  for (let i = 0; i < 100; i++) f.session.frame(frame(212));
  for (let b = 0; b < 2; b++) {
    // Two bits too short to take the turn.
    for (let i = 0; i < 4; i++) f.session.frame(frame(1100));
    for (let i = 0; i < 60; i++) f.session.frame(frame(212));
  }
  assert.equal(f.session.floor(), HandsFreeSession.Floor.OPEN);
  f.session.sendNow();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Hi, can you hear me?');
  assert.ok(reasons(f).includes('Send: writing down what didn\'t count as speech'), reasons(f));
});

test('theSendWordOnItsOwnAfterSendIsntAnEmptyTurn', async () => {
  // 22:37: Send pressed while the part was written down, then "over." came as a part of its own.
  const f = new Fake('Maybe it\'s also not needed', 'over.');
  await f.talk();
  await until(() => f.session.pending() !== '');
  f.session.sendNow();
  await until(() => f.sent.length === 1);
  await f.talk();
  await until(() => reasons(f).includes('Send word heard: your message had already gone'));
  assert.equal(f.sent.length, 1);
  assert.ok(!f.logText().includes('your turn ended without a message'), f.logText());
});

test('eachCheckWritesDownOnlyTheNewPartAndSendRightAfterWritesNothing', async () => {
  const f = new Fake('Book the', 'hotel for Friday');
  await f.talk();
  await until(() => f.session.pending() === 'Book the');
  await f.talk();
  await until(() => f.session.pending() === 'Book the hotel for Friday');
  assert.equal(f.transcriptions, 2);
  f.session.sendNow();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the hotel for Friday');
  assert.equal(f.transcriptions, 2, 'Send after a check: nothing written down again');
});

test('onlyTheNewPartIsWrittenDownAtAPauseButTheWholeTurnInOnePassIsWhatGoes', async () => {
  // On its own, a part's first word came out wrong; in one pass with the rest it's right.
  const f = new Fake('Book that', 'hotel for Friday. Over.');
  f.wholeAs = (t) => t.replace('Book that', 'Book the');
  const asked = [];
  f.session.judge = async (said) => {
    asked.push(said);
    return said.endsWith('Over.') ? verdict('over', 0.95, 0) : verdict('unfinished', 0.1, 0);
  };
  await f.talk();
  await until(() => f.session.pending() === 'Book that');
  await f.talk();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the hotel for Friday.');
  assert.equal(f.transcriptions, 2, 'each part written down once, on its own');
  assert.deepEqual(asked, ['Book that', 'Book that hotel for Friday. Over.'], 'Jev judges the parts\' text, whole');
  const log = f.logText();
  assert.ok(log.includes('check (pause): 2 part(s), '), log);
  assert.ok(log.includes('1 new (1.') && log.includes(' s) written down in '), log);
  assert.ok(log.includes('whole turn (2 parts) written down in '), log);
  assert.ok(log.includes('it changed 1 of 6 words of the parts\' text'), log);
});

test('whenTheWholeTurnsPassFailsThePartsTextGoes', async () => {
  const f = new Fake('Book the hotel', 'for Friday. Over.');
  f.wholeFails = true;
  await f.talk();
  await until(() => f.session.pending() === 'Book the hotel');
  await f.talk();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the hotel for Friday.');
  assert.ok(f.logText().includes('the whole turn couldn\'t be written down (Fake provider error): the parts\' text goes'));
});

test('endingTheCallWhileTheWholePassIsWaitedForSendsYourWordsOnce', async () => {
  const f = new Fake('Book the hotel', 'for Friday. Over.');
  await f.talk();
  await until(() => f.session.pending() === 'Book the hotel');
  f.slowWhole = latch();
  await f.talk(); // Jev (none: the send word) says done; sending waits for the whole pass.
  await until(() => f.wholes >= 1);
  f.session.end();
  f.slowWhole.countDown();
  await sleep(500);
  assert.equal(f.sent.length, 1, f.logText());
  assert.ok(f.sent[0].startsWith('Book the hotel for Friday'), f.sent[0]);
});

test('talkingOnWhileTheWholePassIsWaitedForMeansNoSendYet', async () => {
  const f = new Fake('Book the hotel', 'for Friday. Over.', 'and the car. Over.');
  await f.talk();
  await until(() => f.session.pending() === 'Book the hotel');
  f.slowWhole = latch();
  await f.talk();
  await until(() => f.wholes >= 1);
  f.speak(); // On you go, mid-sentence.
  f.slowWhole.countDown();
  await sleep(300);
  assert.equal(f.sent.length, 0);
  f.slowWhole = null;
  f.quiet(1200);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the hotel for Friday. Over. and the car.');
});

test('whenThePartsHaveNoWordsButTheWholePassHasThemTheyGo', async () => {
  // Each part alone came out empty (the first kept: you talked on while it was checked); in one
  // pass the words are there.
  const f = new Fake('', '');
  f.wholeAs = () => 'Book the table.';
  f.session.judge = async () => verdict('request', 0.95, 0);
  f.slow = latch();
  await f.talk();
  await until(() => f.session.checkStep() === 'writing');
  f.speak(); // On you go while it's written down.
  f.slow.countDown();
  f.quiet(1200);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the table.');
});

test('yourLastWordsGoAsFarAsTheyWereWrittenDownWhenThRestFails', async () => {
  const f = new Fake('Book the hotel'); // The next part's transcription fails.
  f.session.judge = async () => verdict('more', 0.1, 0);
  await f.talk();
  await until(() => f.session.pending() === 'Book the hotel');
  f.speak();
  f.session.end();
  for (let i = 0; i < 250 && f.sent.length === 0; i++) await sleep(20); // The fake waits 2 s for the part's text.
  assert.deepEqual(f.sent, ['Book the hotel'], f.logText());
  assert.ok(f.logText().includes('some of your last words couldn\'t be written down'));
});

test('aReplyThatStopsPartWayIsNotPlayedAgainAndYourNextMessageSaysHowFar', async () => {
  const f = new Fake('Thanks. Over.');
  f.quiet(1000);
  f.session.reply('r1', LONG_REPLY);
  await until(() => f.spoken.length === 1);
  f.heardChars = LONG_REPLY.indexOf('Lisbon');
  f.fail(); // Its audio stopped coming part-way.
  await sleep(300);
  assert.equal(f.spoken.length, 1, 'not played again');
  assert.ok(reasons(f).includes('Reply stopped part-way'), reasons(f));
  f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
  await f.talk();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Thanks.\n\n[heard up to: "…the morning from gate twelve. The train to"] [not played from there: "Lisbon costs about forty euros if you book today."]');
});

test('wordsChangedCountsWordsAddedDroppedOrChanged', () => {
  assert.equal(HandsFreeSession.wordsChanged('Book the hotel.', 'book the  hotel'), 0);
  assert.equal(HandsFreeSession.wordsChanged('Book that hotel', 'Book the hotel'), 1);
  assert.equal(HandsFreeSession.wordsChanged('Book the hotel', 'Book the hotel for Friday'), 2);
  assert.equal(HandsFreeSession.wordsChanged('', 'one two three'), 3);
});
