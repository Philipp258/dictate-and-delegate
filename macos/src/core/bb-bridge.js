'use strict';
// The bridge to bb (getbb.app), through bb's built-in MCP server (plugin bb--mcp). Its "run" tool
// takes a JavaScript snippet that calls the bb command line (`await bb.json([...])`), at most 25
// seconds each; snippets here are one or two bb calls and never wait.
//
// Two ways to reach bb: bb Connect (https://<handle>.getbb.app/mcp, signed in with OAuth, see
// bb-oauth.js), or a custom address with an optional bearer token. bb doesn't run on the Mac: the
// Mac reaches the same bb as the phone, the same way.
//
// The chief of staff is one bb thread in Personal that receives every agent request. It notifies
// the user through ntfy itself. Each request carries a short ID; text meant for pasting comes back
// as an ntfy message tagged with it (chief-text.js).

const { tr, format } = require('./util');
const mcp = require('./mcp');
const oauthLib = require('./bb-oauth');
const netLog = require('./net-log');

const CONNECT = 'connect';
const CUSTOM = 'custom';

/** bb's project for threads outside any repository ("no project"). */
const PROJECT = 'proj_personal';
const CHIEF_TITLE = 'Chief of staff';

/** Settings (not secret), under the Android preference keys; tokens and the topic in the vault. */
const MODE = 'bbMode';
const HANDLE = 'bbHandle';
const URL_KEY = 'bbUrl';
const LINK_BASE = 'bbLinkBase';
const CHIEF_ID = 'chiefId';
const CHIEF_NAME = 'chiefTitle';
const TALKER_ID = 'talkerId';
const TALKER_ON = 'talkerOn';
const NTFY_SERVER = 'ntfyServer';
const TOKEN = 'bbToken';
const NTFY_TOPIC = 'ntfyTopic';

const NTFY_DEFAULT = 'https://ntfy.sh';

/** The ntfy tag that marks text meant for pasting, and the one that names its request. */
const PASTE_TAG = 'talkrouter-paste';

/** Marks a message from hands-free mode for the chief (HandsFree.TAG on Android). */
const HANDS_FREE_TAG = '[hands-free]';

/** bb's MCP tools take at most 100,000 characters of code; a base64 part stays well below. */
const CODE_LIMIT = 100_000;
const PART = 80_000;
const PASTED_MAX = 60_000;

/** Larger files don't go the base64 way: too many parts. */
const BASE64_MAX = 3_000_000;

const MCP_PATH = '/api/v1/plugins/bb--mcp/http/mcp';

// ------------------------------------------------------------------ pure helpers (unit-tested)

/** A thread id from "thr_…" or a link like https://<handle>.getbb.app/threads/thr_…; "" if none. */
function threadId(idOrLink) {
  const m = /\bthr_[A-Za-z0-9]+/.exec(idOrLink == null ? '' : String(idOrLink).trim());
  return m ? m[0] : '';
}

function threadLink(linkBase, id) {
  return !linkBase || !id ? '' : linkBase + '/threads/' + id;
}

/** https://<handle>.getbb.app/mcp → https://<handle>.getbb.app; other addresses: "". */
function linkBaseFor(mcpUrl) {
  const m = /^(https:\/\/[a-z0-9-]+\.getbb\.app)(\/.*)?$/.exec(String(mcpUrl || '').trim());
  return m ? m[1] : '';
}

/** A JavaScript string literal (JSON is valid JavaScript). */
function js(s) {
  return JSON.stringify(String(s));
}

/**
 * The snippet that sends a message to a thread, queued behind a running turn, else started; with
 * uploaded attachments: [["--image" or "--file", path inside bb's attachments], …].
 */
function tellSnippet(id, message, attachments = []) {
  let files = '';
  for (const a of attachments) files += ',' + js(a[0]) + ',' + js(a[1]);
  return (
    'const r = await bb.json(["thread","tell",' +
    js(id) +
    ',"--mode","queue","--message-file","-"' +
    files +
    '], {stdin: ' +
    js(message) +
    '});\nreturn {threadId: r.threadId, delivery: r.delivery};'
  );
}

function spawnSnippet(prompt) {
  return (
    'const t = await bb.json(["thread","spawn","--project",' +
    js(PROJECT) +
    ',"--title",' +
    js(CHIEF_TITLE) +
    ',"--prompt-file","-"], {stdin: ' +
    js(prompt) +
    '});\nreturn {id: t.id, title: t.title, status: t.status};'
  );
}

function showSnippet(id) {
  return (
    'const s = await bb.json(["thread","show",' +
    js(id) +
    ']);\nreturn {id: s.thread.id, title: s.thread.title || s.thread.titleFallback || "",' +
    ' status: s.thread.status, archived: !!s.thread.archivedAt};'
  );
}

function requestTag(request) {
  return 'req-' + request;
}

/** The ntfy app's subscribe link: ntfy://<host>/<topic> (secure=false for plain HTTP). */
function ntfyLink(server, topic) {
  const host = server.replace(/^[a-zA-Z]+:\/\//, '').replace(/\/+$/, '');
  return 'ntfy://' + host + '/' + topic + (server.startsWith('http://') ? '?secure=false' : '');
}

/** [name, text] from a pair or an object {name, text}. */
function pair(p) {
  return Array.isArray(p) ? [String(p[0]), String(p[1])] : [String(p.name), String(p.text)];
}

/**
 * The message for the chief: the dictation as said, then pasted text as context, then a note about
 * the attached files when there is one ("" for none), then the request ID.
 */
function message(said, pasted = [], note = '', request = '') {
  let s = String(said).trim();
  // Pasted text shares bb's 100,000-character limit with everything else: at most this much.
  let room = PASTED_MAX;
  for (const p of pasted) {
    const [name, raw] = pair(p);
    let text = raw.trim();
    if (room <= 0) break;
    if (text.length > room) text = text.substring(0, room) + '\n[… shortened by Dictate & Delegate]';
    room -= text.length;
    s += '\n\n<pasted name="' + name.replace(/"/g, "'") + '">\n' + text + '\n</pasted>';
  }
  if (note) s += '\n\n' + note;
  if (request) s += '\n\n[request: ' + request + ']';
  return s;
}

/** A message from hands-free mode: what was said, tagged so the chief answers in speakable form. */
function handsFreeMessage(said, request) {
  return message(said, [], HANDS_FREE_TAG, request);
}

/** What the chief is told about files that came as base64 text parts. */
function base64Note(names) {
  return (
    "(Dictate & Delegate couldn't upload my attachments directly, so they come as base64 text in" +
    ' parts, attached as <name>.partNNofMM.b64: for each file, join its parts in order and' +
    ' decode them, e.g. `cat <name>.part*.b64 | base64 -d > <name>`, before you look at it: ' +
    names.join(', ') +
    '.)'
  );
}

/**
 * The name an attached file goes by, with the extension its bytes have (images are stored as
 * JPEG): Attachments.Binary.fileName() on Android. A file object may bring its own fileName.
 */
function fileName(b) {
  if (typeof b.fileName === 'function') return b.fileName();
  if (typeof b.fileName === 'string' && b.fileName) return b.fileName;
  const ext = isImage(b) ? '.jpg' : '.pdf';
  const base = String(b.name).replace(/[^A-Za-z0-9._-]/g, '_');
  return base.toLowerCase().endsWith(ext) ? base : base.replace(/\.[A-Za-z0-9]+$/, '') + ext;
}

function isImage(b) {
  return typeof b.image === 'function' ? b.image() : b.kind === 'image';
}

/**
 * The talker's and the chief's messages, the talker's first (HandsFreeService.bothTo): tellEach
 * starts the first one first, which a real bb took first more often.
 */
function bothTo(chief, talker, toChief, toTalker) {
  const to = new Map();
  if (talker) to.set(talker, toTalker);
  to.set(chief, toChief);
  return to;
}

/** bb refused an upload (HTTP 401, 403, 404 or 405): the base64 way is used instead. */
class UploadRefused extends Error {
  constructor(status) {
    super('HTTP ' + status);
    this.name = 'UploadRefused';
    this.status = status;
  }
}

/**
 * A message that reached one of the chief and the talker but not the other: it counts as sent
 * (sending it again would repeat it to the one that got it), and the reason says who missed it.
 */
class PartlySent extends Error {
  constructor(request, chiefMissed, why) {
    super(why);
    this.name = 'PartlySent';
    this.request = request;
    this.chiefMissed = chiefMissed;
  }
}

function why(ex) {
  return (ex && ex.message) || (ex && ex.name) || String(ex);
}

function explain(ex, connect) {
  switch (ex.status) {
    case 0:
      return ex.message;
    case 401:
      return connect
        ? tr('bb no longer accepts this sign-in. Sign in again in Settings → bb.')
        : tr('bb refused the token (HTTP 401). Check the token in Settings → bb.');
    case 403:
      return tr("bb refused the request (HTTP 403). Is this address allowed to use bb's MCP server?");
    case 404:
      return tr("No MCP server at this address (HTTP 404). Check the address, and that bb's MCP plugin is on.");
    case 502:
    case 503:
    case 504:
      return tr("bb isn't reachable right now (HTTP %1$d). Is your computer on and bb running?", ex.status);
    default:
      return ex.message;
  }
}

function wrap(message, cause) {
  const e = new Error(message);
  e.cause = cause;
  return e;
}

// ------------------------------------------------------------------ the bridge

class BbBridge {
  /**
   * prefs and vault as in store.js; oauth a BbOAuth on the same vault (made here if not given);
   * skills the ChiefSkills that keeps bb's skills current (made on first use if not given).
   */
  constructor({ prefs, vault, oauth, fetch: fetchImpl = globalThis.fetch, log = () => {}, skills } = {}) {
    this.prefs = prefs;
    this.vault = vault;
    this.fetch = fetchImpl;
    this.oauth = oauth || new oauthLib.BbOAuth({ vault, fetch: fetchImpl });
    this.log = log;
    this._skills = skills || null;
    /** For a real check: treat the upload as refused, as bb Connect does. */
    this.refuseUploads = false;
  }

  get skills() {
    if (!this._skills) {
      const { ChiefSkills } = require('./chief-skills');
      this._skills = new ChiefSkills({ bridge: this, prefs: this.prefs, log: this.log });
    }
    return this._skills;
  }

  set skills(s) {
    this._skills = s;
  }

  // ---------------------------------------------------------------- settings

  mode() {
    return this.prefs.get(MODE, CONNECT);
  }

  handle() {
    return this.prefs.get(HANDLE, '');
  }

  /** The MCP address in use: bb Connect's for the handle, or the custom one. */
  url() {
    if (this.mode() === CUSTOM) return this.prefs.get(URL_KEY, '');
    return this.handle() ? this.oauth.resource(this.handle()) : '';
  }

  /** Where thread links point: the bb web app, e.g. https://<handle>.getbb.app. */
  linkBase() {
    const custom = this.prefs.get(LINK_BASE, '');
    if (this.mode() === CUSTOM && custom) return custom;
    if (this.handle()) return this.oauth.origin(this.handle());
    return this.mode() === CUSTOM ? linkBaseFor(this.prefs.get(URL_KEY, '')) : '';
  }

  /** bb Connect signed in, or a custom address saved. */
  connected() {
    return this.mode() === CUSTOM ? !!this.prefs.get(URL_KEY, '') : !!this.handle() && this.oauth.signedIn();
  }

  chiefId() {
    return this.prefs.get(CHIEF_ID, '');
  }

  chiefTitle() {
    return this.prefs.get(CHIEF_NAME, '');
  }

  /** The talker thread as saved (Settings → Hands-free), on or off; "" for none. */
  savedTalker() {
    return this.prefs.get(TALKER_ID, '');
  }

  talkerOn() {
    return !!this.prefs.get(TALKER_ON, false);
  }

  /**
   * The talker for hands-free calls: a fast thread that does the talking while the chief does the
   * work. "" when off, not set, or the chief itself.
   */
  talkerId() {
    const t = this.savedTalker();
    return this.talkerOn() && t !== this.chiefId() ? t : '';
  }

  /** The chief can get requests: bb is connected and a chief is set. */
  ready() {
    return this.connected() && !!this.chiefId();
  }

  useConnect(h) {
    this.prefs.set(MODE, CONNECT);
    this.prefs.set(HANDLE, h);
  }

  useCustom(url, token = '', linkBase = '') {
    this.prefs.set(MODE, CUSTOM);
    this.prefs.set(URL_KEY, String(url).trim());
    this.prefs.set(LINK_BASE, String(linkBase).trim().replace(/\/+$/, ''));
    if (!String(token).trim()) this.vault.remove(TOKEN);
    else this.vault.set(TOKEN, String(token).trim());
  }

  customToken() {
    try {
      return this.vault.get(TOKEN) || '';
    } catch {
      return '';
    }
  }

  setChief(t) {
    const { CHIEF_TOLD } = require('./chief-skills');
    this.prefs.set(CHIEF_ID, t.id);
    this.prefs.set(CHIEF_NAME, t.title);
    this.prefs.set(CHIEF_TOLD, true);
  }

  forgetChief() {
    const { CHIEF_TOLD } = require('./chief-skills');
    this.prefs.remove(CHIEF_ID);
    this.prefs.remove(CHIEF_NAME);
    this.prefs.remove(CHIEF_TOLD);
  }

  /** Signs out of bb Connect (revoking the tokens) or forgets the custom address. */
  async disconnect() {
    if (this.mode() === CUSTOM) {
      this.prefs.remove(URL_KEY);
      this.prefs.remove(LINK_BASE);
      this.vault.remove(TOKEN);
    } else await this.oauth.signOut();
  }

  /** Forgets everything about bb on this Mac (Delete local data); revokes in the background. */
  forgetAll() {
    const tokens = this.oauth.forget();
    this.oauth.revoke(tokens).catch(() => {});
    this.vault.remove(TOKEN);
    this.vault.remove(NTFY_TOPIC);
  }

  ntfyServer() {
    return this.prefs.get(NTFY_SERVER, NTFY_DEFAULT);
  }

  setNtfyServer(server) {
    const s = String(server).trim().replace(/\/+$/, '');
    this.prefs.set(NTFY_SERVER, s || NTFY_DEFAULT);
  }

  /** The ntfy topic, made once: whoever knows it can read the notifications. */
  ntfyTopic() {
    let topic = this.vault.get(NTFY_TOPIC);
    if (!topic) {
      topic = newTopic();
      this.vault.set(NTFY_TOPIC, topic);
    }
    return topic;
  }

  /** Mac: is there a topic yet? (Without one, the phone's is taken from bb: ChiefSkills.adoptFromBb.) */
  hasNtfyTopic() {
    return !!this.vault.get(NTFY_TOPIC);
  }

  /** Mac: uses this topic (the phone's, read from the installed skill). */
  setNtfyTopic(topic) {
    this.vault.set(NTFY_TOPIC, topic);
  }

  threadLink(id) {
    return threadLink(this.linkBase(), id);
  }

  // ---------------------------------------------------------------- operations

  /** Checks that bb answers and offers the run tool. */
  async test() {
    await this.call('bb check', async (c) => {
      for (const t of await c.tools()) if (t.name === 'run') return null;
      throw new Error(tr("bb answers, but it doesn't offer the run tool. Update bb and check that the MCP plugin is on."));
    });
  }

  /**
   * Creates the chief of staff in Personal and keeps it. Its instructions are the chief-of-staff
   * and dictate-and-delegate skills, installed first; the thread itself only gets one line.
   */
  async createChief() {
    const skills = this.skills;
    await skills.adoptIfNew(); // Mac: fill the skills as the phone does, if it set them up.
    await skills.ensure(skills.filled());
    const { START } = require('./chief-skills');
    const r = await this.run(spawnSnippet(START));
    const t = { id: r.id || '', title: r.title || CHIEF_TITLE, status: r.status || '' };
    if (!t.id) throw new Error(tr("bb didn't say which thread it created."));
    this.setChief(t);
    return t;
  }

  /**
   * Uses an existing bb thread as the chief of staff, after checking it exists: the skills are
   * installed, then it gets the one line.
   */
  async useExistingChief(idOrLink) {
    const id = threadId(idOrLink);
    if (!id) throw new Error(tr("That isn't a bb thread link or id (it starts with thr_)."));
    const r = await this.run(showSnippet(id));
    if (r.archived) throw new Error(tr('That thread is archived in bb. Unarchive it or pick another.'));
    const t = { id: r.id || id, title: r.title || '', status: r.status || '' };
    const skills = this.skills;
    await skills.adoptIfNew();
    await skills.ensure(skills.filled());
    const { START } = require('./chief-skills');
    await this.send(t.id, START);
    this.setChief(t);
    return t;
  }

  /** Posts a test notification to the topic, as the chief would. */
  async ntfyTest() {
    const server = this.ntfyServer();
    const url = server + '/' + this.ntfyTopic();
    let res;
    try {
      res = await netLog.request('ntfy test', 'POST', url, async (net) => {
        const body = tr("Test from Dictate & Delegate. Your chief of staff's notifications arrive like this.");
        net.sent(Buffer.byteLength(body, 'utf8'));
        const r = await this.fetch(url, {
          method: 'POST',
          headers: { Title: 'Dictate & Delegate' },
          body,
          signal: AbortSignal.timeout(20_000),
        });
        net.status(r.status);
        await r.arrayBuffer().catch(() => {});
        return r;
      }, { secrets: [this.ntfyTopic()] });
    } catch (ex) {
      throw wrap(
        mcp.networkKind(ex) === 'timeout'
          ? tr("%1$s didn't answer in time. Try again.", server)
          : tr('Could not reach %1$s. Check the address and your connection.', server),
        ex,
      );
    }
    if (res.status >= 300) throw new Error(tr('The ntfy server answered with HTTP %1$d.', res.status));
  }

  /** Sends a message to a thread: queued behind a turn that is running, else it starts one. */
  async send(chiefId, msg) {
    await this.run(tellSnippet(chiefId, msg));
  }

  /**
   * Sends a request to the chief (its instructions come from the skills): what was said, pasted
   * text ([[name, text]]), and the images and PDFs ({kind: "image"|"pdf", name, mimeType, data:
   * Buffer}), images first. Files are uploaded to bb's attachments and go with the message
   * (--image, --file). If bb refuses the upload (bb Connect may not take the app's sign-in for it),
   * they go as base64 text in parts through MCP, and the message tells the chief to join and decode
   * them. A file that can't go either way is named in the message; the dictation always goes.
   * Returns {files, how: "upload"|"base64"|"upload+base64"|"", refused: HTTP status or 0, failed}.
   */
  async sendRequest(chiefId, said, pasted = [], files = [], request = '') {
    const refs = [];
    const failed = [];
    const encoded = [];
    let refused = 0;
    let sent = 0;
    for (const b of files) {
      const name = fileName(b);
      const data = Buffer.from(b.data);
      try {
        if (refused === 0) {
          try {
            refs.push([isImage(b) ? '--image' : '--file', await this.upload(name, b.mimeType, data)]);
            sent++;
            continue;
          } catch (ex) {
            if (!(ex instanceof UploadRefused)) throw ex;
            refused = ex.status;
          }
        }
        if (data.length > BASE64_MAX) throw new Error(tr("it's too big to pass on this way"));
        const parts = await this.uploadBase64(name, data);
        for (const path of parts) refs.push(['--file', path]);
        encoded.push(name + ' (' + parts.length + (parts.length === 1 ? ' part)' : ' parts)'));
        sent++;
      } catch (ex) {
        failed.push(name + ': ' + why(ex));
      }
    }
    let note = '';
    if (encoded.length) note += base64Note(encoded);
    if (failed.length) {
      note += (note ? '\n\n' : '') + '(I also attached ' + failed.join('; ') + ". Dictate & Delegate couldn't pass that on.)";
    }
    await this.run(tellSnippet(chiefId, message(said, pasted, note, request), refs));
    const how = sent === 0 ? '' : encoded.length === 0 ? 'upload' : sent === encoded.length ? 'base64' : 'upload+base64';
    return { files: sent, how, refused, failed };
  }

  /**
   * A message from hands-free mode: what was said, tagged so the chief answers in speakable form.
   * With a talker, it goes to both at once, the same text and request ID (HandsFreeService.sendBoth):
   * throws when neither got it, PartlySent when only one did. Returns {took: {threadId: ms}}.
   */
  async sendHandsFree(chiefId, said, request, talker = '', events = null) {
    const msg = handsFreeMessage(said, request);
    if (!talker || talker === chiefId) {
      const start = Date.now();
      await this.run(tellSnippet(chiefId, msg));
      return { took: { [chiefId]: Date.now() - start } };
    }
    const took = {};
    const failed = await this.tellEach(bothTo(chiefId, talker, msg, msg), took);
    const chiefWhy = failed[chiefId];
    const talkerWhy = failed[talker];
    const note = events || this.log;
    if (chiefWhy != null) note("the chief didn't get " + request + ': ' + chiefWhy);
    if (talkerWhy != null) note('the talker (' + talker + ") didn't get " + request + ': ' + talkerWhy);
    if (chiefWhy != null && talkerWhy != null) throw new Error(tr('neither the chief nor the talker got it: %1$s', chiefWhy));
    if (chiefWhy != null) throw new PartlySent(request, true, chiefWhy);
    if (talkerWhy != null) throw new PartlySent(request, false, talkerWhy);
    return { took };
  }

  /**
   * Sends each thread its message (a Map or object, thread ID → message), all at the same time: a
   * failure to reach one doesn't hold up the others. Returns the failures, thread ID → why; empty
   * when every thread got its message. took gets how long each send took, thread ID → ms.
   */
  async tellEach(messages, took = {}) {
    const entries = messages instanceof Map ? [...messages.entries()] : Object.entries(messages);
    const failed = {};
    await Promise.all(
      entries.map(async ([id, msg]) => {
        const start = Date.now();
        try {
          await this.run(tellSnippet(id, msg));
        } catch (ex) {
          failed[id] = why(ex);
        } finally {
          took[id] = Date.now() - start;
        }
      }),
    );
    return failed;
  }

  /** bb's own address for its REST API, next to the MCP address. */
  apiBase() {
    if (this.mode() === CONNECT) return this.handle() ? this.oauth.origin(this.handle()) : '';
    const u = this.url().replace(/\/+$/, '');
    if (u.endsWith(MCP_PATH)) return u.substring(0, u.length - MCP_PATH.length);
    if (u.endsWith('/mcp')) return u.substring(0, u.length - 4);
    const parsed = new URL(u);
    return parsed.protocol + '//' + parsed.host;
  }

  /**
   * Uploads a file to bb's attachments for Personal (POST /api/v1/projects/proj_personal/attachments,
   * multipart, like bb's own app) and returns its path there, for bb thread tell.
   */
  async upload(name, mimeType, data) {
    if (this.refuseUploads) throw new UploadRefused(401);
    const connect = this.mode() === CONNECT;
    for (let attempt = 0; ; attempt++) {
      const token = connect ? await this.oauth.accessToken(attempt > 0) : this.customToken();
      const boundary = 'talkrouter' + oauthLib.random(12);
      const payload = Buffer.concat([
        Buffer.from(
          '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + String(name).replace(/"/g, '_') +
            '"\r\nContent-Type: ' + mimeType + '\r\n\r\n',
          'utf8',
        ),
        Buffer.from(data),
        Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8'),
      ]);
      const headers = { 'Content-Type': 'multipart/form-data; boundary=' + boundary };
      if (token) headers.Authorization = 'Bearer ' + token;
      let res, text;
      try {
        const address = this.apiBase() + '/api/v1/projects/' + PROJECT + '/attachments';
        res = await netLog.request('bb upload', 'POST', address, async (net) => {
          net.sent(payload.length);
          const r = await this.fetch(address, {
            method: 'POST',
            headers,
            body: payload,
            redirect: 'manual',
            signal: AbortSignal.timeout(60_000),
          });
          net.status(r.status);
          text = await r.text();
          net.received(Buffer.byteLength(text, 'utf8'));
          return r;
        }, { retry: attempt });
      } catch (ex) {
        throw wrap(
          mcp.networkKind(ex) === 'broken'
            ? tr('The connection to bb broke off. Try again.')
            : tr("bb isn't reachable right now. Is your computer on and bb running?"),
          ex,
        );
      }
      const status = res.status;
      if (status === 401 && connect && attempt === 0) continue;
      if (status === 401 || status === 403 || status === 404 || status === 405) throw new UploadRefused(status);
      if (status >= 300) throw new Error(tr("bb couldn't take the attachment (HTTP %1$d).", status));
      let path = '';
      try {
        path = JSON.parse(text).path || '';
      } catch {
        /* Not JSON: said below. */
      }
      if (!path) throw new Error(tr('bb sent something unexpected. Update bb, then try again.'));
      return path;
    }
  }

  /**
   * A file as base64 text through MCP (bb.cli takes text only), in parts that keep each snippet
   * under bb's code limit: <name>.partNNofMM.b64. Returns their paths in bb's attachments.
   */
  async uploadBase64(name, data) {
    const all = Buffer.from(data).toString('base64');
    const count = Math.max(1, Math.ceil(all.length / PART));
    const paths = [];
    for (let i = 0; i < count; i++) {
      const part = all.substring(i * PART, Math.min(all.length, (i + 1) * PART));
      const file = format('%s.part%02dof%02d.b64', name, i + 1, count);
      const code =
        'const a = await bb.json(["project","attachment","upload",' +
        js(PROJECT) +
        ',"--client-file","/dev/stdin","--filename",' +
        js(file) +
        ',"--mime-type","text/plain"], {stdin: ' +
        js(part) +
        '});\nreturn {path: a.path};';
      const path = (await this.run(code)).path || '';
      if (!path) throw new Error(tr('bb sent something unexpected. Update bb, then try again.'));
      paths.push(path);
    }
    return paths;
  }

  // ---------------------------------------------------------------- transport

  /** Runs a snippet with the run tool; its returned value as an object. */
  run(code) {
    return this.snippet('run', code);
  }

  /** Runs a snippet that only looks (bb skill list/show) with the read tool. */
  read(code) {
    return this.snippet('read', code);
  }

  async snippet(tool, code) {
    if (code.length > CODE_LIMIT) {
      throw new Error(tr('This is too long for bb (%1$d characters, at most %2$d).', code.length, CODE_LIMIT));
    }
    return this.call('bb ' + what(code, tool, this.chiefId(), this.talkerId()), async (c) => {
      const result = await c.callResult(tool, { code });
      let text = mcp.Connection.text(result).trim();
      if (result.isError) {
        if (text.length > 400) text = text.substring(0, 400) + '…';
        throw new Error(tr("bb couldn't do it: %1$s", text || tr('no details')));
      }
      if (!text) return {};
      try {
        const v = JSON.parse(text);
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      } catch {
        /* Plain text. */
      }
      return { text };
    });
  }

  /**
   * One MCP session. With bb Connect, an expired or refused token is refreshed once and the call
   * tried again. Every failure comes back as an Error with a readable message.
   */
  async call(label, work) {
    const url = this.url();
    if (!this.connected() || !url) throw new Error(tr("bb isn't connected. Connect it in Settings → bb."));
    const connect = this.mode() === CONNECT;
    try {
      for (let attempt = 0; ; attempt++) {
        const token = connect ? await this.oauth.accessToken(attempt > 0) : this.customToken();
        const c = new mcp.Connection({ name: 'bb', url, token }, { fetch: this.fetch });
        c.what = label;
        c.retry = attempt;
        try {
          await c.open();
          return await work(c);
        } catch (ex) {
          if (ex instanceof mcp.McpError && ex.status === 401 && connect && attempt === 0) continue;
          throw ex;
        }
      }
    } catch (ex) {
      if (ex instanceof mcp.McpError) throw wrap(explain(ex, connect), ex);
      if (ex instanceof SyntaxError) throw wrap(tr('bb sent something unexpected. Update bb, then try again.'), ex);
      if (ex instanceof Error && ex.message) throw ex;
      throw wrap(tr('The connection to bb broke off. Try again.'), ex);
    }
  }
}

/**
 * What a snippet does, for the network log: "tell chief", "tell talker", "tell thr_…", "check
 * skills", "spawn thread", "archive thread", "show thread", "upload part"; else the tool.
 */
function what(code, tool, chief, talker) {
  const tell = /\["thread","tell","([^"]*)"/.exec(code);
  if (tell) {
    const id = tell[1];
    return 'tell ' + (id && id === chief ? 'chief' : id && id === talker ? 'talker' : id);
  }
  if (code.includes('["skill","list"]')) return 'check skills';
  if (code.includes('["thread","spawn"')) return 'spawn thread';
  if (code.includes('["thread","archive"')) return 'archive thread';
  if (code.includes('["thread","show"')) return 'show thread';
  if (code.includes('["project","attachment","upload"')) return 'upload part';
  return tool;
}

/** "talkrouter-" and 24 random URL-safe characters (144 bits). */
function newTopic() {
  return 'talkrouter-' + oauthLib.random(18);
}

module.exports = {
  BbBridge,
  CONNECT,
  CUSTOM,
  PROJECT,
  CHIEF_TITLE,
  MODE,
  HANDLE,
  URL: URL_KEY,
  LINK_BASE,
  CHIEF_ID,
  CHIEF_NAME,
  TALKER_ID,
  TALKER_ON,
  NTFY_SERVER,
  TOKEN,
  NTFY_TOPIC,
  NTFY_DEFAULT,
  PASTE_TAG,
  HANDS_FREE_TAG,
  CODE_LIMIT,
  PART,
  PASTED_MAX,
  BASE64_MAX,
  UploadRefused,
  PartlySent,
  threadId,
  threadLink,
  linkBaseFor,
  js,
  tellSnippet,
  spawnSnippet,
  showSnippet,
  requestTag,
  ntfyLink,
  message,
  handsFreeMessage,
  base64Note,
  fileName,
  bothTo,
  newTopic,
  explain,
  what,
};
