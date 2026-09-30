import { createBruhchan } from './app.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const bruhchan = createBruhchan({
  dataDir: process.env.DATA_DIR,
  postsPerMinute: Number(process.env.POSTS_PER_MINUTE) || undefined,
});

bruhchan.server.listen(port, host, () => {
  console.log(`[bruhchan] остров открыт: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    bruhchan.close().finally(() => process.exit(0));
  });
}
