for (const [route, expected] of [['/healthz', '"status":"ok"'], ['/', 'id="postcard-dialog"'], ['/app.js', 'photoSelection'], ['/style.css', '.milestone.earned'], ['/experience.js','export async function drawPostcard'], ['/vendor/leaflet.js','1.9.4'], ['/vendor/leaflet.css','.leaflet-container']]) {
  const response = await fetch(`http://localhost:3000${route}`);
  const content = await response.text();
  if (!response.ok || !content.includes(expected)) throw new Error(`Demo response check failed for ${route}`);
  console.log(`${route}: ${response.status}, expected release content present`);
}
