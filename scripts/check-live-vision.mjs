import sharp from 'sharp';
import { config } from '../adventure.mjs';
import { preparePhoto, reviewPhoto } from '../photos.mjs';
process.loadEnvFile('.env');
// Deterministic diagnostic illustration, not a real completed outdoor quest.
const input = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="white"/><rect x="96" y="96" width="320" height="320" fill="red"/></svg>');
const photo = await preparePhoto(await sharp(input).png().toBuffer());
let failed = false;
for (const item of [{ title: 'Colour and shape test', category: 'discovery', mission: 'Photograph a red square on a white background.', evidence: 'One red square clearly visible on a white background.', shouldMatch: true }, { title: 'Tree observation test', category: 'nature', mission: 'Photograph a real tree outdoors.', evidence: 'A real tree with a trunk and leaves outdoors.', shouldMatch: false }]) {
  const result = await reviewPhoto(item, photo, config());
  console.log(JSON.stringify({ test: item.title, verdict: result.verdict, reason: result.reason, model: result.model }));
  if (item.shouldMatch ? result.verdict !== 'matched' : result.verdict === 'matched') failed = true;
}
process.exitCode = failed ? 1 : 0;
