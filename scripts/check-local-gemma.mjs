// Optional real-model smoke test. Place retrieval is mocked; Ollama inference is real.
import { config, generateAdventure } from '../adventure.mjs';
import { center, placeGroups } from '../tests/fixtures.mjs';
const settings = { ...config(), serpKey: 'smoke-test-placeholder' };
const fetcher = async (input, options) => {
  const url = new URL(input);
  if (url.host === new URL(settings.ollamaUrl).host) return fetch(input, options);
  const query = url.searchParams.get('q');
  if (!url.searchParams.has('ll')) return Response.json({ place_results: { title: 'Test neighbourhood', gps_coordinates: center } });
  const category = query.startsWith('restaurants') ? 'food' : query.startsWith('landmarks') ? 'landmark' : 'nature';
  return Response.json({ local_results: placeGroups[category] });
};
const start = Date.now();
try {
  const result = await generateAdventure({ neighbourhood: 'Test neighbourhood', city: 'Test city' }, settings, fetcher, stage => console.log(stage));
  console.log(JSON.stringify({ model: result.provenance.model, cards: result.cards.length, categories: result.cards.reduce((counts, card) => ({ ...counts, [card.category]: (counts[card.category] || 0) + 1 }), {}), attempts: result.provenance.generation_attempts, seconds: Math.round((Date.now() - start) / 1000), note: 'Real Ollama inference; synthetic test places, not live SerpApi results.' }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
