import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { GenerationError } from './adventure.mjs';

export const hashPassword = promisify(scrypt);
export function installRuntime(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS rate_limits(bucket TEXT,key TEXT,started INTEGER,count INTEGER,PRIMARY KEY(bucket,key));
    CREATE TABLE IF NOT EXISTS source_cache(area TEXT PRIMARY KEY,sources_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS resolutions(id TEXT PRIMARY KEY,area TEXT NOT NULL,location_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,target INTEGER NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status,id);
    CREATE INDEX IF NOT EXISTS review_adventure ON reviews(adventure_id,card_number);
    CREATE INDEX IF NOT EXISTS adventures_owner ON adventures(user_id);`);
  for (const [column, definition] of [['location_json', 'TEXT'], ['radius', 'INTEGER NOT NULL DEFAULT 3'], ['allow_small', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!db.prepare('PRAGMA table_info(adventures)').all().some(item => item.name === column)) db.exec(`ALTER TABLE adventures ADD COLUMN ${column} ${definition}`);
  }
  if (!db.prepare('PRAGMA table_info(reviews)').all().some(item => item.name === 'bytes')) db.exec('ALTER TABLE reviews ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0');
  db.prepare('DELETE FROM rate_limits WHERE started<?').run(Date.now() - 86400000);
  db.prepare('DELETE FROM resolutions WHERE created_at<?').run(new Date(Date.now() - 86400000).toISOString());
  db.prepare('DELETE FROM jobs WHERE status IN (\'complete\',\'failed\') AND created_at<?').run(new Date(Date.now() - 86400000 * 7).toISOString());
}
export function consumeLimit(db, bucket, key, maximum, windowMs, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare('SELECT * FROM rate_limits WHERE bucket=? AND key=?').get(bucket, String(key));
    if (previous && previous.started + windowMs > now && previous.count >= maximum) { db.exec('COMMIT'); return false; }
    const current = previous && previous.started + windowMs > now ? previous : { started: now, count: 0 };
    db.prepare('INSERT INTO rate_limits VALUES(?,?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET started=excluded.started,count=excluded.count').run(bucket, String(key), current.started, current.count + 1);
    db.exec('COMMIT'); return true;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function queuePosition(db, kind, target) {
  const job = db.prepare("SELECT id,status FROM jobs WHERE kind=? AND target=? AND status IN ('queued','running') ORDER BY id LIMIT 1").get(kind, target);
  if (!job || job.status === 'running') return 0;
  return db.prepare("SELECT count(*) AS count FROM jobs WHERE status IN ('queued','running') AND id<=?").get(job.id).count;
}
export function createQueue(db, handlers) {
  let draining = false;
  db.exec("UPDATE jobs SET status='queued' WHERE status='running'; UPDATE collections SET status='queued',stage='Waiting for local Gemma',error=NULL WHERE adventure_id IN (SELECT target FROM jobs WHERE kind='generation' AND status='queued'); UPDATE reviews SET status='queued',reason=NULL WHERE id IN (SELECT target FROM jobs WHERE kind='photo' AND status='queued')");
  async function drain() {
    if (draining) return; draining = true;
    try {
      let job;
      while ((job = db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").get())) {
        db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(job.id);
        try { await handlers[job.kind](job.target, JSON.parse(job.payload_json)); db.prepare("UPDATE jobs SET status='complete' WHERE id=?").run(job.id); }
        catch (error) { db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(job.id); console.error(`Background ${job.kind} job failed: ${error instanceof GenerationError ? error.message : 'internal error'}`); }
      }
    } finally { draining = false; }
  }
  return {
    ensureRoom() { if (db.prepare("SELECT count(*) AS count FROM jobs WHERE status IN ('queued','running')").get().count >= 20) throw new GenerationError('The adventure queue is full. Please try again shortly.', 429); },
    enqueue(kind, target, payload) { db.prepare("INSERT INTO jobs(kind,target,payload_json,status,created_at) VALUES(?,?,?,'queued',?)").run(kind, target, JSON.stringify(payload), new Date().toISOString()); setImmediate(() => void drain()); },
    start() { setImmediate(() => void drain()); }
  };
}
export function resolutionId() { return randomBytes(16).toString('hex'); }
