'use strict';
// Mac counterpart of NetState.java: the network at a moment, for the network log ("wifi (en0),
// v4+v6", "ethernet (en7), v4 only", "vpn (utun4), v4+v6", "offline"). The default route's
// interface (route -n get default) and its hardware port (networksetup -listallhardwareports),
// with whether it has IPv4 and a global IPv6 address. No Wi-Fi name. Looking costs two small
// processes, so the description is kept and refreshed in the background (every 15 s, and soon
// after a failed request): logging never waits for it. Changes go into the log as they happen.

const { execFile } = require('child_process');
const os = require('os');
const netLog = require('./net-log');

/** "Hardware Port: Wi-Fi\nDevice: en0" blocks → { en0: "Wi-Fi" }. */
function parsePorts(text) {
  const out = {};
  let port = null;
  for (const l of String(text || '').split('\n')) {
    const p = /^Hardware Port:\s*(.+)$/.exec(l.trim());
    if (p) port = p[1].trim();
    const d = /^Device:\s*(\S+)$/.exec(l.trim());
    if (d && port) {
      out[d[1]] = port;
      port = null;
    }
  }
  return out;
}

/** The interface of the default route ("interface: en0"), "" without one. */
function parseRoute(text) {
  const m = /^\s*interface:\s*(\S+)/m.exec(String(text || ''));
  return m ? m[1] : '';
}

/** What a hardware port is, in the log's words: Wi-Fi → "wifi", the Ethernet kinds → "ethernet". */
function kindOf(iface, port) {
  if (/^utun|^ipsec|^ppp|^tun|^tap/.test(iface)) return 'vpn';
  if (!port) return 'other';
  if (/wi-?fi|airport/i.test(port)) return 'wifi';
  if (/ethernet|lan/i.test(port)) return 'ethernet';
  return port; // "iPhone USB", "Thunderbolt Bridge", "Bluetooth PAN"…
}

/** "v4+v6", "v4 only", "v6 only" or "no address", from os.networkInterfaces()[iface]. */
function families(addresses) {
  let v4 = false;
  let v6 = false;
  for (const a of addresses || []) {
    if (a.internal) continue;
    const fam = a.family === 4 ? 'IPv4' : a.family === 6 ? 'IPv6' : a.family;
    if (fam === 'IPv4') v4 = true;
    else if (fam === 'IPv6' && !/^fe80:/i.test(a.address)) v6 = true;
  }
  return v4 && v6 ? 'v4+v6' : v4 ? 'v4 only' : v6 ? 'v6 only' : 'no address';
}

function describe(iface, ports, interfaces) {
  if (!iface) return 'offline';
  return kindOf(iface, ports[iface]) + ' (' + iface + '), ' + families(interfaces[iface]);
}

function run(exec, cmd, args) {
  return new Promise((resolve) => {
    exec(cmd, args, { timeout: 3000 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** The watcher: { exec, interfaces, everyMs, portsEveryMs, onChange }; describe() never waits. */
class NetState {
  constructor({
    exec = execFile,
    interfaces = () => os.networkInterfaces(),
    everyMs = 15_000,
    portsEveryMs = 5 * 60_000,
    onChange = (d) => netLog.networkChanged(d),
  } = {}) {
    this.exec = exec;
    this.interfaces = interfaces;
    this.everyMs = everyMs;
    this.portsEveryMs = portsEveryMs;
    this.onChange = onChange;
    this.current = '';
    this.ports = null;
    this.portsAt = 0;
    this.refreshing = null;
    this.soon = null;
    this.timer = null;
  }

  /** The last description; "" until the first look. */
  describe() {
    return this.current;
  }

  /** Looks now (one look at a time). */
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        if (!this.ports || Date.now() - this.portsAt > this.portsEveryMs) {
          const p = await run(this.exec, '/usr/sbin/networksetup', ['-listallhardwareports']);
          if (p != null) {
            this.ports = parsePorts(p);
            this.portsAt = Date.now();
          }
        }
        const r = await run(this.exec, '/sbin/route', ['-n', 'get', 'default']);
        const d = describe(r == null ? '' : parseRoute(r), this.ports || {}, this.interfaces() || {});
        if (d !== this.current) {
          this.current = d;
          this.onChange(d);
        }
      } catch {
        /* Keep the last one. */
      } finally {
        this.refreshing = null;
      }
      return this.current;
    })();
    return this.refreshing;
  }

  /** A request failed: look again in a moment (the network may have just changed). */
  stale() {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      this.refresh();
    }, 500);
    if (this.soon.unref) this.soon.unref();
  }

  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.everyMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.soon);
    this.timer = this.soon = null;
  }
}

module.exports = { NetState, parsePorts, parseRoute, kindOf, families, describe };
