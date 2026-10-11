import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { center, placeGroups, modelDraft, records } from './fixtures.mjs';

test('accounts, persistence, neighbourhood validation and account isolation', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'neighbourdex-test-'));
  let child;
  let searchCalls = 0;
  let photoVerdict = 'uncertain';
  let invalidGeneration = false, generationDelay = 0;
  const provider = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'gemma3:4b' }] }));
    if (url.pathname === '/api/chat') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      const generation = !input.messages[0].images && !input.format?.properties?.verdict;
      if (generation && generationDelay) await new Promise(resolve=>setTimeout(resolve,generationDelay));
      const output = input.messages[0].images ? { description: 'Fixture image showing food, greenery and a place exterior.', food: true, nature: true, built_place: true } : input.format?.properties?.verdict ? { verdict: photoVerdict, reason: 'Fixture review of visible evidence.' } : invalidGeneration ? {cards:{}} : modelDraft(records());
      return res.end(JSON.stringify({ message: { content: JSON.stringify(output) } }));
    }
    searchCalls++;
    const query = url.searchParams.get('q');
    if (!url.searchParams.has('ll')) return res.end(JSON.stringify({ place_results: { title: 'Saket', gps_coordinates: center } }));
    const category = query.startsWith('restaurants') ? 'food' : query.startsWith('landmarks') ? 'landmark' : 'nature';
    res.end(JSON.stringify({ local_results: placeGroups[category] }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const providerURL = `http://127.0.0.1:${provider.address().port}`;
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '0', DATA_DIR: directory, SERPAPI_API_KEY: 'fixture-key', SERPAPI_URL: providerURL + '/search.json', OLLAMA_URL: providerURL, OLLAMA_MODEL: 'gemma3:4b' }, stdio: ['ignore', 'pipe', 'pipe'] });
    return await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
      child.stdout.on('data', chunk => { output += chunk; const match = /http:\/\/localhost:(\d+)/.exec(output); if (match) { clearTimeout(timer); resolve(`http://localhost:${match[1]}`); } });
      child.on('error', reject);
      child.on('exit', code => { clearTimeout(timer); if (!output.includes('ready')) reject(new Error(`Server exited ${code}`)); });
    });
  }
  async function stop() { const exited = once(child, 'exit'); child.kill(); await exited; }
  try {
    let base = await start();
    async function request(route, method = 'GET', input, cookie = '') {
      const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(input ? { body: JSON.stringify(input) } : {}) });
      return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
    }
    assert.equal((await request('/api/adventures')).status, 401);
    assert.equal((await request('/api/signup', 'POST', { username: 'a', password: 'weak' })).status, 400);
    const signup = await request('/api/signup', 'POST', { username: 'explorer', password: 'secure-pass-123' });
    assert.equal(signup.status, 200);
    assert.match(signup.headers.get('set-cookie'), /HttpOnly/);
    const cookie = signup.cookie;
    assert.equal((await request('/api/signup', 'POST', { username: 'EXPLORER', password: 'secure-pass-123' })).status, 409);
    assert.equal((await request('/api/login', 'POST', { username: 'explorer', password: 'wrong-pass-123' })).status, 401);
    const added = await request('/api/adventures', 'POST', { neighbourhood: ' Saket ', city: 'Delhi' }, cookie);
    assert.equal(added.status, 201);
    assert.equal(added.data.adventure.neighbourhood, 'Saket');
    assert.equal((await request('/api/adventures', 'POST', { neighbourhood: 'SAKET', city: 'delhi' }, cookie)).status, 409);
    assert.equal((await request('/api/adventures', 'POST', { neighbourhood: '', city: 'Delhi' }, cookie)).status, 400);
    const other = await request('/api/signup', 'POST', { username: 'another', password: 'other-pass-123' });
    assert.deepEqual((await request('/api/adventures', 'GET', null, other.cookie)).data.adventures, []);
    assert.equal((await request(`/api/adventures/${added.data.adventure.id}`, 'DELETE', null, other.cookie)).status, 404);
    assert.equal((await request(`/api/adventures/${added.data.adventure.id}`, 'GET', null, other.cookie)).status, 404);
    assert.equal((await request(`/api/adventures/${added.data.adventure.id}/generate`, 'POST', null, other.cookie)).status, 404);
    assert.equal((await request('/api/generation-config', 'GET', null, cookie)).data.modelInstalled, true);
    assert.equal((await request(`/api/adventures/${added.data.adventure.id}/generate`, 'POST', null, cookie)).status, 202);
    let generated;
    for (let attempt = 0; attempt < 50; attempt++) {
      generated = await request(`/api/adventures/${added.data.adventure.id}`, 'GET', null, cookie);
      if (generated.data.collection.status !== 'generating') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(generated.data.collection.status, 'ready'); assert.equal(generated.data.collection.cards.length, 12);
    assert.equal((await request(`/api/adventures/${added.data.adventure.id}/generate`, 'POST', null, cookie)).status, 200);
    assert.equal(searchCalls, 4, 'ready collections reuse persisted results without new searches');
    const id = added.data.adventure.id;
    const photoURL = `/api/adventures/${id}/cards/1/photo`;
    const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#88aa55' } }).png().toBuffer();
    const upload = async (cookieValue, photo = image, type = 'image/png') => fetch(base + photoURL, { method: 'POST', headers: { Cookie: cookieValue, 'Content-Type': type }, body: photo });
    assert.equal((await upload(other.cookie)).status, 404);
    assert.equal((await upload(cookie, image, 'text/html')).status, 415);
    assert.equal((await upload(cookie, Buffer.from('not an image'))).status, 400);
    assert.equal((await upload(cookie)).status, 202);
    async function waitReview() {
      for (let attempt = 0; attempt < 50; attempt++) {
        const response = await request(`/api/adventures/${id}`, 'GET', null, cookie);
        const card = response.data.collection.cards[0];
        if (card.review?.status !== 'reviewing') return card;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail('Photo review did not finish');
    }
    let reviewed = await waitReview();
    assert.equal(reviewed.review.verdict, 'uncertain'); assert.equal(reviewed.status, 'undiscovered');
    photoVerdict = 'not_matched'; assert.equal((await upload(cookie)).status, 202);
    reviewed = await waitReview(); assert.equal(reviewed.status, 'undiscovered');
    photoVerdict = 'matched'; assert.equal((await upload(cookie)).status, 202);
    reviewed = await waitReview(); assert.equal(reviewed.status, 'collected');
    const privatePhoto = await fetch(base + reviewed.memory.photo_url, { headers: { Cookie: cookie } });
    assert.equal(privatePhoto.status, 200); assert.equal(privatePhoto.headers.get('content-type'), 'image/jpeg');
    const decoded = await sharp(Buffer.from(await privatePhoto.arrayBuffer())).metadata();
    assert.equal(decoded.format, 'jpeg'); assert.equal(decoded.exif, undefined);
    assert.equal((await fetch(base + reviewed.memory.photo_url, { headers: { Cookie: other.cookie } })).status, 404);
    assert.equal((await fetch(base + reviewed.memory.photo_url)).status, 401);
    assert.equal((await upload(cookie)).status, 409, 'collected cards cannot be re-uploaded');
    assert.equal((await request(`/api/adventures/${id}/cards/1/note`, 'POST', { note: 'A good day outside.' }, cookie)).status, 200);
    assert.equal((await request(`/api/adventures/${id}/cards/1/note`, 'POST', { note: 'intrusion' }, other.cookie)).status, 404);
    assert.equal((await request('/api/adventures', 'GET', null, cookie)).data.adventures[0].collected_count, 1);
    const cloned = await request('/api/adventures', 'POST', { neighbourhood: 'Saket', city: 'Delhi' }, other.cookie);
    const clone = await request(`/api/adventures/${cloned.data.adventure.id}/generate`, 'POST', null, other.cookie);
    assert.equal(clone.status, 200); assert.equal(searchCalls, 4);
    assert.equal(clone.data.collection.provenance.cache_reused, true);
    assert.equal(clone.data.collection.cards[0].status, 'undiscovered'); assert.equal(clone.data.collection.cards[0].memory, null);
    const storage=await request('/api/storage','GET',null,cookie);assert.ok(storage.data.used_bytes>0);assert.equal(storage.data.limit_bytes,104857600);
    const quotaDB=new DatabaseSync(path.join(directory,'neighbourdex.sqlite'));
    const actualBytes=quotaDB.prepare('SELECT bytes FROM reviews WHERE id=?').get(reviewed.memory.id).bytes;
    quotaDB.prepare('UPDATE reviews SET bytes=104857600 WHERE id=?').run(reviewed.memory.id);
    const overQuota=await fetch(`${base}/api/adventures/${id}/cards/2/photo`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'image/png'},body:image});
    assert.equal(overQuota.status,413);assert.match((await overQuota.json()).error,/storage is full/);
    quotaDB.prepare('UPDATE reviews SET bytes=? WHERE id=?').run(actualBytes,reviewed.memory.id);quotaDB.close();
    async function newResolved(name) {
      const input={neighbourhood:name,city:'Delhi'};
      const lookup=await request('/api/localities/resolve','POST',input,cookie);assert.equal(lookup.status,200);
      const before=searchCalls;const reused=await request('/api/localities/resolve','POST',input,cookie);assert.equal(reused.status,200);assert.equal(searchCalls,before);
      const wrong=await request('/api/adventures','POST',{...input,city:'Wrong city',location_id:lookup.data.choices[0].id},cookie);assert.equal(wrong.status,400);
      const created=await request('/api/adventures','POST',{...input,location_id:lookup.data.choices[0].id},cookie);assert.equal(created.status,201);return created.data.adventure.id;
    }
    async function waitCollection(target) {
      for(let attempt=0;attempt<150;attempt++){
        const data=(await request(`/api/adventures/${target}`,'GET',null,cookie)).data.collection;
        if(!['queued','generating'].includes(data.status))return data;
        await new Promise(resolve=>setTimeout(resolve,20));
      }assert.fail('Collection did not finish');
    }
    const retryId=await newResolved('Saket West');invalidGeneration=true;
    assert.equal((await request(`/api/adventures/${retryId}/generate`,'POST',null,cookie)).status,202);
    assert.equal((await waitCollection(retryId)).status,'failed');const searchesBeforeRetry=searchCalls;
    invalidGeneration=false;assert.equal((await request(`/api/adventures/${retryId}/generate`,'POST',null,cookie)).status,202);
    const retryResult=await waitCollection(retryId);assert.equal(retryResult.status,'ready');assert.equal(retryResult.provenance.source_cache_reused,true);assert.equal(searchCalls,searchesBeforeRetry);
    assert.equal((await request(`/api/adventures/${retryId}`,'DELETE',null,cookie)).status,200);
    generationDelay=150;const eastId=await newResolved('Saket East'),northId=await newResolved('Saket North');
    assert.equal((await request(`/api/adventures/${eastId}/generate`,'POST',null,cookie)).status,202);
    const queued=await request(`/api/adventures/${northId}/generate`,'POST',null,cookie);assert.equal(queued.status,202);assert.equal(queued.data.collection.status,'queued');assert.ok(queued.data.collection.queue_position>=1);
    assert.equal((await waitCollection(eastId)).status,'ready');assert.equal((await waitCollection(northId)).status,'ready');generationDelay=0;
    await request(`/api/adventures/${eastId}`,'DELETE',null,cookie);await request(`/api/adventures/${northId}`,'DELETE',null,cookie);
    const forged = await fetch(base + '/api/adventures', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ neighbourhood: 'Other', city: 'Delhi' }) });
    assert.equal(forged.status, 403);
    await stop(); base = await start();
    const limited=await request('/api/adventures','POST',{neighbourhood:'Saket Again',city:'Delhi'},cookie);
    assert.equal((await request(`/api/adventures/${limited.data.adventure.id}/generate`,'POST',null,cookie)).status,429,'generation rate limits survive restart');
    await request(`/api/adventures/${limited.data.adventure.id}`,'DELETE',null,cookie);
    assert.equal((await request('/api/me', 'GET', null, cookie)).data.user.username, 'explorer');
    assert.equal((await request('/api/adventures', 'GET', null, cookie)).data.adventures.length, 1);
    assert.equal((await request(`/api/adventures/${added.data.adventure.id}`, 'GET', null, cookie)).data.collection.cards.length, 12);
    const saved = (await request(`/api/adventures/${id}`, 'GET', null, cookie)).data.collection.cards[0];
    assert.equal(saved.status, 'collected'); assert.equal(saved.memory.note, 'A good day outside.');
    assert.equal((await request(`/api/adventures/${added.data.adventure.id}`, 'DELETE', null, cookie)).status, 200);
    assert.equal((await request('/api/adventures', 'GET', null, cookie)).data.adventures.length, 0);
    assert.equal((await fetch(base + saved.memory.photo_url, { headers: { Cookie: cookie } })).status, 404);
    await request('/api/logout', 'POST', null, cookie);
    assert.equal((await request('/api/me', 'GET', null, cookie)).status, 401);
    assert.equal((await request('/api/login', 'POST', { username: 'explorer', password: 'secure-pass-123' })).status, 200);
  } finally {
    if (child && child.exitCode === null) await stop();
    await new Promise(resolve => provider.close(resolve));
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('neighbourdex-test-'));
    rmSync(resolved, { recursive: true, force: true });
  }
});
