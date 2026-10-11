import path from 'node:path';
import { restoreSnapshot } from '../storage.mjs';
try { process.loadEnvFile('.env'); } catch {}
const folder = process.argv[2];
if (!folder) throw new Error('Usage: npm run restore -- data/backups/<backup-folder>');
const safety = await restoreSnapshot(path.resolve(process.env.DATA_DIR || 'data'), path.resolve(folder));
console.log(`Backup restored. Previous data preserved at ${safety || 'no previous database'}. Start the app again.`);
