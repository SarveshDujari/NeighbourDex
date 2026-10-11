import { renderMap, destroyMap, explorerMilestones, drawPostcard } from './experience.js';
const $ = id => document.getElementById(id);
let mode = 'signup', user = null, adventures = [], selected = null;
let collection = null, category = 'all', pollTimer = null, viewVersion = 0;
let selectedQuest = null, photoFile = null, photoTimer = null, photoVersion = 0;
let photoSelection = 0, noteDirty = false, questView = 'list', locationChoice = null, postcardCanvas = null, postcardVersion = 0;
let localityRequest = 0;
const pending = status => ['queued','generating'].includes(status);
const categories = { food: ['🍜', 'Food'], landmark: ['🏛️', 'Landmark'], nature: ['🌿', 'Nature'], discovery: ['🔎', 'Discovery'] };
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && user) { user = null; showAuth(); } const error = new Error(data.error || 'Please try again.'); error.status = response.status; throw error; }
  return data;
}
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 3500); }
function showAuth() { viewVersion++; clearTimeout(pollTimer); stopPhotoPolling(); destroyMap(); selected = null; $('auth-view').hidden = false; $('dashboard').hidden = true; $('collection-view').hidden = true; $('logout').hidden = true; document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); }
function setMode(next) {
  mode = next;
  $('signup-tab').setAttribute('aria-selected', String(mode === 'signup'));
  $('login-tab').setAttribute('aria-selected', String(mode === 'login'));
  $('auth-title').innerHTML = mode === 'signup' ? 'Start close.<br>Go somewhere new.' : 'Welcome back,<br>wanderer.';
  $('auth-description').textContent = mode === 'signup' ? 'Create an account to keep your adventures together.' : 'Your neighbourhoods are right where you left them.';
  $('password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('auth-submit').innerHTML = `${mode === 'signup' ? 'Create my passport' : 'Open my passport'} <span>↗</span>`;
  $('auth-error').textContent = '';
}
function render() {
  $('auth-view').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false;
  $('collection-view').hidden = true;
  $('greeting').textContent = `LET’S GET CURIOUS, ${user.username.toUpperCase()}`;
  $('passport-user').textContent = `@${user.username}`;
  $('count').textContent = String(adventures.length).padStart(2, '0');
  $('empty-state').hidden = adventures.length > 0;
  $('adventure-list').replaceChildren();
  adventures.forEach((adventure, index) => {
    const card = document.createElement('button'); card.className = `adventure-card tone-${index % 3}`;
    const top = document.createElement('div'); top.className = 'card-top';
    const number = document.createElement('span'); number.textContent = `NEIGHBOURHOOD / ${String(adventures.length - index).padStart(2, '0')}`;
    const arrow = document.createElement('span'); arrow.textContent = '↗'; top.append(number, arrow);
    const art = document.createElement('div'); art.className = 'card-art'; art.textContent = ['⌖', '✳', '◈'][index % 3];
    const title = document.createElement('h3'); title.textContent = adventure.neighbourhood;
    const city = document.createElement('p'); city.textContent = adventure.city;
    const status = document.createElement('div'); status.className = 'card-status'; status.textContent = adventure.status === 'ready' ? `${adventure.collected_count || 0} / ${adventure.card_count} COLLECTED · KEEP EXPLORING` : pending(adventure.status) ? 'YOUR ADVENTURE IS TAKING SHAPE…' : adventure.status === 'failed' ? 'GENERATION NEEDS A RETRY' : 'READY TO CREATE YOUR ADVENTURE';
    card.append(top, art, title, city, status); card.addEventListener('click', () => openDetail(adventure)); $('adventure-list').append(card);
  });
}
async function loadAdventures() { adventures = (await api('/api/adventures')).adventures; render(); api('/api/storage').then(data=>{ if (user) $('storage-summary').textContent=`${Math.round(data.used_bytes/1024/1024)} / ${Math.round(data.limit_bytes/1024/1024)} MB of memories`; }).catch(()=>{}); }
function resetLocality() { localityRequest++; locationChoice=null; $('location-choices').hidden=true; $('location-options').replaceChildren(); $('save-adventure').disabled=false; $('save-adventure').innerHTML='Find my neighbourhood <span>↗</span>'; }
function openAdd() { $('neighbourhood-form').reset(); resetLocality(); $('add-error').textContent = ''; $('add-dialog').showModal(); }
async function openDetail(adventure, autoGenerate = false) {
  const version = ++viewVersion; clearTimeout(pollTimer); destroyMap(); selected = adventure; collection = null; category = 'all'; questView='list';
  $('dashboard').hidden = true; $('collection-view').hidden = false;
  $('collection-title').textContent = adventure.neighbourhood; $('collection-location').textContent = adventure.city;
  $('detail-error').textContent = ''; $('remove-adventure').textContent = 'Remove neighbourhood';
  $('dex-content').hidden = true; $('generation-panel').hidden = false; $('generate-button').disabled = true;
  $('generation-title').textContent = 'Opening your field guide…'; $('generation-description').textContent = ''; $('generation-stage').textContent = ''; $('generation-error').textContent = ''; $('setup-message').hidden = true;
  try {
    const data = await api(`/api/adventures/${adventure.id}`);
    if (version !== viewVersion) return;
    selected = data.adventure; collection = data.collection; $('retry-radius').value=String(selected.radius||3); $('retry-small').checked=Boolean(selected.allow_small); renderCollection();
    if (pending(collection.status)) schedulePoll(adventure.id, version);
    else if (collection.status !== 'ready') {
      const setup = await api('/api/generation-config');
      if (version !== viewVersion) return;
      const problems = [];
      if (!setup.serpapiConfigured) problems.push('Add your SerpApi key to .env and restart the app.');
      if (!setup.reachable) problems.push('Start your local Ollama server.');
      else if (!setup.modelInstalled) problems.push(`Install the configured model with: ollama pull ${setup.model}`);
      $('setup-message').textContent = problems.join(' '); $('setup-message').hidden = !problems.length;
      $('generate-button').disabled = problems.length > 0;
      if (autoGenerate && !problems.length) await startGeneration();
    }
  } catch (error) { if (version === viewVersion) { $('generation-error').textContent = error.message; $('generate-button').disabled = false; } }
}
function renderCollection() {
  const ready = collection.status === 'ready', generating = pending(collection.status), queued = collection.status === 'queued';
  $('dex-content').hidden = !ready; $('generation-panel').hidden = ready;
  $('generate-button').disabled = generating; $('remove-adventure').disabled = generating;
  $('generate-button').textContent = collection.status === 'failed' ? 'Try creating again ↗' : generating ? 'Creating your adventure…' : 'Create my adventure ↗';
  $('generation-title').textContent = queued ? 'Good adventures are worth a little wait.' : generating ? 'Finding your next favourite corner.' : 'Your neighbourhood has side quests.';
  $('generation-description').textContent = generating ? 'Searching local places, then letting Gemma write your missions. You can return to your neighbourhoods while this runs.' : 'A little food, a little nature, and a few things you’ve never noticed. Let’s create your field guide.';
  $('generation-stage').textContent = queued ? `Waiting for local Gemma${collection.queue_position ? ` · Queue position ${collection.queue_position}` : ''}. You can return later.` : generating ? collection.stage : '';
  $('retry-settings').hidden=ready||generating;
  $('save-settings').disabled=generating;
  const step=queued?0:generating?(collection.stage.toLowerCase().includes('writing')?2:1):ready?3:-1;
  ['step-wait','step-search','step-write','step-ready'].forEach((id,index)=>{ $(id).classList.toggle('current',index===step); $(id).classList.toggle('done',index<step); });
  $('generation-error').textContent = collection.error || '';
  $('generation-panel').classList.toggle('is-generating', generating);
  if (ready) {
    const collected = collection.cards.filter(card => card.status === 'collected').length;
    $('quest-count').textContent = `${String(collected).padStart(2, '0')} / ${collection.cards.length} COLLECTED`;
    const progress = $('collection-progress'); progress.value = collected; progress.max = collection.cards.length;
    progress.setAttribute('aria-label', `${collected} of ${collection.cards.length} quests collected`); renderQuests();
    const p = collection.provenance;
    $('collection-provenance').textContent = `Places sourced through SerpApi · Titles by ${p.model} on local Ollama · Generated ${new Date(p.generated_at).toLocaleDateString()}${p.cache_reused ? ' · Reusing a recent local collection' : ''}${p.source_cache_reused ? ' · Reused recent place search' : ''}${p.missing_categories?.length ? ` · No nearby ${p.missing_categories.join(' / ')} found` : ''}`;
    $('radius-note').textContent=`Nearby means within ${p.radius_km || 3} km of the confirmed starting point;`;
    $('milestones').replaceChildren(...explorerMilestones(collection.cards).map(item=>{
      const badge=document.createElement('div'); badge.className=`milestone ${item.unlocked?'earned':''}`;
      const icon=document.createElement('span'); icon.textContent=item.icon;
      const name=document.createElement('strong'); name.textContent=item.name;
      const count=document.createElement('small'); count.textContent=item.unlocked?'STAMP EARNED':`${Math.min(item.count,item.total)} / ${item.total} TO DISCOVER`;
      badge.append(icon,name,count); return badge;
    }));
  }
}
function renderQuests() {
  $('quest-grid').hidden=questView==='map'; $('map-panel').hidden=questView!=='map';
  $('list-view').setAttribute('aria-pressed',String(questView==='list')); $('map-view').setAttribute('aria-pressed',String(questView==='map'));
  const visible=collection.cards.filter(card => category === 'all' || card.category === category || (category === 'collected' && card.status === 'collected'));
  if (questView==='map') {
    $('map-note').textContent='Tap a numbered pin to open a quest. Discovery prompts can be explored anywhere nearby. Map tiles load from OpenStreetMap.';
    renderMap($('quest-map'),visible,collection.provenance.center,selected.id,openQuest);
    $('map-quest-list').replaceChildren(...visible.map(card=>{ const button=document.createElement('button'); button.className='map-quest-row'; const label=document.createElement('span'); label.textContent=`${String(card.number).padStart(2,'0')} · ${card.place?.name||card.title}`; const detail=document.createElement('small'); detail.textContent=card.place?`${card.place.distance_km} km · ${card.status==='collected'?'Collected':'Explore ↗'}`:'A discovery anywhere nearby ↗'; button.append(label,detail); button.onclick=()=>openQuest(card); return button; }));
  }
  $('quest-grid').replaceChildren();
  document.querySelectorAll('[data-category]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.category === category)));
  for (const card of visible) {
    const button = document.createElement('button'); button.className = `quest-card quest-${card.category}${card.status === 'collected' ? ' is-collected' : ''}`;
    const top = document.createElement('div'); top.className = 'quest-card-top';
    const number = document.createElement('span'); number.textContent = `NO. ${String(card.number).padStart(3, '0')}`;
    const label = document.createElement('span'); label.textContent = categories[card.category][1]; top.append(number, label);
    const icon = document.createElement('div'); icon.className = 'quest-card-icon'; icon.textContent = categories[card.category][0];
    if (card.memory) { const image = document.createElement('img'); image.src = card.memory.photo_url; image.alt = `Your memory for ${card.title}`; image.loading = 'lazy'; icon.replaceChildren(image); }
    const title = document.createElement('h3'); title.textContent = card.title;
    const place = document.createElement('p'); place.className = 'quest-card-place'; place.textContent = card.place?.name || 'An observation around your neighbourhood';
    const footer = document.createElement('div'); footer.className = 'quest-card-footer';
    const status = document.createElement('span'); status.textContent = card.status === 'collected' ? '✦ Collected' : ['queued','reviewing'].includes(card.review?.status) ? '◌ Reviewing' : '◇ Undiscovered';
    const duration = document.createElement('span'); duration.textContent = `~${card.minutes} min`; footer.append(status, duration);
    button.append(top, icon, title, place, footer); button.onclick = () => openQuest(card); $('quest-grid').append(button);
  }
  if (!$('quest-grid').children.length) { const empty = document.createElement('p'); empty.className = 'quest-empty'; empty.textContent = category==='collected' ? 'Your collected memories will appear here. Pick a quest and capture your first discovery.' : 'No nearby quests in this category. Try another filter to explore your field guide.'; $('quest-grid').append(empty); }
}
function openQuest(card) {
  stopPhotoPolling(); photoSelection++; noteDirty=false; selectedQuest = card; photoFile = null; $('photo-preview').hidden = true; $('verify-photo').hidden = true; $('photo-error').textContent = ''; $('camera-input').value = ''; $('upload-input').value = '';
  $('quest-category').textContent = `NO. ${String(card.number).padStart(3, '0')} / ${categories[card.category][1].toUpperCase()}`;
  $('quest-icon').textContent = categories[card.category][0]; $('quest-title').textContent = card.title;
  $('quest-place').textContent = card.place?.name || `Explore around ${selected.neighbourhood}`;
  $('quest-time').textContent = `~${card.minutes} minutes · estimated quest time`;
  $('quest-mission').textContent = card.mission; $('quest-evidence').textContent = card.evidence;
  $('quest-address').textContent = card.place ? `${card.place.address || 'Address not supplied'} · ${card.place.distance_km} km from neighbourhood centre${card.place.price ? ` · Listed price: ${card.place.price}` : ''}` : 'An observation prompt: what you find will be your own discovery.';
  $('quest-directions').hidden = !card.place; $('quest-source').hidden = !card.place;
  if (card.place) {
    $('quest-directions').href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${card.place.coordinates.latitude},${card.place.coordinates.longitude}`)}`;
    $('quest-source').href = card.place.source_url;
  }
  renderPhotoState(card); $('quest-dialog').showModal();
  const id = selected.id, version = photoVersion;
  api(`/api/adventures/${id}`).then(data => {
    if (version !== photoVersion || !selected || selected.id !== id) return;
    collection = data.collection; selectedQuest = collection.cards.find(item => item.number === card.number);
    renderCollection(); renderPhotoState(selectedQuest);
    if (['queued','reviewing'].includes(selectedQuest.review?.status)) pollPhoto(id, card.number, version);
  }).catch(error => { if (version === photoVersion) $('photo-error').textContent = error.message; });
}
function stopPhotoPolling() { photoVersion++; clearTimeout(photoTimer); }
function renderPhotoState(card) {
  const reviewing = ['queued','reviewing'].includes(card.review?.status), collected = card.status === 'collected';
  $('capture-controls').hidden = collected; $('memory-panel').hidden = !collected;
  $('take-photo').disabled = reviewing; $('choose-photo').disabled = reviewing; $('verify-photo').disabled = reviewing;
  $('review-status').hidden = !card.review;
  $('review-status').className = `review-status ${collected ? 'success' : reviewing ? 'reviewing' : 'retry'}`;
  $('review-status').textContent = collected ? `✦ Card collected! ${card.review.reason}` : card.review?.status==='queued' ? `◌ Your photo is waiting for local Gemma${card.review.queue_position ? ` · Queue position ${card.review.queue_position}` : ''}. You can return later.` : reviewing ? '◌ Gemma is looking at your photo. This may take a minute. You can close this sheet and return later.' : card.review ? `${card.review.verdict === 'not_matched' ? 'Not a match yet.' : card.review.verdict === 'uncertain' ? 'Let’s take a closer look.' : 'Review interrupted.'} ${card.review.reason} Try another photo.` : '';
  if (collected) { $('memory-photo').src = card.memory.photo_url; if (!noteDirty) $('memory-note').value = card.memory.note; $('memory-date').textContent = `Collected ${new Date(card.memory.reviewed_at).toLocaleDateString()} · Reviewed by local Gemma`; }
}
function pollPhoto(id, number, version) {
  clearTimeout(photoTimer);
  photoTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/adventures/${id}`);
      if (version !== photoVersion || !selected || selected.id !== id) return;
      const card = data.collection.cards.find(card => card.number === number);
      const wasCollected = selectedQuest?.status === 'collected';
      collection = data.collection; selectedQuest = card; renderCollection(); renderPhotoState(card);
      if (['queued','reviewing'].includes(card.review?.status)) pollPhoto(id, number, version);
      else if (card.status === 'collected' && !wasCollected) { toast('✦ A little adventure, collected.'); $('quest-dialog').classList.add('just-collected'); }
    } catch (error) { if (version === photoVersion) { $('photo-error').textContent = error.message; if (error.status !== 404) pollPhoto(id, number, version); } }
  }, 2000);
}
async function chooseFile(event) {
  const selection=++photoSelection; photoFile=null; $('verify-photo').hidden=true; $('photo-preview').hidden=true;
  const file = event.target.files[0]; if (!file) return;
  $('photo-error').textContent = '';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) { $('photo-error').textContent = 'Choose a JPEG, PNG or WebP photo under 8 MB.'; return; }
  const version = photoVersion;
  const reader = new FileReader(); reader.onload = () => { if (version !== photoVersion || selection!==photoSelection) return; photoFile=file; $('photo-preview').src = reader.result; $('photo-preview').hidden = false; $('verify-photo').hidden = false; }; reader.onerror=()=>{ if(version===photoVersion&&selection===photoSelection) $('photo-error').textContent='Could not read this photo. Choose another.'; }; reader.readAsDataURL(file);
}
$('camera-input').onchange = chooseFile; $('upload-input').onchange = chooseFile;
$('take-photo').onclick = () => $('camera-input').click(); $('choose-photo').onclick = () => $('upload-input').click();
$('verify-photo').onclick = async () => {
  if (!photoFile || !selectedQuest || !selected) return;
  const id = selected.id, number = selectedQuest.number, version = photoVersion;
  $('verify-photo').disabled = true; $('take-photo').disabled = true; $('choose-photo').disabled = true; $('photo-error').textContent = '';
  try {
    await api(`/api/adventures/${id}/cards/${number}/photo`, { method: 'POST', headers: { 'Content-Type': photoFile.type }, body: photoFile });
    if (version !== photoVersion) return;
    selectedQuest.review = { status: 'queued' }; renderPhotoState(selectedQuest); pollPhoto(id, number, version);
  } catch (error) { if (version === photoVersion) { $('photo-error').textContent = error.message; $('verify-photo').disabled = false; $('take-photo').disabled = false; $('choose-photo').disabled = false; } }
};
$('memory-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  const id=selected.id, number=selectedQuest.number, version=photoVersion, note=$('memory-note').value;
  try { await api(`/api/adventures/${id}/cards/${number}/note`, { method: 'POST', body: JSON.stringify({ note }) }); if (version===photoVersion&&selected?.id===id&&selectedQuest?.number===number) { selectedQuest.memory.note=note.trim(); if($('memory-note').value===note)noteDirty=false; toast('Memory saved.'); } }
  catch (error) { if(version===photoVersion) $('photo-error').textContent = error.message; } finally { button.disabled = false; }
};
$('memory-note').oninput=()=>{noteDirty=true;};
const progress = document.createElement('progress'); progress.id = 'collection-progress'; progress.className = 'collection-progress'; $('category-filters').before(progress);
const collectedFilter = document.createElement('button'); collectedFilter.dataset.category = 'collected'; collectedFilter.textContent = '✦ Collected'; collectedFilter.setAttribute('aria-pressed', 'false'); $('category-filters').append(collectedFilter);
function schedulePoll(id, version) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/adventures/${id}`);
      if (version !== viewVersion) return;
      collection = data.collection; renderCollection();
      if (pending(collection.status)) schedulePoll(id, version);
    } catch (error) { if (version === viewVersion) { $('generation-error').textContent = error.message; if (error.status !== 404) schedulePoll(id, version); } }
  }, 2000);
}
async function startGeneration() {
  const id = selected.id, version = viewVersion; $('generate-button').disabled = true; $('generation-error').textContent = '';
  try {
    const data = await api(`/api/adventures/${id}/generate`, { method: 'POST' });
    if (version !== viewVersion) return;
    collection = data.collection; renderCollection();
    if (pending(collection.status)) schedulePoll(id, version);
  } catch (error) { if (version === viewVersion) { $('generation-error').textContent = error.message; $('generate-button').disabled = false; } }
}
$('generate-button').onclick = startGeneration;
$('back-button').onclick = async () => { viewVersion++; clearTimeout(pollTimer); destroyMap(); selected = null; try { await loadAdventures(); } catch (error) { toast(error.message); } };
$('close-quest').onclick = () => $('quest-dialog').close();
$('quest-dialog').addEventListener('close', () => { stopPhotoPolling(); photoSelection++; photoFile = null; $('photo-preview').removeAttribute('src'); $('quest-dialog').classList.remove('just-collected'); });
// Reopen the sheet with current server state if a review finished in the background.
$('quest-dialog').addEventListener('cancel', stopPhotoPolling);
document.querySelectorAll('[data-category]').forEach(button => button.onclick = () => { category = button.dataset.category; renderQuests(); });
$('signup-tab').onclick = () => setMode('signup'); $('login-tab').onclick = () => setMode('login');
$('show-password').onclick = () => { const showing = $('password').type === 'password'; $('password').type = showing ? 'text' : 'password'; $('show-password').textContent = showing ? 'Hide' : 'Show'; $('show-password').setAttribute('aria-label', showing ? 'Hide password' : 'Show password'); };
$('auth-form').onsubmit = async event => {
  event.preventDefault(); $('auth-error').textContent = ''; $('auth-submit').disabled = true;
  try { user = (await api(`/api/${mode}`, { method: 'POST', body: JSON.stringify({ username: $('username').value, password: $('password').value }) })).user; $('password').value = ''; await loadAdventures(); }
  catch (error) { $('auth-error').textContent = error.message; } finally { $('auth-submit').disabled = false; }
};
$('logout').onclick = async () => { try { await api('/api/logout', { method: 'POST' }); user = null; adventures = []; showAuth(); } catch (error) { toast(error.message); } };
$('add-button').onclick = openAdd; $('empty-add').onclick = openAdd;
$('close-add').onclick = () => $('add-dialog').close();
$('saket-example').onclick = () => { $('neighbourhood').value = 'Saket'; $('city').value = 'Delhi'; resetLocality(); };
$('neighbourhood').oninput=resetLocality; $('city').oninput=resetLocality;
$('neighbourhood-form').onsubmit = async event => {
  event.preventDefault(); $('add-error').textContent = ''; $('save-adventure').disabled = true;
  const version=localityRequest;
  const input={ neighbourhood:$('neighbourhood').value,city:$('city').value,radius:Number($('search-radius').value),allow_small:$('allow-small').checked };
  try {
    if (!locationChoice) {
      const data=await api('/api/localities/resolve',{method:'POST',body:JSON.stringify(input)});
      if(version!==localityRequest||!$('add-dialog').open)return;
      $('location-options').replaceChildren(...data.choices.map((choice,index)=>{
        const label=document.createElement('label'); label.className='location-option';
        const radio=document.createElement('input');radio.type='radio';radio.name='resolved-place';radio.value=choice.id;radio.checked=index===0;
        if(index===0)locationChoice=choice.id;radio.onchange=()=>{locationChoice=choice.id;};
        const content=document.createElement('span'),name=document.createElement('strong'),address=document.createElement('small');name.textContent=choice.name;address.textContent=choice.address||`${choice.center.latitude.toFixed(4)}, ${choice.center.longitude.toFixed(4)} · Check this starting point`;content.append(name,address);label.append(radio,content);return label;
      }));$('location-choices').hidden=false;$('save-adventure').innerHTML='Confirm & build adventure <span>↗</span>';return;
    }
    const data = await api('/api/adventures', { method: 'POST', body: JSON.stringify({...input,location_id:locationChoice}) });
    if(version!==localityRequest||!$('add-dialog').open){toast('Your neighbourhood was saved. Find it on your passport.');return;}
    $('add-dialog').close(); toast('A new neighbourhood, a new chapter.'); await openDetail(data.adventure, true);
  }
  catch (error) { if(version===localityRequest)$('add-error').textContent = error.message; } finally { if(version===localityRequest)$('save-adventure').disabled = false; }
};
$('add-dialog').addEventListener('close',resetLocality);
$('list-view').onclick=()=>{questView='list';renderQuests();}; $('map-view').onclick=()=>{questView='map';renderQuests();};
$('save-settings').onclick=async()=>{
  const id=selected.id, version=viewVersion; $('save-settings').disabled=true;
  try{await api(`/api/adventures/${id}/settings`,{method:'POST',body:JSON.stringify({radius:Number($('retry-radius').value),allow_small:$('retry-small').checked})});if(version===viewVersion)toast('Settings saved. Try creating your adventure again.');}
  catch(error){if(version===viewVersion)$('generation-error').textContent=error.message;}
  finally{if(version===viewVersion)$('save-settings').disabled=false;}
};
$('share-adventure').onclick=()=>{
  postcardVersion++;postcardCanvas=null;$('postcard-preview').hidden=true;$('download-postcard').hidden=true;$('postcard-error').textContent='';$('postcard-username').checked=false;
  const memories=collection.cards.filter(card=>card.memory);
  $('postcard-options').replaceChildren(...memories.map(card=>{const label=document.createElement('label');label.className='postcard-option';const input=document.createElement('input');input.type='checkbox';input.value=card.number;const image=document.createElement('img');image.src=card.memory.photo_url;image.alt='';const name=document.createElement('span');name.textContent=card.place?.name||card.title;label.append(input,image,name);return label;}));
  if(!memories.length){const p=document.createElement('p');p.textContent='You can save a field-guide postcard now. Collected photos will appear here after your first adventure.';$('postcard-options').append(p);}
  $('postcard-dialog').showModal();
};
$('close-postcard').onclick=()=>$('postcard-dialog').close();
$('postcard-dialog').addEventListener('close',()=>{postcardVersion++;postcardCanvas=null;});
$('postcard-options').onchange=()=>{postcardVersion++;postcardCanvas=null;$('download-postcard').hidden=true;$('postcard-preview').hidden=true;};
$('postcard-username').onchange=$('postcard-options').onchange;
$('create-postcard').onclick=async()=>{
  const numbers=[...$('postcard-options').querySelectorAll('input:checked')].map(input=>Number(input.value));
  $('postcard-error').textContent='';if(numbers.length>4){$('postcard-error').textContent='Choose up to four photos for this postcard.';return;}
  const version=++postcardVersion;$('create-postcard').disabled=true;
  try{const canvas=await drawPostcard(selected,collection.cards,collection.cards.filter(card=>numbers.includes(card.number)),$('postcard-username').checked?user.username:'');if(version!==postcardVersion)return;postcardCanvas=canvas;$('postcard-preview').replaceChildren(canvas);$('postcard-preview').hidden=false;$('download-postcard').hidden=false;}
  catch(error){if(version===postcardVersion)$('postcard-error').textContent=error.message;}
  finally{$('create-postcard').disabled=false;}
};
$('download-postcard').onclick=()=>{if(!postcardCanvas)return;postcardCanvas.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='neighbourdex-postcard.png';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);},'image/png');};
$('remove-adventure').onclick = async () => {
  if ($('remove-adventure').textContent !== 'Confirm removal') { $('remove-adventure').textContent = 'Confirm removal'; return; }
  $('remove-adventure').disabled = true;
  try { await api(`/api/adventures/${selected.id}`, { method: 'DELETE' }); viewVersion++; clearTimeout(pollTimer); selected = null; await loadAdventures(); toast('Neighbourhood removed.'); }
  catch (error) { $('detail-error').textContent = error.message; } finally { $('remove-adventure').disabled = false; }
};
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
try { user = (await api('/api/me')).user; await loadAdventures(); } catch (error) { showAuth(); if (user) $('auth-error').textContent = error.message; } finally { $('loading').hidden = true; }
