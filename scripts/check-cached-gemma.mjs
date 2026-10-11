import { readFileSync } from 'node:fs';
import { config, generateAdventure } from '../adventure.mjs';
process.loadEnvFile('.env');
const saved = JSON.parse(readFileSync('data/live-saket.json', 'utf8'));
const settings = { ...config(), serpKey: 'cached-diagnostic-only' };
const fetcher = async (input, options) => {
  const url = new URL(input);
  if (url.host === new URL(settings.ollamaUrl).host) return fetch(input, options);
  if (!url.searchParams.has('ll')) return Response.json({ place_results: { title: 'Saket', gps_coordinates: saved.provenance.center } });
  const query = url.searchParams.get('q');
  const category = query.startsWith('restaurants') ? 'food' : query.startsWith('landmarks') ? 'landmark' : 'nature';
  return Response.json({ local_results: saved.provenance.places.filter(place => place.category === category).map(place => ({ title: place.name, address: place.address, type: place.types?.[0], types: place.types, data_id: place.id, gps_coordinates: place.coordinates, rating: place.rating, price: place.price })) });
};
const start = Date.now();
const result = await generateAdventure({ neighbourhood: 'Saket', city: 'Delhi' }, settings, fetcher, stage => console.log(stage));
console.log(JSON.stringify({ cards: result.cards.length, attempts: result.provenance.generation_attempts, seconds: Math.round((Date.now() - start) / 1000), model: result.provenance.model, note: 'Real local Gemma; previously retrieved Saket records; no SerpApi requests.' }));
