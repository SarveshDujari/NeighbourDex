import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const html = readFileSync('public/index.html', 'utf8'), app = readFileSync('public/app.js', 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
const dynamic = ['collection-progress'];
const references = [...app.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
const missing = [...new Set(references.filter(id => !ids.includes(id) && !dynamic.includes(id)))];
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
console.log(JSON.stringify({ missingElementReferences: missing, duplicateElementIds: duplicates }));
let failed = missing.length || duplicates.length;
for (const file of ['server.mjs', 'adventure.mjs', 'photos.mjs', 'runtime.mjs', 'storage.mjs', 'public/app.js', 'public/experience.js', 'scripts/backup.mjs', 'scripts/restore.mjs']) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
