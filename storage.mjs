import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export function serverRunning(dataDir) {
  try { const { pid } = JSON.parse(readFileSync(path.join(dataDir, 'server.lock'), 'utf8')); process.kill(pid, 0); return true; } catch { return false; }
}
export async function createSnapshot(dataDir, { automatic = false } = {}) {
  const dbPath = path.join(dataDir, 'neighbourdex.sqlite');
  if (!existsSync(dbPath)) throw new Error('No database exists to back up.');
  const folder = path.join(dataDir, 'backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(4).toString('hex') + (automatic ? '-auto' : ''));
  mkdirSync(path.join(folder, 'photos'), { recursive: true });
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    await backup(db, path.join(folder, 'neighbourdex.sqlite'));
    const snapshot = new DatabaseSync(path.join(folder, 'neighbourdex.sqlite'), { readOnly: true });
    let photos;
    try { photos = snapshot.prepare('SELECT DISTINCT filename FROM reviews').all(); } catch { photos = []; }
    snapshot.close();
    const files = { 'neighbourdex.sqlite': digest(path.join(folder, 'neighbourdex.sqlite')) };
    for (const { filename } of photos) {
      if (!/^[a-f0-9]{48}\.jpg$/.test(filename)) throw new Error('Unexpected stored photo name.');
      const target = path.join(folder, 'photos', filename);
      copyFileSync(path.join(dataDir, 'photos', filename), target);
      files[`photos/${filename}`] = digest(target);
    }
    writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ version: 1, created_at: new Date().toISOString(), files }, null, 2));
    if (automatic) {
      const backupRoot = realpathSync(path.join(dataDir, 'backups'));
      const old = readdirSync(backupRoot).filter(name => /^\d{4}-\d{2}-\d{2}T[\dZ-]+(?:-[a-f0-9]{8})?-auto$/.test(name) && existsSync(path.join(backupRoot,name,'manifest.json'))).sort().reverse().slice(3);
      for (const name of old) {
        const candidate = path.join(backupRoot, name);
        // Check the final physical target too, so a junction cannot redirect deletion.
        if (realpathSync(candidate).startsWith(backupRoot + path.sep)) rmSync(candidate, { recursive: true });
      }
    }
    return folder;
  } catch (error) {
    const backupRoot=realpathSync(path.join(dataDir,'backups'));
    if(realpathSync(folder).startsWith(backupRoot+path.sep))rmSync(folder,{recursive:true});
    throw error;
  } finally { db?.close(); }
}
export function verifySnapshot(folder) {
  const manifest = JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !manifest.files?.['neighbourdex.sqlite']) throw new Error('Invalid backup manifest.');
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (name !== 'neighbourdex.sqlite' && !/^photos\/[a-f0-9]{48}\.jpg$/.test(name)) throw new Error('Unsafe backup path.');
    if (digest(path.join(folder, name)) !== hash) throw new Error(`Backup integrity check failed: ${name}`);
  }
  const db = new DatabaseSync(path.join(folder, 'neighbourdex.sqlite'), { readOnly: true });
  try {
    if (Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backup database integrity failed.');
    for (const photo of db.prepare('SELECT DISTINCT filename FROM reviews').all()) if (!manifest.files[`photos/${photo.filename}`]) throw new Error('Backup is missing a referenced photo.');
  }
  finally { db.close(); }
  return manifest;
}
export async function restoreSnapshot(dataDir, folder) {
  if (serverRunning(dataDir)) throw new Error('Stop the app before restoring a backup.');
  const manifest = verifySnapshot(folder);
  let safety = null;
  if (existsSync(path.join(dataDir, 'neighbourdex.sqlite'))) {
    try { safety = await createSnapshot(dataDir); }
    catch {
      // A corrupt database must not prevent recovery. Keep its raw files for inspection.
      safety = path.join(dataDir, 'backups', 'raw-safety-' + Date.now() + '-' + randomBytes(4).toString('hex'));
      mkdirSync(path.join(safety, 'photos'), { recursive: true });
      for (const name of ['neighbourdex.sqlite','neighbourdex.sqlite-wal','neighbourdex.sqlite-shm']) {
        if (existsSync(path.join(dataDir, name))) copyFileSync(path.join(dataDir, name), path.join(safety, name));
      }
      if (existsSync(path.join(dataDir, 'photos'))) {
        for (const name of readdirSync(path.join(dataDir, 'photos')).filter(name => /^[a-f0-9]{48}\.jpg$/.test(name))) copyFileSync(path.join(dataDir, 'photos', name), path.join(safety, 'photos', name));
      }
      writeFileSync(path.join(safety, 'README.txt'), 'Raw data preserved before recovery. This is not a verified snapshot; use it for manual recovery only.');
    }
  }
  mkdirSync(path.join(dataDir, 'photos'), { recursive: true });
  for (const name of Object.keys(manifest.files).filter(name => name.startsWith('photos/'))) copyFileSync(path.join(folder, name), path.join(dataDir, name));
  for (const suffix of ['-wal','-shm']) { const file = path.join(dataDir, 'neighbourdex.sqlite' + suffix); if (existsSync(file)) unlinkSync(file); }
  copyFileSync(path.join(folder, 'neighbourdex.sqlite'), path.join(dataDir, 'neighbourdex.sqlite'));
  return safety;
}
export function photoUsage(db, userId) {
  return db.prepare('SELECT COALESCE(sum(bytes),0) AS bytes FROM reviews r JOIN adventures a ON a.id=r.adventure_id WHERE a.user_id=?').get(userId).bytes;
}
export function maintainPhotos(db, uploadDir) {
  const expired = db.prepare("SELECT id,filename FROM reviews WHERE status NOT IN ('queued','reviewing') AND COALESCE(verdict,'')!='matched' AND created_at<?").all(new Date(Date.now() - 86400000 * 7).toISOString());
  for (const photo of expired) { try { unlinkSync(path.join(uploadDir, photo.filename)); } catch {} db.prepare('DELETE FROM reviews WHERE id=?').run(photo.id); }
  for (const photo of db.prepare('SELECT id,filename,bytes FROM reviews').all()) {
    try { const size = statSync(path.join(uploadDir, photo.filename)).size; if (size !== photo.bytes) db.prepare('UPDATE reviews SET bytes=? WHERE id=?').run(size, photo.id); } catch { /* Keep missing memories visible for recovery rather than deleting records. */ }
  }
}
