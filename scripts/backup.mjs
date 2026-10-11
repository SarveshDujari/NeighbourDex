import path from 'node:path';
import { createSnapshot, serverRunning, verifySnapshot } from '../storage.mjs';
try { process.loadEnvFile('.env'); } catch {}
const directory = path.resolve(process.env.DATA_DIR || 'data');
if (serverRunning(directory)) throw new Error('Stop the app first so photos and database are backed up together.');
const folder = await createSnapshot(directory); verifySnapshot(folder); console.log(`Verified backup saved to ${folder}`);
