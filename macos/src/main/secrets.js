'use strict';
// The vault on the Mac: API keys, bb tokens and the ntfy topic, encrypted with Electron's
// safeStorage, whose key lives in the macOS Keychain ("Dictate & Delegate Safe Storage"). The app
// has no Apple Team ID, so macOS ties that Keychain item to the exact build: after an update it
// asks once whether the new version may read it (Always Allow). That's why the vault uses
// safeStorage's synchronous calls: the asynchronous ones fail instead of letting macOS ask. The
// encrypted values sit in vault.json in the app's data folder; nothing is stored in plain text on
// the Mac.
//
// The core reads secrets synchronously (as Android's Vault does), so load() decrypts everything
// once at start; set() updates memory at once and writes the encrypted file right after.

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

class KeychainVault {
  constructor(file, { log = () => {} } = {}) {
    this.file = file;
    this.log = log;
    this.values = new Map();
    this.writes = Promise.resolve();
    this.available = false;
    try {
      this.sealed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.sealed = {};
    }
  }

  /** Decrypts what's saved. Off the Mac (development on Linux) without a keyring, values stay in memory. */
  async load() {
    try {
      this.available = safeStorage.isEncryptionAvailable();
    } catch {
      this.available = false;
    }
    if (!this.available) {
      this.log('vault: the Keychain is not available; secrets are kept in memory only');
      return;
    }
    for (const [name, sealed] of Object.entries(this.sealed)) {
      try {
        this.values.set(name, safeStorage.decryptString(Buffer.from(sealed, 'base64')));
      } catch (e) {
        this.log(`vault: ${name} could not be decrypted (${e.message})`);
      }
    }
  }

  get(name) {
    return this.values.has(name) ? this.values.get(name) : null;
  }

  set(name, value) {
    if (value === null || value === undefined || value === '') return this.remove(name);
    if (!this.available && process.platform === 'darwin') throw new Error('The macOS Keychain is not available, so the key could not be saved.');
    this.values.set(name, String(value));
    if (this.available) this.persist(name, String(value));
  }

  persist(name, value) {
    this.writes = this.writes
      .then(() => {
        if (this.values.get(name) !== value) return; // Changed or removed meanwhile.
        this.sealed[name] = safeStorage.encryptString(value).toString('base64');
        this.save();
      })
      .catch((e) => {
        this.log(`vault: ${name} not saved (${e.message})`);
        this.failure = e;
      });
  }

  remove(name) {
    this.values.delete(name);
    this.writes = this.writes
      .then(() => {
        delete this.sealed[name];
        this.save();
      })
      .catch((e) => {
        this.log(`vault: ${name} not removed (${e.message})`);
        this.failure = e;
      });
  }

  names() {
    return [...this.values.keys()];
  }

  clear() {
    this.values.clear();
    this.writes = this.writes
      .then(() => {
        this.sealed = {};
        this.save();
      })
      .catch((e) => {
        this.log(`vault: not cleared (${e.message})`);
        this.failure = e;
      });
  }

  /** Resolves once everything set so far is on disk; rejects (once) when a write failed. */
  async flush() {
    await this.writes;
    const failure = this.failure;
    this.failure = null;
    if (failure) throw new Error('The key could not be saved in the Keychain: ' + failure.message);
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.sealed), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { KeychainVault };
