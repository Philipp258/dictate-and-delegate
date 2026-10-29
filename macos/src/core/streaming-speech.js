'use strict';
// Hands-free's live transcription: the microphone's audio streams to a speech model as you talk
// (AssemblyAI or ElevenLabs, with your own key), and its text comes back while you speak. A send
// phrase at the end of it sends your turn at once; take() ends the turn with the model's final text.
//
// Text comes in two kinds: final (a stretch the model is done with) and live (what it has of the
// stretch going on, changing). The turn is the finals since the last take(), then the live text.
// The connection is opened on the first speech and closed after IDLE_MS without any (the
// providers bill the time it's open); the last RING_MS of audio is kept, so what you said while it
// connected is sent first.
//
// Implements HandsFreeSession's LiveText: audio(frame), speech(), text(), take(waitMs) → Promise,
// discard(), working(), failure(), close().

const crypto = require('crypto');
const WebSocket = require('ws');
const { SerialQueue, withTimeout, TimeoutError, format } = require('./util');
const netLog = require('./net-log');

/** 16 kHz 16-bit mono (AudioFiles.BYTES_PER_SECOND). */
const BYTES_PER_SECOND = 16000 * 2;
/** More audio than this waiting to go out: the connection is stuck (Mac: see take()). */
const STUCK_BYTES = BYTES_PER_SECOND * 2;

const ASSEMBLYAI = 'assemblyai',
  ELEVENLABS = 'elevenlabs';
/** Where each provider's key is kept (the vault). */
const ASSEMBLYAI_KEY = 'assemblyaiKey',
  ELEVENLABS_KEY = 'elevenlabsKey';

/** A choice in Settings → Hands-free → Streaming transcription; perHour: list price, dollars (October 2026). */
function choiceOf(id, name, note, provider, model, perHour) {
  return Object.freeze({ id, name, note, provider, model, perHour, label: () => name + ' · ' + note });
}

/**
 * Measured on Philipp's dictations (October 2026): Universal-3.6 Pro made the fewest
 * meaning-changing mistakes (8 in 18 minutes), ElevenLabs 13 (and once dropped 30 s), Universal
 * Streaming English 16 but is the quickest and cheapest.
 */
const AAI_PRO = choiceOf('aai-pro', 'AssemblyAI Universal-3.6 Pro', 'most accurate', ASSEMBLYAI, 'universal-3-6-pro', 0.45),
  ELEVEN = choiceOf('eleven', 'ElevenLabs Scribe v2 Realtime', 'second best', ELEVENLABS, 'scribe_v2_realtime', 0.39),
  AAI_EN = choiceOf('aai-en', 'AssemblyAI Universal Streaming (English)', 'fastest, cheapest, less accurate', ASSEMBLYAI, 'universal-streaming-english', 0.15);

const CHOICES = [AAI_PRO, ELEVEN, AAI_EN];
const DEFAULT = AAI_PRO;

function choice(id) {
  return CHOICES.find((c) => c.id === id) || DEFAULT;
}

function keyName(c) {
  return c.provider === ELEVENLABS ? ELEVENLABS_KEY : ASSEMBLYAI_KEY;
}

/** Closed after this long without your speech; opened again when you speak. */
const IDLE_MS = 60_000;
/** Audio kept while it's closed (or connecting), sent first once it's open. */
const RING_MS = 2000;
/** Audio goes out in chunks of this much (the providers want 50 ms to 1 s). */
const CHUNK_MS = 100;

// ------------------------------------------------------------------ the WebSocket

/** The Sec-WebSocket-Accept a server answers a key with (for test servers). */
function expectedAccept(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

/**
 * Opens a WebSocket (the `ws` package; the Android app had its own client): text and binary out,
 * text messages to listener.message(text), listener.ended(code, why) once when it ends ("closed"
 * when we closed it). Resolves once it's open; rejects with "HTTP 401 Unauthorized: <what it
 * said>" when the upgrade is refused, or after timeoutMs (also a TLS handshake that stalls).
 */
function openSocket(url, headers, listener, timeoutMs, what = 'live transcription') {
  // In the network log: the upgrade (101 or why not), then how it closed and how long it was open.
  const net = netLog.begin(what + ' connect', 'GET', url);
  let openedAt = 0;
  return new Promise((resolve, reject) => {
    let settled = false,
      ended = false,
      error = null;
    const ws = new WebSocket(url, { headers, handshakeTimeout: timeoutMs, perMessageDeflate: false, followRedirects: false });
    const fail = (ex) => {
      if (settled) return;
      net.fail(ex instanceof Error ? ex : new Error(String(ex)));
      net.end();
      settled = true;
      ended = true;
      try {
        ws.terminate();
      } catch {
        /* Failed anyway. */
      }
      reject(ex instanceof Error ? ex : new Error(String(ex)));
    };
    ws.on('unexpected-response', (req, res) => {
      // What the provider said, for the log (its body may say why: a bad key, no credit).
      let said = '';
      net.status(res.statusCode);
      const status = `HTTP ${res.statusCode}${res.statusMessage ? ' ' + res.statusMessage : ''}`;
      const done = () => {
        clearTimeout(timer);
        res.destroy();
        req.destroy();
        said = said.trim();
        fail(new Error(status + (said ? ': ' + said : '')));
      };
      const timer = setTimeout(done, 1000);
      res.on('data', (d) => {
        said += d.toString('utf8');
        if (said.length >= 512) {
          said = said.slice(0, 512);
          done();
        }
      });
      res.on('end', done);
      res.on('error', done);
    });
    ws.on('error', (ex) => {
      if (!settled) return fail(ex);
      error = ex;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary || ended || !listener) return;
      listener.message(data.toString('utf8'));
    });
    ws.on('close', (code, reason) => {
      if (!settled) return fail(new Error('the connection was lost'));
      const first = !ended;
      ended = true;
      let why = reason ? reason.toString('utf8') : '';
      if (code === 1006) why = error ? String(error.message).toLowerCase() : 'the connection was lost';
      const open = Date.now() - openedAt;
      // The provider's close reason is a status line ("session expired"), cut short; never what was said.
      const reasonShort = reason ? reason.toString('utf8').replace(/\s+/g, ' ').slice(0, 60) : '';
      netLog.event(
        what + ' closed',
        url,
        !first ? 'closed by the app' : code === 1006 ? (error ? netLog.classify(error) : 'connection lost') : 'code ' + code + (reasonShort ? ' ' + reasonShort : ''),
        '',
        'open ' + Math.round(open / 1000) + ' s',
      );
      if (listener) listener.ended(code, first ? why : 'closed');
    });
    ws.on('open', () => {
      if (settled) return;
      net.status(101).end();
      openedAt = Date.now();
      settled = true;
      resolve({
        send(data) {
          if (ended || ws.readyState !== WebSocket.OPEN) throw new Error('closed');
          ws.send(data, { binary: typeof data !== 'string' });
        },
        open: () => !ended && ws.readyState === WebSocket.OPEN,
        /** Closes it at once (that ends the provider's session); the listener hears "closed". */
        close() {
          // No close handshake, which could wait behind a full send buffer on a dead network.
          ended = true;
          ws.terminate();
        },
        /** Bytes waiting to go out. */
        buffered: () => ws.bufferedAmount,
      });
    });
  });
}

// ------------------------------------------------------------------ live transcription

class StreamingSpeech {
  constructor(choice, key, opts = {}) {
    this.choice = choice;
    this.key = key;
    /** The provider's address (tests point it at a fake); else the class's. */
    this.baseUrl = opts.url || null;
    this.socket = null;
    this.connecting = false;
    this.failed = false;
    this._failure = '';
    /** The finals in order, the turn's first among them, and the live text. */
    this.finals = [];
    this.turnStart = 0;
    this.live = '';
    /** Finals asked for (take): counted up when one comes. */
    this.finalsSeen = 0;
    /**
     * Stretches dropped (taken without their final, or discarded): their live text and late final
     * are ignored when they come, up to and including this stretch (finalsSeen counts them).
     */
    this.dropThrough = -1;
    /** A drop lasts at most until then: a final that never comes doesn't hide the next stretch. */
    this.dropUntil = 0;
    /** Closed for good (the call ended): a connection opening meanwhile is closed at once. */
    this.closed = false;
    this.ring = [];
    this.chunk = [];
    this.chunkBytes = 0;
    this.lastSpeech = -1e15;
    /** How long it took to open the last time (-1: not yet; for the log). */
    this.openedMs = -1;
    this.sender = new SerialQueue();
    /** Connections opened so far: each is a session of its own at the provider. */
    this.sessions = 0;
    /** When it was opened (0: it's closed), and how long it's been open in all. */
    this.openSince = 0;
    this.openMs = 0;
    this.waiters = new Set();
    this.changed = opts.changed || (() => {});
    this.events = opts.events || (() => {});
    /** Hears once why it failed (the session says it on screen). */
    this.onFailure = opts.onFailure || (() => {});
    /** The time; tests set their own. */
    this.clock = opts.clock || (() => Date.now());
  }

  /** The live text of the stretch going on. */
  setLive(text) {
    if (this.dropping()) return; // A dropped stretch's: not this turn's.
    this.live = text == null ? '' : String(text).trim();
    this.changed(this.text());
  }

  /** A final text: what was live is done. */
  finished(text) {
    const f = text == null ? '' : String(text).trim();
    const dropped = this.dropping(); // Late, for a stretch already taken or dropped.
    if (f && !dropped) this.finals.push(f);
    if (!dropped) this.live = '';
    this.finalsSeen++;
    this.notifyAll();
    this.changed(this.text());
  }

  notifyAll() {
    const w = [...this.waiters];
    this.waiters.clear();
    for (const r of w) r();
  }

  /** Waits at most ms (real time) for notifyAll(). */
  waitNotify(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        resolve();
      }, ms);
      this.waiters.add(done);
    });
  }

  /** The stretch going on is dropped: what still comes of it is ignored. */
  drop() {
    const empty = this.live === '';
    if (!this.byTurn()) {
      this.dropThrough = this.finalsSeen;
      this.dropUntil = this.clock() + StreamingSpeech.DROP_MS;
    }
    this.dropped(empty);
  }

  /** Is what comes now a dropped stretch's? Not past its time. */
  dropping() {
    if (this.finalsSeen > this.dropThrough) return false;
    if (this.clock() > this.dropUntil) {
      this.dropThrough = this.finalsSeen - 1;
      return false;
    }
    return true;
  }

  /** Does the provider say which stretch a message is of (then it drops by that)? */
  byTurn() {
    return false;
  }

  /** Told when the stretch going on is dropped, and whether nothing of it had come yet. */
  dropped() {}

  text() {
    const parts = this.finals.slice(this.turnStart);
    if (this.live) parts.push(this.live);
    return parts.join(' ');
  }

  working() {
    return !this.failed;
  }

  failure() {
    return this._failure;
  }

  /** It can't be used for this call any more: why, once. */
  fail(why) {
    if (this.failed) return;
    this.failed = true;
    this._failure = why;
    this.notifyAll();
    // Not used again this call: closed now (it's billed while open).
    const ws = this.socket;
    this.socket = null;
    if (ws) ws.close();
    this.events('streaming transcription failed: ' + why);
    this.onFailure(why);
  }

  /** A 20 ms frame of 16 kHz 16-bit mono audio (a Buffer or Uint8Array). */
  audio(frame) {
    if (this.failed || this.closed) return;
    this.chunk.push(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
    this.chunkBytes += frame.byteLength;
    if (this.chunkBytes < (BYTES_PER_SECOND * CHUNK_MS) / 1000) return;
    const c = Buffer.concat(this.chunk, this.chunkBytes);
    this.chunk = [];
    this.chunkBytes = 0;
    this.sender.run(() => this.deliver(c)).catch(() => {});
  }

  /** In order: the chunk goes out, or into the ring while it's closed. */
  async deliver(c) {
    if (this.closed) return;
    const ws = this.socket;
    const now = this.clock();
    if (!ws || !ws.open()) {
      this.ring.push(c);
      while (this.ring.length > RING_MS / CHUNK_MS) this.ring.shift();
      if (!this.connecting && now - this.lastSpeech < IDLE_MS) await this.connect();
      return;
    }
    if (now - this.lastSpeech >= IDLE_MS && this.text() === '') {
      this.events(`streaming transcription closed: no speech for ${IDLE_MS / 1000} s (it's billed while open)`);
      this.socket = null;
      ws.close();
      this.closedAt(now);
      this.ring.push(c);
      return;
    }
    try {
      this.sendAudio(ws, c);
    } catch {
      this.ring.push(c);
    }
  }

  speech() {
    this.lastSpeech = this.clock();
    if (this.failed || this.connecting || this.closed) return;
    const ws = this.socket;
    if (!ws || !ws.open()) this.sender.run(() => this.connect()).catch(() => {});
  }

  /** In order: opens the connection, then sends what the ring kept. */
  async connect() {
    if (this.failed || this.connecting || this.closed || (this.socket && this.socket.open())) return;
    this.connecting = true;
    const start = this.clock();
    const session = this.newSession();
    try {
      const ws = await openSocket(
        this.url(),
        this.headers(),
        {
          message: (text) => {
            if (session !== this.sessions) return; // An earlier connection's, late: not this session's.
            try {
              this.message(text);
            } catch (ex) {
              this.events(`streaming transcription: a message not understood (${ex.message})`);
            }
          },
          ended: (code, why) => {
            if (session !== this.sessions) return; // An earlier connection's: the new one is open.
            this.closedAt(this.clock());
            if (why === 'closed') return; // We closed it.
            if (code === 1000) {
              // Ended normally by the provider (its session limit): opened again when you speak.
              this.socket = null;
              this.events(`streaming transcription: the provider ended the session${why ? ' (' + why + ')' : ''}; it opens again when you speak`);
              return;
            }
            // Closed by the provider while in use: why (a bad key, no credit, its limit).
            this.fail((why || 'connection lost') + (code === 1006 || code === 1005 ? '' : ` (${code})`));
          },
        },
        10_000,
      );
      if (this.closed) {
        // The call ended while it connected.
        ws.close();
        return;
      }
      this.socket = ws;
      this.openedMs = this.clock() - start;
      this.openSince = this.clock();
      this.events(format('streaming transcription (%s) open in %d ms', this.choice.model, this.openedMs));
      while (this.ring.length) this.sendAudio(ws, this.ring.shift());
    } catch (ex) {
      this.fail("couldn't connect: " + ex.message);
    } finally {
      this.connecting = false;
    }
  }

  /**
   * A new connection is a new session at the provider: it counts its stretches from the start
   * again (AssemblyAI's turn_order from 0), and nothing more comes of the last one's. What was
   * still live of it is kept as final; a drop waiting for its late messages is over.
   */
  newSession() {
    if (this.live) this.finals.push(this.live);
    this.live = '';
    this.dropThrough = this.finalsSeen - 1;
    this.opened();
    return ++this.sessions;
  }

  /** A new session starts: what the provider counts starts again. */
  opened() {}

  /**
   * The turn's text once the model has finished what's live (asked to, at once), waited for at
   * most waitMs; the next turn starts after it. Rejects once it failed.
   */
  async take(waitMs) {
    if (this.failed) throw new Error(this._failure);
    const ws = this.socket;
    const asked = this.finalsSeen;
    const pending = this.live !== '';
    // Nothing live: the last final is the end of it (forcing would bring nothing).
    if (pending && ws && ws.open()) {
      // Java's send blocks on a full socket, so a stuck connection times out the force below;
      // Node's never blocks, so a backlog of unsent audio is the sign here.
      if (ws.buffered && ws.buffered() > STUCK_BYTES) {
        this.fail(`couldn't ask for the final text: ${Math.round(ws.buffered() / BYTES_PER_SECOND)} s of audio still waiting to go out`);
        throw new Error(this._failure);
      }
      try {
        await withTimeout(
          this.sender.run(() => this.force(ws)),
          waitMs,
        );
      } catch (ex) {
        // Couldn't even ask (the connection is stuck): not used again this call.
        if (!(ex instanceof TimeoutError)) throw ex;
        this.fail(`couldn't ask for the final text in ${waitMs} ms`);
      }
      const until = this.clock() + waitMs;
      while (this.finalsSeen === asked && !this.failed) {
        const left = until - this.clock();
        if (left <= 0) break;
        await this.waitNotify(left);
      }
    }
    if (this.failed) throw new Error(this._failure);
    const forced = pending && ws && ws.open();
    if (this.finalsSeen === asked && forced) {
      this.events(`streaming transcription: no final within ${waitMs} ms; its live text is taken`);
      this.drop(); // Its final, when it comes, isn't the next turn's.
    }
    if (this.live) this.finals.push(this.live);
    this.live = '';
    const t = this.text();
    this.turnStart = this.finals.length;
    return t;
  }

  discard() {
    const ws = this.socket;
    const open = ws && ws.open();
    // What's in flight of this stretch (its words may not have come yet: its audio went out
    // written down from the audio) is dropped when it comes, as its final (asked for below).
    if (open) this.drop();
    this.turnStart = this.finals.length;
    this.live = '';
    if (open && !this.closed)
      this.sender
        .run(() => {
          try {
            return this.force(ws);
          } catch {
            /* Only a cleanup. */
          }
        })
        .catch(() => {});
  }

  /** It closed: its time open counts. */
  closedAt(now) {
    if (this.openSince > 0) this.openMs += now - this.openSince;
    this.openSince = 0;
  }

  /** How long it was open in this call, and what that costs at the provider's list price. */
  usage() {
    const ms = this.openMs + (this.openSince > 0 ? this.clock() - this.openSince : 0);
    return format(
      "open %d s in all, about $%.4f at %s's list price ($%.2f an hour)",
      Math.floor(ms / 1000),
      (ms / 3_600_000) * this.choice.perHour,
      this.choice.provider,
      this.choice.perHour,
    );
  }

  close() {
    this.closed = true;
    this.events('streaming transcription: ' + this.usage());
    const ws = this.socket;
    this.socket = null;
    if (ws) ws.close();
  }
}

/** Where the providers are (tests point these at a fake). */
StreamingSpeech.assemblyAiUrl = 'wss://streaming.assemblyai.com/v3/ws';
StreamingSpeech.elevenLabsUrl = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
/** How long a dropped stretch's late messages are waited for (tests shorten it). */
StreamingSpeech.DROP_MS = 2000;

/** Java's URLEncoder.encode: spaces as +, and !'()~ encoded too. */
function urlEncode(s) {
  return encodeURIComponent(s)
    .replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
}

/**
 * AssemblyAI's v3 streaming: raw PCM as binary messages; "Turn" messages with the words so far,
 * end_of_turn true when the turn's done (ForceEndpoint ends it now). Universal Streaming English
 * sends each turn's end twice, the second formatted: that one counts.
 */
class AssemblyAi extends StreamingSpeech {
  constructor(c, key, keyterms = [], opts) {
    super(c, key, opts);
    this.keyterms = keyterms || [];
    /** The last turn that came final, the turn live now, and the one dropped (-1: none). */
    this.lastTurn = -1;
    this.liveTurn = -1;
    this.droppedTurn = -1;
    /** The dropped turn hadn't shown up yet (a guess: the next one), and when it was dropped. */
    this.guessed = false;
    this.droppedAt = 0;
  }

  byTurn() {
    return true;
  }

  opened() {
    // Each session's turn_order starts at 0. Kept from the last session, its turns would count
    // as repeats of turns already final and be ignored: words lost after every reconnect
    // (Philipp's call, 27 October 2026: "Okay." and then "Over." sent nothing).
    this.lastTurn = this.liveTurn = this.droppedTurn = -1;
    this.guessed = false;
  }

  dropped(nothingYet) {
    // Nothing of it had come: it's the turn after the last one seen.
    this.droppedTurn = nothingYet ? Math.max(this.liveTurn, this.lastTurn) + 1 : this.liveTurn;
    this.guessed = nothingYet;
    this.droppedAt = this.clock();
  }

  url() {
    let u = (this.baseUrl || StreamingSpeech.assemblyAiUrl) + '?sample_rate=16000&encoding=pcm_s16le&speech_model=' + this.choice.model;
    if (this.choice.model === AAI_EN.model) u += '&format_turns=true';
    if (this.keyterms.length) {
      const terms = [];
      for (const t of this.keyterms) if (terms.length < 100 && t.length <= 50) terms.push(t);
      u += '&keyterms_prompt=' + urlEncode(JSON.stringify(terms));
    }
    return u;
  }

  headers() {
    return { Authorization: this.key };
  }

  sendAudio(ws, pcm) {
    ws.send(pcm);
  }

  force(ws) {
    ws.send('{"type":"ForceEndpoint"}');
  }

  message(text) {
    const m = JSON.parse(text);
    const type = str(m.type);
    if (type === 'Turn') {
      const order = int(m.turn_order, -1);
      let dropped = this.droppedTurn;
      if (dropped >= 0 && order === dropped && this.guessed && order !== this.liveTurn && this.clock() - this.droppedAt > StreamingSpeech.DROP_MS)
        dropped = this.droppedTurn = -1; // The guessed turn started long after: new speech, not the dropped audio.
      if (dropped >= 0 && order > dropped) dropped = this.droppedTurn = -1; // Past it.
      if (order >= 0) this.liveTurn = order;
      if (dropped >= 0 && order === dropped) {
        // The dropped turn's words, or its final: not this turn's.
        if (m.end_of_turn === true) this.lastTurn = Math.max(this.lastTurn, order);
        return;
      }
      const formatted = this.choice.model !== AAI_EN.model || m.turn_is_formatted === true;
      if (m.end_of_turn === true && formatted) {
        // One final per turn (Universal-3.6 Pro sent one each in Philipp's runs; a repeat is dropped).
        const turn = int(m.turn_order, -1);
        if (turn >= 0 && turn <= this.lastTurn) return;
        this.lastTurn = Math.max(this.lastTurn, turn);
        this.finished(str(m.transcript));
      } else {
        let t = str(m.transcript);
        if (!t && Array.isArray(m.words)) t = m.words.map((w) => str(w && w.text)).join(' ');
        this.setLive(t);
      }
    } else if (type === 'Error' || 'error' in m) this.fail(m.error == null ? text : str(m.error));
  }
}

/**
 * ElevenLabs' Scribe v2 realtime: audio as base64 in JSON, committed by us (commit_strategy
 * manual: at once when asked, instead of after 1.5 s of silence, which took about 5 s).
 */
class ElevenLabs extends StreamingSpeech {
  url() {
    return (this.baseUrl || StreamingSpeech.elevenLabsUrl) + '?model_id=' + this.choice.model + '&audio_format=pcm_16000&language_code=en&commit_strategy=manual';
  }

  headers() {
    return { 'xi-api-key': this.key };
  }

  static chunk(pcm, commit) {
    return JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: Buffer.from(pcm).toString('base64'), commit, sample_rate: 16000 });
  }

  sendAudio(ws, pcm) {
    ws.send(ElevenLabs.chunk(pcm, false));
  }

  force(ws) {
    ws.send(ElevenLabs.chunk(Buffer.alloc(0), true));
  }

  message(text) {
    const m = JSON.parse(text);
    const type = str(m.message_type);
    switch (type) {
      case 'partial_transcript':
        this.setLive(str(m.text));
        break;
      case 'committed_transcript':
        this.finished(str(m.text));
        break;
      case 'session_started':
      case 'committed_transcript_with_timestamps':
        break;
      default:
        if (type.includes('error') || type === 'quota_exceeded' || type.includes('limit'))
          this.fail(type + ': ' + (m.error != null ? str(m.error) : m.message != null ? str(m.message) : text));
    }
  }
}

/** org.json's optString: "" when missing or null, objects as JSON. */
function str(v) {
  if (v == null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** org.json's optInt. */
function int(v, fallback) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** opts: { url, clock, changed(text), events(line), onFailure(why) }. */
function create(c, key, keyterms = [], opts = {}) {
  return c.provider === ELEVENLABS ? new ElevenLabs(c, key, opts) : new AssemblyAi(c, key, keyterms, opts);
}

module.exports = {
  StreamingSpeech,
  AssemblyAi,
  ElevenLabs,
  create,
  choice,
  keyName,
  openSocket,
  expectedAccept,
  CHOICES,
  DEFAULT,
  AAI_PRO,
  ELEVEN,
  AAI_EN,
  ASSEMBLYAI,
  ELEVENLABS,
  ASSEMBLYAI_KEY,
  ELEVENLABS_KEY,
  IDLE_MS,
  RING_MS,
  CHUNK_MS,
  BYTES_PER_SECOND,
};
