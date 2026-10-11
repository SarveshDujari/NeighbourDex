import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installRuntime, consumeLimit, createQueue, queuePosition } from '../runtime.mjs';
import { createSnapshot, verifySnapshot, restoreSnapshot, maintainPhotos, photoUsage } from '../storage.mjs';

function setup(db) {
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE adventures(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id));
    CREATE TABLE collections(adventure_id INTEGER PRIMARY KEY,status TEXT,stage TEXT,error TEXT);
    CREATE TABLE reviews(id INTEGER PRIMARY KEY,adventure_id INTEGER REFERENCES adventures(id),card_number INTEGER,filename TEXT,status TEXT,verdict TEXT,reason TEXT,created_at TEXT);
    INSERT INTO users VALUES(1,'explorer'); INSERT INTO adventures(id,user_id) VALUES(1,1);`);
  installRuntime(db);
}
test('rate limits are stored in SQLite and expire at the correct boundary', () => {
  const db=new DatabaseSync(':memory:');setup(db);
  assert.equal(consumeLimit(db,'test',1,2,60000,1000),true);
  assert.equal(consumeLimit(db,'test',1,2,60000,2000),true);
  assert.equal(consumeLimit(db,'test',1,2,60000,60999),false);
  assert.equal(consumeLimit(db,'test',1,2,60000,61000),true);
  assert.equal(consumeLimit(db,'other',1,2,60000,61000),true);db.close();
});
test('jobs execute serially in FIFO order and interrupted jobs resume', async () => {
  const db=new DatabaseSync(':memory:');setup(db);
  db.prepare("INSERT INTO collections VALUES(1,'generating','Writing','interrupted')").run();
  db.prepare("INSERT INTO jobs(kind,target,payload_json,status,created_at) VALUES('generation',1,'{}','running',?)").run(new Date().toISOString());
  let release;const gate=new Promise(resolve=>{release=resolve;}); const order=[];let active=0,maxActive=0;
  const queue=createQueue(db,{generation:async target=>{active++;maxActive=Math.max(maxActive,active);order.push(target);if(target===1)await gate;active--;}});
  assert.equal(db.prepare('SELECT status,error FROM collections').get().status,'queued');
  assert.equal(db.prepare('SELECT error FROM collections').get().error,null);
  queue.enqueue('generation',2,{});queue.start();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(order,[1]);assert.equal(queuePosition(db,'generation',2),2);
  release();await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(order,[1,2]);assert.equal(maxActive,1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM jobs WHERE status='complete'").get().count,2);db.close();
});
test('photo usage and retention preserve collected memories', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'neighbourdex-storage-'));const db=new DatabaseSync(':memory:');setup(db);
  try {
    for(const [id,verdict] of [[1,'matched'],[2,'not_matched']]) {
      const name=String(id).repeat(48)+'.jpg';writeFileSync(path.join(dir,name),'photo');
      db.prepare('INSERT INTO reviews(id,adventure_id,card_number,filename,status,verdict,created_at) VALUES(?,1,1,?,\'complete\',?,?)').run(id,name,verdict,'2020-01-01T00:00:00.000Z');
    }
    maintainPhotos(db,dir);assert.equal(photoUsage(db,1),5);assert.equal(db.prepare('SELECT count(*) AS count FROM reviews').get().count,1);
    assert.equal(readFileSync(path.join(dir,'1'.repeat(48)+'.jpg'),'utf8'),'photo');
  } finally { db.close();assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));rmSync(dir,{recursive:true}); }
});
test('verified backups restore database and photos, preserve previous data and reject corruption', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'neighbourdex-backup-'));mkdirSync(path.join(dir,'photos'));const dbPath=path.join(dir,'neighbourdex.sqlite');
  let db=new DatabaseSync(dbPath);setup(db);const name='a'.repeat(48)+'.jpg';writeFileSync(path.join(dir,'photos',name),'original-photo');
  db.prepare("INSERT INTO reviews(id,adventure_id,card_number,filename,status,verdict,created_at) VALUES(1,1,1,?,'complete','matched',?)").run(name,new Date().toISOString());db.close();
  try {
    const folder=await createSnapshot(dir);assert.equal(verifySnapshot(folder).version,1);
    db=new DatabaseSync(dbPath);db.prepare("UPDATE users SET username='changed'").run();db.close();
    writeFileSync(path.join(dir,'photos',name),'changed-photo');
    const safety=await restoreSnapshot(dir,folder);assert.ok(safety);verifySnapshot(safety);
    db=new DatabaseSync(dbPath);assert.equal(db.prepare('SELECT username FROM users').get().username,'explorer');db.close();
    assert.equal(readFileSync(path.join(dir,'photos',name),'utf8'),'original-photo');
    writeFileSync(dbPath,'corrupt database');
    const rawSafety=await restoreSnapshot(dir,folder);assert.ok(rawSafety.includes('raw-safety-'));
    assert.equal(readFileSync(path.join(rawSafety,'neighbourdex.sqlite'),'utf8'),'corrupt database');
    db=new DatabaseSync(dbPath);assert.equal(db.prepare('SELECT username FROM users').get().username,'explorer');db.close();
    writeFileSync(path.join(folder,'photos',name),'tampered');assert.throws(()=>verifySnapshot(folder),/integrity check failed/);
  } finally { assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));rmSync(dir,{recursive:true}); }
});
