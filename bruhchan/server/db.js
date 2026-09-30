import Database from 'better-sqlite3';

// There is intentionally no column for IPs, user agents, sessions or original file names.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  subject    TEXT    NOT NULL DEFAULT '',
  comment    TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  file       TEXT,
  file_kind  TEXT,
  file_size  INTEGER,
  file_w     INTEGER,
  file_h     INTEGER,
  thumb      TEXT,
  thumb_w    INTEGER,
  thumb_h    INTEGER
);
CREATE INDEX IF NOT EXISTS posts_by_thread ON posts (thread_id, id);
CREATE TABLE IF NOT EXISTS threads (
  id          INTEGER PRIMARY KEY REFERENCES posts (id),
  x           REAL    NOT NULL,
  y           REAL    NOT NULL,
  z           REAL    NOT NULL,
  heading     REAL    NOT NULL DEFAULT 0,
  bumped_at   INTEGER NOT NULL,
  reply_count INTEGER NOT NULL DEFAULT 0,
  image_count INTEGER NOT NULL DEFAULT 0
);
`;

export class NearThreadError extends Error {
  constructor(id) {
    super(`near thread ${id}`);
    this.near = id;
  }
}

const systemClock = () => Math.floor(Date.now() / 1000);

function postParams(post, threadId, createdAt) {
  const f = post.media;
  return {
    thread_id: threadId,
    name: post.name,
    subject: post.subject ?? '',
    comment: post.comment ?? '',
    created_at: createdAt,
    file: f?.file ?? null,
    file_kind: f?.kind ?? null,
    file_size: f?.size ?? null,
    file_w: f?.width ?? null,
    file_h: f?.height ?? null,
    thumb: f?.thumb ?? null,
    thumb_w: f?.thumbWidth ?? null,
    thumb_h: f?.thumbHeight ?? null,
  };
}

export function publicPost(row) {
  return {
    no: row.id,
    name: row.name,
    subject: row.subject,
    comment: row.comment,
    time: row.created_at,
    file: row.file
      ? {
          src: `/src/${row.file}`,
          thumb: `/thumb/${row.thumb}`,
          name: row.file,
          kind: row.file_kind,
          size: row.file_size,
          w: row.file_w,
          h: row.file_h,
          tw: row.thumb_w,
          th: row.thumb_h,
        }
      : null,
  };
}

export function publicMarker(row) {
  return {
    id: row.id,
    x: row.x,
    y: row.y,
    z: row.z,
    heading: row.heading,
    subject: row.subject,
    excerpt: row.excerpt,
    replies: row.reply_count,
    images: row.image_count,
    bumped: row.bumped_at,
    created: row.created_at,
    thumb: row.thumb ? `/thumb/${row.thumb}` : null,
  };
}

export function openDatabase(file, { now = systemClock } = {}) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const MARKER_SQL = `
    SELECT t.*, p.subject, substr(p.comment, 1, 200) AS excerpt, p.created_at, p.thumb
    FROM threads t JOIN posts p ON p.id = t.id`;
  const q = {
    insertPost: db.prepare(`
      INSERT INTO posts (thread_id, name, subject, comment, created_at, file, file_kind, file_size, file_w, file_h, thumb, thumb_w, thumb_h)
      VALUES (@thread_id, @name, @subject, @comment, @created_at, @file, @file_kind, @file_size, @file_w, @file_h, @thumb, @thumb_w, @thumb_h)`),
    setThreadId: db.prepare('UPDATE posts SET thread_id = ? WHERE id = ?'),
    insertThread: db.prepare(`
      INSERT INTO threads (id, x, y, z, heading, bumped_at, reply_count, image_count)
      VALUES (@id, @x, @y, @z, @heading, @bumped_at, 0, @image_count)`),
    nearest: db.prepare(`
      SELECT id FROM threads WHERE (x - @x) * (x - @x) + (z - @z) * (z - @z) < @d2
      ORDER BY (x - @x) * (x - @x) + (z - @z) * (z - @z) LIMIT 1`),
    thread: db.prepare('SELECT * FROM threads WHERE id = ?'),
    marker: db.prepare(`${MARKER_SQL} WHERE t.id = ?`),
    markers: db.prepare(`${MARKER_SQL} ORDER BY t.bumped_at DESC, t.id DESC LIMIT 5000`),
    posts: db.prepare('SELECT * FROM posts WHERE thread_id = ? ORDER BY id'),
    post: db.prepare('SELECT * FROM posts WHERE id = ?'),
    bump: db.prepare(`
      UPDATE threads SET bumped_at = @bumped_at, reply_count = reply_count + 1, image_count = image_count + @images
      WHERE id = @id`),
    counts: db.prepare('SELECT (SELECT count(*) FROM threads) AS threads, (SELECT count(*) FROM posts) AS posts'),
  };

  const createThread = db.transaction((post, pos, spacing) => {
    const near = q.nearest.get({ x: pos.x, z: pos.z, d2: spacing * spacing });
    if (near) throw new NearThreadError(near.id);
    const t = now();
    const id = Number(q.insertPost.run(postParams(post, 0, t)).lastInsertRowid);
    q.setThreadId.run(id, id);
    q.insertThread.run({ id, x: pos.x, y: pos.y, z: pos.z, heading: pos.heading, bumped_at: t, image_count: post.media ? 1 : 0 });
    return publicMarker(q.marker.get(id));
  });

  const addReply = db.transaction((threadId, post, { sage, bumpLimit }) => {
    const thread = q.thread.get(threadId);
    if (!thread) return null;
    const t = now();
    const id = Number(q.insertPost.run(postParams(post, threadId, t)).lastInsertRowid);
    const bump = !sage && thread.reply_count < bumpLimit;
    q.bump.run({ id: threadId, bumped_at: bump ? t : thread.bumped_at, images: post.media ? 1 : 0 });
    return { post: publicPost(q.post.get(id)), marker: publicMarker(q.marker.get(threadId)) };
  });

  return {
    raw: db,
    createThread,
    addReply,
    threadExists: (id) => Boolean(q.thread.get(id)),
    listMarkers: () => q.markers.all().map(publicMarker),
    getThread(id) {
      const row = q.marker.get(id);
      if (!row) return null;
      return { thread: publicMarker(row), posts: q.posts.all(id).map(publicPost) };
    },
    counts: () => q.counts.get(),
    close: () => db.close(),
  };
}
