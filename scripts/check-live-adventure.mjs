import { mkdirSync, writeFileSync } from 'node:fs';
import { config, generateAdventure } from '../adventure.mjs';
process.loadEnvFile('.env');
const adventure = { neighbourhood: process.argv[2] || 'Saket', city: process.argv[3] || 'Delhi' };
const slug = adventure.neighbourhood.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'locality';
const savedPath = `data/live-${slug}.json`;
const start = Date.now();
try {
  const result = await generateAdventure(adventure, config(), fetch, stage => console.log(stage));
  mkdirSync('data', { recursive: true });
  writeFileSync(savedPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...adventure, cards: result.cards.length, categories: result.cards.reduce((counts, card) => ({ ...counts, [card.category]: (counts[card.category] || 0) + 1 }), {}), places: result.provenance.places.map(place => ({ name: place.name, category: place.category, distance_km: place.distance_km })), seconds: Math.round((Date.now() - start) / 1000), saved: savedPath, attempts: result.provenance.generation_attempts }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
