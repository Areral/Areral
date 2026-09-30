import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { io as ioClient } from 'socket.io-client';
import { renderComment } from '../public/js/markup.js';
import { createBruhchan } from '../server/app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let app;
let base;
let dataDir;
let clock = 1_760_000_000;

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'bruhchan-test-'));
  app = createBruhchan({ dataDir, clock: () => clock, postsPerMinute: 600, postBurst: 100 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function form(fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  if (file) fd.set('file', new Blob([file.buffer], { type: file.type }), file.name);
  return fd;
}

async function post(url, fd) {
  const res = await fetch(base + url, { method: 'POST', body: fd });
  return { res, body: await res.json() };
}

const spawn = () => ({ x: app.world.spawn.pos[0], z: app.world.spawn.pos[2] });

async function exifJpeg() {
  return sharp({ create: { width: 320, height: 200, channels: 3, background: '#b0663a' } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'SECRET-MAKE', Model: 'SECRET-CAM', Software: 'SECRET-SOFT' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '55/1 45/1 21/1', GPSLongitudeRef: 'E', GPSLongitude: '37/1 37/1 4/1' },
    })
    .toBuffer();
}

describe('privacy', () => {
  test('serves the page with a hash-pinned CSP, no cookies and no fingerprinting headers', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
    const hash = createHash('sha256').update(importMap).digest('base64');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, new RegExp(`script-src 'self' 'sha256-${hash.replace(/[+/]/g, '\\$&')}'`));
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(res.headers.get('x-powered-by'), null);

    for (const url of ['/api/threads', '/vendor/three/build/three.module.js', '/socket.io/socket.io.esm.min.js', '/socket.io/?EIO=4&transport=polling']) {
      const r = await fetch(base + url);
      assert.equal(r.status, 200, url);
      assert.equal(r.headers.get('set-cookie'), null, url);
    }
  });

  test('server code never reads client addresses', () => {
    const forbidden = /req\.ip\b|req\.ips\b|remoteAddress|x-forwarded-for|handshake\.address|morgan/i;
    for (const file of readdirSync(path.join(ROOT, 'server'))) {
      const src = readFileSync(path.join(ROOT, 'server', file), 'utf8');
      assert.doesNotMatch(src, forbidden, file);
    }
  });

  test('database schema has no place for identifying data', () => {
    for (const table of ['posts', 'threads']) {
      const cols = app.db.raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      for (const c of cols) assert.doesNotMatch(c, /ip|addr|agent|cookie|session|user|email|orig/i, `${table}.${c}`);
    }
  });
});

describe('threads', () => {
  let threadId;

  test('refuses to plant in the sea, inside ruins or without coordinates', async () => {
    const [cx, cz] = app.world.colliders[0];
    for (const [x, z] of [[130, 130], [cx, cz], ['nope', 1]]) {
      const { res, body } = await post('/api/threads', form({ x, z, comment: 'тест' }));
      assert.equal(res.status, 422, `${x},${z}`);
      assert.ok(body.error);
    }
  });

  test('plants a thread, decides ground height itself and strips EXIF/GPS in memory', async () => {
    const jpeg = await exifJpeg();
    const before = await sharp(jpeg).metadata();
    assert.ok(before.exif?.includes('SECRET-CAM'), 'fixture must carry EXIF');

    const { x, z } = spawn();
    const { res, body } = await post('/api/threads', form(
      { x, z, y: 999, heading: 1.5, subject: 'Кто построил эти камни?', comment: 'Проснулся на пляже.\n>be me' },
      { buffer: jpeg, type: 'image/jpeg', name: 'IMG_20260930_101010.jpg' },
    ));
    assert.equal(res.status, 201, JSON.stringify(body));
    threadId = body.thread.id;
    assert.equal(body.thread.y, Math.round(app.terrain.heightAt(x, z) * 100) / 100);
    assert.equal(body.thread.subject, 'Кто построил эти камни?');

    const { posts } = await (await fetch(`${base}/api/threads/${threadId}`)).json();
    const file = posts[0].file;
    assert.equal(file.kind, 'image');
    assert.doesNotMatch(file.name, /IMG_2026/, 'original file name must not survive');
    const stored = readFileSync(path.join(dataDir, 'src', file.name));
    const meta = await sharp(stored).metadata();
    assert.equal(meta.exif, undefined);
    assert.equal(meta.xmp, undefined);
    for (const needle of ['SECRET-CAM', 'SECRET-MAKE', 'SECRET-SOFT', 'Exif\0\0']) assert.ok(!stored.includes(needle), needle);
    assert.equal(meta.width, 320);
    const thumb = await (await fetch(base + file.thumb)).arrayBuffer();
    assert.ok(thumb.byteLength > 0);
  });

  test('keeps thread stones apart', async () => {
    const { x, z } = spawn();
    const { res, body } = await post('/api/threads', form({ x: x + 1, z, comment: 'рядом' }));
    assert.equal(res.status, 409);
    assert.match(body.error, new RegExp(`№${threadId}`));
  });

  test('lists markers with island stats', async () => {
    const listing = await (await fetch(`${base}/api/threads`)).json();
    assert.ok(Array.isArray(listing.threads));
    assert.equal(listing.threads[0].id, threadId);
    assert.equal(listing.threads[0].subject, 'Кто построил эти камни?');
    assert.ok(listing.threads[0].thumb.startsWith('/thumb/'));
    assert.deepEqual(listing.stats, { threads: 1, posts: 1 });
  });

  test('replies bump the thread, sage does not', async () => {
    clock += 10;
    let r = await post(`/api/threads/${threadId}/replies`, form({ comment: `>>${threadId}\nтоже тут` }));
    assert.equal(r.res.status, 201);
    assert.equal(r.body.marker.bumped, clock);
    const bumped = clock;
    clock += 10;
    r = await post(`/api/threads/${threadId}/replies`, form({ comment: 'сажа', sage: 1 }));
    assert.equal(r.res.status, 201);
    assert.equal(r.body.marker.bumped, bumped);
    assert.equal(r.body.marker.replies, 2);
    const { posts } = await (await fetch(`${base}/api/threads/${threadId}`)).json();
    assert.deepEqual(posts.map((p) => p.name), ['Аноним', 'Аноним', 'Аноним']);
  });

  test('rejects empty posts, oversized comments and unknown threads', async () => {
    let r = await post(`/api/threads/${threadId}/replies`, form({ comment: '   ' }));
    assert.equal(r.res.status, 400);
    r = await post(`/api/threads/${threadId}/replies`, form({ comment: 'а'.repeat(5001) }));
    assert.equal(r.res.status, 400);
    r = await post('/api/threads/999999/replies', form({ comment: 'эй' }));
    assert.equal(r.res.status, 404);
    r = await post(`/api/threads/${threadId}/replies`, form({ comment: 'x' }, { buffer: Buffer.from('not an image'), type: 'image/png', name: 'a.png' }));
    assert.equal(r.res.status, 415);
  });

  test('strips container and stream tags from webm', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'ffmpeg missing' }, async () => {
    const gen = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '1',
      '-c:v', 'libvpx', '-b:v', '200k', '-metadata', 'title=SECRET-TITLE', '-metadata', 'comment=SECRET-COMMENT',
      '-metadata:s:v:0', 'title=SECRET-STREAM', '-f', 'webm', 'pipe:1',
    ], { maxBuffer: 16 * 1024 * 1024 });
    assert.equal(gen.status, 0);
    assert.ok(gen.stdout.includes('SECRET-TITLE'), 'fixture must carry tags');
    const r = await post(`/api/threads/${threadId}/replies`, form({ comment: 'вебм' }, { buffer: gen.stdout, type: 'video/webm', name: 'clip.webm' }));
    assert.equal(r.res.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.post.file.kind, 'video');
    assert.deepEqual([r.body.post.file.w, r.body.post.file.h], [160, 120]);
    const stored = readFileSync(path.join(dataDir, 'src', r.body.post.file.name));
    for (const needle of ['SECRET-TITLE', 'SECRET-COMMENT', 'SECRET-STREAM']) assert.ok(!stored.includes(needle), needle);
    assert.equal(stored.readUInt32BE(0), 0x1a45dfa3);
  });

  test('broadcasts presence, new threads and bumps over socket.io', async () => {
    const client = ioClient(base, { transports: ['websocket'], forceNew: true });
    const next = (event, pred = () => true) => new Promise((resolve) => {
      const h = (d) => { if (pred(d)) { client.off(event, h); resolve(d); } };
      client.on(event, h);
    });
    try {
      await next('hello');
      const welcome = next('welcome');
      client.emit('enter');
      const { id } = await welcome;
      const seen = next('players', (s) => s.some(([pid, x]) => pid === id && x === 1.5));
      client.emit('move', [1.5, 4, 2.5, 0.3, 1]);
      await seen;

      const [cx, cy, cz] = app.world.landmarks.circle;
      const planted = next('thread:new');
      const { res, body } = await post('/api/threads', form({ x: cx + 4, z: cz, comment: 'у камней' }));
      assert.equal(res.status, 201, JSON.stringify(body));
      assert.equal((await planted).id, body.thread.id);
      assert.ok(Math.abs(body.thread.y - cy) < 1.5);

      const bumped = next('thread:bump');
      await post(`/api/threads/${body.thread.id}/replies`, form({ comment: 'ответ' }));
      assert.equal((await bumped).replies, 1);
    } finally {
      client.close();
    }
  });
});

describe('shared client modules', () => {
  test('imageboard markup escapes html and renders greentext, quotes, spoilers', () => {
    const html = renderComment('<script>alert(1)</script>\n>зелёный текст\n>>12 привет\n[spoiler]тайна[/spoiler]');
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('<span class="quote">&gt;зелёный текст</span>'));
    assert.ok(html.includes('<a class="quotelink" href="#p12" data-no="12">&gt;&gt;12</a> привет'));
    assert.ok(!html.includes('<span class="quote"><a class="quotelink"'));
    assert.ok(html.includes('<s class="spoiler">тайна</s>'));
  });

  test('heightmap sampling hits grid vertices exactly and interpolates linearly', () => {
    const { heightmap: hm } = app.world;
    for (const [r, c] of [[10, 10], [44, 44], [60, 31]]) {
      const h = app.terrain.heightAt(hm.x0 + c * hm.cell, hm.z0 + r * hm.cell);
      assert.ok(Math.abs(h - hm.heights[r * hm.cols + c]) < 1e-4);
    }
    const r = 44;
    const c = 44;
    const mid = app.terrain.heightAt(hm.x0 + (c + 0.5) * hm.cell, hm.z0 + r * hm.cell);
    const expected = (hm.heights[r * hm.cols + c] + hm.heights[r * hm.cols + c + 1]) / 2;
    assert.ok(Math.abs(mid - expected) < 1e-4);
  });
});
