'use strict';
// Small helpers the core modules share: the Java executors, futures and latches of the Android
// app become these on Node's single thread.

/** Resolves after ms. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise with its resolve and reject at hand (a CountDownLatch of one, a settable future). */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class TimeoutError extends Error {
  constructor(message = 'timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** The promise's value, or a TimeoutError after ms (Future.get(ms)). The promise keeps running. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(message || `timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Runs tasks one after another, in the order they were handed in (a single-thread executor).
 * run() returns the task's own promise; a failing task never stops the queue.
 */
class SerialQueue {
  constructor() {
    this.tail = Promise.resolve();
    this.pending = 0;
  }

  run(task) {
    this.pending++;
    const result = this.tail.then(() => task());
    this.tail = result.then(
      () => {
        this.pending--;
      },
      () => {
        this.pending--;
      },
    );
    return result;
  }

  /** Resolves once everything handed in so far has run. */
  idle() {
    return this.tail;
  }
}

/** Polls until check() is truthy (tests), failing after timeoutMs; an async check is awaited. */
async function waitFor(check, timeoutMs = 5000, what = 'condition', stepMs = 5) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > until) throw new Error(`waited ${timeoutMs} ms for ${what}`);
    await sleep(stepMs);
  }
}

/** Java's String.format for the %s, %d, %.Nf and %N$… forms the Android texts use (Locale.ROOT). */
function format(pattern, ...args) {
  let next = 0;
  return pattern.replace(/%(?:(\d+)\$)?([-+ 0,(#]*)(\d+)?(?:\.(\d+))?([sdfx%])/g, (m, index, flags, width, precision, conv) => {
    if (conv === '%') return '%';
    const arg = index ? args[Number(index) - 1] : args[next++];
    let out;
    switch (conv) {
      case 'd':
        out = String(Math.trunc(Number(arg)));
        break;
      case 'f':
        out = Number(arg).toFixed(precision === undefined ? 6 : Number(precision));
        break;
      case 'x':
        out = Math.trunc(Number(arg)).toString(16);
        break;
      default:
        out = String(arg);
    }
    if (width && out.length < Number(width)) {
      const pad = flags.includes('0') && conv !== 's' ? '0' : ' ';
      out = flags.includes('-') ? out.padEnd(Number(width), ' ') : out.padStart(Number(width), pad);
    }
    return out;
  });
}

/** An Error with an HTTP status, like the Android app's IOExceptions that carry one. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** UI text: English only on the Mac for now, so tr() just fills in the arguments. */
const tr = (english, ...args) => (args.length ? format(english, ...args) : english);

module.exports = { tr, sleep, deferred, withTimeout, TimeoutError, SerialQueue, waitFor, format, HttpError };
