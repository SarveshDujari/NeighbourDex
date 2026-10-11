import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, findPlaces, generateAdventure, validateCards, bindQuestDrafts, classifyPlace, resolveLocality } from '../adventure.mjs';
import { center, placeGroups, modelOutput, modelDraft, records } from './fixtures.mjs';

const adventure = { neighbourhood: 'Test neighbourhood', city: 'Test city' };
const settings = { ...config({}), serpKey: 'test-secret-never-returned' };
function mockProvider({ invalidFirst = false, fewPlaces = false, distant = false } = {}) {
  let modelCalls = 0, searchCalls = 0;
  const fetcher = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/tags') return Response.json({ models: [{ name: 'gemma3:4b' }] });
    if (url.pathname === '/api/chat') {
      modelCalls++;
      const request = JSON.parse(options.body);
      assert.equal(request.model, 'gemma3:4b'); assert.equal(request.format.type, 'object'); assert.equal(request.stream, false);
      return Response.json({ message: { content: JSON.stringify(invalidFirst && modelCalls === 1 ? { cards: {} } : modelDraft(records())) } });
    }
    searchCalls++;
    assert.equal(url.searchParams.get('api_key'), settings.serpKey);
    const query = url.searchParams.get('q');
    if (!url.searchParams.has('ll')) return Response.json({ place_results: { title: 'Test neighbourhood', gps_coordinates: center } });
    const category = query.startsWith('restaurants') ? 'food' : query.startsWith('landmarks') ? 'landmark' : 'nature';
    const places = fewPlaces ? placeGroups[category].slice(0, 1) : placeGroups[category];
    return Response.json({ local_results: [...places, ...(distant ? [{ title: 'Far away', data_id: `far-${category}`, gps_coordinates: { latitude: 29.5, longitude: 78.5 } }] : [])] });
  };
  return { fetcher, counts: () => ({ modelCalls, searchCalls }) };
}
test('SerpApi searches are geographically filtered and Gemma results carry trusted place metadata', async () => {
  const provider = mockProvider({ distant: true });
  const result = await generateAdventure(adventure, settings, provider.fetcher);
  assert.equal(result.cards.length, 12); assert.equal(result.provenance.places.length, 10);
  assert.deepEqual(provider.counts(), { modelCalls: 1, searchCalls: 4 });
  assert.equal(result.cards.filter(card => card.category === 'discovery').length, 2);
  assert.ok(result.cards.filter(card => card.place).every(card => card.place.source_url.startsWith('https://www.google.com/maps')));
  assert.ok(!JSON.stringify(result).includes(settings.serpKey));
});
test('invalid model output gets one bounded repair attempt without repeating paid search', async () => {
  const provider = mockProvider({ invalidFirst: true });
  const result = await generateAdventure(adventure, settings, provider.fetcher);
  assert.equal(result.provenance.generation_attempts, 2);
  assert.deepEqual(provider.counts(), { modelCalls: 2, searchCalls: 4 });
});
test('sparse results and missing credentials fail instead of inventing places', async () => {
  const provider = mockProvider({ fewPlaces: true });
  await assert.rejects(findPlaces(adventure, settings, provider.fetcher), /Not enough nearby places/);
  await assert.rejects(generateAdventure(adventure, { ...settings, serpKey: '' }, provider.fetcher), /SERPAPI_API_KEY/);
  assert.equal(provider.counts().modelCalls, 0);
});
test('unknown source IDs, duplicate places, invalid discovery anchors and wrong categories are rejected', () => {
  for (const mutate of [output => output.cards[0].place_id = 'invented', output => output.cards[1].place_id = 'p1', output => output.cards[0].category = 'nature', output => output.cards[10].place_id = 'p1', output => output.cards[0].minutes = 0]) {
    const output = modelOutput(records()); mutate(output);
    assert.throws(() => validateCards(output, records()));
  }
});
test('quest identities are assigned by code independent of model output order', () => {
  const places = records();
  const draft = modelDraft(places);
  draft.cards = Object.fromEntries(Object.entries(draft.cards).reverse());
  const cards = bindQuestDrafts(draft, places);
  assert.equal(cards.length, 12);
  assert.deepEqual(cards.slice(0, 10).map(card => [card.place.id, card.category]), places.map(place => [place.id, place.category]));
  assert.equal(cards[10].category, 'discovery'); assert.equal(cards[10].place, null);
  const invalid = modelDraft(places); invalid.cards.p1.category = 'nature';
  assert.throws(() => bindQuestDrafts(invalid, places), /unexpected quest fields/);
  const missing = modelDraft(places); delete missing.cards.p1;
  assert.throws(() => bindQuestDrafts(missing, places), /every required quest/);
});
test('missions and evidence use trusted place records rather than model inventions', () => {
  const places=records(), cards=bindQuestDrafts(modelDraft(places),places);
  assert.equal(cards[0].evidence_type,'food');assert.ok(cards[0].mission.includes(places[0].name));
  assert.ok(!cards[0].evidence.includes('sign'));
  const landmark=cards.find(card=>card.category==='landmark');assert.equal(landmark.evidence_type,'exterior');assert.ok(landmark.evidence.includes(landmark.place.name));
  const malicious=modelDraft(places);malicious.cards.p1.mission='Visit an unrelated invented landmark';
  assert.throws(()=>bindQuestDrafts(malicious,places),/unexpected quest fields/);
});
test('a failed writing attempt preserves search results for a cheaper retry', async()=>{
  const provider=mockProvider();let saved;
  const broken=async(input,options)=>new URL(input).pathname==='/api/chat'?Response.json({message:{content:'{"cards":{}}'}}):provider.fetcher(input,options);
  await assert.rejects(generateAdventure(adventure,settings,broken,()=>{},{saveSources:sources=>{saved=sources;}}),/Could not create/);
  assert.ok(saved);assert.equal(provider.counts().searchCalls,4);
  const result=await generateAdventure(adventure,settings,provider.fetcher,()=>{},{sources:saved});
  assert.equal(provider.counts().searchCalls,4);assert.equal(result.provenance.source_cache_reused,true);
});
test('compact collections require explicit consent and never invent missing categories',async()=>{
  const provider=mockProvider();
  const compactProvider=async(input,options)=>{
    const url=new URL(input);
    if(url.pathname==='/api/chat') {
      const keys=Object.keys(JSON.parse(options.body).format.properties.cards.properties);
      return Response.json({message:{content:JSON.stringify({cards:Object.fromEntries(keys.map(key=>[key,{title:`Quest ${key}`}]))})}});
    }
    if(url.searchParams.has('ll'))return Response.json({local_results:url.searchParams.get('q').startsWith('restaurants')?placeGroups.food:[]});
    return provider.fetcher(input,options);
  };
  await assert.rejects(generateAdventure(adventure,settings,compactProvider),/missing landmark, nature/);
  const result=await generateAdventure({...adventure,allow_small:true},settings,compactProvider);
  assert.equal(result.cards.length,6);assert.equal(result.provenance.compact,true);assert.deepEqual(result.provenance.missing_categories,['landmark','nature']);
});
test('place types override the search category and locality choices discard invalid coordinates',async()=>{
  assert.equal(classifyPlace(['Restaurant'],'nature'),'food');assert.equal(classifyPlace(['Park'],'landmark'),'nature');assert.equal(classifyPlace(['Bank'],'landmark'),null);
  const choices=await resolveLocality(adventure,settings,async()=>Response.json({local_results:[{title:'Candidate A',gps_coordinates:center},{title:'Duplicate',gps_coordinates:center},{title:'Invalid',gps_coordinates:{latitude:200,longitude:20}}]}));
  assert.equal(choices.length,1);assert.equal(choices[0].name,'Candidate A');
});
