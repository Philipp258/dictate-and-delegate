'use strict';
// What the user adds to a dictation while recording: pasted text or files (images, PDFs, text).
// They wait in "pending" for the dictation being recorded (or the next one), then move to that
// note's folder, so a redo or "process again" has them too, and are kept as long as its audio.
// Jev sees a short summary; the text model gets the content; a dictation that asks for nothing
// ignores them. Same folder layout as Android: <dir>/<note>/items.json and the files.

const fs = require('fs');
const path = require('path');
const { tr } = require('./util');

const MAX_FILE = 10_000_000;
const MAX_TEXT = 60_000;
const MAX_ITEMS = 6;
const WEEK = 7 * 86_400_000;

/** What Android scales images to before its JPEG (85 %); a toJpeg on the Mac should do the same. */
const IMAGE_MAX_WIDTH = 1600;
const IMAGE_MAX_HEIGHT = 8000;
const JPEG_QUALITY = 85;

const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
};

const EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/tiff': '.tiff',
  'image/bmp': '.bmp',
};

/**
 * What a file is, from its first bytes, else its extension (Android asks the content resolver):
 * { kind: "image" | "pdf" | "file", mime }.
 */
function sniff(name, data) {
  const head = data.subarray(0, 16);
  const ascii = head.toString('latin1');
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (ascii.startsWith('\x89PNG')) return { kind: 'image', mime: 'image/png' };
  if (ascii.startsWith('GIF8')) return { kind: 'image', mime: 'image/gif' };
  if (ascii.startsWith('RIFF') && ascii.substring(8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (ascii.substring(4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|heim|heis)$/.test(ascii.substring(8, 12)))
    return { kind: 'image', mime: 'image/heic' };
  if (ascii.startsWith('%PDF')) return { kind: 'pdf', mime: 'application/pdf' };
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_TYPES[ext]) return { kind: 'image', mime: IMAGE_TYPES[ext] };
  if (ext === '.pdf') return { kind: 'pdf', mime: 'application/pdf' };
  return { kind: 'file', mime: 'text/plain' };
}

/** An image or PDF as bytes, for the chief: { kind, name, mimeType, data, image(), fileName() }. */
class Binary {
  constructor(kind, name, mimeType, data) {
    this.kind = kind;
    this.name = name;
    this.mimeType = mimeType;
    this.data = data;
  }

  image() {
    return this.kind === 'image';
  }

  /** The name with the extension its bytes have (images are stored as JPEG when converted). */
  fileName() {
    const ext = this.image() ? EXTENSIONS[this.mimeType] || '.jpg' : '.pdf';
    const base = this.name.replace(/[^A-Za-z0-9._-]/g, '_');
    return base.toLowerCase().endsWith(ext) ? base : base.replace(/\.[A-Za-z0-9]+$/, '') + ext;
  }
}

class Attachments {
  /**
   * dir: the attachments folder; toJpeg(buffer) → buffer or Promise<buffer>: how images become
   * JPEG (Android scales them to IMAGE_MAX_* and compresses at JPEG_QUALITY); without it, images
   * are kept as they are, with their own type. clock for tests.
   */
  constructor({ dir, toJpeg = null, clock = () => Date.now() }) {
    this.dir = dir;
    this.toJpeg = toJpeg;
    this.clock = clock;
  }

  folder(note) {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(String(note)) || note === '.' || note === '..')
      throw new Error('Invalid note ID: ' + note);
    return path.join(this.dir, note);
  }

  /** The attachments waiting for the current or next dictation: [{ kind, name, file, size, mime? }]. */
  pending() {
    return read(this.folder('pending'));
  }

  of(note) {
    return read(this.folder(note));
  }

  addText(text) {
    let clean = text.trim();
    if (clean === '') throw new Error(tr('Nothing to paste: copy some text first.'));
    if (clean.length > MAX_TEXT) clean = clean.substring(0, MAX_TEXT);
    const first = clean.replace(/\n/g, ' ');
    this.add('text', first.length > 40 ? first.substring(0, 40) + '…' : first, Buffer.from(clean, 'utf8'), '.txt');
  }

  /** Copies a file the user picked (a path, where Android has a Uri); images become JPEG with toJpeg. */
  async addFile(file) {
    const name = path.basename(file);
    let size;
    try {
      size = fs.statSync(file).size;
    } catch (ex) {
      throw new Error(tr('Could not read this file.'), { cause: ex });
    }
    if (size > MAX_FILE) throw new Error(tr('This file is too large (at most 10 MB).'));
    let data;
    try {
      data = fs.readFileSync(file);
    } catch (ex) {
      throw new Error(tr('Could not read this file.'), { cause: ex });
    }
    const type = sniff(name, data);
    if (type.kind === 'image') {
      if (this.toJpeg) {
        let jpeg;
        try {
          jpeg = await this.toJpeg(data);
        } catch (ex) {
          throw new Error(tr('Could not read this image.'), { cause: ex });
        }
        if (!jpeg || jpeg.length === 0) throw new Error(tr('Could not read this image.'));
        this.add('image', name, Buffer.from(jpeg), '.jpg', 'image/jpeg');
      } else this.add('image', name, data, EXTENSIONS[type.mime] || path.extname(name).toLowerCase() || '.img', type.mime);
    } else if (type.kind === 'pdf') this.add('pdf', name, data, '.pdf');
    else this.add('file', name, data, '.txt');
  }

  remove(item) {
    const f = this.folder('pending');
    const list = read(f).filter((i) => i.file !== item.file);
    fs.rmSync(path.join(f, path.basename(item.file)), { force: true });
    write(f, list);
  }

  clearPending() {
    fs.rmSync(this.folder('pending'), { recursive: true, force: true });
  }

  /**
   * The finished dictation keeps what was attached while it was recorded. Returns how many the
   * note has now (Android asks of(note).size() right after).
   */
  claimPending(note) {
    const from = this.folder('pending');
    const to = this.folder(note);
    if (!fs.existsSync(from) || read(from).length === 0) return this.of(note).length;
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch {
      fs.rmSync(from, { recursive: true, force: true });
    }
    return this.of(note).length;
  }

  deleteNote(note) {
    fs.rmSync(this.folder(note), { recursive: true, force: true });
  }

  deleteAll() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** Same time limit as saved audio: a week, then only the note's text stays (keep: recordings of notes still queued for the chief). */
  prune(keep = new Set()) {
    let notes;
    try {
      notes = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const weekAgo = this.clock() - WEEK;
    for (const n of notes) {
      if (n === 'pending' || keep.has(n)) continue;
      const f = path.join(this.dir, n);
      try {
        if (fs.statSync(f).mtimeMs < weekAgo) fs.rmSync(f, { recursive: true, force: true });
      } catch {
        /* Gone meanwhile. */
      }
    }
  }

  /** "The user attached:\n- pasted text (1234 characters): "…"\n- an image (photo.jpg)\n- a PDF (offer.pdf)" */
  summary(note) {
    const items = this.of(note);
    if (items.length === 0) return '';
    let s = 'The user attached:';
    for (const i of items) {
      s += '\n- ';
      switch (i.kind) {
        case 'text': {
          const text = this.readText(note, i);
          s += 'pasted text (' + text.length + ' characters): "' + (text.length > 300 ? text.substring(0, 300) + '…' : text) + '"';
          break;
        }
        case 'image':
          s += 'an image (' + i.name + ')';
          break;
        case 'pdf':
          s += 'a PDF (' + i.name + ')';
          break;
        default:
          s += 'a file (' + i.name + ')';
      }
    }
    return s;
  }

  /** Pasted text and text files, for the chief: [[name, text]]. */
  texts(note) {
    const out = [];
    for (const i of this.of(note)) {
      if (i.kind === 'text') out.push(['pasted text', this.readText(note, i)]);
      else if (i.kind === 'file') out.push([i.name, this.readText(note, i)]);
    }
    return out;
  }

  /** Images, then PDFs: what goes to the chief as attachments ([Binary]). */
  binaries(note) {
    const images = [];
    const others = [];
    for (const i of this.of(note)) {
      if (i.kind !== 'image' && i.kind !== 'pdf') continue;
      const data = fs.readFileSync(path.join(this.folder(note), path.basename(i.file)));
      if (i.kind === 'image') images.push(new Binary('image', i.name, imageType(i), data));
      else others.push(new Binary('pdf', i.name, 'application/pdf', data));
    }
    return images.concat(others);
  }

  /** Message parts for the model: text inline, images and PDFs as base64 data URLs. */
  parts(note) {
    const parts = [];
    for (const i of this.of(note)) {
      const f = path.join(this.folder(note), path.basename(i.file));
      switch (i.kind) {
        case 'image':
          parts.push({
            type: 'image_url',
            image_url: { url: 'data:' + imageType(i) + ';base64,' + fs.readFileSync(f).toString('base64') },
          });
          break;
        case 'pdf':
          parts.push({
            type: 'file',
            file: { filename: i.name, file_data: 'data:application/pdf;base64,' + fs.readFileSync(f).toString('base64') },
          });
          break;
        default:
          parts.push({
            type: 'text',
            text: '<attachment name="' + i.name.replace(/"/g, "'") + '">\n' + this.readText(note, i) + '\n</attachment>',
          });
      }
    }
    return parts;
  }

  readText(note, i) {
    try {
      const text = fs.readFileSync(path.join(this.folder(note), path.basename(i.file)), 'utf8');
      return text.length > MAX_TEXT ? text.substring(0, MAX_TEXT) : text;
    } catch {
      return '';
    }
  }

  /**
   * Adds bytes to the pending attachments (also for tests). mime: images kept unconverted carry
   * their type (a Mac-only field; Android's images are always JPEG).
   */
  add(kind, name, data, suffix, mime) {
    if (data.length > MAX_FILE) throw new Error(tr('This file is too large (at most 10 MB).'));
    const f = this.folder('pending');
    const list = read(f);
    if (list.length >= MAX_ITEMS) throw new Error(tr('At most %1$d attachments per dictation.', MAX_ITEMS));
    fs.mkdirSync(f, { recursive: true });
    const file = this.clock() + '-' + list.length + suffix;
    fs.writeFileSync(path.join(f, file), data);
    const item = { kind, name: name.trim() === '' ? kind : name, file, size: data.length };
    if (kind === 'image' && mime && mime !== 'image/jpeg') item.mime = mime;
    list.push(item);
    write(f, list);
  }
}

function imageType(item) {
  return item.mime || 'image/jpeg';
}

function read(folder) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(folder, 'items.json'), 'utf8'));
    if (!Array.isArray(a)) return [];
    return a.map((o) => {
      const item = {
        kind: String(o.kind ?? ''),
        name: String(o.name ?? ''),
        file: String(o.file ?? ''),
        size: Number(o.size) || 0,
      };
      if (o.mime) item.mime = String(o.mime);
      return item;
    });
  } catch {
    return []; // No attachments.
  }
}

function write(folder, list) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'items.json'), JSON.stringify(list));
}

module.exports = {
  Attachments,
  Binary,
  sniff,
  MAX_FILE,
  MAX_TEXT,
  MAX_ITEMS,
  WEEK,
  IMAGE_MAX_WIDTH,
  IMAGE_MAX_HEIGHT,
  JPEG_QUALITY,
};
