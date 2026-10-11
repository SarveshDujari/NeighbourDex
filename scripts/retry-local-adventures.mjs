import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { config, generateAdventure } from '../adventure.mjs';

process.loadEnvFile('.env');
const db = new DatabaseSync('data/neighbourdex.sqlite');
const targets = db.prepare("SELECT id,neighbourhood,city FROM adventures JOIN collections ON adventures.id=collections.adventure_id WHERE status='failed' AND lower(neighbourhood) IN ('manhattan','rohini') AND NOT EXISTS (SELECT 1 FROM reviews WHERE reviews.adventure_id=adventures.id)").all();
const results = new Map();
for (const adventure of targets) {
  const area = `${adventure.neighbourhood.toLowerCase()}|${adventure.city.toLowerCase()}`;
  const start = Date.now();
  try {
    let result = results.get(area);
    if (!result) {
      result = await generateAdventure(adventure, config(), fetch, stage => console.log(`${adventure.neighbourhood}: ${stage}`));
      results.set(area, result);
      writeFileSync(`data/live-${adventure.neighbourhood.toLowerCase()}.json`, JSON.stringify(result, null, 2));
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO blueprints VALUES(?,?,?,?) ON CONFLICT(area) DO UPDATE SET cards_json=excluded.cards_json,provenance_json=excluded.provenance_json,created_at=excluded.created_at').run(area, JSON.stringify(result.cards), JSON.stringify(result.provenance), result.provenance.generated_at);
      const changed = db.prepare("UPDATE collections SET status='ready',stage='',error=NULL,cards_json=?,provenance_json=?,updated_at=? WHERE adventure_id=? AND status='failed' AND NOT EXISTS (SELECT 1 FROM reviews WHERE reviews.adventure_id=collections.adventure_id)").run(JSON.stringify(result.cards), JSON.stringify(result.provenance), new Date().toISOString(), adventure.id).changes;
      db.exec('COMMIT');
      console.log(JSON.stringify({ neighbourhood: adventure.neighbourhood, city: adventure.city, cards: result.cards.length, attempts: result.provenance.generation_attempts, seconds: Math.round((Date.now() - start) / 1000), restored: Boolean(changed) }));
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) { console.log(JSON.stringify({ neighbourhood: adventure.neighbourhood, error: error.message })); process.exitCode = 1; }
}
db.close();
