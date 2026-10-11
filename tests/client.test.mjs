import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { explorerMilestones, drawPostcard, renderMap, destroyMap } from '../public/experience.js';

async function client() {
  const {document}=parseHTML(readFileSync('public/index.html','utf8'));const readers=[];
  document.querySelectorAll('dialog').forEach(dialog=>{dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};});
  const context={ document, console, setTimeout:()=>0,clearTimeout:()=>{}, renderMap:()=>{},destroyMap:()=>{},explorerMilestones,drawPostcard:async()=>document.createElement('canvas'),
    FileReader:class{constructor(){readers.push(this);}readAsDataURL(){}},
    fetch:async url=>({ok:true,json:async()=>url==='/api/me'?{user:{username:'explorer'}}:url==='/api/adventures'?{adventures:[]}:url==='/api/storage'?{used_bytes:0,limit_bytes:104857600}:{}})
  };
  vm.createContext(context);
  const source=readFileSync('public/app.js','utf8').replace(/^import[^\n]+\n/,'');
  await vm.runInContext(`(async()=>{${source}\nglobalThis.harness={chooseFile,state:()=>({photoFile}),setState:(value)=>{selected=value.adventure;collection=value.collection;selectedQuest=value.quest;}};})();`,context);
  return {context,document,readers};
}
test('rapid photo selection never previews or uploads an obsolete file', async()=>{
  const {context,document,readers}=await client();const first={type:'image/jpeg',size:20,name:'first'},second={type:'image/jpeg',size:20,name:'second'};
  await context.harness.chooseFile({target:{files:[first]}});await context.harness.chooseFile({target:{files:[second]}});
  readers[0].result='first-preview';readers[0].onload();assert.equal(context.harness.state().photoFile,null);
  readers[1].result='second-preview';readers[1].onload();assert.equal(context.harness.state().photoFile,second);assert.equal(document.getElementById('photo-preview').getAttribute('src'),'second-preview');
  readers[0].onload();assert.equal(context.harness.state().photoFile,second);
  await context.harness.chooseFile({target:{files:[{type:'image/gif',size:20}]}});assert.equal(context.harness.state().photoFile,null);assert.equal(document.getElementById('verify-photo').hidden,true);
});
test('saving a note cannot overwrite another quest after switching sheets',async()=>{
  const {context,document}=await client();const original={number:1,memory:{note:'old'}};
  context.harness.setState({adventure:{id:1},quest:original});document.getElementById('memory-note').value='new note';
  let resolve;context.fetch=()=>new Promise(done=>{resolve=done;});
  const button=document.createElement('button');const saving=document.getElementById('memory-form').onsubmit({preventDefault(){},submitter:button});
  const other={number:2,memory:{note:'keep me'}};context.harness.setState({adventure:{id:2},quest:other});document.getElementById('memory-note').value='other draft';
  resolve({ok:true,json:async()=>({ok:true})});await saving;
  assert.equal(other.memory.note,'keep me');assert.equal(document.getElementById('memory-note').value,'other draft');assert.equal(button.disabled,false);
});
test('milestones use real collection progress and adapt to compact guides',()=>{
  const cards=[{category:'food',status:'collected'},{category:'nature',status:'undiscovered'},{category:'discovery',status:'undiscovered'}];
  const badges=explorerMilestones(cards);assert.equal(badges.find(item=>item.name==='First discovery').unlocked,true);
  assert.equal(badges.find(item=>item.name==='Food explorer').unlocked,true);
  assert.equal(badges.find(item=>item.name==='Neighbourhood complete').unlocked,false);
  assert.ok(!badges.some(item=>item.name==='Landmark explorer'));
});
test('postcards include only explicitly selected photos and opt-in usernames',async()=>{
  const texts=[],images=[],loaded=[];const previousDocument=globalThis.document,previousImage=globalThis.Image;
  const context={fillRect(){},strokeRect(){},fillText(text){texts.push(text);},measureText(text){return{width:text.length*15};},beginPath(){},roundRect(){},fill(){},save(){},clip(){},restore(){},drawImage(...args){images.push(args);}};
  globalThis.document={createElement(){return{getContext(){return context;}};}};
  globalThis.Image=class{width=300;height=600;set src(value){loaded.push(value);queueMicrotask(()=>this.onload());}};
  try{
    const chosen={status:'collected',title:'My memory',memory:{photo_url:'/api/photos/1'}};
    await drawPostcard({neighbourhood:'Test area',city:'City'},[chosen,{status:'collected',memory:{photo_url:'/api/photos/2'}}],[chosen]);
    assert.deepEqual(loaded,['/api/photos/1']);assert.equal(images.length,1);assert.ok(!texts.some(text=>text.includes('@')));
    await drawPostcard({neighbourhood:'Test area',city:'City'},[chosen],[],'explorer');assert.ok(texts.some(text=>text.includes('@EXPLORER')));
  }finally{globalThis.document=previousDocument;globalThis.Image=previousImage;}
});
test('changing postcard selections discards an in-flight preview',async()=>{
  const {context,document}=await client();const card={number:1,title:'Memory',status:'collected',memory:{photo_url:'/api/photos/1'}};
  context.harness.setState({adventure:{id:1,neighbourhood:'Area'},collection:{cards:[card]},quest:card});
  document.getElementById('share-adventure').onclick();const input=document.querySelector('#postcard-options input');input.checked=true;
  let finish;context.drawPostcard=()=>new Promise(resolve=>{finish=resolve;});
  const creating=document.getElementById('create-postcard').onclick();input.checked=false;document.getElementById('postcard-options').onchange();
  finish(document.createElement('canvas'));await creating;
  assert.equal(document.getElementById('postcard-preview').hidden,true);assert.equal(document.getElementById('download-postcard').hidden,true);
});
test('map pins use trusted coordinates, skip generic discovery quests and open the selected card',()=>{
  const previousL=globalThis.L,previousFrame=globalThis.requestAnimationFrame,previousDocument=globalThis.document;
  const pins=[],bounds=[];let opened=null;
  const instance={setView(){return this;},invalidateSize(){},fitBounds(value){bounds.push(value);},remove(){}};
  const layer={addTo(){return this;},clearLayers(){pins.length=0;}};
  globalThis.L={map:()=>instance,tileLayer:()=>({on(){return this;},addTo(){}}),layerGroup:()=>layer,divIcon:value=>value,latLngBounds:value=>value,
    marker:(point,options)=>({on(event,handler){this.handler=handler;return this;},addTo(){pins.push({point,options,handler:this.handler});}})};
  globalThis.requestAnimationFrame=handler=>handler();globalThis.document={getElementById:()=>({})};
  try{
    const card={number:7,title:'Landmark',category:'landmark',status:'collected',place:{name:'Place',coordinates:{latitude:28.5,longitude:77.2}}};
    renderMap({replaceChildren(){}},[card,{number:8,category:'discovery'}],{latitude:28.5,longitude:77.2},1,value=>{opened=value;});
    assert.equal(pins.length,1);assert.deepEqual(pins[0].point,[28.5,77.2]);assert.equal(pins[0].options.keyboard,true);assert.match(pins[0].options.icon.className,/pin-collected/);
    pins[0].handler();assert.equal(opened,card);assert.equal(bounds[0].length,1);
  }finally{destroyMap();globalThis.L=previousL;globalThis.requestAnimationFrame=previousFrame;globalThis.document=previousDocument;}
});
