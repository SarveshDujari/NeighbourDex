import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { MAX_UPLOAD, preparePhoto, parseReview, reviewPhoto } from '../photos.mjs';
import { config } from '../adventure.mjs';

test('uploads are decoded, resized, normalized to JPEG and stripped of metadata', async () => {
  const original = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#557755' } }).withMetadata().jpeg().toBuffer();
  const result = await preparePhoto(original), metadata = await sharp(result).metadata();
  assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, 1280); assert.equal(metadata.exif, undefined);
  await assert.rejects(preparePhoto(Buffer.from('<svg><script>bad</script></svg>')), /could not be read/);
  await assert.rejects(preparePhoto(Buffer.alloc(MAX_UPLOAD + 1)), /under 8 MB/);
});
test('ambiguous or malformed model output cannot unlock a card', async () => {
  assert.throws(() => parseReview('{"verdict":"yes","reason":"go"}'));
  assert.throws(() => parseReview('{"verdict":"matched","reason":""}'));
  assert.deepEqual(parseReview('{"verdict":"uncertain","reason":"Sign is unreadable."}'), { verdict: 'uncertain', reason: 'Sign is unreadable.' });
  const result = await reviewPhoto({ title: 'Spot leaves', category: 'discovery', mission: 'Find a leaf.', evidence: 'A visible leaf.' }, Buffer.from('test-image'), config(), async (url, options) => {
    const request = JSON.parse(options.body);
    assert.ok(request.messages[0].content.includes('untrusted'));
    if (request.messages[0].images) {
      assert.equal(request.messages[0].images[0], Buffer.from('test-image').toString('base64'));
      return Response.json({ message: { content: '{"description":"A red square on a white background.","food":false,"nature":false,"built_place":false}' } });
    }
    return Response.json({ message: { content: '{"verdict":"not_matched","reason":"No leaf visible."}' } });
  });
  assert.equal(result.verdict, 'not_matched');
  await assert.rejects(reviewPhoto({}, Buffer.from('test'), config(), async () => Response.json({ message: { content: 'invalid' } })), /unclear photo observations/);
});
test('blinded category observation rejects unrelated evidence before approval', async () => {
  let calls = 0;
  const result = await reviewPhoto({ category: 'nature', evidence: 'A tree.' }, Buffer.from('test'), config(), async (url, options) => {
    calls++; const request = JSON.parse(options.body);
    assert.ok(!request.messages[0].content.includes('Quest data:'));
    return Response.json({ message: { content: '{"description":"Only a red square on white.","food":false,"nature":false,"built_place":false}' } });
  });
  assert.equal(result.verdict, 'not_matched'); assert.equal(calls, 1);
});
test('an exterior quest in the food category checks the exterior rather than requiring a dish',async()=>{
  let calls=0;
  const result=await reviewPhoto({category:'food',evidence_type:'exterior',evidence:'A readable Test Cafe sign.',place:{name:'Test Cafe'}},Buffer.from('fixture'),config(),async(url,options)=>{
    calls++;const input=JSON.parse(options.body);
    return Response.json({message:{content:JSON.stringify(input.messages[0].images?{description:'A cafe exterior with a readable Test Cafe sign.',food:false,nature:false,built_place:true}:{verdict:'matched',reason:'The required sign is visible.'})}});
  });assert.equal(result.verdict,'matched');assert.equal(calls,2);
});
