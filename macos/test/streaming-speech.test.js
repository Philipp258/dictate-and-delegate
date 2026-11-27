'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { sleep, deferred, waitFor } = require('../src/core/util');
const S = require('../src/core/streaming-speech');
const { StreamingSpeech, AssemblyAi, openSocket, expectedAccept } = S;

/** A text that works as a ws:// URL test server's handshake answer. */
function upgradeAnswer(head) {
  const key = /Sec-WebSocket-Key: ([^\r]+)/i.exec(head)[1];
  return `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${expectedAccept(key)}\r\n\r\n`;
}

/** A raw TCP server on a free port; onSocket gets each connection. */
async function rawServer(onSocket) {
  const server = net.createServer(onSocket);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(() => r())) };
}

/** Reads from a socket as asked: n bytes, or up to a marker. */
function reader(socket) {
  let buf = Buffer.alloc(0);
  let wake = null;
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (wake) wake();
  });
  socket.on('error', () => {});
  const more = () => new Promise((r) => (wake = r));
  return {
    async bytes(n) {
      while (buf.length < n) await more();
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    },
    async until(marker) {
      for (;;) {
        const i = buf.indexOf(marker);
        if (i >= 0) {
          const out = buf.subarray(0, i + marker.length);
          buf = buf.subarray(i + marker.length);
          return out.toString('latin1');
        }
        await more();
      }
    },
  };
}

test('assemblyAisTurnsAreLiveTextThenFinalAndTakeEndsTheTurn', async () => {
  const s = S.create(S.AAI_PRO, 'k', []);
  const changed = [];
  s.changed = (t) => changed.push(t);
  s.message('{"type":"Turn","turn_order":0,"end_of_turn":false,"transcript":"","words":[{"text":"Book"},{"text":"the"}]}');
  assert.equal(s.text(), 'Book the');
  s.message('{"type":"Turn","turn_order":0,"end_of_turn":true,"transcript":"Book the table.","words":[]}');
  assert.equal(s.text(), 'Book the table.');
  s.message('{"type":"Turn","turn_order":1,"end_of_turn":false,"transcript":"Over"}');
  assert.equal(s.text(), 'Book the table. Over');
  assert.deepEqual(changed, ['Book the', 'Book the table.', 'Book the table. Over']);
  // Not connected: what's live is taken as it is.
  assert.equal(await s.take(0), 'Book the table. Over');
  assert.equal(s.text(), '');
  s.message('{"type":"Turn","turn_order":2,"end_of_turn":false,"transcript":"Next"}');
  assert.equal(s.text(), 'Next', 'the next turn starts after the taken one');
  s.discard();
  assert.equal(s.text(), '');
});

test('universalStreamingEnglishCountsTheFormattedEndOfATurn', () => {
  const s = S.create(S.AAI_EN, 'k', ['over', "that's all"]);
  assert.ok(s.url().includes('speech_model=universal-streaming-english&format_turns=true'), s.url());
  assert.ok(s.url().includes('&keyterms_prompt=%5B%22over%22%2C%22that%27s+all%22%5D'), s.url());
  assert.ok(!S.create(S.AAI_PRO, 'k', []).url().includes('format_turns'));
  s.message('{"type":"Turn","end_of_turn":true,"turn_is_formatted":false,"transcript":"book the table over"}');
  assert.equal(s.text(), 'book the table over');
  s.message('{"type":"Turn","end_of_turn":true,"turn_is_formatted":true,"transcript":"Book the table. Over."}');
  assert.equal(s.text(), 'Book the table. Over.');
});

test('elevenLabsPartialsAndCommitsAndAnErrorEndsIt', async () => {
  const s = S.create(S.ELEVEN, 'k', []);
  assert.ok(s.url().endsWith('?model_id=scribe_v2_realtime&audio_format=pcm_16000&language_code=en&commit_strategy=manual'), s.url());
  const failures = [];
  s.onFailure = (why) => failures.push(why);
  s.message('{"message_type":"session_started","session_id":"x"}');
  s.message('{"message_type":"partial_transcript","text":"Remind me"}');
  assert.equal(s.text(), 'Remind me');
  s.message('{"message_type":"committed_transcript","text":"Remind me to call Jana."}');
  s.message('{"message_type":"committed_transcript_with_timestamps","text":"Remind me to call Jana.","words":null}');
  assert.equal(s.text(), 'Remind me to call Jana.');
  assert.equal(s.working(), true);
  s.message('{"message_type":"quota_exceeded","error":"You have used up your quota"}');
  assert.equal(s.working(), false);
  assert.deepEqual(failures, ['quota_exceeded: You have used up your quota']);
  await assert.rejects(s.take(0), { message: 'quota_exceeded: You have used up your quota' }, "a failed one can't be taken from");
});

test('aWebSocketUpgradesSendsMaskedFramesAndReadsTextAndClose', async () => {
  const got = [];
  let path = '';
  const served = deferred();
  const srv = await rawServer(async (c) => {
    try {
      const r = reader(c);
      const head = await r.until('\r\n\r\n');
      path = head.split(' ')[1];
      assert.ok(head.includes('Authorization: secret\r\n'), head);
      c.write(upgradeAnswer(head));
      // The client's frame: masked text.
      const [b0, b1] = await r.bytes(2);
      assert.equal(b0, 0x81);
      assert.ok((b1 & 0x80) !== 0, 'masked');
      const mask = await r.bytes(4);
      const payload = Buffer.from(await r.bytes(b1 & 0x7f));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      got.push(payload.toString('utf8'));
      // A text message in two fragments, then a close with its code and reason.
      c.write(Buffer.from([0x01, 3, 0x68, 0x65, 0x6c]));
      c.write(Buffer.from([0x80, 2, 0x6c, 0x6f]));
      c.write(Buffer.from([0x88, 6, 0x03, 0xf0, 0x62, 0x75, 0x73, 0x79]));
      await r.bytes(8); // Its answer to the close.
      c.end();
    } catch (ex) {
      got.push('server: ' + ex);
    }
    served.resolve();
  });
  const messages = [];
  let code = 0,
    why = null;
  const ws = await openSocket(
    `ws://127.0.0.1:${srv.port}/v3/ws?sample_rate=16000`,
    { Authorization: 'secret' },
    { message: (t) => messages.push(t), ended: (c, w) => ((code = c), (why = w)) },
    2000,
  );
  ws.send('{"type":"ForceEndpoint"}');
  await served.promise;
  await waitFor(() => why !== null, 2000, 'the end');
  assert.equal(path, '/v3/ws?sample_rate=16000');
  assert.deepEqual(got, ['{"type":"ForceEndpoint"}']);
  assert.deepEqual(messages, ['hello']);
  assert.equal(code, 1008);
  assert.equal(why, 'busy');
  assert.equal(ws.open(), false);
  await srv.close();
});

/**
 * A provider for several connections in turn: it answers each upgrade, sends what the test tells
 * it to on the latest connection, can end its session (close 1000, as AssemblyAI does at its
 * limit), and counts the connections and the ForceEndpoints it got.
 */
class Provider {
  static async start() {
    const p = new Provider();
    p.wss = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: false });
    p.connections = 0;
    p.forces = 0;
    p.wss.on('connection', (c) => {
      p.latest = c;
      p.connections++;
      c.on('message', (data, isBinary) => {
        if (!isBinary && data.toString().includes('ForceEndpoint')) p.forces++;
      });
      c.on('error', () => {});
    });
    await new Promise((r) => p.wss.on('listening', r));
    return p;
  }

  /** A text message on the latest connection. */
  send(text) {
    this.latest.send(text);
  }

  /** The latest connection is cut (the network: no close frame). */
  abort() {
    this.latest.terminate();
  }

  /** The provider ends the session (its time limit): close 1000. */
  endSession() {
    this.latest.close(1000);
  }

  url() {
    return `ws://127.0.0.1:${this.wss.address().port}/v3/ws`;
  }

  close() {
    for (const c of this.wss.clients) c.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

/** Waits until the condition holds (at most 2 s). */
const until = (c) => waitFor(c, 2000);

/** An AssemblyAI turn message. */
function turn(order, end, transcript) {
  return `{"type":"Turn","turn_order":${order},"end_of_turn":${end},"transcript":"${transcript}"}`;
}

/** 100 ms of audio (one chunk): what makes it check whether to close after a minute. */
function chunk(s) {
  for (let i = 0; i < S.CHUNK_MS / 20; i++) s.audio(Buffer.alloc(640));
}

/** Open, a minute without speech (closed: it's billed while open), then speech again: open anew. */
async function reconnect(s, now, p) {
  const before = p.connections;
  const events = [];
  const was = s.events;
  s.events = (e) => {
    events.push(e);
    was(e);
  };
  now.value += S.IDLE_MS;
  chunk(s);
  await until(() => events.join('\n').includes('closed: no speech'));
  s.events = was;
  s.speech();
  await until(() => p.connections === before + 1);
  await sleep(100);
}

/** Points the providers' URLs at url (and drops at dropMs) for the test. */
async function pointed(url, test, dropMs = StreamingSpeech.DROP_MS) {
  const aai = StreamingSpeech.assemblyAiUrl,
    el = StreamingSpeech.elevenLabsUrl,
    drop = StreamingSpeech.DROP_MS;
  try {
    StreamingSpeech.assemblyAiUrl = url;
    StreamingSpeech.elevenLabsUrl = url;
    StreamingSpeech.DROP_MS = dropMs;
    await test();
  } finally {
    StreamingSpeech.assemblyAiUrl = aai;
    StreamingSpeech.elevenLabsUrl = el;
    StreamingSpeech.DROP_MS = drop;
  }
}

test('assemblyAiCountsTurnsAfreshOnANewConnection', async () => {
  // Philipp's call, 27 October 2026, 09:17:52: the connection closed after a minute without
  // speech and opened again; the new session's turns counted from 0 again and were taken for
  // repeats of the last session's: "Okay." never came, so "Over." alone sent nothing.
  const p = await Provider.start();
  try {
    await pointed(p.url(), async () => {
      const now = { value: 1_000_000 };
      const s = S.create(S.AAI_PRO, 'k', []);
      s.clock = () => now.value;
      s.speech();
      await until(() => p.connections === 1);
      await until(() => s.openedMs >= 0);
      for (let i = 0; i <= 3; i++) {
        p.send(turn(i, true, 'Message ' + i + '. Over.'));
        await until(() => s.text() === 'Message ' + i + '. Over.');
        await s.take(100);
      }
      await reconnect(s, now, p);
      p.send(turn(0, false, 'Okay'));
      await until(() => s.text() === 'Okay');
      p.send(turn(0, true, 'Okay.'));
      await until(() => s.text() === 'Okay.');
      p.send(turn(1, false, 'Over.'));
      await until(() => s.text() === 'Okay. Over.');
      p.send(turn(1, true, 'Over.'));
      assert.equal(await s.take(1000), 'Okay. Over.');
      // And again after the next reconnect, also with a turn dropped just before it.
      p.send(turn(2, false, 'Mm'));
      await until(() => s.text() === 'Mm');
      s.discard();
      await reconnect(s, now, p);
      p.send(turn(0, true, 'So it seems to be stuck.'));
      await until(() => s.text() === 'So it seems to be stuck.');
      s.close();
    });
  } finally {
    await p.close();
  }
});

test('aLostConnectionConnectsAgainAndItsTurnsCountAgain', async () => {
  // Philipp's call, 27 November 2026, 16:08:46: "software caused connection abort" after 20
  // minutes, and live transcription was gone for the rest of the call ("over" did nothing).
  const p = await Provider.start();
  const retry = StreamingSpeech.RETRY_MS;
  StreamingSpeech.RETRY_MS = 50;
  try {
    await pointed(p.url(), async () => {
      const events = [];
      const drops = [];
      const failed = [];
      const s = S.create(S.AAI_PRO, 'k', []);
      s.events = (e) => events.push(e);
      s.onDropped = (why) => drops.push(why);
      s.onFailure = (why) => failed.push(why);
      s.speech();
      await until(() => p.connections === 1);
      await until(() => s.openedMs >= 0);
      p.send(turn(3, true, 'Book the table.'));
      await until(() => s.text() === 'Book the table.');
      p.abort();
      await until(() => drops.length === 1);
      await until(() => p.connections === 2); // Connected again by itself (you're talking).
      assert.ok(s.working());
      await until(() => !s.reconnecting());
      assert.ok(events.join('\n').includes('connecting again (1 of ' + StreamingSpeech.RECONNECTS + ')'), events.join('\n'));
      await sleep(100);
      p.send(turn(0, true, 'Over.'));
      await until(() => s.text() === 'Book the table. Over.');
      // Lost again and again: given up after RECONNECTS in a row, said once.
      for (let i = 2; i <= StreamingSpeech.RECONNECTS + 1; i++) {
        await sleep(50);
        p.abort();
        if (i <= StreamingSpeech.RECONNECTS) await until(() => p.connections === i + 1);
      }
      await until(() => failed.length === 1);
      assert.ok(!s.working());
      assert.equal(drops.length, 1, 'said once a series; the tries after are in the log');
      assert.ok(!s.reconnecting());
      s.close();
    });
  } finally {
    StreamingSpeech.RETRY_MS = retry;
    await p.close();
  }
});

test('whatsLiveWhenTheProviderEndsTheSessionIsKept', async () => {
  const p = await Provider.start();
  try {
    await pointed(p.url(), async () => {
      const events = [];
      const s = S.create(S.AAI_PRO, 'k', []);
      s.events = (e) => events.push(e);
      s.speech();
      await until(() => p.connections === 1);
      await until(() => s.openedMs >= 0);
      p.send(turn(5, false, 'Book the table'));
      await until(() => s.text() === 'Book the table');
      p.endSession(); // Its final never comes.
      await until(() => events.join('\n').includes('the provider ended the session'));
      s.speech();
      await until(() => p.connections === 2);
      await sleep(100);
      p.send(turn(0, false, 'for Friday'));
      await until(() => s.text() === 'Book the table for Friday');
      p.send(turn(0, true, 'for Friday.'));
      await until(() => s.text() === 'Book the table for Friday.');
      s.close();
    });
  } finally {
    await p.close();
  }
});

/** A server that answers the upgrade (after delayMs), then reads what comes and reports when it ends. */
async function server(delayMs, read) {
  const ended = deferred();
  let reported = false;
  const end = () => {
    if (!reported) ended.resolve((reported = true));
  };
  const sockets = new Set();
  const srv = await rawServer(async (c) => {
    sockets.add(c);
    c.on('close', end);
    c.on('error', end);
    const head = await new Promise((resolve) => {
      let h = '';
      const onData = (d) => {
        h += d.toString('latin1');
        if (h.includes('\r\n\r\n')) {
          c.off('data', onData);
          c.pause();
          resolve(h);
        }
      };
      c.on('data', onData);
    });
    await sleep(delayMs);
    if (c.destroyed) return;
    c.write(upgradeAnswer(head));
    if (!read) return; // It never reads: writes fill up.
    c.on('data', (d) => {
      if ((d[0] & 0x0f) === 0x8) end(); // A close frame.
    });
    c.resume();
  });
  return {
    url: () => `ws://127.0.0.1:${srv.port}/v3/ws`,
    ended: ended.promise,
    close: () => {
      for (const s of sockets) s.destroy();
      return srv.close();
    },
  };
}

async function open(c) {
  const s = S.create(c, 'k', []);
  s.speech();
  await waitFor(() => s.openedMs >= 0, 2000, 'open');
  return s;
}

test('aLateFinalOfATakenOrDroppedStretchStaysOutOfTheNextTurn', async () => {
  const srv = await server(0, true);
  try {
    await pointed(srv.url(), async () => {
      const s = await open(S.ELEVEN);
      s.message('{"message_type":"partial_transcript","text":"send the report over"}');
      assert.equal(await s.take(100), 'send the report over'); // No final in time: its live text is taken.
      s.message('{"message_type":"partial_transcript","text":"send the report over"}');
      s.message('{"message_type":"committed_transcript","text":"Send the report. Over."}');
      assert.equal(s.text(), '', "its final, late, isn't the next turn's");
      s.message('{"message_type":"partial_transcript","text":"Mm"}');
      s.discard();
      s.message('{"message_type":"committed_transcript","text":"Mm."}');
      assert.equal(s.text(), '');
      s.message('{"message_type":"partial_transcript","text":"Next"}');
      assert.equal(s.text(), 'Next');
      s.close();
      // AssemblyAI: a turn that came final twice counts once.
      const a = S.create(S.AAI_PRO, 'k', []);
      a.message('{"type":"Turn","turn_order":0,"end_of_turn":true,"transcript":"Book it."}');
      a.message('{"type":"Turn","turn_order":0,"end_of_turn":true,"transcript":"Book it."}');
      assert.equal(a.text(), 'Book it.');
    });
  } finally {
    await srv.close();
  }
});

test('wordsStillComingOfAStretchWrittenDownFromItsAudioStayOutOfTheNextTurn', async () => {
  // Send before its first live words: the turn went written down from its audio; then they come.
  const srv = await server(0, true);
  try {
    await pointed(
      srv.url(),
      async () => {
        const s = await open(S.ELEVEN);
        assert.equal(await s.take(100), '');
        s.discard();
        s.message('{"message_type":"partial_transcript","text":"Book the table"}');
        s.message('{"message_type":"committed_transcript","text":"Book the table."}');
        assert.equal(s.text(), '');
        s.message('{"message_type":"partial_transcript","text":"Next"}');
        assert.equal(s.text(), 'Next');
        s.close();
      },
      300,
    );
  } finally {
    await srv.close();
  }
});

test('anElevenLabsDropWhoseFinalNeverComesEndsAfterAWhile', async () => {
  const srv = await server(0, true);
  try {
    await pointed(
      srv.url(),
      async () => {
        const s = await open(S.ELEVEN);
        s.message('{"message_type":"partial_transcript","text":"Mm"}');
        s.discard(); // Its final never comes.
        s.message('{"message_type":"partial_transcript","text":"Mm"}');
        assert.equal(s.text(), '');
        await sleep(400);
        s.message('{"message_type":"partial_transcript","text":"Book the table"}');
        assert.equal(s.text(), 'Book the table', "the next stretch's words show");
        s.close();
      },
      300,
    );
  } finally {
    await srv.close();
  }
});

test('assemblyAiDropsTheTurnStillComingAndNotTheOneAfter', async () => {
  const srv = await server(0, true);
  try {
    await pointed(
      srv.url(),
      async () => {
        const s = await open(S.AAI_PRO);
        s.message('{"type":"Turn","turn_order":0,"end_of_turn":true,"transcript":"Hello."}');
        assert.equal(await s.take(100), 'Hello.');
        s.discard(); // Turn 1's words haven't come yet.
        s.message('{"type":"Turn","turn_order":1,"end_of_turn":false,"transcript":"Book the"}');
        s.message('{"type":"Turn","turn_order":1,"end_of_turn":true,"transcript":"Book the table."}');
        assert.equal(s.text(), '');
        s.message('{"type":"Turn","turn_order":2,"end_of_turn":false,"transcript":"Next"}');
        assert.equal(s.text(), 'Next');
        // Dropped with nothing coming after it: a turn starting much later is new speech.
        await s.take(100);
        s.discard();
        await sleep(400);
        s.message('{"type":"Turn","turn_order":3,"end_of_turn":false,"transcript":"Later"}');
        assert.equal(s.text(), 'Later');
        s.close();
      },
      300,
    );
  } finally {
    await srv.close();
  }
});

test('closedWhileItConnectsTheNewConnectionIsClosedAtOnce', async () => {
  const srv = await server(400, true);
  try {
    await pointed(srv.url(), async () => {
      const s = S.create(S.AAI_PRO, 'k', []);
      s.speech(); // Connecting (the call starts).
      await sleep(100);
      s.close(); // The call ends before it's open.
      assert.equal(await Promise.race([srv.ended, sleep(3000).then(() => false)]), true, 'the connection that opened after was closed');
    });
  } finally {
    await srv.close();
  }
});

test('askingForTheFinalTextThatHangsFailsInsteadOfFiringLater', async () => {
  const srv = await server(0, true);
  try {
    await pointed(srv.url(), async () => {
      const stuck = deferred();
      const s = new (class extends AssemblyAi {
        force() {
          return stuck.promise; // The connection's write hangs.
        }
      })(S.AAI_PRO, 'k', []);
      s.speech();
      await waitFor(() => s.openedMs >= 0, 2000, 'open');
      s.message('{"type":"Turn","turn_order":0,"end_of_turn":false,"transcript":"Book the"}');
      const start = Date.now();
      await assert.rejects(s.take(300), (ex) => ex.message.includes("couldn't ask for the final text"));
      assert.ok(Date.now() - start < 2000);
      assert.equal(s.working(), false);
      assert.equal(await Promise.race([srv.ended, sleep(2000).then(() => false)]), true, "the stuck connection is closed (it's billed while open)");
      s.close();
    });
  } finally {
    await srv.close();
  }
});

test('aTlsHandshakeThatStallsGivesUp', async () => {
  const sockets = [];
  const silent = await rawServer((c) => sockets.push(c)); // Accepts, says nothing.
  try {
    const start = Date.now();
    await assert.rejects(openSocket(`wss://127.0.0.1:${silent.port}/`, {}, null, 500));
    assert.ok(Date.now() - start < 3000, String(Date.now() - start));
  } finally {
    for (const c of sockets) c.destroy();
    await silent.close();
  }
});

test('closeDoesntWaitBehindAWriteThatHangs', async () => {
  const srv = await server(0, false); // It never reads: writes fill up.
  try {
    const ws = await openSocket(srv.url(), {}, { message() {}, ended() {} }, 2000);
    const big = Buffer.alloc(1 << 20);
    const until = Date.now() + 800;
    while (Date.now() < until && ws.buffered() < 32 << 20) {
      ws.send(big);
      await sleep(10);
    }
    assert.ok(ws.buffered() > 0, 'by now writes wait');
    const start = Date.now();
    ws.close();
    assert.ok(Date.now() - start < 500, String(Date.now() - start));
    assert.throws(() => ws.send(big), /closed/, 'writing after it ends fails');
  } finally {
    await srv.close();
  }
});

test('aLongFrameHasItsLengthInTwoOrEightBytes', async () => {
  // Mac: the frames are the ws package's; this checks what goes out on the wire.
  const heads = [];
  const done = deferred();
  const srv = await rawServer(async (c) => {
    const r = reader(c);
    c.write(upgradeAnswer(await r.until('\r\n\r\n')));
    for (let k = 0; k < 2; k++) {
      const [b0, b1] = await r.bytes(2);
      let n = b1 & 0x7f;
      let ext = [];
      if (n === 126) {
        ext = [...(await r.bytes(2))];
        n = (ext[0] << 8) | ext[1];
      } else if (n === 127) {
        ext = [...(await r.bytes(8))];
        n = ext.reduce((v, b) => v * 256 + b, 0);
      }
      await r.bytes(4 + n);
      heads.push({ b0, b1, ext, n });
    }
    c.destroy();
    done.resolve();
  });
  const ws = await openSocket(`ws://127.0.0.1:${srv.port}/`, {}, { message() {}, ended() {} }, 2000);
  ws.send(Buffer.alloc(200));
  ws.send(Buffer.alloc(70_000));
  await done.promise;
  assert.equal(heads[0].b0, 0x82);
  assert.equal(heads[0].b1, 0x80 | 126);
  assert.equal(heads[0].n, 200);
  assert.equal(heads[1].b1, 0x80 | 127);
  assert.equal(heads[1].ext.length, 8);
  assert.equal(heads[1].n, 70_000);
  await srv.close();
});

// ------------------------------------------------------------------ against scripts/fakes/fake_streaming.py

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

/** 100 ms of a tone loud enough for the fake to count as speech, in 20 ms frames. */
function speak(s, chunks) {
  for (let c = 0; c < chunks; c++)
    for (let f = 0; f < 5; f++) {
      const frame = Buffer.alloc(640);
      for (let i = 0; i < 320; i++) frame.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2);
      s.audio(frame);
    }
}

test('theFakeProvidersWriteDownAStretchAndATakeEndsIt', async (t) => {
  const port = await freePort();
  const fake = spawn('python3', [path.join(__dirname, '..', '..', 'scripts', 'fakes', 'fake_streaming.py'), '--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try {
        up = (await fetch(base + '/test/log')).ok;
      } catch {
        await sleep(50);
      }
    }
    if (!up) return t.skip('python3 or the fake is missing');
    const script = (texts) => fetch(base + '/test/script', { method: 'POST', body: JSON.stringify({ texts }), headers: { 'Content-Type': 'application/json' } });
    for (const c of [S.AAI_PRO, S.ELEVEN]) {
      await script(['Book the table. Over.']);
      const url = `ws://127.0.0.1:${port}` + (c === S.ELEVEN ? '/v1/speech-to-text/realtime' : '/v3/ws');
      const changed = [];
      const s = S.create(c, 'k', ['over'], { url, changed: (x) => changed.push(x) });
      s.speech();
      await waitFor(() => s.openedMs >= 0, 3000, 'open');
      speak(s, 4); // A word per 100 ms of speech.
      await waitFor(() => s.text().split(' ').length === 4, 3000, 'the live words');
      assert.equal(s.text().replace(/[.,]/g, ''), 'Book the table Over', c.id);
      assert.equal(await s.take(1500), 'Book the table. Over.', c.id);
      assert.equal(s.text(), '');
      s.close();
    }
    const log = (await (await fetch(base + '/test/log')).json()).log;
    const opened = log.filter((e) => e.kind === 'open');
    assert.ok(opened[0].query.includes('speech_model=universal-3-6-pro'), opened[0].query);
    assert.ok(opened[0].query.includes('keyterms_prompt=%5B%22over%22%5D'), opened[0].query);
    assert.ok(opened[1].query.includes('model_id=scribe_v2_realtime'), opened[1].query);
    assert.equal(log.filter((e) => e.kind === 'force').length, 2);
    // A wrong key is refused: it fails at once, saying what the provider said.
    const failures = [];
    const bad = S.create(S.AAI_PRO, 'bad', [], { url: `ws://127.0.0.1:${port}/v3/ws`, onFailure: (w) => failures.push(w) });
    bad.speech();
    await waitFor(() => failures.length > 0, 3000, 'the failure');
    assert.deepEqual(failures, ['couldn\'t connect: HTTP 401 Unauthorized: {"error": "Invalid API key"}']);
    assert.equal(bad.working(), false);
    bad.close();
  } finally {
    fake.kill();
  }
});
