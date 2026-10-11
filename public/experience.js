let map = null, pins = null, mapArea = null;
export function destroyMap() { if (map) map.remove(); map = pins = mapArea = null; }
export function renderMap(container, cards, center, area, onOpen) {
  if (!globalThis.L) { container.textContent = 'Map unavailable. Your quests and directions still work in list view.'; return; }
  if (mapArea !== area) { destroyMap(); mapArea = area; }
  if (!map) {
    container.replaceChildren();
    map = L.map(container, { scrollWheelZoom: false }).setView([center.latitude, center.longitude], 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>' }).on('tileerror', () => { document.getElementById('map-note').textContent = 'Map tiles could not load. Quest pins still show their relative positions; directions work in list view.'; }).addTo(map);
    pins = L.layerGroup().addTo(map);
  }
  pins.clearLayers();
  const points = [];
  cards.filter(card => card.place).forEach(card => {
    const point = [card.place.coordinates.latitude, card.place.coordinates.longitude]; points.push(point);
    const icon = L.divIcon({ className: 'quest-map-pin ' + (card.status === 'collected' ? 'pin-collected' : `pin-${card.category}`), html: `<span>${card.number}</span>`, iconSize: [34,34], iconAnchor: [17,17] });
    L.marker(point, { icon, title: `${card.title} — ${card.place.name}`, keyboard: true }).on('click', () => onOpen(card)).addTo(pins);
  });
  requestAnimationFrame(() => { if (!map) return; map.invalidateSize(); if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [40,40], maxZoom: 16 }); });
}
export function explorerMilestones(cards) {
  const collected = cards.filter(card => card.status === 'collected');
  const defs = [
    { icon: '✦', name: 'First discovery', count: collected.length, total: 1 },
    ...[['food','Food explorer','🍜',3],['nature','Green wanderer','🌿',2],['landmark','Landmark explorer','🏛️',2]].map(([category,name,icon,target]) => ({ icon, name, count: collected.filter(card=>card.category===category).length, total: Math.min(target, cards.filter(card=>card.category===category).length) })),
    { icon: '⌖', name: 'Neighbourhood complete', count: collected.length, total: cards.length }
  ];
  return defs.filter(item=>item.total>0).map(item=>({ ...item, unlocked: item.count>=item.total }));
}
function wrapText(ctx, text, x, y, width, lineHeight, maxLines = 2) {
  let line = '', lines = [];
  for (const word of text.split(/\s+/)) {
    if (ctx.measureText(line + word).width > width && line) { lines.push(line.trim()); line = ''; }
    line += word + ' ';
  }
  if (line) lines.push(line.trim());
  lines.slice(0,maxLines).forEach((line,index)=>ctx.fillText(line.slice(0,100),x,y+index*lineHeight));
}
export async function drawPostcard(adventure, cards, photos, username = '') {
  const canvas = document.createElement('canvas'); canvas.width=1080; canvas.height=1350;
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#f6f5ec'; ctx.fillRect(0,0,1080,1350);
  ctx.strokeStyle='#d4dcc9'; ctx.lineWidth=2; ctx.strokeRect(35,35,1010,1280);
  ctx.fillStyle='#153a2f'; ctx.font='bold 27px Arial'; ctx.fillText('✳ neighbourdex',75,100);
  ctx.font='17px monospace'; ctx.fillText('A LITTLE ADVENTURE, COLLECTED.',75,145);
  ctx.font='64px Georgia'; wrapText(ctx,adventure.neighbourhood,75,235,920,72);
  ctx.font='24px Arial'; ctx.fillStyle='#68766b'; wrapText(ctx,adventure.city,75,350,920,30,1);
  const count=cards.filter(card=>card.status==='collected').length;
  const chosen=photos.slice(0,4);
  if (chosen.length) {
    const images = await Promise.all(chosen.map(card => new Promise((resolve,reject)=>{
      const img=new Image(); img.onload=()=>resolve({img,card}); img.onerror=()=>reject(new Error('A selected photo could not load. Choose another memory.')); img.src=card.memory.photo_url;
    })));
    images.forEach(({img,card},index)=>{
      const columns=chosen.length===1 ? 1 : 2, width=columns===1 ? 930 : 450;
      const x=75+(index%columns)*480, y=400+Math.floor(index/columns)*350, height=chosen.length===1 ? 635 : 280;
      const scale=Math.max(width/img.width,height/img.height), sw=width/scale, sh=height/scale;
      ctx.save(); ctx.beginPath(); ctx.roundRect(x,y,width,height,14); ctx.clip();
      ctx.drawImage(img,(img.width-sw)/2,(img.height-sh)/2,sw,sh,x,y,width,height); ctx.restore();
      ctx.fillStyle='#153a2f'; ctx.font='21px Georgia'; wrapText(ctx,card.place?.name||card.title,x,y+height+30,width,25,2);
    });
  } else {
    ctx.fillStyle='#e8eddb'; ctx.beginPath(); ctx.roundRect(75,400,930,655,16); ctx.fill();
    ctx.fillStyle='#789443'; ctx.font='190px Georgia'; ctx.textAlign='center'; ctx.fillText('✳',540,720);
    ctx.fillStyle='#153a2f'; ctx.font='46px Georgia'; ctx.fillText('Small streets. Big adventures.',540,830); ctx.textAlign='left';
  }
  ctx.fillStyle='#153a2f'; ctx.font='38px Georgia'; ctx.fillText(`${count} / ${cards.length} memories collected`,75,1170);
  ctx.font='19px monospace'; ctx.fillStyle='#68766b'; ctx.fillText(username ? `EXPLORER @${username.toUpperCase()}` : 'STAY LOCAL. GET CURIOUS.',75,1230);
  ctx.font='16px Arial'; ctx.fillText('Made with NeighbourDex · Places sourced with SerpApi · Local Gemma',75,1270);
  return canvas;
}
