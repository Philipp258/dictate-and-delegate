'use strict';
// HandsFreeTest.java, part 3: live transcription, the send word checked by Jev, words before and
// after a send word, Jev, visible reasons, replies reach you, voices, the log.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const HandsFree = require('../src/core/handsfree');
const HandsFreeLog = require('../src/core/handsfree-log');
const HandsFreeService = require('../src/core/handsfree-call');
const { HandsFreeSession } = require('../src/core/handsfree-session');
const { sleep, waitFor } = require('../src/core/util');
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
  verdict,
  overIsDone,
  LONG_REPLY,
  playingReply,
  optional,
} = require('./support/handsfree-fakes');

const { State, Floor, Live, Cue } = HandsFreeSession;

// ------------------------------------------------------------------ live transcription

test('aSendWordAtTheEndOfTheLiveTextSendsAtOnceWithoutAPauseOnceJevAgrees', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  const asked = [];
  f.session.judge = async (said) => {
    asked.push(said);
    return verdict('over', 0.95, 0);
  };
  f.quiet(1000);
  f.speak(); // Still talking: no pause yet.
  live.say('Book the table for Friday');
  assert.equal(f.session.pending(), 'Book the table for Friday');
  live.finalText = 'Book the table for Friday. Over.';
  live.say('Book the table for Friday over');
  await sleep(100);
  assert.equal(f.sent.length, 0, 'not before you\'re quiet a moment after it');
  f.quiet(400);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the table for Friday.');
  assert.equal(f.transcriptions, 0, 'nothing written down from audio');
  assert.deepEqual(asked, ['Book the table for Friday over'], 'Jev asked once, about the live text');
  const log = f.logText();
  assert.ok(log.includes('live text ends with the send phrase: "Book the table for Friday over"'), log);
  assert.ok(log.includes('Jev on the send phrase in '), log);
  assert.ok(log.includes('send phrase: quiet '), log);
  assert.ok(log.includes('ms after the phrase was heard)'), log);
  // The stretch it was said in ends at the pause: it went with the message, nothing more is checked.
  f.quiet(1200);
  await sleep(150);
  assert.ok(f.logText().includes('the rest of the stretch with the phrase'));
  assert.equal(f.sent.length, 1);
  assert.ok(!reasons(f).includes('heard no words'), reasons(f));
  assert.equal(f.session.floor(), Floor.OPEN);
});

test('withoutJevTheSendWordSendsAndEndTheCallEndsIt', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  f.quiet(1000);
  f.speak();
  live.say('Remind me to call Jana. Over.');
  f.quiet(400);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Remind me to call Jana.');
  f.quiet(1200);
  await sleep(150);
  f.speak();
  live.say('Thanks, that was everything. End the call.');
  f.quiet(800);
  await sleep(200);
  // No Jev to confirm the goodbye: not at once; at the pause the end words still end it.
  assert.equal(f.session.state(), State.LISTENING);
  assert.ok(f.logText().includes('Jev couldn\'t confirm the goodbye (no judge): not ended'));
  f.quiet(600);
  await until(() => f.session.state() === State.ENDED);
  await until(() => f.sent.length === 2); // The last words go after the end.
  assert.equal(f.sent[1], 'Thanks, that was everything.');
});

test('aSendWordWhoseFinalTextGoesOnSendsNothing', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  f.session.judge = async () => verdict('over', 0.9, 0); // Jev took it for the end: the final text says otherwise.
  f.quiet(1000);
  f.speak();
  // The live text ended with "over" for a moment; the final text goes on.
  live.finalText = 'The game is over and then we left';
  live.say('The game is over');
  f.quiet(400);
  await until(() => f.logText().includes('doesn\'t end with the phrase'));
  assert.equal(f.sent.length, 0);
  live.say('and the train was late. Over.');
  f.quiet(400);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'The game is over and then we left and the train was late.');
});

test('endTheCallWithoutAPauseAfterItIsAHesitationNotAGoodbye', async () => {
  // "Should we end the call … tomorrow": a hesitation after "call" doesn't hang up.
  const f = new Fake();
  const live = new FakeLive(f);
  f.quiet(1000);
  f.speak();
  live.say('Should we end the call');
  f.quiet(300); // A hesitation, shorter than hanging up waits for.
  f.speak();
  live.say('Should we end the call tomorrow');
  f.quiet(800);
  await sleep(200);
  const log = f.logText();
  assert.equal(f.session.state(), State.LISTENING, log);
  assert.ok(log.includes('you went on after the phrase: not an ending'), log);
  assert.equal(f.sent.length, 0, log);
});

test('jevConfirmsAGoodbyeBeforeTheCallEnds', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  const asked = [];
  f.session.judge = async (said) => {
    asked.push(said);
    return said.includes('Thanks') ? verdict('end', 0.9, 0.95) : verdict('request', 0.2, 0.1);
  };
  f.quiet(1000);
  f.speak();
  live.say('Ask Jana how to end the call'); // Then quiet: but it's not a goodbye.
  f.quiet(800);
  await until(() => f.logText().includes('Jev: not a goodbye'));
  assert.equal(f.session.state(), State.LISTENING);
  f.speak();
  live.say('Ask Jana how to end the call and tell her. Thanks, end the call.');
  f.quiet(800);
  await until(() => f.session.state() === State.ENDED);
  assert.equal(f.sent[0], 'Ask Jana how to end the call and tell her. Thanks');
});

test('aReplyAfterASendPhraseDoesntCostTheNextStretch', async () => {
  const f = new Fake('Second.');
  const live = new FakeLive(f);
  f.session.judge = async (said) => overIsDone(said);
  f.quiet(1000);
  f.speak();
  live.say('Book the table. Over.');
  f.quiet(400); // Sent while the stretch goes on: its rest went with the message.
  await until(() => f.sent.length === 1);
  f.session.reply('r1', 'Done.');
  f.quiet(1200);
  await until(() => f.spoken.length === 1);
  f.done();
  f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
  live.fail('connection lost');
  await f.talk(); // The next stretch is yours, written down.
  f.now.addAndGet(HandsFreeSession.REPRESS_MS + 1);
  f.session.sendNow();
  for (let i = 0; i < 100 && f.sent.length < 2; i++) await sleep(20);
  assert.deepEqual(f.sent, ['Book the table.', 'Second.'], f.logText());
});

test('audioWithoutLiveTextIsWrittenDownNotDropped', async () => {
  // Send pressed before the first live words came (or a short turn they never came for).
  const f = new Fake('Book the table.');
  new FakeLive(f);
  f.quiet(1000);
  await f.talk();
  await until(() => f.session.pending() === 'Book the table.');
  assert.ok(f.logText().includes('no live text for 1.'));
  f.session.sendNow();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the table.');
});

test('wordsTakenForAPhraseMidSentenceAreNotWrittenDownAgainAfterAFailure', async () => {
  const f = new Fake('and the train was late. Over.');
  const live = new FakeLive(f);
  f.quiet(1000);
  f.speak();
  live.finalText = 'The game is over and then we left';
  live.say('The game is over');
  f.quiet(400);
  await until(() => f.logText().includes('doesn\'t end with the phrase'));
  f.quiet(1200); // That stretch ends: its words are in the turn already.
  live.fail('connection lost');
  await f.talk();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'The game is over and then we left and the train was late.');
  assert.equal(f.transcriptions, 1, 'only the new part written down');
});

test('aClickAfterASendPhraseDoesntCostTheNextStretch', async () => {
  const f = new Fake('Book the table.', 'Second.');
  const live = new FakeLive(f);
  f.session.judge = async (said) => overIsDone(said);
  f.quiet(1000);
  await f.talk(); // No live words came: written down from its audio, not done yet.
  await until(() => f.session.pending() === 'Book the table.');
  // A click going on (too short to count) as "Over." comes and is acted on. (Live words of the
  // part written down still coming late are dropped: they'd be there twice.)
  for (let i = 0; i < 3; i++) f.session.frame(frame(7000));
  live.say('Over.');
  f.quiet(400);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the table.');
  f.quiet(1200); // The click ends as noise: the next stretch is yours again.
  live.fail('connection lost');
  await f.talk();
  f.now.addAndGet(HandsFreeSession.REPRESS_MS + 1);
  f.session.sendNow();
  for (let i = 0; i < 100 && f.sent.length < 2; i++) await sleep(20);
  assert.equal(f.sent.length, 2, f.logText());
  assert.equal(f.sent[1], 'Second.');
});

test('atAPauseWithoutASendWordJevJudgesTheLiveText', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  const asked = [];
  f.session.judge = async (said) => {
    asked.push(said);
    return verdict('question', 0.95, 0);
  };
  f.quiet(1000);
  f.speak();
  live.say('can you check when the next train leaves');
  live.finalText = 'Can you check when the next train leaves?';
  f.quiet(1200);
  await until(() => f.sent.length === 1);
  assert.deepEqual(asked, ['can you check when the next train leaves']);
  assert.equal(f.sent[0], 'Can you check when the next train leaves?', 'the model\'s final text goes');
  assert.equal(f.transcriptions, 0);
  assert.ok(f.logText().includes('final live text in '));
});

test('whenLiveTranscriptionFailsItSaysSoAndYourWordsAreWrittenDownFromTheirAudio', async () => {
  const f = new Fake('Book the table. Over.');
  const live = new FakeLive(f);
  f.quiet(1000);
  f.speak();
  live.say('Book the');
  live.fail('connection lost');
  await until(() => reasons(f).includes('Live transcription failed (connection lost): your words are written down instead'));
  f.quiet(1200);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the table.');
  assert.equal(f.transcriptions, 1);
});

test('aTurnWhoseLiveTextLooksStuckIsWrittenDownFromItsAudio', async () => {
  // ElevenLabs once stayed on "Mm." for 30 s while Philipp talked.
  const f = new Fake('Book the table for four tonight at eight. Over.');
  const live = new FakeLive(f);
  f.quiet(1000);
  for (let i = 0; i < 4; i++) f.speak(); // 4.8 s of speech.
  live.say('Mm.');
  f.quiet(1200);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the table for four tonight at eight.');
  assert.ok(f.logText().includes('live text looks stuck (1 words for 5.'));
  assert.ok(reasons(f).includes('Live transcription looks stuck'), reasons(f));
});

test('wordsLiveTranscriptionHearsWhileNobodyHasTheFloorAreDropped', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  f.quiet(1000);
  live.say('and now the weather'); // A radio: nobody took the floor.
  assert.equal(f.session.pending(), '');
  f.quiet(3200);
  f.session.tick();
  assert.equal(live.discards, 1);
  assert.ok(f.logText().includes('live text heard words while nobody had the floor: dropped ("and now the weather")'));
});

test('aSendPhraseThatDoesntActAlwaysSaysWhyInTheLog', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  f.quiet(1000);
  // Nobody took the floor: the phrase is only noise's words.
  live.say('game over');
  const log = f.logText();
  assert.ok(log.includes('live text ends with the send phrase, not acted on: nobody had the floor (no speech heard) ("game over")'), log);
  live.say('game over'); // Repeats aren't logged again.
  assert.equal(count(f.logText(), 'not acted on: nobody had the floor'), 1);
  // A reply playing.
  f.session.reply('r0', 'Here\'s what I found.');
  await until(() => f.spoken.length === 1);
  live.say('thanks over');
  assert.ok(f.logText().includes('not acted on: a reply is playing ("thanks over")'));
  f.done();
  // Live transcription failed: written down from audio, and the log says so.
  live.fail('connection lost');
  f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
  f.speak();
  live.say('book it over');
  assert.ok(f.logText().includes('not acted on: live transcription isn\'t working ("book it over")'));
});

test('tenSecondsIntoACallTheLogSaysWhetherLiveTranscriptionWorks', () => {
  const f = new Fake();
  new FakeLive(f);
  f.session.tick();
  f.now.addAndGet(HandsFreeSession.LIVE_CHECK_MS);
  f.session.tick();
  f.session.tick();
  assert.equal(count(f.logText(), 'live transcription 10 s into the call: working'), 1);
  const off = new Fake();
  off.session.tick();
  off.now.addAndGet(HandsFreeSession.LIVE_CHECK_MS);
  off.session.tick();
  assert.ok(off.logText().includes('live transcription 10 s into the call: not used (off, or no key)'));
});

test('wordsLiveTranscriptionHearsWhileNobodyHasTheFloorDontHoldAReply', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  f.quiet(1000);
  live.say('and now the weather'); // A radio.
  f.session.reply('r1', 'Your table is booked.');
  await until(() => f.spoken.length === 1);
  assert.equal(f.session.pending(), '');
});

test('withLiveTranscriptionYourTurnIsYourUnsentWordsNotLoudness', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  f.quiet(1000);
  // Speech without words yet: your turn a moment (the live text's delay), then not.
  f.speak();
  assert.equal(f.session.yourTurn(f.now.get()), 'speaking');
  f.now.addAndGet(HandsFreeSession.WORDLESS_MS);
  assert.equal(f.session.yourTurn(f.now.get()), null, 'loud, but no words: not your turn');
  f.quiet(1200);
  await sleep(150);
  // Words: your turn, however quiet you are.
  f.speak();
  live.say('Book the hotel');
  f.quiet(1500);
  await until(() => f.session.yourTurn(f.now.get()) === 'unsent words'); // Once its check is done.
  f.quiet(5000);
  f.session.tick();
  await sleep(100);
  assert.equal(f.session.yourTurn(f.now.get()), 'unsent words');
  assert.ok(f.logText().includes('turn: yours (unsent words)'));
});

test('aReplyIsSilenceToLiveTranscriptionUntilYouTalkOverIt', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  f.quiet(1000);
  f.session.reply('r1', LONG_REPLY);
  await until(() => f.spoken.length === 1);
  const before = live.loud;
  for (let i = 0; i < 100; i++) f.session.frame(frame(i % 7 === 0 ? 700 : 300)); // Its leftover echo.
  assert.equal(live.loud, before, 'its echo isn\'t sent');
  // You, over it, with little gaps: it takes a while to count as you; all of it goes to live
  // transcription once it does, from the start (not only the last half second).
  let loud = 0;
  for (let i = 0; i < 80 && f.session.state() === State.READING; i++) {
    const voiced = i % 4 < 2;
    if (voiced) loud++;
    f.session.frame(frame(voiced ? 8000 : 50));
  }
  assert.equal(f.session.state(), State.LISTENING);
  assert.ok(live.loud - before >= loud, loud + ' loud frames, ' + (live.loud - before) + ' sent');
});

// ------------------------------------------------------------------ the send word, checked by Jev

test('overThatsAWordOfTheSentenceIsHeldBackByJevAndTheTurnGoesOn', async () => {
  // The sentence from Philipp's call that "over" alone used to send in the middle of.
  const sentence = 'Let someone live there for 3 months until the period is over.';
  const f = new Fake();
  const live = new FakeLive(f);
  const asked = [];
  f.session.judge = async (said) => {
    asked.push(said);
    return said === sentence ? verdict('unfinished', 0.2, 0) : overIsDone(said);
  };
  f.quiet(1000);
  f.speak();
  live.say(sentence);
  f.quiet(400);
  await until(() => reasons(f).includes('Not sent: you seem mid-sentence (20% done)'));
  await sleep(100);
  assert.equal(f.sent.length, 0);
  assert.equal(f.session.floor(), Floor.YOU);
  assert.equal(live.text(), sentence, 'the live text wasn\'t taken: it goes on');
  assert.ok(f.logText().includes('send phrase: Jev is sure you\'re mid-sentence (done 0.20): not sent, the turn goes on'));
  // The live text repeats it (its final): not asked again.
  live.say(sentence);
  await sleep(100);
  assert.deepEqual(asked, [sentence]);
  // You go on, and end with "over" as the send word.
  f.speak();
  live.say(sentence + ' Then we sell it. Over.');
  f.quiet(400);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], sentence + ' Then we sell it.');
  assert.deepEqual(asked, [sentence, sentence + ' Then we sell it. Over.']);
});

test('jevIsAskedAtOnceOnTheSendWordWhileTheQuietAfterItIsWaitedFor', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  const asked = [];
  const answer = latch();
  f.session.judge = async (said) => {
    asked.push(said);
    await answer.promise;
    return verdict('over', 0.95, 0);
  };
  f.quiet(1000);
  f.speak();
  live.say('Book the table for Friday. Over.');
  await until(() => asked.length === 1); // Before you were quiet after it.
  f.quiet(400);
  await sleep(100);
  assert.equal(f.sent.length, 0, 'it waits for Jev');
  answer.countDown();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the table for Friday.');
  assert.ok(reasons(f).includes('Sent: you said "over"'), reasons(f));
});

test('overSaidAgainWhileJevIsAskedAboutTheFirstIsCheckedAfterIt', async () => {
  // Philipp's call, 2 November 2026, 22:36 (Android 3.4.0): "…let's see what happens. Over. Over.
  // Oh, it's just stuck." The second "over" came while Jev was still asked about the first and was
  // never checked: only the next 5 s pause could send.
  const first = "So I will say something else and then let's see what happens. Over.";
  const f = new Fake();
  const live = new FakeLive(f);
  const asked = [];
  const answer = latch();
  f.session.judge = async (said) => {
    asked.push(said);
    if (said === first) {
      await answer.promise;
      return verdict('more', 0.1, 0);
    }
    return verdict('over', 0.95, 0);
  };
  f.quiet(1000);
  f.speak();
  live.say(first);
  await until(() => asked.length === 1);
  f.speak();
  live.say(first + ' Over.');
  f.quiet(400);
  await sleep(100);
  assert.equal(f.sent.length, 0);
  answer.countDown();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], first);
  assert.deepEqual(asked, [first], 'said twice, Jev isn\'t asked again');
  assert.ok(f.logText().includes('a phrase is being checked already; checked again after it'), f.logText());
  assert.ok(f.logText().includes('the send word said again and again: sent without asking Jev'), f.logText());
});

test('overSaidAgainWhileJevFailsIsAskedAgain', async () => {
  const first = 'Book the table. Over.';
  const f = new Fake();
  const live = new FakeLive(f);
  const asked = [];
  const answer = latch();
  f.session.judge = async (said) => {
    asked.push(said);
    if (said === first) {
      await answer.promise;
      throw new Error('HTTP 502');
    }
    return verdict('over', 0.95, 0);
  };
  f.quiet(1000);
  f.speak();
  live.say(first);
  await until(() => asked.length === 1);
  f.speak();
  live.say(first + ' Over.');
  f.quiet(400);
  answer.countDown();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], first);
});

test('whenJevCantTellOnASendWordNothingIsSent', async () => {
  // Only Jev's clear "done" ends your turn: the send word only asks (Philipp's design, 2 November 2026).
  const f = new Fake();
  const live = new FakeLive(f);
  f.session.judge = async () => {
    throw new Error('HTTP 502');
  };
  f.quiet(1000);
  f.speak();
  live.say('Book the table. Over.');
  f.quiet(400);
  await until(() => f.logText().includes('Jev couldn\'t tell whether you\'re done (HTTP 502): not sent, your pause asks again'));
  await sleep(100);
  assert.equal(f.sent.length, 0);
  assert.ok(reasons(f).includes('Couldn\'t ask whether you\'re done (HTTP 502): not sent; say "over" again or press Send'), reasons(f));
  assert.equal(f.session.floor(), Floor.YOU);
  // Too slow: given up after phraseJudgeMs, and not sent either.
  const was = HandsFreeSession.phraseJudgeMs;
  HandsFreeSession.phraseJudgeMs = 200;
  try {
    const g = new Fake();
    const l = new FakeLive(g);
    g.session.judge = async () => {
      await sleep(5000);
      return verdict('more', 0.1, 0);
    };
    g.quiet(1000);
    g.speak();
    l.say('Book the train. Over.');
    g.quiet(400);
    await until(() => g.logText().includes('Jev couldn\'t tell whether you\'re done (no answer in 200 ms)'));
    await sleep(100);
    assert.equal(g.sent.length, 0);
  } finally {
    HandsFreeSession.phraseJudgeMs = was;
  }
});

test('onTheSendWordJevOnlyHasToNotBeSureYoureMidSentence', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  f.session.judge = async () => verdict('over', 0.6, 0); // Likely done, not clearly.
  f.quiet(1000);
  f.speak();
  live.say('Book the table. Over.');
  f.quiet(400);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the table.');
  assert.ok(f.logText().includes('send phrase: Jev isn\'t sure you\'re done (done 0.60), but you said the send word: sent'), f.logText());
});

// Philipp's call, 6 November 2026, 08:49 (Android 3.6.0): Jev's answers on the send word, as logged.
const OPTIONS =
  "Oh, because there's more options. And we should explore all the options. Like another good option would be to have a kind of mode." +
  ' So maybe not buttons, but like one switch on the overlay between, or like even allowing hand assistants. Like end BBs.' +
  ' And just have a kind of a switch between them. End the robot. Overlay. Oh, we have the 2 apps, right, with 2 hotkeys.' +
  " Oh, nice. Allowing you to have multiple times. With different hotkeys, such as having configurable hotkeys. And I don't" +
  ' know, like, first of all, maybe there are even more options, and then you should weigh the disadvantages and the' +
  ' advantages of those options.';

/** Says text as the live text, ending a turn with Jev answering v; what was sent ('' none). */
async function phraseSends(text, v, asked) {
  const f = new Fake();
  const live = new FakeLive(f);
  f.session.judge = async (said) => {
    asked.push(said);
    return v;
  };
  f.quiet(1000);
  f.speak();
  live.say(text);
  f.quiet(400);
  await until(() => f.sent.length === 1 || reasons(f).includes('Not sent'));
  await sleep(100);
  return f.sent.length === 0 ? '' : f.sent[0];
}

test('overSendsUnlessJevIsSureYoureMidSentence', async () => {
  const asked = [];
  // 08:52:31: "over (done 0.68)" held it back.
  assert.equal(await phraseSends(OPTIONS + ' Over.', verdict('over', 0.68, 0), asked), OPTIONS);
  // 09:11:38 and 09:11:44: "unfinished (done 0.48)", "unfinished (done 0.37)".
  assert.equal(await phraseSends('From, uh, since yesterday over.', verdict('unfinished', 0.48, 0), asked), 'From, uh, since yesterday');
  assert.equal(await phraseSends('From, uh, since yesterday over. Well, over.', verdict('unfinished', 0.37, 0), asked), 'From, uh, since yesterday over. Well');
  assert.equal(asked.length, 3);
  // 08:51:59: "…switch between them. End the over." was mid-sentence (he went on "End the robot.
  // Overlay."), Jev "unfinished (done 0.26)": held back, as it was.
  assert.equal(await phraseSends('And just have a kind of a switch between them. End the over.', verdict('unfinished', 0.26, 0), asked), '');
});

test('overSaidTwiceOrMoreSendsWithoutAskingJev', async () => {
  // 08:52:35 and 08:52:38: "Over. Over." got done 0.66, "Over. Over. Over." 0.50; he pressed Send.
  for (const repeats of [' Over. Over.', ' Over. Over. Over.']) {
    const asked = [];
    const sent = await phraseSends(OPTIONS + repeats, verdict('over', 0.1, 0), asked);
    assert.equal(sent, (OPTIONS + repeats).slice(0, -' Over.'.length), repeats);
    assert.deepEqual(asked, [], repeats);
  }
});

test('overSaidAgainAfterJevHeldItBackSendsWithoutAskingAgain', async () => {
  // "End the over." held back (08:51:59); you say "over" once more: it goes.
  const first = 'And just have a kind of a switch between them. End the over.';
  const f = new Fake();
  const live = new FakeLive(f);
  const asked = [];
  f.session.judge = async (said) => {
    asked.push(said);
    return verdict('unfinished', 0.26, 0);
  };
  f.quiet(1000);
  f.speak();
  live.say(first);
  f.quiet(400);
  await until(() => reasons(f).includes('Not sent: you seem mid-sentence (26% done)'));
  f.speak();
  live.say(first + ' Over.');
  f.quiet(400);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], first);
  assert.deepEqual(asked, [first]);
  assert.ok(reasons(f).includes('Sent: you said "over"'), reasons(f));
});

test('atAPauseATurnEndingWithOverNeedsLessFromJevOneWithoutItIsAsBefore', async () => {
  // 08:52:43, the pause after "Over. Over. Over.": Jev "over (done 0.59)", not sent. Now it goes
  // without asking.
  const f = new Fake(OPTIONS + ' Over. Over. Over.');
  const asked = [];
  f.session.judge = async (said) => {
    asked.push(said);
    return verdict('over', 0.59, 0);
  };
  await f.talk();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], OPTIONS + ' Over. Over.');
  assert.deepEqual(asked, []);
  // Once: Jev's 0.59 is enough.
  const g = new Fake(OPTIONS + ' Over.');
  g.session.judge = async () => verdict('over', 0.59, 0);
  await g.talk();
  await until(() => g.sent.length === 1);
  assert.equal(g.sent[0], OPTIONS);
  // Jev sure you're mid-sentence: not sent.
  const m = new Fake('And just have a kind of a switch between them. End the over.');
  m.session.judge = async () => verdict('unfinished', 0.26, 0);
  await m.talk();
  await until(() => reasons(m).includes('Not sent: you seem mid-sentence (26% done)'));
  assert.equal(m.sent.length, 0);
  // Without the send word the pause still needs Jev's clear "done" (0.7).
  const p = new Fake("It's like a 3-room apartment, I think.");
  p.session.judge = async () => verdict('request', 0.59, 0);
  await p.talk();
  await until(() => reasons(p).includes('Not sent: not clearly done yet (59%)'));
  assert.equal(p.sent.length, 0);
});


// ------------------------------------------------------------------ words before and after a send word

/** StreamingSpeechTest's provider: answers each upgrade, sends what the test tells it to on the latest. */
class Provider {
  static async start() {
    const p = new Provider();
    p.wss = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: false });
    p.connections = 0;
    p.wss.on('connection', (c) => {
      p.latest = c;
      p.connections++;
      c.on('error', () => {});
    });
    await new Promise((r) => p.wss.on('listening', r));
    return p;
  }

  send(text) {
    this.latest.send(text);
  }

  url() {
    return `ws://127.0.0.1:${this.wss.address().port}/v3/ws`;
  }

  close() {
    for (const c of this.wss.clients) c.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

/** An AssemblyAI turn message. */
function turn(order, end, transcript) {
  return `{"type":"Turn","turn_order":${order},"end_of_turn":${end},"transcript":"${transcript}"}`;
}

test('aSendWordAfterAPauseSendsTheWordsBeforeItWhenLiveTranscriptionReconnected', async () => {
  // Philipp's call, 27 October 2026, 09:17:53–09:18:03, with AssemblyAI as it answered: the
  // connection had closed after a minute without speech and opened again. "Okay.", a pause
  // (Jev: more), then "Over." alone, and "Build it." in the same breath. It sent nothing: "Only
  // the send word was heard", and "Build it." was dropped as heard "while nobody had the floor".
  const S = require('../src/core/streaming-speech');
  const was = S.StreamingSpeech.assemblyAiUrl;
  const p = await Provider.start();
  const waitUntil = (c) => waitFor(c, 2000);
  try {
    S.StreamingSpeech.assemblyAiUrl = p.url();
    const f = new Fake();
    const s = S.create(S.AAI_PRO, 'k', ['over']);
    const t0 = Date.now();
    s.clock = () => f.now.get() + Date.now() - t0; // The session's time, running (take waits by it).
    s.events = (l) => f.log.push(l);
    const asked = [];
    f.session.judge = async (said) => {
      asked.push(said);
      switch (said) {
        case 'Okay.':
          return verdict('more', 0.33, 0);
        case 'Okay. Over.':
          return verdict('over', 0.9, 0);
        case 'Build it.':
          return verdict('request', 0.9, 0);
        default:
          return verdict('more', 0.1, 0);
      }
    };
    // The call so far: a first connection with turns 0 to 3, then it closes and opens again.
    s.speech();
    await waitUntil(() => p.connections === 1);
    for (let i = 0; i <= 3; i++) {
      p.send(turn(i, true, 'Earlier ' + i + '.'));
      await waitUntil(() => s.text() === 'Earlier ' + i + '.');
      await s.take(100);
    }
    // StreamingSpeechTest.reconnect: a minute without speech (closed), then speech again.
    {
      const before = p.connections;
      f.now.addAndGet(S.IDLE_MS);
      for (let i = 0; i < S.CHUNK_MS / 20; i++) s.audio(Buffer.alloc(640));
      await waitUntil(() => f.logText().includes('closed: no speech'));
      s.speech();
      await waitUntil(() => p.connections === before + 1);
      await sleep(100);
    }
    s.changed = (t) => f.session.liveText(t);
    f.session.live = s;
    f.quiet(1000);
    f.speak();
    p.send(turn(0, false, 'Okay'));
    p.send(turn(0, true, 'Okay.'));
    await until(() => f.session.pending() === 'Okay.');
    f.quiet(1200); // The pause: Jev says more.
    await until(() => reasons(f).includes('Not sent: you seem to have more to say (33% done)'));
    f.speak();
    p.send(turn(1, false, 'Over.'));
    await until(() => f.session.pending() === 'Okay. Over.');
    f.quiet(400);
    // Its final doesn't come (as in the log): after 1.5 s its live text is taken.
    for (let i = 0; i < 200 && f.sent.length === 0; i++) await sleep(20);
    assert.deepEqual(f.sent, ['Okay.'], f.logText());
    // "Build it.", in the same stretch: the next turn's, not dropped.
    f.speak();
    p.send(turn(2, false, 'Build it.'));
    await until(() => f.session.pending() === 'Build it.');
    f.quiet(3200);
    f.session.tick();
    for (let i = 0; i < 200 && f.sent.length < 2; i++) {
      await sleep(20);
      f.session.tick();
    }
    const log = f.logText();
    assert.deepEqual(f.sent, ['Okay.', 'Build it.'], log);
    assert.ok(!log.includes('Only the send word'), log);
    assert.ok(!log.includes('nobody had the floor'), log);
    assert.ok(log.includes('words after the phrase, in the same stretch: they\'re your turn\'s ("Build it.")'), log);
    assert.deepEqual(asked, ['Okay.', 'Okay. Over.', 'Build it.']);
    s.close();
  } finally {
    S.StreamingSpeech.assemblyAiUrl = was;
    await p.close();
  }
});

test('aSendWordAfterAPauseSendsWordsWrittenDownFromAudioThatLiveTranscriptionMissed', async () => {
  // Philipp's call, 27 October 2026, 09:19:24–09:19:33: live transcription took 2.7 s to open,
  // so it missed the turn's first words; they were written down from their audio (Jev:
  // unfinished), then "Over." alone came as the live text and sent nothing.
  const f = new Fake('So it seems to be stuck right over');
  const live = new FakeLive(f);
  const asked = [];
  f.session.judge = async (said) => {
    asked.push(said);
    return said === 'So it seems to be stuck right over' ? verdict('unfinished', 0.07, 0) : verdict('over', 0.9, 0);
  };
  f.quiet(1000);
  await f.talk(); // No live text for it.
  await until(() => reasons(f).includes('Not sent: you seem mid-sentence (7% done)'));
  const log = f.logText();
  assert.ok(log.includes('no live text for 1.'), log);
  assert.ok(log.includes('these words start your turn: live transcription didn\'t hear them'), log);
  assert.equal(live.discards, 0, 'nothing came of it late: nothing dropped (a drop would guess at your next words)');
  f.speak();
  live.say('Over.');
  f.quiet(400);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'So it seems to be stuck right over');
  assert.deepEqual(asked, ['So it seems to be stuck right over'], '"…right over Over." is the send word twice: Jev isn\'t asked');
  assert.equal(f.transcriptions, 1, 'written down once');
  assert.ok(!reasons(f).includes('Only the send word'), reasons(f));
});

test('liveWordsOfAPartWrittenDownFromAudioThatComeLateAreDroppedNotSentTwice', async () => {
  const f = new Fake('So it seems to be stuck right over');
  const live = new FakeLive(f);
  f.session.judge = async (said) => (said === 'So it seems to be stuck right over' ? verdict('unfinished', 0.07, 0) : verdict('over', 0.9, 0));
  const slow = latch();
  f.slow = slow;
  f.quiet(1000);
  await f.talk(); // No live text yet: written down from its audio (slowly).
  await until(() => f.logText().includes('no live text for 1.'));
  live.say('to be stuck right over'); // Its words, late, while it's written down.
  slow.countDown();
  await until(() => reasons(f).includes('Not sent: you seem mid-sentence (7% done)'));
  assert.equal(live.discards, 1);
  f.speak();
  live.say('Over.');
  f.quiet(400);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'So it seems to be stuck right over');
});

test('wordsSaidWhileAPartIsWrittenDownFromAudioAreJudgedWithItAndSentOnce', async () => {
  // You went on while live transcription's missing part was written down: the next check, with
  // your new words, decides, not the one about the part alone.
  const f = new Fake('So it seems to be stuck');
  const live = new FakeLive(f);
  const asked = [];
  f.session.judge = async (said) => {
    asked.push(said);
    return verdict('request', 0.9, 0);
  };
  const slow = latch();
  f.slow = slow;
  f.quiet(1000);
  await f.talk();
  await until(() => f.logText().includes('no live text for 1.'));
  f.speak();
  live.say('Okay.');
  f.quiet(1200); // That stretch ends too: its check waits behind the first.
  await sleep(100);
  slow.countDown();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'So it seems to be stuck Okay.');
  assert.deepEqual(asked, ['So it seems to be stuck Okay.']);
  f.quiet(1200);
  f.now.addAndGet(9000);
  f.session.tick();
  await sleep(200);
  assert.equal(f.sent.length, 1, f.logText());
});

test('aSendWordJevHeldBackDoesntSendWhenJevFailsAtThePause', async () => {
  const sentence = 'Let someone live there for 3 months until the period is over.';
  const f = new Fake();
  const live = new FakeLive(f);
  let calls = 0;
  f.session.judge = async () => {
    if (++calls === 1) return verdict('unfinished', 0.2, 0);
    throw new Error('HTTP 502');
  };
  f.quiet(1000);
  f.speak();
  live.say(sentence);
  f.quiet(400);
  await until(() => reasons(f).includes('Not sent: you seem mid-sentence (20% done)'));
  f.quiet(1200); // The pause: Jev fails.
  await until(() => calls === 2);
  await sleep(200);
  assert.equal(f.sent.length, 0, f.logText());
});

test('sendPressedRightAfterASendWordWhileYouGoOnSendsWhatYouSaidSince', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  f.session.judge = async (said) => (said.endsWith('Over.') ? verdict('over', 0.95, 0) : verdict('more', 0.1, 0));
  f.quiet(1000);
  f.speak();
  live.say('Book the table. Over.');
  f.quiet(400);
  await until(() => f.sent.length === 1);
  f.speak(); // The same stretch goes on.
  live.say('And the car');
  f.now.addAndGet(HandsFreeSession.REPRESS_MS + 1);
  f.session.sendNow(); // Send goes, without asking Jev.
  await until(() => f.sent.length === 2);
  assert.equal(f.sent[1], 'And the car');
  await until(() => f.session.liveState() !== Live.SENDING);
});

test('wordsWrittenDownFromAudioComeBeforeTheLiveTextAfterThem', async () => {
  const f = new Fake('So it seems to be stuck');
  const live = new FakeLive(f);
  f.session.judge = async (said) => (said.endsWith('Over.') ? verdict('over', 0.95, 0) : verdict('unfinished', 0.1, 0));
  f.quiet(1000);
  await f.talk();
  await until(() => reasons(f).includes('Not sent: you seem mid-sentence (10% done)'));
  f.speak();
  live.say('right after the reply.');
  f.quiet(1200); // A pause: Jev is asked about all of it.
  await until(() => count(reasons(f), 'mid-sentence') >= 1 && f.logText().includes('"So it seems to be stuck right after the reply."'));
  f.speak();
  live.say('right after the reply. Over.');
  f.quiet(400);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'So it seems to be stuck right after the reply.');
});

test('onlyTheSendWordThenMoreWordsInTheSameBreathAreTheTurn', async () => {
  // "Over." on its own gives the turn up; what you say right after it isn't lost.
  const f = new Fake();
  const live = new FakeLive(f);
  f.session.judge = async (said) => (said === 'Build it.' ? verdict('request', 0.9, 0) : overIsDone(said));
  f.quiet(1000);
  f.speak();
  live.say('Over.');
  f.quiet(400);
  await until(() => reasons(f).includes('Only the send word was heard: nothing to send'));
  assert.equal(live.discards, 0, 'the live text was taken: nothing of it is dropped (what comes next would be)');
  f.speak();
  live.say('Build it.');
  f.quiet(1200);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Build it.');
});

test('aSendWordThatWasntTheEndThenMoreInTheSameStretchIsCheckedAtItsPause', async () => {
  // 09:15:56: "Mac, over." came out as "Mac, oh, this shit." and the stretch went on for 30 s;
  // its pause asked nothing, so only a later pause or the long silence could send it.
  const f = new Fake();
  const live = new FakeLive(f);
  const asked = [];
  f.session.judge = async (said) => {
    asked.push(said);
    return said.endsWith('?') ? verdict('question', 0.95, 0) : overIsDone(said);
  };
  f.quiet(1000);
  f.speak();
  live.finalText = 'Mac, oh, this shit.';
  live.say('Mac, over.');
  f.quiet(400);
  await until(() => f.logText().includes('doesn\'t end with the phrase'));
  f.speak();
  live.say('So is it still not fully ported or what?');
  f.quiet(1200);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Mac, oh, this shit. So is it still not fully ported or what?');
  assert.deepEqual(asked, ['Mac, over.', 'Mac, oh, this shit. So is it still not fully ported or what?']);
});

// ------------------------------------------------------------------ Jev: is the turn done?

test('atAPauseJevDecidesWhetherYourTurnIsDoneAndSaysWhy', async () => {
  const f = new Fake('Can you check', 'when the next train to Lisbon leaves?');
  const asked = [];
  const answers = [verdict('unfinished', 0.04, 0.0), verdict('question', 0.98, 0.0)];
  f.session.judge = async (said) => {
    asked.push(said);
    return answers.shift();
  };
  await f.talk();
  await until(() => reasons(f).includes('Not sent: you seem mid-sentence (4% done)'));
  assert.equal(f.sent.length, 0);
  assert.equal(f.session.liveState(), Live.WAITING_SEND);
  await f.talk(); // On: the next pause asks again, with the whole turn.
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Can you check when the next train to Lisbon leaves?');
  assert.deepEqual(asked, ['Can you check', 'Can you check when the next train to Lisbon leaves?']);
  assert.ok(reasons(f).includes('Sent: you asked your question (98%)'), reasons(f));
  assert.ok(f.logText().includes('Jev in '), f.logText());
});

test('jevHearingYouWantToEndTheCallSendsWhatCameBeforeAndEnds', async () => {
  const f = new Fake('Thanks, that\'s all. End the call.');
  f.session.judge = async () => verdict('end', 0.5, 0.99);
  await f.talk();
  await until(() => f.session.state() === State.ENDED);
  assert.deepEqual(f.sent, ['Thanks, that\'s all.']);
  assert.ok(reasons(f).includes('Ending the call: you said goodbye'), reasons(f));
});

test('sendAlwaysSendsAtOnceWithoutAskingJev', async () => {
  const f = new Fake('I was thinking about the trip and');
  let asked = 0;
  f.session.judge = async () => {
    asked++;
    return verdict('unfinished', 0.01, 0);
  };
  f.speak(); // Still talking: Send ends the part and sends it.
  f.session.sendNow();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'I was thinking about the trip and');
  assert.equal(asked, 0);
});

test('talkingOnWhileJevIsAskedMeansNoDecision', async () => {
  const f = new Fake('Book the hotel', 'and the car');
  const asking = latch();
  const answer = latch();
  let asked = 0;
  f.session.judge = async () => {
    if (++asked === 1) {
      asking.countDown();
      await answer.promise;
    }
    return verdict('request', 0.95, 0);
  };
  await f.talk();
  await asking.promise;
  f.speak(); // You go on while Jev thinks.
  answer.countDown();
  await sleep(150);
  assert.equal(f.sent.length, 0);
  f.quiet(1200);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the hotel and the car');
});

test('whenJevCantBeAskedAtThePauseNothingIsSentButSendStillWorks', async () => {
  const f = new Fake('Book the table.', 'Over.');
  f.session.judge = async () => {
    throw new Error('timeout');
  };
  await f.talk();
  await until(() => reasons(f).includes('Couldn\'t ask whether you\'re done (timeout): not sent; say "over" or press Send'));
  assert.equal(f.sent.length, 0);
  await f.talk();
  await until(() => f.logText().includes('Jev failed after') && count(f.logText(), 'Jev failed after') === 2);
  await sleep(100);
  assert.equal(f.sent.length, 0, 'the send word only asks Jev');
  f.session.sendNow();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Book the table. Over.');
});

test('jevsAnswerIsReadAsDoneAndEnd', () => {
  const Jev = require('../src/core/jev');
  const r = JSON.parse(
    '{"answers":{"turn":{"type":"choice","choice":"question","probabilities":{"over":0.02,"question":0.9,"request":0.05,"end":0.01,"unfinished":0.01,"more":0.01}}},"usage":{"cost":0.00002}}',
  );
  const v = Jev.turnVerdict(r);
  assert.equal(v.choice, 'question');
  assert.ok(Math.abs(v.send - 0.97) < 1e-9);
  assert.ok(Math.abs(v.end - 0.01) < 1e-9);
  const body = Jev.turnBody('Hi', ['over'], ['end the call']);
  const criteria = body.questions.turn.criteria;
  assert.equal(Object.keys(criteria)[0], 'over'); // First: a fake without a script says done.
  assert.ok(criteria.over.includes('"over"'));
  assert.ok(criteria.end.includes('"end the call"'));
});

test('theBackgroundComesDownOnceTheStartsNoiseHasPassed', () => {
  const s = new HandsFree.Segmenter(800, () => {});
  feed(s, 900, 2000); // Handling noise at the start: about 640.
  feed(s, 50, 1000); // Then the quiet car.
  assert.ok(s.background() < 100, 'background ' + s.background()); // Was about 600 a second later.
});

// ------------------------------------------------------------------ every decision has a visible reason

test('everyEarlyReturnOfSendShowsItsReason', async () => {
  const f = new Fake('Book the table', 'Next words');
  f.session.sendNow();
  assert.equal(f.session.reasons()[0].text, 'Send ignored: nothing heard yet');
  // Already sending: the first press waits for the speech model.
  f.slow = latch();
  await f.talk();
  f.session.sendNow();
  f.session.sendNow();
  assert.equal(f.session.reasons()[0].text, 'Send ignored: already sending');
  f.slow.countDown();
  await until(() => f.sent.length === 1);
  // Right after the message went: the same press.
  f.slow = null;
  await f.talk();
  await until(() => f.session.pending() === 'Next words');
  f.session.sendNow();
  assert.ok(f.session.reasons()[0].text.startsWith('Send ignored: just sent ('), f.session.reasons()[0].text);
  assert.equal(f.session.pending(), 'Next words');
  // A reply playing and nothing of yours to send.
  f.now.addAndGet(HandsFreeSession.REPRESS_MS + 1);
  f.session.sendNow();
  await until(() => f.sent.length === 2);
  f.session.reply('r2', 'An answer.');
  await until(() => f.spoken.length === 1);
  f.now.addAndGet(HandsFreeSession.REPRESS_MS + 1);
  f.session.sendNow();
  assert.equal(f.session.reasons()[0].text, 'Send ignored: a reply is playing and you have nothing unsent');
  // The same reason again counts up instead of filling the list.
  f.session.sendNow();
  assert.equal(f.session.reasons()[0].times, 2);
  assert.ok(f.logText().includes('→ Send ignored: nothing heard yet'), f.logText());
});

test('soundsMarkTheMomentsAndNeverStartYourSpeech', async () => {
  const f = new Fake('Book the table. Over.');
  const cues = [];
  f.session.cues = (c) => {
    cues.push(c);
    return true; // Each plays.
  };
  f.quiet(1000);
  await f.talk();
  await until(() => f.sent.length === 1);
  await until(() => cues.length === 2);
  assert.deepEqual(cues, [Cue.HEARD, Cue.SENT]);
  // The sent sound coming back through the microphone: no speech.
  for (let i = 0; i < 15; i++) f.session.frame(frame(8000));
  assert.ok(!f.session.speaking());
  assert.equal(f.session.liveState(), Live.SENT);
  f.audioStarts = false; // Its voice fails before any audio.
  f.session.reply('r1', 'Done.');
  await until(() => cues.length === 3);
  assert.equal(cues[2], Cue.REPLY);
  for (let i = 1; i <= 1 + HandsFreeSession.RETRIES; i++) {
    // Tried again, then given up.
    const tries = i;
    await until(() => f.spoken.length === tries);
    f.fail();
  }
  assert.ok(cues.includes(Cue.FAILED), String(cues));
});

test('soundTooQuietToCountIsShownWithItsLevels', () => {
  const f = new Fake();
  for (let i = 0; i < 400; i++) f.session.frame(frame(560)); // A loud room: background about 400.
  for (let i = 0; i < 50; i++) f.session.frame(frame(1270)); // A voice not 3× louder.
  for (let i = 0; i < 40; i++) f.session.frame(frame(560));
  const r = reasons(f);
  assert.ok(r.includes('Didn\'t count as speech: too quiet (level 9'), r);
  assert.ok(r.includes(' < 3.0× background 4'), r);
  assert.equal(f.session.floor(), Floor.OPEN);
});

test('aTranscriptionThatFailsShowsWhy', async () => {
  const f = new Fake();
  f.quiet(1000);
  await f.talk();
  await until(() => f.session.error() !== '');
  assert.ok(reasons(f).startsWith('Couldn\'t write down 1.'), reasons(f));
});

// ------------------------------------------------------------------ 3.2.9: replies reach you

test('householdBurstsInAQuietRoomNeverOpenATurnButYourVoiceDoes', () => {
  const started = [];
  const out = [];
  const s = new HandsFree.Segmenter(HandsFree.DEFAULT_PAUSE_MS, () => HandsFree.DEFAULT_TAKE_MS, HandsFree.DEFAULT_GATE, HandsFree.LEVEL, {
    segment(pcm) {
      out.push(pcm);
    },
    started(level, background) {
      started.push(`level ${level.toFixed(0)}, background ${background.toFixed(0)}`);
    },
  });
  const random = new JavaRandom(7);
  feed(s, 140, 3000); // A quiet room: background about 100.
  for (let i = 0; i < 40; i++) {
    // A minute and a half: a cup, a door, a drawer every few seconds.
    const amplitude = 1400 + random.nextInt(2000); // Levels 1000 to 2400: ten to twenty-four times the room.
    feed(s, amplitude, 60 + random.nextInt(5) * 20); // 60 to 140 ms.
    feed(s, 140, 1800 + random.nextInt(1500));
  }
  assert.deepEqual(started, [], 'noise took the turn');
  assert.equal(out.length, 0);
  assert.ok(s.background() < 150, 'background ' + s.background());
  feed(s, 6000, 600); // You, close to the microphone.
  assert.equal(started.length, 1);
  feed(s, 6000, 120);
  feed(s, 140, HandsFree.DEFAULT_PAUSE_MS + 200);
  assert.equal(out.length, 1);
});

/** java.util.Random, so the household test hears the same sounds as on the phone. */
class JavaRandom {
  constructor(seed) {
    this.seed = (BigInt(seed) ^ 0x5deece66dn) & ((1n << 48n) - 1n);
  }

  next(bits) {
    this.seed = (this.seed * 0x5deece66dn + 0xbn) & ((1n << 48n) - 1n);
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)));
  }

  nextInt(bound) {
    if ((bound & -bound) === bound) return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
    let bits, val;
    do {
      bits = this.next(31);
      val = bits % bound;
    } while (bits - val + (bound - 1) < 0 || bits - val + (bound - 1) > 0x7fffffff);
    return val;
  }
}

test('aSoundThatNeverCountsAsSpeechDoesntHoldAReply', async () => {
  const f = new Fake();
  f.quiet(1000);
  clatter(f.session, 2100, 3); // A sound that never counts as speech.
  f.session.reply('r1', 'Your table is booked.');
  for (let i = 0; i < 5 && f.spoken.length === 0; i++) {
    clatter(f.session, 50, 22);
    clatter(f.session, 2100, 3);
    f.session.tick();
    await sleep(50);
  }
  assert.deepEqual(f.spoken, ['Your table is booked.']);
  assert.ok(!reasons(f).includes('Reply waits'), reasons(f));
  assert.equal(f.session.pending(), '', 'the noise never took the turn');
  assert.equal(f.transcriptions, 0);
});

test('waitingForTheVoiceIsShownAndCountsUp', async () => {
  const f = new Fake();
  const fetched = latch();
  f.prepare = async (text) => {
    await fetched.promise;
    return text;
  };
  f.quiet(1000);
  f.session.reply('r1', 'Your table is booked.');
  f.session.tick();
  assert.ok(!reasons(f).includes('its voice'), 'not in the first second');
  f.now.addAndGet(1000);
  f.session.tick();
  assert.ok(reasons(f).startsWith('Reply waits: its voice is being fetched (1 s)'), reasons(f));
  f.now.addAndGet(2000);
  f.session.tick();
  const r = reasons(f);
  assert.ok(r.startsWith('Reply waits: its voice is being fetched (3 s)'), r);
  assert.ok(!r.includes('(1 s)'), 'counted up in place');
  assert.equal(f.log.filter((l) => l.includes('its voice is being fetched')).length, 1);
  fetched.countDown();
  await until(() => f.spoken.length === 1);
});

test('wordsYouStartAsAReplyEndsAreKept', async () => {
  const f = await playingReply('Wait, one more thing');
  for (let i = 0; i < 8; i++) f.session.frame(frame(8000)); // You, over its last words.
  f.done(); // It ends before that's enough to stop it.
  assert.equal(f.session.state(), State.LISTENING);
  for (let i = 0; i < 30; i++) f.session.frame(frame(8000)); // The microphone stayed on.
  f.quiet(1200);
  await until(() => f.session.pending() === 'Wait, one more thing');
  assert.equal(f.session.floor(), Floor.YOU);
});

// ------------------------------------------------------------------ 3.2.10: voices

const Voice = optional('../src/core/voice');
const noVoice = Voice ? false : 'voice.js (the speech agent\'s port) not there yet';

test('rawSamplesBecomeAWavWithTheirRate', { skip: noVoice }, () => {
  assert.deepEqual(Voice.pcmFormat('audio/pcm;rate=44100;channels=1'), [44100, 1]);
  assert.deepEqual(Voice.pcmFormat('audio/pcm; rate=24000'), [24000, 1]);
  assert.equal(Voice.pcmFormat('audio/mpeg'), null);
  assert.equal(Voice.pcmFormat('audio/pcm'), null);
  assert.equal(Voice.pcmFormat(null), null);
  const h = Buffer.from(Voice.wavHeader(24000, 1, 48000));
  assert.equal(h.length, 44);
  assert.equal(h.toString('ascii', 0, 4), 'RIFF');
  assert.equal(h.readInt32LE(4), 36 + 48000);
  assert.equal(h.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(h.readInt16LE(20), 1); // PCM
  assert.equal(h.readInt16LE(22), 1); // mono
  assert.equal(h.readInt32LE(24), 24000);
  assert.equal(h.readInt32LE(28), 48000); // bytes a second
  assert.equal(h.readInt16LE(32), 2);
  assert.equal(h.readInt16LE(34), 16);
  assert.equal(h.toString('ascii', 36, 40), 'data');
  assert.equal(h.readInt32LE(40), 48000);
  // The same header as the app's own WAV files for 16 kHz mono.
  const own = HandsFree.wav(Buffer.alloc(320));
  assert.deepEqual(Buffer.from(Voice.wavHeader(HandsFree.RATE, 1, 320)), own.subarray(0, 44));
});

test('theNewVoicesAskForWhatTheySend', { skip: noVoice }, () => {
  const gemini = Voice.choice('gemini-kore');
  const fish = Voice.choice('fish-drama');
  const mai = Voice.choice('mai-harper');
  const g = Voice.body(gemini, 'Hi');
  assert.equal(g.model, 'google/gemini-3.8-flash-lite-tts');
  assert.equal(g.voice, 'Kore');
  assert.equal(g.response_format, 'pcm');
  assert.equal(Voice.body(Voice.choice('heygen-bram'), 'Hi').response_format, 'pcm');
  const d = Voice.body(fish, 'Hi');
  // Without a voice Fish picked another speaker for each reply: always one of its voice IDs.
  assert.equal(d.voice, '933563129e564b19a115bedd57b7406a');
  assert.equal(d.response_format, 'mp3');
  const field = (c, k) => (typeof c[k] === 'function' ? c[k]() : c[k]);
  for (const c of Voice.CHOICES) assert.ok(field(c, 'model') === '' || field(c, 'voice') !== '', 'a fixed voice: ' + field(c, 'id'));
  assert.equal(field(fish, 'tag'), 'fish-audio/drama-3 (933563129e564b19a115bedd57b7406a)');
  // Android's voice is the Mac's own on the Mac (the same choice, id "android").
  assert.equal(field(Voice.ANDROID, 'tag'), 'the Mac\'s voice');
  assert.equal(Voice.body(mai, 'Hi').voice, 'en-US-Harper:MAI-Voice-2.1-Flash');
  const ids = new Set();
  for (const c of Voice.CHOICES) {
    assert.ok(!ids.has(field(c, 'id')), 'twice: ' + field(c, 'id'));
    ids.add(field(c, 'id'));
  }
  for (const id of ['kokoro', 'eleven', 'android']) assert.ok(ids.has(id), id); // Chosen before: still there.
});

test('aVoiceThatFailsSaysWhy', () => {
  if (Voice) {
    assert.equal(Voice.httpError(503, '{"error":{"message":"No provider available","code":503}}'), 'HTTP 503: No provider available');
    assert.equal(Voice.httpError(502, 'Bad\n  gateway'), 'HTTP 502: Bad gateway');
    assert.equal(Voice.httpError(500, ''), 'HTTP 500');
    assert.ok(Voice.httpError(400, 'x'.repeat(500)).endsWith('…'));
  }
  const f = new Fake();
  f.session.voiceFailed('Kokoro: no answer in 30.0 s', false);
  assert.ok(reasons(f).startsWith('Voice failed (Kokoro: no answer in 30.0 s): no other voice works on this Mac'), reasons(f));
  assert.equal(f.session.voiceError(), 'Kokoro: no answer in 30.0 s');
  assert.ok(f.logText().includes('Voice failed (Kokoro: no answer in 30.0 s)'));
  f.now.addAndGet(HandsFreeSession.VOICE_ERROR_MS);
  assert.equal(f.session.voiceError(), '', 'shown a while, then gone');
  f.session.voiceFailed('Kokoro: HTTP 503: No provider available', true);
  assert.ok(reasons(f).startsWith('Voice failed (Kokoro: HTTP 503: No provider available): the Mac\'s voice reads the reply'), reasons(f));
});

test('liveTranscriptionWithoutItsKeySaysSoForAWhileOnTheCallBarAndAllCallOnScreen', () => {
  const f = new Fake();
  assert.equal(f.session.liveKeyMissing(), '');
  assert.ok(!HandsFreeService.liveOffShown(f.session));
  f.session.liveKeyMissing('AssemblyAI');
  const off = 'Live transcription is off: no AssemblyAI key (Settings → Hands-free)';
  assert.ok(reasons(f).startsWith(off), reasons(f));
  assert.ok(f.logText().includes('→ ' + off), f.logText());
  assert.equal(HandsFreeService.liveOffText(f.session), off);
  assert.equal(HandsFreeService.shortLabel(f.session), 'Live off · no AssemblyAI key');
  // A voice failure goes first.
  f.session.voiceFailed('Kokoro: HTTP 503: No provider available', true);
  assert.equal(HandsFreeService.shortLabel(f.session), 'Voice failed · Kokoro: HTTP 503');
  f.now.addAndGet(HandsFreeSession.VOICE_ERROR_MS);
  assert.equal(HandsFreeService.shortLabel(f.session), 'Live off · no AssemblyAI key');
  // A minute on the call bar; on the screen the whole call.
  f.now.addAndGet(HandsFreeSession.LIVE_OFF_MS - HandsFreeSession.VOICE_ERROR_MS);
  assert.ok(!HandsFreeService.liveOffShown(f.session));
  assert.equal(HandsFreeService.shortLabel(f.session), 'Listening');
  assert.equal(f.session.liveKeyMissing(), 'AssemblyAI');
});

test('aMessageToTheTalkerAndTheChiefNamesTheTalkerFirst', () => {
  assert.deepEqual([...HandsFreeService.bothTo('thr_chief', 'thr_talker', 'to the chief', 'to the talker').keys()], ['thr_talker', 'thr_chief']);
  assert.equal(HandsFreeService.bothTo('thr_chief', 'thr_talker', 'to the chief', 'to the talker').get('thr_talker'), 'to the talker');
  assert.deepEqual(Object.fromEntries(HandsFreeService.bothTo('thr_chief', '', 'to the chief', 'to the talker')), { thr_chief: 'to the chief' });
});

test('aHangingVoiceNeverHoldsUpTheNextReply', async () => {
  const f = new Fake();
  const hang = latch();
  f.prepare = async (text) => {
    if (text.startsWith('First')) await hang.promise;
    return text;
  };
  f.quiet(1000);
  f.session.reply('r1', 'First reply.');
  f.session.reply('r2', 'Second reply.');
  await until(() => f.log.some((l) => l.startsWith('voice ready for r2')));
  hang.countDown();
  await until(() => f.spoken.length === 1);
  assert.equal(f.spoken[0], 'First reply.');
  f.done();
  f.now.addAndGet(HandsFreeSession.TAIL_MS);
  f.session.tick();
  await until(() => f.spoken.length === 2);
});

test('callAudioUsesAHeadsetElseTheSpeakerNeverTheEarpiece', { skip: 'Android only: CallAudio picks the phone\'s audio route; macOS routes call audio itself' }, () => {});

// ------------------------------------------------------------------ the log

test('theLogLosesNoLineFromManyThreadsAndKeepsTheLastThousand', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-')), 'handsfree.log');
  try {
    let old = '';
    for (let i = 0; i < 1000; i++) old += 'old ' + i + '\n';
    fs.writeFileSync(file, old);
    HandsFreeLog.append(file, HandsFreeLog.callStarted('14:05'));
    // Eight writers taking turns between lines (Node's threads of work).
    const writers = [];
    for (let t = 0; t < 8; t++)
      writers.push(
        (async () => {
          for (let i = 0; i < 100; i++) {
            HandsFreeLog.append(file, 'thread ' + t + ' event ' + i);
            await new Promise((r) => setImmediate(r));
          }
        })(),
      );
    HandsFreeLog.append(file, 'call ended'); // While the others write.
    await Promise.all(writers);
    HandsFreeLog.append(file, 'told the chief: [hands-free call ended]');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l, i, all) => i < all.length - 1 || l !== '');
    for (let t = 0; t < 8; t++) for (let i = 0; i < 100; i++) assert.ok(lines.includes('thread ' + t + ' event ' + i), 'lost: thread ' + t + ' event ' + i);
    assert.ok(lines.includes('call ended'));
    assert.ok(lines.includes('── call started 14:05 ──'));
    assert.equal(lines[lines.length - 1], 'told the chief: [hands-free call ended]');
    assert.ok(lines.length <= HandsFreeLog.KEEP + 100, 'old lines dropped: ' + lines.length);
    assert.ok(!lines.includes('old 0'), 'the oldest go first');
    assert.equal(new Set(lines).size, lines.length);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('copyingTakesWholeCallsNewestIncluded', () => {
  const log =
    'old line\n' +
    HandsFreeLog.callStarted('22:10') +
    '\nfirst a\n' +
    HandsFreeLog.callStarted('23:29') +
    '\nsecond a\nsecond b\n' +
    HandsFreeLog.callStarted('23:41') +
    '\nthird a\nthird b\n';
  assert.equal(HandsFreeLog.lastCalls(log, 1), '── call started 23:41 ──\nthird a\nthird b\n');
  assert.equal(HandsFreeLog.lastCalls(log, 2), '── call started 23:29 ──\nsecond a\nsecond b\n── call started 23:41 ──\nthird a\nthird b\n');
  assert.equal(HandsFreeLog.lastCalls(log, 3), log.substring(log.indexOf('── call started 22:10')));
  assert.equal(HandsFreeLog.lastCalls(log, 4), log, 'fewer calls than asked: all of it');
  assert.equal(HandsFreeLog.lastCalls('a\nb\n', 1), 'a\nb\n', 'no call yet: all of it');
  assert.equal(HandsFreeLog.lastCalls('', 1), '');
});

test('aMessageOnlyTheTalkerOrOnlyTheChiefGotCountsAsSentAndSaysWhoMissedIt', async () => {
  const f = new Fake('Book the hotel. Over.', 'And the train. Over.');
  f.missedBy = 'talker';
  await f.talk();
  await until(() => f.session.sent() === 1);
  assert.ok(f.session.ours('r1'));
  assert.equal(f.session.pending(), ''); // Not kept: the chief has it.
  await until(() => reasons(f).includes('Sent ✓ to the chief. The talker didn\'t get it: thread not found'));
  f.missedBy = 'chief';
  f.now.addAndGet(5000);
  await f.talk();
  await until(() => f.session.sent() === 2);
  assert.equal(f.session.pending(), ''); // Not sent again: the talker would hear it twice.
  await until(() => reasons(f).includes('Sent to the talker only. The chief didn\'t get it: thread not found'));
  assert.equal(f.sent.length, 2);
});

// ------------------------------------------------------------------ the live state on screen

const { Hearing } = HandsFreeSession;

test('theMeterSaysQuietASoundOrYourVoice', async () => {
  const f = new Fake();
  f.quiet(1000);
  assert.equal(f.session.hearing(), Hearing.QUIET);
  assert.ok(Math.abs(f.session.meter()) < 0.01);
  // Clearly there, but not loud enough against the background to count as speech.
  for (let i = 0; i < 10; i++) f.session.frame(frame(900));
  assert.equal(f.session.hearing(), Hearing.SOUND);
  f.quiet(1000);
  f.speak();
  assert.equal(f.session.hearing(), Hearing.VOICE);
  assert.ok(f.session.meter() > 0.5);
});

test('theLastWordsHeardShowAndWordsThatDontCountAreMarked', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  f.quiet(1000);
  // Live text while nobody has the floor (the radio): shown, as not counted.
  live.say('traffic news for the A3');
  let h = f.session.heard();
  assert.ok(h);
  assert.equal(h.counted, false);
  assert.equal(h.words, 'traffic news for the A3');
  live.discard();
  f.speak();
  live.say('one two three four five six seven eight nine ten');
  h = f.session.heard();
  assert.equal(h.counted, true);
  assert.equal(h.words, '…three four five six seven eight nine ten');
  assert.equal(f.session.liveState(), Live.HEARING);
});

test('speechWithoutLiveWordsSaysSoUntilWordsCome', async () => {
  const f = new Fake('');
  const live = new FakeLive(f);
  f.quiet(1000);
  // Speech counts from when it took the turn (0.4 s in): 0.8 s, then 1.2 s each.
  for (let i = 0; i < 4; i++) f.speak();
  assert.equal(f.session.trouble(), '');
  f.speak();
  assert.ok(f.session.trouble().startsWith('No words for 5 s of sound'), f.session.trouble());
  assert.equal(f.session.troubleShort(), 'No words for 5 s');
  assert.ok(reasons(f).includes('No words came for 5 s of sound'), reasons(f));
  live.say('Can you hear me');
  assert.equal(f.session.trouble(), '');
  assert.ok(f.logText().includes('live transcription: words again, after 5 s of speech without'));
});

test('failedLiveTranscriptionIsShownForTheWholeCall', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  f.quiet(1000);
  live.fail('connection lost');
  assert.equal(f.session.trouble(), 'Live transcription failed: connection lost');
  assert.equal(f.session.troubleShort(), 'No live text · words at pauses');
  assert.equal(f.session.liveWords(), false);
});

test('aSendWordWithoutAPauseAfterItSaysWhyNothingWent', async () => {
  // In the car: "over", but sound goes on (noise counted as speech) and the live text stays.
  const f = new Fake();
  const live = new FakeLive(f);
  f.session.judge = async () => verdict('over', 0.95, 0);
  f.quiet(1000);
  f.speak();
  live.say('Read me the message, over');
  await until(() => f.session.checkStep() === 'pause');
  assert.equal(f.session.liveState(), Live.WRITING);
  assert.equal(f.session.phraseWaiting(), 'over');
  const end = Date.now() + HandsFreeSession.PHRASE_WAIT_MS + 1000;
  while (Date.now() < end && !reasons(f).includes('sound went on after it')) {
    f.speak();
    await sleep(50);
  }
  assert.ok(reasons(f).includes('Heard "over", but sound went on after it (noise?): not sent'), reasons(f));
  assert.ok(f.logText().includes('no pause after the phrase in 3000 ms (sound went on: level'));
  assert.equal(f.sent.length, 0);
});

test('aSendWordWhileYourVoiceDoesntCountIsOnScreen', async () => {
  const f = new Fake();
  const live = new FakeLive(f);
  f.quiet(1000);
  live.say('Read me the message. Over.');
  assert.ok(reasons(f).includes('Heard "over", but your voice didn\'t count as speech'), reasons(f));
  assert.equal(f.sent.length, 0);
});

test('thePauseThatEndsAStretchIsntYourVoiceNorSoundWithoutWords', async () => {
  // A stretch goes on through the pause that ends it (here 1 s; 5 s by default): that silence
  // mustn't show as your voice or count as sound without words.
  const f = new Fake();
  const live = new FakeLive(f);
  f.quiet(1000);
  f.speak();
  live.say('Hello there');
  f.quiet(900); // Still the same stretch.
  assert.ok(f.session.speaking());
  assert.notEqual(f.session.hearing(), Hearing.VOICE);
  assert.notEqual(f.session.liveState(), Live.HEARING);
  // More stretches, each with a pause just short of ending it, and the same words: only the
  // voice counts, 1.2 s each.
  for (let i = 0; i < 4; i++) {
    f.speak();
    live.say('Hello there'); // A repeat isn't new words.
    f.quiet(900);
  }
  assert.equal(f.session.trouble(), '');
  f.speak();
  assert.ok(f.session.trouble().startsWith('No words for 6 s of sound'), f.session.trouble());
});
