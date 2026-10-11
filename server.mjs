import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, checkOllama, generateAdventure, validateCards, groundCards, resolveLocality, GenerationError } from './adventure.mjs';
import { preparePhoto, reviewPhoto, MAX_UPLOAD } from './photos.mjs';
import { installRuntime, consumeLimit, createQueue, queuePosition, resolutionId, hashPassword } from './runtime.mjs';
import { createSnapshot, maintainPhotos, photoUsage, serverRunning } from './storage.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });
if (serverRunning(dataDir)) throw new Error('Another app server is already using this data directory.');
if (existsSync(path.join(dataDir, 'neighbourdex.sqlite'))) {
  const backups = path.join(dataDir, 'backups');
  const today = new Date().toISOString().slice(0, 10);
  if (!existsSync(backups) || !readdirSync(backups).some(name => name.startsWith(today) && name.endsWith('-auto') && existsSync(path.join(backups,name,'manifest.json')))) {
    try { await createSnapshot(dataDir, { automatic: true }); } catch { console.error('Automatic backup could not be completed. Check storage and existing photo files.'); }
  }
}
const db = new DatabaseSync(path.join(dataDir, 'neighbourdex.sqlite'));
db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS adventures (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), neighbourhood TEXT NOT NULL, city TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id, neighbourhood, city));`);
db.exec(`CREATE TABLE IF NOT EXISTS collections (adventure_id INTEGER PRIMARY KEY REFERENCES adventures(id) ON DELETE CASCADE, status TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '', error TEXT, cards_json TEXT, provenance_json TEXT, updated_at TEXT NOT NULL);
UPDATE collections SET status='failed', stage='', error='Generation was interrupted by a server restart. Please retry.' WHERE status='generating';`);
const settings = config();
const photoJobs = new Set();
const uploadDir = path.join(dataDir, 'photos');
mkdirSync(uploadDir, { recursive: true });
db.exec(`CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, adventure_id INTEGER NOT NULL REFERENCES adventures(id) ON DELETE CASCADE, card_number INTEGER NOT NULL, filename TEXT NOT NULL, status TEXT NOT NULL, verdict TEXT, reason TEXT, note TEXT NOT NULL DEFAULT '', model TEXT, created_at TEXT NOT NULL, reviewed_at TEXT);
UPDATE reviews SET status='failed',reason='Photo review was interrupted. Please retry.' WHERE status='reviewing';`);
if (!db.prepare('PRAGMA table_info(reviews)').all().some(column => column.name === 'observation')) db.exec('ALTER TABLE reviews ADD COLUMN observation TEXT');
installRuntime(db);
maintainPhotos(db, uploadDir);
const userPhotoLimit = Math.max(8, Number(process.env.USER_PHOTO_LIMIT_MB) || 100) * 1024 * 1024;
const totalPhotoLimit = Math.max(8, Number(process.env.TOTAL_PHOTO_LIMIT_MB) || 1024) * 1024 * 1024;
db.exec('CREATE TABLE IF NOT EXISTS blueprints (area TEXT PRIMARY KEY,cards_json TEXT NOT NULL,provenance_json TEXT NOT NULL,created_at TEXT NOT NULL)');
const areaKey = adventure => `${adventure.neighbourhood.toLowerCase()}|${adventure.city.toLowerCase()}|${adventure.radius || 3}|${adventure.allow_small ? 1 : 0}|${adventure.location ? `${adventure.location.center.latitude},${adventure.location.center.longitude}` : 'auto'}|v2`;
const sourceKey = adventure => `${adventure.neighbourhood.toLowerCase()}|${adventure.city.toLowerCase()}|${adventure.radius || 3}|${adventure.location ? `${adventure.location.center.latitude},${adventure.location.center.longitude}` : 'auto'}|sources-v1`;
function saveBlueprint(adventure, result) {
  db.prepare('INSERT INTO blueprints VALUES(?,?,?,?) ON CONFLICT(area) DO UPDATE SET cards_json=excluded.cards_json,provenance_json=excluded.provenance_json,created_at=excluded.created_at').run(areaKey(adventure), JSON.stringify(result.cards), JSON.stringify(result.provenance), result.provenance.generated_at);
}
// The optional live diagnostic produces real sourced Saket quests, never test fixtures.
try {
  const sample = JSON.parse(readFileSync(path.join(dataDir, 'live-saket.json'), 'utf8'));
  const cards = groundCards(validateCards({ cards: sample.cards.map(card => ({ ...card, place_id: card.place?.id || null })) }, sample.provenance.places));
  if (Date.parse(sample.provenance.generated_at) > Date.now() - 86400000) saveBlueprint({ neighbourhood: 'Saket', city: 'Delhi' }, { cards, provenance: sample.provenance });
} catch { /* No verified local sample available. Normal live generation remains available. */ }
// Preserve card numbers, collected photos and memories while repairing legacy evidence text.
for (const row of db.prepare("SELECT adventure_id,cards_json FROM collections WHERE status='ready'").all()) {
  const cards = JSON.parse(row.cards_json || '[]');
  if (cards.some(card => !card.evidence_type)) db.prepare('UPDATE collections SET cards_json=? WHERE adventure_id=?').run(JSON.stringify(groundCards(cards)), row.adventure_id);
}
function collectionFor(id) {
  const row = db.prepare('SELECT * FROM collections WHERE adventure_id=?').get(id);
  if (!row) return { status: 'pending', stage: '', error: null, cards: [], provenance: null };
  const reviews = db.prepare('SELECT id,card_number,status,verdict,reason,observation,note,created_at,reviewed_at FROM reviews WHERE adventure_id=? ORDER BY id DESC').all(id).map(review => ({ ...review, queue_position: queuePosition(db, 'photo', review.id) }));
  const cards = JSON.parse(row.cards_json || '[]').map(card => {
    const history = reviews.filter(review => review.card_number === card.number);
    const collected = history.find(review => review.verdict === 'matched');
    return { ...card, status: collected ? 'collected' : 'undiscovered', review: history[0] || null, memory: collected ? { ...collected, photo_url: `/api/photos/${collected.id}` } : null };
  });
  return { status: row.status, stage: row.stage, error: row.error, queue_position: queuePosition(db, 'generation', id), cards, provenance: JSON.parse(row.provenance_json || 'null') };
}
async function runPhotoReview(id, card, photo) {
  db.prepare("UPDATE reviews SET status='reviewing' WHERE id=?").run(id);
  try {
    const result = await reviewPhoto(card, photo, settings);
    db.prepare("UPDATE reviews SET status='complete',verdict=?,reason=?,observation=?,model=?,reviewed_at=? WHERE id=?").run(result.verdict, result.reason, result.observation, result.model, result.reviewed_at, id);
  } catch (error) {
    db.prepare("UPDATE reviews SET status='failed',reason=? WHERE id=?").run(error instanceof GenerationError ? error.message : 'Photo review failed. Please retry.', id);
  } finally { photoJobs.delete(id); }
}
async function runGeneration(adventure) {
  try {
    db.prepare("UPDATE collections SET status='generating',stage='Checking local Gemma' WHERE adventure_id=?").run(adventure.id);
    const key = sourceKey(adventure);
    const saved = db.prepare('SELECT sources_json FROM source_cache WHERE area=? AND created_at>?').get(key, new Date(Date.now() - 86400000).toISOString());
    const result = await generateAdventure(adventure, settings, fetch, stage => db.prepare('UPDATE collections SET stage=?,updated_at=? WHERE adventure_id=?').run(stage, new Date().toISOString(), adventure.id), { sources: saved ? JSON.parse(saved.sources_json) : null, saveSources: sources => db.prepare('INSERT INTO source_cache VALUES(?,?,?) ON CONFLICT(area) DO UPDATE SET sources_json=excluded.sources_json,created_at=excluded.created_at').run(key, JSON.stringify(sources), sources.retrieved_at) });
    saveBlueprint(adventure, result);
    db.prepare("UPDATE collections SET status='ready',stage='',error=NULL,cards_json=?,provenance_json=?,updated_at=? WHERE adventure_id=?").run(JSON.stringify(result.cards), JSON.stringify(result.provenance), new Date().toISOString(), adventure.id);
  } catch (error) {
    db.prepare("UPDATE collections SET status='failed',stage='',error=?,updated_at=? WHERE adventure_id=?").run(error instanceof GenerationError ? error.message : 'Generation failed. Please try again.', new Date().toISOString(), adventure.id);
  }
}
const queue = createQueue(db, {
  generation: async (id, adventure) => {
    if (db.prepare('SELECT id FROM adventures WHERE id=?').get(id)) await runGeneration(adventure);
  },
  photo: async (id, payload) => {
    const row = db.prepare('SELECT filename FROM reviews WHERE id=?').get(id);
    if (!row) return;
    try { await runPhotoReview(id, payload.card, readFileSync(path.join(uploadDir, row.filename))); }
    catch { db.prepare("UPDATE reviews SET status='failed',reason='Stored photo unavailable. Try another photo.' WHERE id=?").run(id); }
  }
});
const port = Number(process.env.PORT || 3000);
const hash = value => createHash('sha256').update(value).digest('hex');
const sessionCookie = token => `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
function json(res, status, data, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); }
function userFor(req) {
  const token = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  return token ? db.prepare('SELECT users.id, username FROM users JOIN sessions ON users.id=sessions.user_id WHERE token_hash=? AND expires>?').get(hash(token), Date.now()) : null;
}
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 16384) throw new Error('Request too large.'); }
  try { return JSON.parse(text); } catch { throw new Error('Invalid request.'); }
}
async function photoBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_UPLOAD) throw new GenerationError('Choose a photo under 8 MB.', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') { db.prepare('SELECT 1').get(); return json(res, 200, { status: 'ok' }); }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}` && req.headers.origin !== process.env.APP_ORIGIN) return json(res, 403, { error: 'Request origin rejected.' });
      if (req.method === 'POST' && ['/api/signup', '/api/login'].includes(url.pathname)) {
        const ip = req.socket.remoteAddress;
        const now = Date.now();
        if (!consumeLimit(db, 'auth', ip, 20, 60000, now)) return json(res, 429, { error: 'Too many attempts. Try again in a minute.' });
        const input = await body(req);
        const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
        const password = typeof input.password === 'string' ? input.password : '';
        if (!/^[a-z0-9_]{3,24}$/.test(username) || password.length < 8 || password.length > 128) return json(res, 400, { error: 'Use a 3–24 character username (letters, numbers, underscores) and an 8–128 character password.' });
        let user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
        if (url.pathname === '/api/signup') {
          if (user) return json(res, 409, { error: 'That username is already taken.' });
          const salt = randomBytes(16).toString('hex');
          const passwordHash = (await hashPassword(password, salt, 64)).toString('hex');
          if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) return json(res, 409, { error: 'That username is already taken.' });
          const result = db.prepare('INSERT INTO users(username,salt,password_hash) VALUES(?,?,?)').run(username, salt, passwordHash);
          user = { id: Number(result.lastInsertRowid), username };
        } else {
          const candidate = await hashPassword(password, user?.salt || 'dummy-auth-salt', 64);
          if (!user || !timingSafeEqual(candidate, Buffer.from(user.password_hash, 'hex'))) return json(res, 401, { error: 'Username or password is incorrect.' });
        }
        db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
        const token = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), user.id, now + 604800000);
        return json(res, 200, { user: { id: user.id, username: user.username } }, { 'Set-Cookie': sessionCookie(token) });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        const token = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
        if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
        return json(res, 200, { ok: true }, { 'Set-Cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
      }
      const user = userFor(req);
      if (!user) return json(res, 401, { error: 'Please log in to continue.' });
      if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, { user });
      if (req.method === 'POST' && url.pathname === '/api/localities/resolve') {
        const input = await body(req);
        const neighbourhood = typeof input.neighbourhood === 'string' ? input.neighbourhood.trim().replace(/\s+/g, ' ') : '';
        const city = typeof input.city === 'string' ? input.city.trim().replace(/\s+/g, ' ') : '';
        if (neighbourhood.length < 2 || neighbourhood.length > 80 || city.length < 2 || city.length > 80) return json(res, 400, { error: 'Enter a neighbourhood and city, each 2–80 characters.' });
        const area = `${neighbourhood.toLowerCase()}|${city.toLowerCase()}`;
        let choices = db.prepare('SELECT id,location_json FROM resolutions WHERE area=? AND created_at>?').all(area, new Date(Date.now() - 86400000).toISOString());
        if (!choices.length) {
          if (!consumeLimit(db, 'resolve', user.id, 15, 3600000)) return json(res, 429, { error: 'Too many place lookups this hour. Please try later.' });
          const found = await resolveLocality({ neighbourhood, city }, settings);
          choices = found.map(location => {
            const id = resolutionId(), location_json = JSON.stringify(location);
            db.prepare('INSERT INTO resolutions VALUES(?,?,?,?)').run(id, area, location_json, new Date().toISOString()); return { id, location_json };
          });
        }
        if (!choices.length) return json(res, 422, { error: 'No matching place found. Try a fuller locality name and include the city or country.' });
        return json(res, 200, { choices: choices.map(choice => ({ id: choice.id, ...JSON.parse(choice.location_json) })) });
      }
      if (req.method === 'GET' && url.pathname === '/api/storage') return json(res, 200, { used_bytes: photoUsage(db, user.id), limit_bytes: userPhotoLimit });
      if (req.method === 'GET' && url.pathname === '/api/adventures') return json(res, 200, { adventures: db.prepare("SELECT a.id,neighbourhood,city,created_at,COALESCE(c.status,'pending') AS status,c.cards_json,(SELECT count(DISTINCT card_number) FROM reviews r WHERE r.adventure_id=a.id AND r.verdict='matched') AS collected_count FROM adventures a LEFT JOIN collections c ON c.adventure_id=a.id WHERE user_id=? ORDER BY a.id DESC").all(user.id).map(({ cards_json, ...adventure }) => ({ ...adventure, card_count: JSON.parse(cards_json || '[]').length })) });
      if (req.method === 'GET' && /^\/api\/photos\/\d+$/.test(url.pathname)) {
        const photo = db.prepare('SELECT filename FROM reviews r JOIN adventures a ON a.id=r.adventure_id WHERE r.id=? AND a.user_id=?').get(Number(url.pathname.split('/').at(-1)), user.id);
        if (!photo) return json(res, 404, { error: 'Photo not found.' });
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' });
        return res.end(readFileSync(path.join(uploadDir, photo.filename)));
      }
      const photoRoute = /^\/api\/adventures\/(\d+)\/cards\/(\d+)\/photo$/.exec(url.pathname);
      if (req.method === 'POST' && photoRoute) {
        const adventure = db.prepare('SELECT id FROM adventures WHERE id=? AND user_id=?').get(Number(photoRoute[1]), user.id);
        if (!adventure) return json(res, 404, { error: 'Adventure not found.' });
        const card = collectionFor(adventure.id).cards.find(card => card.number === Number(photoRoute[2]));
        if (!card) return json(res, 404, { error: 'Quest not found.' });
        if (card.status === 'collected') return json(res, 409, { error: 'This card is already collected.' });
        if (card.review && ['queued','reviewing'].includes(card.review.status)) return json(res, 409, { error: 'This photo is already waiting for review.' });
        queue.ensureRoom();
        const recent = db.prepare('SELECT count(*) AS count FROM reviews r JOIN adventures a ON a.id=r.adventure_id WHERE a.user_id=? AND r.created_at>?').get(user.id, new Date(Date.now() - 3600000).toISOString()).count;
        if (recent >= 30) return json(res, 429, { error: 'You have reached 30 photo reviews this hour. Please try later.' });
        if (!['image/jpeg', 'image/png', 'image/webp'].includes((req.headers['content-type'] || '').split(';')[0])) return json(res, 415, { error: 'Use a JPEG, PNG or WebP photo.' });
        // Reserve before awaiting upload so concurrent requests cannot start two model jobs.
        const reservation = `upload-${adventure.id}-${card.number}`;
        if (photoJobs.has(reservation)) return json(res, 409, { error: 'This photo is already uploading.' });
        if (photoJobs.size >= 2) return json(res, 429, { error: 'Two photos are uploading right now. Please try again in a moment.' });
        photoJobs.add(reservation);
        let filename;
        try {
          const photo = await preparePhoto(await photoBody(req));
          const total = db.prepare('SELECT COALESCE(sum(bytes),0) AS bytes FROM reviews').get().bytes;
          if (photoUsage(db, user.id) + photo.length > userPhotoLimit || total + photo.length > totalPhotoLimit) throw new GenerationError('Photo storage is full. Remove an old neighbourhood to free space.', 413);
          queue.ensureRoom();
          if (!consumeLimit(db, 'photo', user.id, 30, 3600000)) throw new GenerationError('You have reached 30 photo reviews this hour. Please try later.', 429);
          filename = `${randomBytes(24).toString('hex')}.jpg`;
          writeFileSync(path.join(uploadDir, filename), photo, { flag: 'wx' });
          let id;
          db.exec('BEGIN IMMEDIATE');
          try {
            const result = db.prepare("INSERT INTO reviews(adventure_id,card_number,filename,status,created_at,bytes) VALUES(?,?,?,'queued',?,?)").run(adventure.id, card.number, filename, new Date().toISOString(), photo.length);
            id = Number(result.lastInsertRowid); queue.enqueue('photo', id, { card: { category: card.category, evidence_type: card.evidence_type, title: card.title, evidence: card.evidence, place: card.place ? { name: card.place.name } : null } }); db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          photoJobs.delete(reservation);
          return json(res, 202, { review_id: id });
        } catch (error) { photoJobs.delete(reservation); if (filename) { try { unlinkSync(path.join(uploadDir, filename)); } catch {} } throw error; }
      }
      const noteRoute = /^\/api\/adventures\/(\d+)\/cards\/(\d+)\/note$/.exec(url.pathname);
      if (req.method === 'POST' && noteRoute) {
        const review = db.prepare("SELECT r.id FROM reviews r JOIN adventures a ON a.id=r.adventure_id WHERE a.id=? AND a.user_id=? AND r.card_number=? AND verdict='matched' ORDER BY r.id DESC LIMIT 1").get(Number(noteRoute[1]), user.id, Number(noteRoute[2]));
        if (!review) return json(res, 404, { error: 'Collect this card before adding a memory.' });
        const input = await body(req);
        if (typeof input.note !== 'string' || input.note.length > 280) return json(res, 400, { error: 'Keep your memory under 280 characters.' });
        db.prepare('UPDATE reviews SET note=? WHERE id=?').run(input.note.trim(), review.id);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/generation-config') return json(res, 200, { serpapiConfigured: Boolean(settings.serpKey), model: settings.model, ...(await checkOllama(settings)) });
      const adventureRoute = /^\/api\/adventures\/(\d+)(\/generate)?$/.exec(url.pathname);
      if (adventureRoute && ['GET', 'POST'].includes(req.method)) {
        const stored = db.prepare('SELECT * FROM adventures WHERE id=? AND user_id=?').get(Number(adventureRoute[1]), user.id);
        const adventure = stored ? { ...stored, location: JSON.parse(stored.location_json || 'null'), allow_small: Boolean(stored.allow_small) } : null;
        if (!adventure) return json(res, 404, { error: 'Adventure not found.' });
        if (req.method === 'GET' && !adventureRoute[2]) return json(res, 200, { adventure, collection: collectionFor(adventure.id) });
        if (req.method === 'POST' && adventureRoute[2]) {
          const collection = collectionFor(adventure.id);
          if (['ready','generating','queued'].includes(collection.status)) return json(res, collection.status === 'ready' ? 200 : 202, { collection });
          const cached = db.prepare('SELECT * FROM blueprints WHERE area=? AND created_at>?').get(areaKey(adventure), new Date(Date.now() - 86400000).toISOString());
          if (cached) {
            const provenance = { ...JSON.parse(cached.provenance_json), cache_reused: true };
            db.prepare("INSERT INTO collections(adventure_id,status,cards_json,provenance_json,updated_at) VALUES(?,'ready',?,?,?) ON CONFLICT(adventure_id) DO UPDATE SET status='ready',stage='',error=NULL,cards_json=excluded.cards_json,provenance_json=excluded.provenance_json,updated_at=excluded.updated_at").run(adventure.id, cached.cards_json, JSON.stringify(provenance), new Date().toISOString());
            return json(res, 200, { collection: collectionFor(adventure.id) });
          }
          if (!settings.serpKey) return json(res, 503, { error: 'Add SERPAPI_API_KEY to .env and restart the app.' });
          queue.ensureRoom();
          if (!consumeLimit(db, 'generation', user.id, 5, 3600000)) return json(res, 429, { error: 'You have reached five generation attempts this hour. Please try later.' });
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare("INSERT INTO collections(adventure_id,status,stage,updated_at) VALUES(?,'queued','Waiting for local Gemma',?) ON CONFLICT(adventure_id) DO UPDATE SET status='queued',stage='Waiting for local Gemma',error=NULL,updated_at=excluded.updated_at").run(adventure.id, new Date().toISOString());
            queue.enqueue('generation', adventure.id, adventure); db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          return json(res, 202, { collection: collectionFor(adventure.id) });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/adventures') {
        const input = await body(req);
        const clean = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
        const neighbourhood = clean(input.neighbourhood), city = clean(input.city);
        if (neighbourhood.length < 2 || neighbourhood.length > 80 || city.length < 2 || city.length > 80) return json(res, 400, { error: 'Enter a neighbourhood and city, each 2–80 characters.' });
        const exists = db.prepare('SELECT id FROM adventures WHERE user_id=? AND lower(neighbourhood)=lower(?) AND lower(city)=lower(?)').get(user.id, neighbourhood, city);
        if (exists) return json(res, 409, { error: 'You already have this neighbourhood in your collection.' });
        const created_at = new Date().toISOString();
        let location = null;
        if (input.location_id) {
          const found = db.prepare('SELECT location_json FROM resolutions WHERE id=? AND area=? AND created_at>?').get(input.location_id, `${neighbourhood.toLowerCase()}|${city.toLowerCase()}`, new Date(Date.now() - 86400000).toISOString());
          if (!found) return json(res, 400, { error: 'That place selection expired. Search again.' });
          location = JSON.parse(found.location_json);
        }
        const radius = input.radius === 5 ? 5 : 3, allowSmall = input.allow_small === true ? 1 : 0;
        const result = db.prepare('INSERT INTO adventures(user_id,neighbourhood,city,created_at,location_json,radius,allow_small) VALUES(?,?,?,?,?,?,?)').run(user.id, neighbourhood, city, created_at, location ? JSON.stringify(location) : null, radius, allowSmall);
        return json(res, 201, { adventure: { id: Number(result.lastInsertRowid), neighbourhood, city, created_at } });
      }
      if (req.method === 'POST' && /^\/api\/adventures\/\d+\/settings$/.test(url.pathname)) {
        const id = Number(url.pathname.split('/')[3]);
        const adventure = db.prepare('SELECT id FROM adventures WHERE id=? AND user_id=?').get(id, user.id);
        if (!adventure) return json(res, 404, { error: 'Adventure not found.' });
        if (['ready','queued','generating'].includes(collectionFor(id).status)) return json(res, 409, { error: 'Settings can be changed before a collection is created or after a failed attempt.' });
        const input = await body(req);
        db.prepare('UPDATE adventures SET radius=?,allow_small=? WHERE id=?').run(input.radius === 5 ? 5 : 3, input.allow_small === true ? 1 : 0, id);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE' && /^\/api\/adventures\/\d+$/.test(url.pathname)) {
        if (queuePosition(db, 'generation', Number(url.pathname.split('/').at(-1))) || db.prepare("SELECT id FROM jobs WHERE kind='generation' AND target=? AND status='running'").get(Number(url.pathname.split('/').at(-1)))) return json(res, 409, { error: 'Wait for generation to finish before removing this neighbourhood.' });
        const id = Number(url.pathname.split('/').at(-1));
        const photos = db.prepare('SELECT r.id,r.filename FROM reviews r JOIN adventures a ON a.id=r.adventure_id WHERE a.id=? AND a.user_id=?').all(id, user.id);
        if (photos.some(photo => db.prepare("SELECT id FROM jobs WHERE kind='photo' AND target=? AND status IN ('queued','running')").get(photo.id)) || Array.from(photoJobs).some(key => key.startsWith(`upload-${id}-`))) return json(res, 409, { error: 'Wait for the photo review to finish before removing a neighbourhood.' });
        const result = db.prepare('DELETE FROM adventures WHERE id=? AND user_id=?').run(id, user.id);
        for (const photo of photos) { try { unlinkSync(path.join(uploadDir, photo.filename)); } catch {} }
        return json(res, result.changes ? 200 : 404, result.changes ? { ok: true } : { error: 'Adventure not found.' });
      }
      return json(res, 404, { error: 'Not found.' });
    }
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/experience.js': ['experience.js','text/javascript'] };
    const vendor = { '/vendor/leaflet.js': ['leaflet.js','text/javascript'], '/vendor/leaflet.css': ['leaflet.css','text/css'] }[url.pathname];
    if (vendor && req.method === 'GET') { res.writeHead(200, { 'Content-Type': vendor[1] }); return res.end(readFileSync(path.join(root,'node_modules','leaflet','dist',vendor[0]))); }
    const file = files[url.pathname];
    if (!file || req.method !== 'GET') return json(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
    res.end(readFileSync(path.join(root, 'public', file[0])));
  } catch (error) { json(res, error instanceof GenerationError ? error.status : error.message === 'Request too large.' ? 413 : 400, { error: error instanceof GenerationError || ['Request too large.', 'Invalid request.'].includes(error.message) ? error.message : 'Something went wrong. Please try again.' }); }
});
server.listen(port, process.env.HOST || '127.0.0.1', () => {
  writeFileSync(path.join(dataDir, 'server.lock'), JSON.stringify({ pid: process.pid }));
  queue.start(); console.log(`NeighbourDex ready at http://localhost:${server.address().port}`);
});
const maintenance = setInterval(() => {
  try {
    maintainPhotos(db, uploadDir);
    db.prepare('DELETE FROM rate_limits WHERE started<?').run(Date.now() - 86400000);
    for (const table of ['resolutions','source_cache','blueprints']) db.prepare(`DELETE FROM ${table} WHERE created_at<?`).run(new Date(Date.now() - 86400000).toISOString());
  } catch { console.error('Storage maintenance could not complete. Check available disk space.'); }
}, 6 * 3600000); maintenance.unref();
function stop() { clearInterval(maintenance); server.close(() => { try { unlinkSync(path.join(dataDir, 'server.lock')); } catch {} db.close(); process.exit(0); }); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
