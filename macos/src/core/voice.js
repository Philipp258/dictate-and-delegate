'use strict';
// Reads the chief's replies aloud in hands-free mode: a speech model through OpenRouter
// (POST /audio/speech, MP3 or raw PCM, with the user's OpenRouter key), or the Mac's own voice
// offline and as the fallback when OpenRouter fails. A reply plays while its audio still comes in
// (VoiceStream), from its first fifth of a second.
//
// Mac: Android's AudioTrack, MediaPlayer, TextToSpeech and audio focus become an injected player
// (the renderer's audio window):
//
//   player.stream(voiceStream, { onStarted(durationMs?), onEnded(played) }) → { stop(), playedMs(), playing() }
//       plays a VoiceStream as its bytes arrive: stream.encoding 'pcm' (16-bit LE, rate()/channels()),
//       'mp3' (whole frames) or 'file' (a whole file of type stream.mime, once complete()). Read it
//       with stream.read(at, maxBytes, waitMs) or stream.data() + stream.onData(). onStarted when
//       its first sound is out (durationMs only matters for 'file'); onEnded(true) once all of it
//       played and the stream is complete, onEnded(false) when it failed. stop(): silent at once.
//   player.speak(text, { onStarted(), onRange(charIndex), onEnded(played), onError(why) }) → { stop(), playing() }
//       the Mac's voice (speechSynthesis), English.
//   player.warm(ms) → Promise (optional): plays ms of silence on the output first (WARM_MS), so a
//       Bluetooth route that wakes up with the first sound swallows silence, not the first words.
//       Not called while the call's audio is kept open (openCall()).
//   player.open() / player.close() (optional): keep the output open (silent) for the whole call.

const { sleep, format } = require('./util');
const netLog = require('./net-log');
const decimal = require('./decimal');
const openrouter = require('./openrouter');
const handsfree = require('./handsfree');
const { VoiceStream, heardChars: heardCharsOf } = require('./voice-stream');

/**
 * A choice in Settings → Models & providers → Text-to-speech: the OpenRouter model and voice (""
 * when the model needs none), or the Mac's; format is what's asked for, "mp3" or "pcm" (for the
 * models that only send raw samples).
 */
function choiceOf(id, name, note, model, voice, pricePerCharacter, fmt = 'mp3') {
  return Object.freeze({
    id,
    name,
    note,
    model,
    voice,
    pricePerCharacter,
    format: fmt,
    label: () => name + ' · ' + note,
    /** For the log: "fish-audio/drama-3 (933563…)", the model and the voice it was asked for. */
    tag: () => (!model ? "the Mac's voice" : !voice ? model : model + ' (' + voice + ')'),
    /** OpenRouter's list price, for when the real cost can't be looked up. */
    perCharacter: () => Number(pricePerCharacter),
  });
}

const MAI = 'microsoft/mai-voice-2.1-flash',
  VOXTRAL = 'mistralai/voxtral-mini-tts-3-0',
  HEYGEN = 'heygen/heygen-voice-1-turbo',
  GEMINI = 'google/gemini-3.8-flash-lite-tts',
  FISH = 'fish-audio/drama-3';

const KOKORO = choiceOf('kokoro', 'Kokoro', 'cheapest', 'hexgrad/kokoro-82m', 'af_heart', '0.00000062'),
  ELEVEN = choiceOf('eleven', 'ElevenLabs Flash v2.5', 'best voice', 'elevenlabs/eleven-flash-v2.5', 'george', '0.00004'),
  // Mac: Android's voice is the Mac's here; its id stays "android", so the setting reads alike.
  SYSTEM = choiceOf('android', "The Mac's voice", 'offline, free', '', '', '0');

/**
 * Prices are OpenRouter's per character; Gemini's is per token (audio out at $6 a million), about
 * $10 a million characters. Each voice answered once in about 0.5 to 2 s (October 2026).
 */
const CHOICES = [
  KOKORO,
  // Fish takes a voice's reference ID (fish.audio); without one each reply had another speaker.
  choiceOf('fish-drama', 'Fish Audio Drama 3 · Sarah', 'fast, cheap', FISH, '933563129e564b19a115bedd57b7406a', '0.000002'),
  choiceOf('fish-friendly', 'Fish Audio Drama 3 · Friendly', 'fast, cheap', FISH, 'b545c585f631496c914815291da4e893', '0.000002'),
  choiceOf('fish-adrian', 'Fish Audio Drama 3 · Adrian', 'fast, cheap', FISH, 'bf322df2096a46f18c579d0baa36f41d', '0.000002'),
  choiceOf('fish-ethan', 'Fish Audio Drama 3 · Ethan', 'fast, cheap', FISH, '536d3a5e000945adb7038665781a4aca', '0.000002'),
  choiceOf('gemini-kore', 'Gemini Flash Lite TTS · Kore', 'cheap', GEMINI, 'Kore', '0.00001', 'pcm'),
  choiceOf('gemini-puck', 'Gemini Flash Lite TTS · Puck', 'cheap', GEMINI, 'Puck', '0.00001', 'pcm'),
  choiceOf('gemini-charon', 'Gemini Flash Lite TTS · Charon', 'cheap', GEMINI, 'Charon', '0.00001', 'pcm'),
  choiceOf('gemini-aoede', 'Gemini Flash Lite TTS · Aoede', 'cheap', GEMINI, 'Aoede', '0.00001', 'pcm'),
  choiceOf('heygen-bram', 'HeyGen Voice 1 Turbo · Bram', 'cheap', HEYGEN, 'bram', '0.000004', 'pcm'),
  choiceOf('heygen-nadine', 'HeyGen Voice 1 Turbo · Nadine', 'cheap', HEYGEN, 'nadine', '0.000004', 'pcm'),
  choiceOf('heygen-lucian', 'HeyGen Voice 1 Turbo · Lucian', 'cheap', HEYGEN, 'lucian', '0.000004', 'pcm'),
  choiceOf('heygen-tabitha', 'HeyGen Voice 1 Turbo · Tabitha', 'cheap', HEYGEN, 'tabitha', '0.000004', 'pcm'),
  choiceOf('voxtral-paul', 'Voxtral Mini TTS · Paul', 'fast', VOXTRAL, 'en_paul_neutral', '0.000013'),
  choiceOf('voxtral-paul-cheerful', 'Voxtral Mini TTS · Paul, cheerful', 'fast', VOXTRAL, 'en_paul_cheerful', '0.000013'),
  choiceOf('voxtral-jane', 'Voxtral Mini TTS · Jane (British)', 'fast', VOXTRAL, 'gb_jane_neutral', '0.000013'),
  choiceOf('voxtral-oliver', 'Voxtral Mini TTS · Oliver (British)', 'fast', VOXTRAL, 'gb_oliver_neutral', '0.000013'),
  choiceOf('mai-harper', 'MAI-Voice 2.1 Flash · Harper', 'fastest', MAI, 'en-US-Harper:MAI-Voice-2.1-Flash', '0.000015'),
  choiceOf('mai-iris', 'MAI-Voice 2.1 Flash · Iris', 'fastest', MAI, 'en-US-Iris:MAI-Voice-2.1-Flash', '0.000015'),
  choiceOf('mai-jasper', 'MAI-Voice 2.1 Flash · Jasper', 'fastest', MAI, 'en-US-Jasper:MAI-Voice-2.1-Flash', '0.000015'),
  choiceOf('mai-ethan', 'MAI-Voice 2.1 Flash · Ethan', 'fastest', MAI, 'en-US-Ethan:MAI-Voice-2.1-Flash', '0.000015'),
  ELEVEN,
  SYSTEM,
];

/** The hands-free voice until another is chosen: the cheapest. */
const DEFAULT = KOKORO;

function choice(id) {
  return CHOICES.find((c) => c.id === id) || DEFAULT;
}

/**
 * A reply ready to play: its audio coming in (stream; null: the Mac's voice reads the text). Also
 * OpenRouter's generation ID, and how it went: when the first byte came and when enough audio to
 * start playing (ms after asking, -1 when it didn't), why the Mac's voice reads it ("" when it
 * doesn't), and which request delivered it ("", or that a second was sent and which won).
 * Mac: Android's whole-file case (a format that can't play as it comes) is a stream too, of
 * encoding 'file'.
 */
class Prepared {
  constructor(stream, generation = '', firstByteMs = -1, playableMs = -1, fallback = '', how = '') {
    this.stream = stream || null;
    this.generation = generation;
    this.firstByteMs = firstByteMs;
    this.playableMs = playableMs;
    this.fallback = fallback;
    this.how = how;
  }

  /** The voice model's audio is there to play. */
  ready() {
    return this.stream !== null;
  }
}

/** A voice model's request failed: why, in a few words (HTTP status and what it said). */
class Failed extends Error {
  constructor(why) {
    super(why);
    this.name = 'Failed';
  }
}

/**
 * A voice request that hasn't delivered after this long gets a second one in parallel; the first
 * to deliver plays, the other is dropped. OpenRouter picks the provider itself (routing is ignored
 * for speech), and its slow answers are single stalls, so a second request cuts them off.
 */
const SECOND_REQUEST_MS = 1000;
/** Silence played first, so the route is awake for the first word. */
const WARM_MS = 500;
/** A stream that stops coming for this long while it plays is given up. */
const STALL_MS = 5000;
/**
 * How fast the replies are read, in characters a second, until a whole reply came: a rate below
 * any of the voices (they measured 15 to 20), so [heard up to] never quotes words not heard yet.
 */
const SLOWEST_CHARS_PER_SECOND = 10;
/** How long the headers (connect 10 s, read 30 s) and each later piece of audio may take. */
const ANSWER_MS = 40_000,
  READ_MS = 30_000;

/** The request for OpenRouter's speech endpoint. */
function body(c, text) {
  const b = { model: c.model, input: text, response_format: c.format };
  if (c.voice) b.voice = c.voice;
  return b;
}

/** "audio/pcm;rate=44100;channels=1" → [44100, 1]; null if it isn't PCM with a rate. */
function pcmFormat(contentType) {
  if (contentType == null || !contentType.toLowerCase().startsWith('audio/pcm')) return null;
  let rate = 0,
    channels = 1;
  for (const part of contentType.split(';')) {
    const kv = part.trim().split('=');
    if (kv.length < 2) continue;
    const k = kv[0].trim().toLowerCase(),
      v = kv.slice(1).join('=').trim();
    if (k !== 'rate' && k !== 'channels') continue;
    if (!/^[+-]?\d+$/.test(v)) return null;
    if (k === 'rate') rate = parseInt(v, 10);
    else channels = parseInt(v, 10);
  }
  return rate <= 0 || channels <= 0 ? null : [rate, channels];
}

/** Is it MP3 ("audio/mpeg", "audio/mp3")? */
function isMp3(contentType) {
  const t = (contentType || '').toLowerCase();
  return t.startsWith('audio/mpeg') || t.startsWith('audio/mp3');
}

/** The 44-byte header that makes 16-bit little-endian PCM a WAV file of that many bytes. */
function wavHeader(rate, channels, pcmBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeInt32LE((36 + pcmBytes) | 0, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeInt32LE(16, 16);
  h.writeInt16LE(1, 20);
  h.writeInt16LE(channels, 22);
  h.writeInt32LE(rate, 24);
  h.writeInt32LE(rate * channels * 2, 28);
  h.writeInt16LE(channels * 2, 32);
  h.writeInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeInt32LE(pcmBytes | 0, 40);
  return h;
}

/**
 * Why a request failed, in a few words: "HTTP 503: <what it said>", its JSON error message if
 * it sent one, cut to a line.
 */
function httpError(status, text) {
  let said = text == null ? '' : String(text).trim();
  try {
    const j = JSON.parse(said);
    if (j && typeof j === 'object') {
      const e = j.error && typeof j.error === 'object' && !Array.isArray(j.error) ? j.error : null;
      const m = e ? e.message : j.message;
      if (m != null && String(m) !== '') said = String(m);
    }
  } catch {
    /* As it came. */
  }
  said = said.replace(/\s+/g, ' ');
  if (said.length > 160) said = said.slice(0, 160) + '…';
  return 'HTTP ' + status + (said ? ': ' + said : '');
}

/** One request for a reply's audio, into its stream as it comes. */
class Attempt {
  constructor(voice, c, text, asked) {
    this.first = -1;
    this.generation = '';
    this.stream = new VoiceStream();
    this.abort = new AbortController();
    this.done = false;
    this.cancelled = false;
    this.error = null;
    this.stream.cancel = () => this.drop();
    voice.fetchAudio(c, text, this, asked).then(
      () => {
        this.done = true;
      },
      (ex) => {
        this.error = ex;
        this.done = true;
        this.stream.fail(ex instanceof Failed ? ex.message : String(ex && ex.message), voice.clock() - asked);
      },
    );
  }

  /** It can start playing: enough audio is in, or the whole file. */
  ready() {
    if (this.stream.failed() !== null) return false;
    return this.stream.playable();
  }

  /** Given up: not downloaded on. */
  drop() {
    if (this.done) return;
    this.cancelled = true;
    this.done = true;
    this.abort.abort();
  }
}

class Voice {
  /**
   * opts: { vault (the OpenRouter key), player, fetch, baseUrl (OpenRouter's, else openrouter.base()),
   * clock, sleep (the generation lookup's waits; tests pass their own), log(line) }.
   */
  constructor(opts = {}) {
    this.vault = opts.vault || { get: () => null };
    this.player = opts.player || null;
    this.fetch = opts.fetch || ((...a) => globalThis.fetch(...a));
    this.baseUrl = opts.baseUrl || null;
    this.clock = opts.clock || (() => Date.now());
    this.sleep = opts.sleep || sleep;
    this.log = opts.log || (() => {});
    this.secondRequestMs = SECOND_REQUEST_MS;
    this.charsPerSecond = SLOWEST_CHARS_PER_SECOND;
    /** The playback going on, the reply being read, and how far the Mac's voice got in it. */
    this.current = null;
    this.text = '';
    this.ttsAt = 0;
    /** How far a streamed reply got when it ended early (-1: it didn't): heardChars says it after. */
    this.heardAtEnd = -1;
    /** The stream being played or about to be (cancelled when the reading stops). */
    this.playingStream = null;
    /** The player's handle for the stream playing, and that stream; the Mac's voice speaking. */
    this.handle = null;
    this.streamed = null;
    this.fileMs = 0;
    this.speaking = null;
    this.utterance = 0;
    this.utterances = 0;
    /** The Mac's voice failed: from now on the voice model is waited for instead. */
    this.systemUnavailable = false;
    /** Hears once when the Mac's voice fails. */
    this.systemStatus = () => {};
    /** The call's audio is kept open (Settings → Hands-free): no warm-up before a reply. */
    this.callOpen = false;
    this.shut = false;
  }

  base() {
    return openrouter.base(this.baseUrl);
  }

  key() {
    return this.vault.get(openrouter.KEY) || '';
  }

  /** Hands a playback callback over later, as Android posted to its main thread. */
  post(fn) {
    setImmediate(fn);
  }

  /** Ends the current reading once. */
  finished(played) {
    const p = this.current;
    this.current = null;
    if (p) this.post(() => p.ended(played));
  }

  /**
   * Gets a reply ready: fetches its audio from OpenRouter. Never rejects: without audio (the Mac's
   * voice chosen, or OpenRouter failed) the Mac's voice reads it. When there isn't enough audio to
   * start playing within waitMs (0: no limit) the request is given up and the Mac's voice reads the
   * reply, so a slow voice model never keeps you waiting. The audio goes on coming in while it plays.
   */
  async prepare(c, text, waitMs = 0) {
    if (!c.model) return new Prepared(null, '');
    const asked = this.clock();
    const deadline = waitMs > 0 ? asked + waitMs : Infinity;
    let a = new Attempt(this, c, text, asked),
      b = null;
    let sent = 1;
    let failed = null;
    for (;;) {
      if (this.shut) {
        // The call ended: not downloaded on.
        if (a) a.drop();
        if (b) b.drop();
        failed = new Error('the call ended');
        break;
      }
      const now = this.clock();
      const ready = a && a.ready() ? a : b && b.ready() ? b : null;
      if (ready) {
        const other = ready === a ? b : a;
        if (other) other.drop();
        const how = !b
          ? ''
          : ready === b
            ? `second request won (sent after ${this.secondRequestMs} ms)`
            : `first request won (a second was sent after ${this.secondRequestMs} ms)`;
        this.learn(ready.stream, text);
        return new Prepared(ready.stream, ready.generation, ready.first, now - asked, '', how);
      }
      const done = a && a.done ? a : b && b.done ? b : null;
      if (done) {
        if (done === a) a = null;
        else b = null;
        if (done.cancelled) {
          failed = new Error('cancelled');
          if (!a && !b) break;
        } else {
          failed = done.error || new Failed('it sent no audio');
          // One request failed: the other may still deliver; if there's none yet, send one.
          if (!a && !b) {
            if (now < deadline && sent < 3) {
              a = new Attempt(this, c, text, asked);
              sent++;
            } else break;
          }
        }
      } else if (!b && a && sent < 3 && now - asked >= this.secondRequestMs && now < deadline) {
        b = new Attempt(this, c, text, asked);
        sent++;
      } else if (now >= deadline) {
        if (a) a.drop();
        if (b) b.drop();
        const answered = (a && a.first >= 0) || (b && b.first >= 0);
        return new Prepared(
          null,
          '',
          a ? a.first : -1,
          -1,
          format(answered ? "%1$s: its audio didn't start coming in %2$.1f s" : '%1$s: no answer in %2$.1f s', c.name, waitMs / 1000),
          b ? 'two requests' : '',
        );
      }
      await sleep(25);
    }
    this.log(`OpenRouter's voice failed, the Mac's reads instead: ${failed && failed.message}`);
    return new Prepared(null, '', -1, -1, c.name + ': ' + (failed instanceof Failed ? failed.message : String(failed ? failed.message : 'failed')));
  }

  /**
   * Fetches a reply's audio into the attempt's stream: MP3 and raw PCM as they come, anything else
   * whole (a 'file'); attempt.first gets when its first byte came (ms after asked).
   */
  fetchAudio(c, text, attempt, asked) {
    const url = this.base() + '/audio/speech';
    return netLog.request('TTS ' + (c.model || ''), 'POST', url, (net) => this.fetchAudioLogged(c, text, attempt, asked, net));
  }

  async fetchAudioLogged(c, text, attempt, asked, net) {
    const stream = attempt.stream;
    const signal = attempt.abort.signal;
    const secs = () => Math.floor((this.clock() - asked) / 1000);
    let timedOut = false;
    const answerTimer = setTimeout(() => {
      timedOut = true;
      attempt.abort.abort();
    }, ANSWER_MS);
    let res;
    try {
      const payload = JSON.stringify(body(c, text));
      net.sent(Buffer.byteLength(payload, 'utf8'));
      res = await this.fetch(this.base() + '/audio/speech', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + this.key(), 'Content-Type': 'application/json', 'X-Title': 'Dictate & Delegate' },
        body: payload,
        signal,
      });
    } catch (ex) {
      if (timedOut) {
        net.fail(Object.assign(new Error('no answer'), { code: 'UND_ERR_HEADERS_TIMEOUT' }));
        throw new Failed(`no answer in ${secs()} s`);
      }
      throw ex;
    } finally {
      clearTimeout(answerTimer);
    }
    net.status(res.status);
    if (res.status >= 300) {
      let said = '';
      try {
        said = (await res.text()).slice(0, 4096);
      } catch {
        /* The status says enough. */
      }
      throw new Failed(httpError(res.status, said));
    }
    attempt.first = this.clock() - asked;
    net.note('first byte ' + attempt.first + ' ms');
    attempt.generation = res.headers.get('X-Generation-Id') || '';
    // Raw samples (some models send nothing else), at the rate they came at, or MP3: played as
    // they come; anything else once it's all in.
    const type = res.headers.get('Content-Type');
    const pcm = pcmFormat(type);
    if (pcm) stream.format(pcm[0], pcm[1]);
    else if (isMp3(type)) stream.format(0, 0, 'mp3');
    else stream.format(0, 0, 'file', type || '');
    let got = 0;
    if (res.body) {
      const reader = res.body.getReader();
      // Dropped: stops waiting for the next piece at once.
      const aborted = new Promise((_, reject) => {
        if (signal.aborted) reject(new Error('dropped'));
        signal.addEventListener('abort', () => reject(new Error('dropped')), { once: true });
      });
      aborted.catch(() => {});
      try {
        for (;;) {
          let timer;
          const stalled = new Promise((_, reject) => {
            timer = setTimeout(() => {
              net.fail(Object.assign(new Error('stalled'), { code: 'UND_ERR_BODY_TIMEOUT' }));
              reject(new Failed(`its audio stopped coming after ${secs()} s`));
            }, READ_MS);
          });
          let r;
          try {
            r = await Promise.race([reader.read(), stalled, aborted]);
          } finally {
            clearTimeout(timer);
          }
          if (r.done) break;
          got += r.value.length;
          net.received(got);
          stream.add(Buffer.from(r.value.buffer, r.value.byteOffset, r.value.byteLength));
        }
      } catch (ex) {
        if (ex && ex.message === 'dropped') net.fail(Object.assign(new Error('dropped'), { name: 'AbortError' }));
        reader.cancel().catch(() => {});
        throw ex;
      }
    }
    if (got === 0) throw new Failed('it sent no audio');
    stream.end(this.clock() - asked);
    if (stream.bytes() === 0) throw new Failed('it sent no audio'); // Not one MP3 frame in it.
  }

  /**
   * Opens the connection to OpenRouter before the first reply (in the background), so that reply
   * doesn't wait for it; later ones reuse it (keep-alive).
   */
  warm() {
    (async () => {
      try {
        await netLog.request('TTS warm-up', 'GET', this.base() + '/key', async (net) => {
          const res = await this.fetch(this.base() + '/key', { headers: { Authorization: 'Bearer ' + this.key() }, signal: AbortSignal.timeout(10_000) });
          net.status(res.status);
          net.received((await res.arrayBuffer()).byteLength); // Read to the end: the connection stays open for reuse.
        });
      } catch {
        /* Only a head start. */
      }
    })();
  }

  /** Keeps the call's audio open (Settings → Hands-free, on by default): replies start without a warm-up. */
  openCall() {
    if (this.callOpen || !this.player) return;
    try {
      if (this.player.open) this.player.open();
      this.callOpen = true;
    } catch (ex) {
      this.log('no call audio: ' + ex.message);
    }
  }

  /** Learns how fast the voice reads once a reply's audio is all in. */
  learn(s, text) {
    s.whenDone((done) => {
      if (done.failed() === null && done.audioMs() > 2000) this.charsPerSecond = (text.length * 1000) / done.audioMs();
    });
  }

  /** How long a streamed reply will take: its length once all of it is in, else a guess. */
  estimatedMs(s, text) {
    return s.complete() ? s.audioMs() : Math.max(s.audioMs(), Math.floor((text.length * 1000) / this.charsPerSecond));
  }

  /** Plays a prepared reply; the playback hears when audio starts and when it ends. */
  play(prepared, text, playback) {
    this.current = playback;
    this.text = text;
    this.ttsAt = 0;
    this.heardAtEnd = -1;
    const stream = prepared && prepared.stream ? prepared.stream : null;
    this.playingStream = stream;
    (async () => {
      if (!this.callOpen && this.player && this.player.warm)
        try {
          await this.player.warm(WARM_MS);
        } catch {
          /* No warm-up: the reply plays anyway. */
        }
      if (this.current !== playback) {
        // Stopped meanwhile.
        if (stream) stream.cancel();
        return;
      }
      if (stream) this.playStream(stream, text, playback);
      else this.speakSystem(text, playback);
    })();
  }

  /**
   * Plays a reply while its audio comes in. A stream that stops coming (STALL_MS) or fails plays
   * what came, then ends unplayed; one the player can't play at all is read by the Mac's voice.
   */
  playStream(s, text, playback) {
    let started = false,
      ended = false,
      handle = null,
      watch = null;
    const stopWatch = () => {
      if (watch) clearInterval(watch);
      watch = null;
    };
    const callbacks = {
      onStarted: (durationMs) => {
        if (started || ended || this.current !== playback) return;
        started = true;
        let ms;
        if (s.encoding === 'file') ms = this.fileMs = durationMs > 0 ? Math.round(durationMs) : Math.floor((text.length * 1000) / 15);
        else ms = this.estimatedMs(s, text);
        this.post(() => playback.started(ms));
      },
      onEnded: (played) => {
        if (ended) return;
        ended = true;
        stopWatch();
        const ok = !!played && s.complete() && s.failed() === null;
        if (this.current === playback && !ok && started) this.heardAtEnd = this.heardChars(); // Ended early: how far it got stays known.
        if (this.handle === handle) {
          this.handle = null;
          this.streamed = null;
        }
        if (this.current !== playback) return;
        if (!ok && !started && s.failed() === null) {
          // It doesn't play: the Mac's voice instead.
          this.log("the reply's audio doesn't play: the Mac's voice reads it");
          s.cancel();
          this.speakSystem(text, playback);
          return;
        }
        this.finished(ok);
      },
    };
    try {
      if (!this.player) throw new Error('no player');
      handle = this.player.stream(s, callbacks);
    } catch (ex) {
      this.log('no player for the reply: ' + ex.message);
      ended = true;
      s.cancel();
      this.speakSystem(text, playback); // It doesn't play: the Mac's voice instead.
      return;
    }
    if (ended) return;
    this.handle = handle;
    this.streamed = s;
    // A stream that stops coming while it plays is given up: what came plays, then it ends.
    let bytes = s.bytes(),
      since = this.clock();
    watch = setInterval(() => {
      if (ended || s.complete()) return stopWatch();
      const now = this.clock();
      if (s.bytes() !== bytes) {
        bytes = s.bytes();
        since = now;
      } else if (now - since >= STALL_MS) {
        stopWatch();
        this.log("the reply's audio stopped coming");
        s.cancel();
        s.fail(`its audio stopped coming for ${STALL_MS / 1000} s`, -1);
      }
    }, 100);
  }

  /** The Mac's voice; about 15 characters a second for how long it takes. */
  speakSystem(text, playback) {
    this.post(() => {
      if (this.current !== playback) return; // Stopped meanwhile.
      const id = ++this.utterances;
      this.utterance = id;
      try {
        if (!this.player) throw new Error('no player');
        this.speaking = this.player.speak(text, {
          onStarted: () => {
            if (this.utterance !== id || this.current !== playback) return;
            this.post(() => playback.started(Math.floor((text.length * 1000) / 15)));
          },
          onRange: (at) => {
            if (this.utterance === id) this.ttsAt = at; // Words as they're spoken: how far you heard.
          },
          onEnded: (played) => {
            if (this.utterance !== id) return;
            this.speaking = null;
            this.finished(!!played);
          },
          onError: (why) => {
            if (this.utterance !== id) return;
            this.speaking = null;
            this.systemFailed(`couldn't speak (${why})`);
            this.finished(false);
          },
        });
      } catch (ex) {
        this.speaking = null;
        this.systemFailed('refused to speak: ' + ex.message);
        this.finished(false);
      }
    });
  }

  /** The Mac's voice failed: from now on the voice model is waited for instead. */
  systemFailed(why) {
    if (!this.systemUnavailable) this.systemStatus(why + ': the voice model is waited for from now on');
    this.systemUnavailable = true;
  }

  /**
   * How many characters of the reply have been heard: by the playback position (a third of a
   * second less, for the sound still on its way to the ear), or the Mac's voice's word. While a
   * streamed reply still comes in, its length isn't known yet: see VoiceStream's heardChars.
   */
  heardChars() {
    const h = this.handle,
      s = this.streamed;
    const length = this.text.length;
    if (h && s) {
      let played = 0;
      try {
        played = Number(h.playedMs()) || 0;
      } catch {
        return 0;
      }
      if (s.encoding === 'file') {
        if (this.fileMs <= 0) return 0;
        const at = Math.max(0, played - 300);
        return Math.min(length, Math.floor((length * at) / this.fileMs));
      }
      return heardCharsOf(length, played, s.audioMs(), s.complete(), this.charsPerSecond);
    }
    if (this.heardAtEnd >= 0) return this.heardAtEnd;
    return Math.min(length, this.ttsAt);
  }

  /** A prepared reply that won't be played (the call ended): its audio isn't fetched on. */
  static drop(prepared) {
    if (prepared instanceof Prepared && prepared.stream) prepared.stream.cancel();
  }

  /** Is reply audio still coming out (the session's watchdog asks)? */
  playing() {
    if (this.handle) return true; // A streamed reply plays until the player ends it.
    try {
      return !!(this.speaking && this.speaking.playing());
    } catch {
      return false;
    }
  }

  /** What OpenRouter charged for a generation (GET /generation), or null if it can't say yet. */
  async cost(generation) {
    const g = await this.generation(generation);
    return g ? g.cost : null;
  }

  /**
   * What OpenRouter says about a generation: { cost (dollars), costText (as it said it), provider,
   * latencyMs }, or null if it can't say yet.
   */
  async generation(generation) {
    if (!generation) return null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this.sleep(1500 * (attempt + 1)); // It shows up a moment after the call.
        const url = this.base() + '/generation?id=' + encodeURIComponent(generation);
        const got = await netLog.request('OpenRouter cost lookup', 'GET', url, async (net) => {
          const res = await this.fetch(url, {
            headers: { Authorization: 'Bearer ' + this.key() },
            signal: AbortSignal.timeout(25_000),
          });
          net.status(res.status);
          return res.status >= 300 ? null : res.json();
        }, { retry: attempt });
        if (got == null) continue;
        const json = got;
        const d = json && typeof json.data === 'object' ? json.data : null;
        if (!d || d.total_cost == null) continue;
        const cost = decimal.parse(String(d.total_cost));
        if (!cost) continue;
        const latency = typeof d.latency === 'number' ? Math.trunc(d.latency) : -1;
        return { cost: decimal.toNumber(cost), costText: decimal.plain(decimal.strip(cost)), provider: d.provider_name == null ? '' : String(d.provider_name), latencyMs: latency };
      } catch {
        /* Try again. */
      }
    }
    return null;
  }

  /** Stops reading at once; the playback still hears it ended. */
  stop() {
    const h = this.handle,
      s = this.streamed;
    if (h) {
      this.heardAtEnd = this.heardChars(); // How far it got stays known.
      this.handle = null;
      this.streamed = null;
      try {
        h.stop(); // Silent at once.
      } catch {
        /* Ended meanwhile. */
      }
    }
    // The rest of its audio isn't fetched on (also while it was still warming up).
    if (this.playingStream) this.playingStream.cancel();
    if (s) s.cancel();
    this.utterance = 0; // Whatever the voice says about it now no longer counts.
    const sp = this.speaking;
    this.speaking = null;
    if (sp)
      try {
        sp.stop();
      } catch {
        /* Done already. */
      }
    this.finished(false);
  }

  shutdown() {
    this.stop();
    this.shut = true;
    if (this.callOpen && this.player && this.player.close)
      try {
        this.player.close();
      } catch {
        /* Closed. */
      }
    this.callOpen = false;
  }
}

/** The list price of reading text, exactly: { cost (dollars), costText }. */
function listCost(c, text) {
  const d = decimal.strip(decimal.multiply(decimal.of(c.pricePerCharacter), decimal.of(text.length)));
  return { cost: decimal.toNumber(d), costText: decimal.plain(d) };
}

/**
 * HandsFreeSession's Speaker on top of a Voice and its player, as HandsFreeService builds it:
 * prepare(request, text) → Promise<Prepared> (never rejects), play(request, text, prepared,
 * playback), playing(), heardChars(), drop(prepared), stop().
 *
 * opts: { voice, prefs (hfVoice, hfVoiceWaitMs), event(line) (the call's log), onVoiceFailed(why,
 * systemVoice) (→ session.voiceFailed), onCost({ request, choice, text, cost, costText, exact,
 * provider, latencyMs, ms }) (what reading a reply cost: its note and the call's total) }.
 */
function createSpeaker(opts) {
  const voice = opts.voice;
  const prefs = opts.prefs || { get: (k, f) => f };
  const event = opts.event || (() => {});
  const onVoiceFailed = opts.onVoiceFailed || (() => {});
  const onCost = opts.onCost || (() => {});

  /**
   * What reading a reply cost, as OpenRouter reports it for its generation (looked up after it's
   * done), else at the model's price per character.
   */
  async function charge(request, c, text, generation, ms) {
    try {
      const g = await voice.generation(generation);
      const price = g ? { cost: g.cost, costText: g.costText } : listCost(c, text);
      event(
        format(
          'voice %s: %d characters, $%s%s%s',
          c.tag(),
          text.length,
          price.costText,
          g ? '' : ' (at list price)',
          !g || !g.provider ? '' : ', served by ' + g.provider + (g.latencyMs < 0 ? '' : ' (its latency ' + g.latencyMs + ' ms)'),
        ),
      );
      onCost({ request, choice: c, text, cost: price.cost, costText: price.costText, exact: !!g, provider: g ? g.provider : '', latencyMs: g ? g.latencyMs : -1, ms });
    } catch (ex) {
      event('voice cost not kept: ' + ex.message);
    }
  }

  return {
    async prepare(request, text) {
      const c = choice(prefs.get(handsfree.VOICE, DEFAULT.id));
      const asked = voice.clock();
      // A voice model slower than this to answer: the Mac's voice reads the reply instead.
      // Without the Mac's voice there's nothing to fall back to: the voice model is waited for
      // (its second and third requests still race the first).
      const p = await voice.prepare(c, text, voice.systemUnavailable ? 30_000 : handsfree.voiceWaitMs(prefs));
      const ms = voice.clock() - asked;
      const how = p.how ? ' · ' + p.how : '';
      if (p.stream && p.stream.encoding !== 'file') {
        // It plays as it comes: when enough was in to start, and later when all of it was.
        event(format('voice %s for %s: first byte after %d ms, playable after %d ms%s', c.tag(), request, p.firstByteMs, p.playableMs, how));
        p.stream.whenDone((s) =>
          event(
            s.failed() === null
              ? format('voice for %s: all of it after %d ms (%.1f s of audio)', request, s.allMs(), s.audioMs() / 1000)
              : format('voice for %s: its audio stopped after %.1f s of it: %s', request, s.audioMs() / 1000, s.failed()),
          ),
        );
        charge(request, c, text, p.generation, ms);
      } else if (p.stream) {
        event(format('voice %s for %s: first byte after %d ms, all of it after %d ms%s', c.tag(), request, p.firstByteMs, p.playableMs, how));
        charge(request, c, text, p.generation, ms);
      } else if (c.model) {
        const system = !voice.systemUnavailable;
        event(
          'voice ' + c.tag() + ' for ' + request + ' failed: ' + p.fallback + how + ' (first byte ' + p.firstByteMs + ' ms)' +
            (system ? ": the Mac's voice reads it" : ": the Mac's voice isn't available"),
        );
        onVoiceFailed(p.fallback, system);
      }
      return p;
    },

    play(request, text, prepared, playback) {
      voice.play(prepared instanceof Prepared ? prepared : new Prepared(null, ''), text, playback);
    },

    playing: () => voice.playing(),
    heardChars: () => voice.heardChars(),
    drop: (prepared) => Voice.drop(prepared),
    stop: () => voice.stop(),
  };
}

module.exports = {
  Voice,
  Prepared,
  Failed,
  createSpeaker,
  choice,
  body,
  pcmFormat,
  isMp3,
  wavHeader,
  httpError,
  listCost,
  CHOICES,
  DEFAULT,
  KOKORO,
  ELEVEN,
  SYSTEM,
  ANDROID: SYSTEM,
  MAI,
  VOXTRAL,
  HEYGEN,
  GEMINI,
  FISH,
  SECOND_REQUEST_MS,
  WARM_MS,
  STALL_MS,
  SLOWEST_CHARS_PER_SECOND,
};
