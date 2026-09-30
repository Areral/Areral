// End-to-end smoke run in a real Chromium (WebGL through SwiftShader):
// portal → world → plant a thread with an EXIF-laden JPEG → read it → reply → second wanderer → catalog.
// Screenshots land in test/e2e/out/. Usage: npm run e2e (CHROME_PATH=/path/to/chrome if not auto-detected).
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { createBruhchan } from '../../server/app.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH
  || ['/usr/local/bin/google-chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!CHROME) {
  console.error('Chrome/Chromium not found — set CHROME_PATH');
  process.exit(2);
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'bruhchan-e2e-'));
const app = createBruhchan({ dataDir });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({
  executablePath: CHROME,
  // Software WebGL for GPU-less CI/containers; the GPU sandbox breaks SwiftShader's Vulkan init under gVisor.
  args: [
    '--no-sandbox', '--disable-gpu-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
    '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
  ],
});

const problems = [];
const warnings = [];
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const step = (msg) => console.log(`• ${msg}`);

async function openPage(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`[${name}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[${name}] console.error: ${m.text()}`);
    else if (m.type() === 'warning') warnings.push(`[${name}] ${m.text()}`);
  });
  await page.goto(base);
  await page.waitForSelector('#enter:not([disabled])', { timeout: 90_000 });
  return page;
}

function landSpot(fromX, fromZ, dz) {
  for (let d = dz; Math.abs(d) > 4; d -= Math.sign(dz)) {
    const z = fromZ + d;
    if (app.terrain.plantable(fromX, z).ok) return [fromX, z];
  }
  return [fromX, fromZ + 6];
}

try {
  const art = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9aa3a8"/><stop offset="1" stop-color="#4b5256"/></linearGradient></defs>
    <rect width="640" height="420" fill="url(#g)"/><rect x="290" y="150" width="60" height="180" fill="#3b3833"/>
    <circle cx="320" cy="210" r="16" fill="#ff9900"/><rect y="330" width="640" height="90" fill="#58664a"/></svg>`);
  const jpeg = await sharp(art).jpeg({ quality: 88 }).withExif({ IFD0: { Make: 'SECRET-MAKE', Model: 'SECRET-CAM' } }).toBuffer();

  const a = await openPage('A');
  await a.waitForTimeout(1500);
  await shot(a, '01-portal');
  step('portal loaded, assets ready');

  await a.click('#enter');
  await a.waitForTimeout(2500);
  await shot(a, '02-spawn');
  step(`entered the world at ${JSON.stringify(await a.evaluate(() => window.__bruhchan.pos.map((v) => +v.toFixed(2))))}`);

  await a.keyboard.press('KeyT');
  await a.waitForSelector('form[data-form="plant"]');
  await a.fill('input[name="subject"]', 'Кто построил эти камни?');
  await a.fill('textarea[name="comment"]', 'Проснулся на пляже, вокруг туман.\n>be me\n>не помню, как сюда попал\nАноны, кто-нибудь знает, что это за остров?');
  await a.setInputFiles('input[name="file"]', { name: 'IMG_20260930_101010.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await shot(a, '03-plant-form');
  await a.click('form[data-form="plant"] button[type="submit"]');
  await a.waitForFunction(() => window.__bruhchan.markers === 1 && !window.__bruhchan.board, null, { timeout: 30_000 });
  await a.waitForTimeout(4500);
  await shot(a, '04-monolith');
  const [tx, , tz] = await a.evaluate(() => window.__bruhchan.pos);
  const marker = (await (await fetch(`${base}/api/threads`)).json()).threads[0];
  await a.keyboard.press('KeyV'); // first person: nothing between the camera and the stone
  await a.evaluate(([x, z, mx, mz]) => {
    window.__bruhchan.teleport(x, z);
    window.__bruhchan.look(Math.atan2(mx - x, mz - z), 0.02);
  }, [marker.x + Math.sin(marker.heading) * 3.2 + 0.8, marker.z + Math.cos(marker.heading) * 3.2, marker.x, marker.z]);
  await a.waitForTimeout(1500);
  await shot(a, '04b-monolith-closeup');
  await a.keyboard.press('KeyV');
  // step up to the carved face of the stone before reading it
  const fx = marker.x + Math.sin(marker.heading) * 1.9;
  const fz = marker.z + Math.cos(marker.heading) * 1.9;
  await a.evaluate(([x, z, mx, mz]) => {
    window.__bruhchan.teleport(x, z);
    window.__bruhchan.look(Math.atan2(mx - x, mz - z), -0.1);
  }, [fx, fz, marker.x, marker.z]);
  await a.waitForTimeout(500);
  step('thread planted, monolith rose');

  await a.keyboard.press('KeyE');
  await a.waitForSelector('.post.op .postMessage');
  await a.waitForTimeout(500);
  await shot(a, '05-thread');
  await a.fill('textarea[name="comment"]', '>>1\nТоже тут очнулся. Камни старше нас всех.\n[spoiler]на севере есть башня[/spoiler]');
  await a.click('form[data-form="reply"] button[type="submit"]');
  await a.waitForSelector('.post.reply');
  await a.waitForTimeout(400);
  await shot(a, '06-reply');
  step('thread read and replied to');
  await a.keyboard.press('Escape');

  const b = await openPage('B');
  await b.click('#enter');
  const [ax, , az] = await a.evaluate(() => window.__bruhchan.pos);
  await b.evaluate(([x, z]) => window.__bruhchan.teleport(x + 2.2, z - 3.2), [ax, az]);
  await a.waitForFunction(() => window.__bruhchan.phantoms >= 1, null, { timeout: 15_000 });
  await a.waitForTimeout(1500);
  await shot(a, '07-phantom');
  step('second wanderer visible as a phantom');

  await a.keyboard.press('KeyC');
  await a.waitForSelector('.catalogTable');
  await shot(a, '08-catalog');
  await a.click('[data-mark]');
  const [mx, mz] = landSpot(ax, az, 26);
  await a.evaluate(([x, z]) => window.__bruhchan.teleport(x, z), [mx, mz]);
  await a.waitForTimeout(2000);
  await shot(a, '09-waypoint');
  step('catalog opened and waypoint beam set');

  const [cx, , cz] = app.world.landmarks.circle;
  await a.evaluate(([x, z]) => window.__bruhchan.teleport(x, z), [cx - 1, cz + 15]);
  await a.waitForTimeout(2000);
  await shot(a, '10-stone-circle');
  step('visited the stone circle');
} catch (err) {
  problems.push(`run failed: ${err.stack || err.message}`);
} finally {
  await browser.close();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}

if (warnings.length) console.log(`\n${warnings.length} console warning(s):\n${[...new Set(warnings)].slice(0, 10).join('\n')}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`\nok — screenshots in ${OUT}`);
