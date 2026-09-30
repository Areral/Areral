import { createHash, randomInt, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { Server } from 'socket.io';
import { createTerrain } from '../public/js/terrain.js';
import { NearThreadError, openDatabase } from './db.js';
import { TokenBucket } from './limits.js';
import { MediaError, processUpload } from './media.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THREE_DIR = path.resolve(path.dirname(createRequire(import.meta.url).resolve('three')), '..');

export const LIMITS = {
  name: 40,
  subject: 100,
  comment: 5000,
  fileBytes: 8 * 1024 * 1024,
  threadSpacing: 2.4,
  bumpLimit: 500,
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g; // incl. bidi overrides

function line(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function comment(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(/\n{4,}/g, '\n\n\n').trim();
  if (text.length > LIMITS.comment) throw new HttpError(400, `Слишком длинно: максимум ${LIMITS.comment} символов.`);
  return text;
}

/** CSP allows exactly one inline script: the import map in index.html, pinned by hash. */
function buildCsp(indexHtml) {
  const importMap = indexHtml.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  const hash = importMap ? `'sha256-${createHash('sha256').update(importMap[1]).digest('base64')}'` : '';
  return [
    "default-src 'self'",
    `script-src 'self' ${hash}`.trim(),
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function createBruhchan(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? path.join(ROOT, 'data'));
  const publicDir = path.join(ROOT, 'public');
  const srcDir = path.join(dataDir, 'src');
  const thumbDir = path.join(dataDir, 'thumb');
  for (const dir of [dataDir, srcDir, thumbDir]) mkdirSync(dir, { recursive: true });

  const world = JSON.parse(readFileSync(path.join(publicDir, 'assets', 'world.json'), 'utf8'));
  const terrain = createTerrain(world);
  const db = openDatabase(path.join(dataDir, 'bruhchan.sqlite'), options.clock ? { now: options.clock } : {});
  const flood = new TokenBucket(options.postBurst ?? 20, (options.postsPerMinute ?? 30) / 60);
  const csp = buildCsp(readFileSync(path.join(publicDir, 'index.html'), 'utf8'));

  const app = express();
  const server = createServer(app);
  // cookie:false is the socket.io default; stated explicitly because "no cookies" is a hard rule.
  const io = new Server(server, { cookie: false, serveClient: true, maxHttpBufferSize: 16 * 1024 });

  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    });
    next();
  });

  const vendor = { immutable: true, maxAge: '30d', index: false };
  const media = { immutable: true, maxAge: '365d', index: false, dotfiles: 'deny', fallthrough: false };
  app.use('/vendor/three/build', express.static(path.join(THREE_DIR, 'build'), vendor));
  app.use('/vendor/three/examples/jsm', express.static(path.join(THREE_DIR, 'examples', 'jsm'), vendor));
  app.use('/src', express.static(srcDir, media));
  app.use('/thumb', express.static(thumbDir, media));
  app.use(express.static(publicDir, { index: 'index.html', dotfiles: 'ignore' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: LIMITS.fileBytes, files: 1, fields: 10, fieldSize: 16 * 1024, parts: 12 },
  });
  const receive = (req, res, next) =>
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, `Файл слишком большой. Максимум — ${LIMITS.fileBytes / 1048576} МБ.`));
      next(new HttpError(400, 'Форма пришла кривой. Попробуй ещё раз.'));
    });
  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
  const api = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

  async function storeMedia(file) {
    if (!file?.size) return null;
    let out;
    try {
      out = await processUpload(file.buffer);
    } catch (err) {
      if (err instanceof MediaError) throw new HttpError(415, err.message);
      throw err;
    }
    const base = `${Date.now()}${String(randomInt(1000)).padStart(3, '0')}`;
    const name = `${base}.${out.ext}`;
    const thumb = `${base}s.webp`;
    await writeFile(path.join(srcDir, name), out.full, { flag: 'wx' });
    await writeFile(path.join(thumbDir, thumb), out.thumb, { flag: 'wx' });
    return {
      file: name, thumb, kind: out.kind, size: out.full.length,
      width: out.width, height: out.height, thumbWidth: out.thumbWidth, thumbHeight: out.thumbHeight,
    };
  }

  function discard(stored) {
    if (!stored) return;
    unlink(path.join(srcDir, stored.file)).catch(() => {});
    unlink(path.join(thumbDir, stored.thumb)).catch(() => {});
  }

  function readPost(body, file) {
    const hasFile = Boolean(file?.size);
    const post = {
      name: line(body.name, LIMITS.name) || 'Аноним',
      subject: line(body.subject, LIMITS.subject),
      comment: comment(body.comment),
    };
    if (!post.comment && !hasFile) throw new HttpError(400, 'Пустой пост. Напиши что-нибудь или прикрепи файл.');
    return post;
  }

  function takeFloodToken() {
    if (!flood.take()) throw new HttpError(429, 'Остров захлёбывается постами. Подожди минуту, анон.');
  }

  app.get('/api/threads', api, (req, res) => {
    res.json({ threads: db.listMarkers(), stats: db.counts() });
  });

  app.get('/api/threads/:id', api, (req, res, next) => {
    const thread = db.getThread(Number(req.params.id));
    if (!thread) return next(new HttpError(404, 'Тред не найден. Возможно, его никогда и не было.'));
    res.json(thread);
  });

  app.post('/api/threads', api, receive, wrap(async (req, res) => {
    const x = Number(req.body.x);
    const z = Number(req.body.z);
    const heading = Number(req.body.heading);
    const spot = terrain.plantable(x, z);
    if (!spot.ok) throw new HttpError(422, spot.reason);
    const post = readPost(req.body, req.file);
    takeFloodToken();
    post.media = await storeMedia(req.file);
    let marker;
    try {
      marker = db.createThread(post, {
        x: Math.round(x * 100) / 100,
        y: Math.round(spot.y * 100) / 100, // ground height is ours to decide, never the client's
        z: Math.round(z * 100) / 100,
        heading: Number.isFinite(heading) ? heading % (Math.PI * 2) : 0,
      }, LIMITS.threadSpacing);
    } catch (err) {
      discard(post.media);
      if (err instanceof NearThreadError) throw new HttpError(409, `Тут уже стоит тред №${err.near}. Отойди на пару шагов.`);
      throw err;
    }
    io.emit('thread:new', marker);
    res.status(201).json({ thread: marker });
  }));

  app.post('/api/threads/:id/replies', api, receive, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !db.threadExists(id)) throw new HttpError(404, 'Тред не найден.');
    const post = readPost(req.body, req.file);
    takeFloodToken();
    post.media = await storeMedia(req.file);
    const result = db.addReply(id, post, { sage: Boolean(req.body.sage), bumpLimit: LIMITS.bumpLimit });
    if (!result) {
      discard(post.media);
      throw new HttpError(404, 'Тред не найден.');
    }
    io.emit('thread:bump', result.marker);
    res.status(201).json(result);
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Нет такого метода.' }));
  app.use((req, res) => res.status(404).type('text/plain; charset=utf-8').send('404 — здесь только туман.'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[bruhchan] ошибка:', err.message); // never the request, never an address
    res.status(status).json({ error: status >= 500 ? 'Сервер споткнулся. Попробуй ещё раз.' : err.message });
  });

  // ---- multiplayer presence: ephemeral ids, positions live only in memory
  const players = new Map();
  const bound = (v, lim) => Math.max(-lim, Math.min(lim, v));
  let dirty = false;

  io.on('connection', (socket) => {
    let id = null;
    let lastMove = 0;
    socket.emit('hello', { online: players.size });
    socket.on('enter', () => {
      if (id) return;
      id = randomBytes(4).toString('hex');
      const [x, y, z] = world.spawn.pos;
      players.set(id, { x, y, z, yaw: world.spawn.yaw, moving: 0 });
      dirty = true;
      socket.emit('welcome', { id });
    });
    socket.on('move', (data) => {
      const p = id && players.get(id);
      const t = Date.now();
      if (!p || !Array.isArray(data) || t - lastMove < 40) return;
      const [x, y, z, yaw, moving] = data.map(Number);
      if (![x, y, z, yaw].every(Number.isFinite)) return;
      lastMove = t;
      Object.assign(p, { x: bound(x, 140), y: bound(y, 60), z: bound(z, 140), yaw, moving: moving ? 1 : 0 });
      dirty = true;
    });
    socket.on('disconnect', () => {
      if (id && players.delete(id)) io.emit('leave', id);
    });
  });

  const round2 = (v) => Math.round(v * 100) / 100;
  const ticker = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    const snapshot = [];
    for (const [id, p] of players) snapshot.push([id, round2(p.x), round2(p.y), round2(p.z), round2(p.yaw), p.moving]);
    io.emit('players', snapshot);
  }, 100);
  ticker.unref();

  async function close() {
    clearInterval(ticker);
    io.close();
    await new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
    db.close();
  }

  return { app, server, io, db, terrain, world, close };
}
