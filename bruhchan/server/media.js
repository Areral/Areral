import { spawn, spawnSync } from 'node:child_process';
import sharp from 'sharp';

// Uploads are decoded and re-encoded entirely in memory. Re-encoding without keepMetadata()
// drops EXIF (incl. GPS), XMP, IPTC, ICC and comments; only the cleaned bytes ever reach disk.
sharp.cache(false);

export class MediaError extends Error {}

const FORMATS = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp' };
const MAX_PIXELS = 40_000_000;
const THUMB_SIZE = 250;
const UNSUPPORTED = 'Такой файл не подойдёт. Можно JPG, PNG, GIF, WebP или WebM.';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

let ffmpegState;
export function ffmpegAvailable() {
  if (ffmpegState === undefined) {
    ffmpegState = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0;
  }
  return ffmpegState;
}

export function isWebm(buf) {
  return (
    buf.length > 32 &&
    buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3 &&
    buf.subarray(0, 64).includes('webm')
  );
}

async function makeThumb(buf) {
  const { data, info } = await sharp(buf, { limitInputPixels: MAX_PIXELS })
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer({ resolveWithObject: true });
  return { thumb: data, thumbWidth: info.width, thumbHeight: info.height };
}

async function processImage(buf) {
  let meta;
  try {
    meta = await sharp(buf, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new MediaError(UNSUPPORTED);
  }
  const ext = FORMATS[meta.format];
  if (!ext) throw new MediaError(UNSUPPORTED);
  const animated = (meta.pages ?? 1) > 1;
  let img = sharp(buf, { limitInputPixels: MAX_PIXELS, animated });
  if (!animated) img = img.rotate(); // bake EXIF orientation into pixels before the tag is dropped
  if (ext === 'jpg') img = img.jpeg({ quality: 90, mozjpeg: true });
  else if (ext === 'png') img = img.png({ compressionLevel: 9 });
  else if (ext === 'webp') img = img.webp({ quality: 88 });
  else img = img.gif();
  let full;
  try {
    full = await img.toBuffer();
  } catch {
    throw new MediaError('Картинка битая — не получилось её прочитать.');
  }
  const clean = await sharp(full, { animated }).metadata();
  return {
    kind: 'image',
    ext,
    full,
    width: clean.width,
    height: clean.pageHeight ?? clean.height,
    ...(await makeThumb(full)),
  };
}

function runFfmpeg(args, input, maxBytes) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0;
    const fail = () => reject(new MediaError('Не удалось обработать WebM. Файл повреждён?'));
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
    proc.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) proc.kill('SIGKILL');
      else chunks.push(chunk);
    });
    proc.on('error', () => { clearTimeout(timer); fail(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && size > 0 && size <= maxBytes) resolve(Buffer.concat(chunks));
      else fail();
    });
    proc.stdin.on('error', () => {}); // ffmpeg may close stdin early on bad input
    proc.stdin.end(input);
  });
}

async function processWebm(buf) {
  if (!ffmpegAvailable()) throw new MediaError('WebM сейчас не принимаются: на сервере нет ffmpeg.');
  // Remux (no re-encode) through pipes: drops container/stream tags, chapters, attachments and encoder strings.
  const clean = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
    '-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1',
    '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
    '-f', 'webm', 'pipe:1',
  ], buf, buf.length * 2 + 1024 * 1024);
  const frame = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1',
  ], clean, 64 * 1024 * 1024);
  const meta = await sharp(frame).metadata();
  return { kind: 'video', ext: 'webm', full: clean, width: meta.width, height: meta.height, ...(await makeThumb(frame)) };
}

export function processUpload(buf) {
  return isWebm(buf) ? processWebm(buf) : processImage(buf);
}
