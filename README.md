# NeighbourDex

Turn your neighbourhood into a collectible adventure. Mobile-first web app.

## Build phases

1. **Foundation (implemented):** username/password registration and login, server sessions, persistent per-user neighbourhoods, empty dashboard, add-neighbourhood bottom sheet, neighbourhood detail and removal.
2. **Adventure generation (implemented):** confirm a neighbourhood centre with SerpApi Google Maps search, retrieve nearby places, use local Gemma for playful titles, and attach missions/photo evidence defined by code. Standard guides contain 10–12 cards; compact guides contain 6–12 with explicit consent. Category filters, map pins, source links and directions are included.
3. **Photo verification (implemented):** camera/gallery uploads, private normalized JPEG storage, vision-capable Gemma review, uncertain/mismatch retry handling, collected cards with photos, progress and memory notes. The completed demo runs locally, as requested; public deployment and optional GPS are not part of this local release.

## Run

Requires Node.js 24 or later, Ollama with a vision-capable Gemma model, and a SerpApi key. Sharp validates and normalizes photo uploads.

```sh
npm install
npm run dev
```

Open http://localhost:3000. SQLite data is created in `data/` (ignored by Git).

```sh
npm test
```

## Phase 1 architecture

`public/` holds the responsive interface. `server.mjs` serves it and handles same-origin JSON endpoints. SQLite stores accounts, hashed sessions, adventures, reviews, search results, public blueprints, persistent jobs and rate limits. Passwords use asynchronous salted scrypt; raw passwords are never stored. Session cookies are HttpOnly with SameSite=Lax, expire after seven days, and become Secure with NODE_ENV=production. User queries are scoped by session identity. `runtime.mjs` handles the persistent queue/rate limits and `storage.mjs` handles quotas, retention and backups.

## Phase 2 setup: SerpApi + local Ollama

An ignored `.env` file is provided with an empty SerpApi key. Add your key to `SERPAPI_API_KEY` in that file, then restart the server. Never put it in frontend code or commit it. `.env.example` documents the configuration.

```dotenv
SERPAPI_API_KEY=your_private_key
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma3:4b
```

Ollama must be running. This machine already has `gemma3:4b` installed; for another machine:

```sh
ollama pull gemma3:4b
# Only if the Ollama application/service is not already running:
ollama serve
```

Use `gemma3:12b` or `gemma3:27b` only if your hardware supports it, and change OLLAMA_MODEL accordingly. The 4B model supports both text and images, preparing for Phase 3. [Ollama Gemma models](https://ollama.com/library/gemma3)

Log in, enter a neighbourhood and city/country, click Find my neighbourhood, and confirm the returned starting point. Choose a 3 km or 5 km radius and optionally allow a compact guide. Generation starts after confirmation. Missing configuration and provider errors have explicit states; failed guides have neighbourhood settings and a retry button.

### Pipeline and cost bounds

1. One SerpApi Google Maps lookup returns up to five unique candidates with valid coordinates. The user confirms the starting point; suggestions are cached for 24 hours. A viewport alone is not a confirmed match. Older/direct API adventures without a selected location still use the stricter matching-record lookup.
2. Three searches fetch food, landmarks and nature. Place types override search-query categories where recognized; known unrelated businesses are excluded. Missing coordinates, duplicates and places beyond the chosen radius are removed. This is a proximity filter, not an administrative boundary. Search-provider types can still be inaccurate.
3. A balanced shortlist of up to ten places (aiming for four food, three landmark, three nature) is passed to Gemma. The model returns only short titles under fixed schema keys. Code supplies place identity, missions, evidence types and estimated durations; it never trusts model-written directions or venue facts. Two discovery quests ask for surface texture and sky. Standard guides require eight sourced places and all three categories. Compact guides require four sourced places and display missing categories without inventing replacements. Place metadata is copied from search data, and directions use stored coordinates.
4. Output is validated for count, categories, IDs, duplicate places, required text and durations. One model repair is allowed; it reuses the same retrieved records. A successful collection is persisted with source records, search timestamp, model name and generation provenance. Reading or reopening it does not trigger paid searches.

Normally one lookup plus three category searches and one Ollama call are used. Each search has a 45-second timeout; each model call has a four-minute timeout. Retrieved sources are saved for 24 hours independently of title generation, including sparse results, so writing failures and compact-setting retries reuse those records. Changing the radius/starting point or using expired sources requires a new search. Five generation attempts per user per hour and fifteen locality lookups per hour are stored in SQLite and survive restarts.

Generation and photo reviews share a persistent FIFO queue, capped at twenty waiting/running jobs. Only one inference job runs at a time. The UI shows queue position and real stages rather than an invented percentage. Interrupted jobs resume on restart; this may repeat an unfinished model call. Successful collection/progress/photo records are preserved during the upgrade.

Successful blueprints are reused for the same neighbourhood/city, radius, compact preference and confirmed centre for 24 hours. Source dates are retained and reuse is labelled. Each account has separate progress, photos and notes; these are never copied. The optional Saket diagnostic can warm the legacy/direct-API Saket blueprint on restart. Newly confirmed starting points generate/reuse their own matching blueprint.

Quests are generated suggestions, not independently verified factual descriptions. Estimates are labelled and users should confirm access/opening hours. Discovery prompts describe observations to attempt, not known objects guaranteed to exist.

## Collecting a card

Open a quest, read what to capture, and use Take a photo or Choose photo. Uploads must be non-animated JPEG, PNG or WebP under 8 MB. Click Check with Gemma. Local inference runs in the background; reopening the quest retrieves its current result.

- **Matched:** the card unlocks, its picture replaces the category artwork, and collection progress increases. Add a personal memory note (up to 280 characters).
- **Uncertain:** the card remains undiscovered. Try a clearer photo or show a distinctive feature/sign.
- **Not matched:** the card remains undiscovered and the explanation helps you retry.
- **Model unavailable/interrupted:** the app reports the problem and allows another attempt. No card is unlocked on an error or invalid model output.

Gemma judges visible evidence, not proof of location, visit time, or actions a picture cannot show. A generic dish photo cannot reliably establish its restaurant. Named places require recognizable features; uncertain results are deliberately not approved. This is a playful collection app, not anti-cheat verification.

Review uses two steps: Gemma first describes the photo without seeing the quest, then compares observations with its explicit evidence type. Food checks visible food/drinks, greenery checks plants, and exterior/sign quests require identification of the named place. A restaurant exterior quest is not incorrectly rejected for lacking a dish. Food and greenery checks do not claim exact venue identity. This reduces conflicting instructions but does not eliminate model mistakes.

### Photo privacy

Images are decoded, rotated, resized to a maximum of 1280 pixels, and re-encoded as JPEG with embedded metadata removed. Files live in `data/photos/`, outside the public directory, and can only be fetched by the owning account. The image is sent to the configured local Ollama instance, not SerpApi. Credentials remain server-side. Model text and image contents are untrusted evidence; returned JSON is validated before changing collection state.

Removing a neighbourhood deletes its reviews and photo files. Queued/running work blocks removal until complete. Thirty photo reviews per user per hour persist across restart. Interrupted reviews resume using their stored normalized photo. The app does not request or store GPS.

Photo quotas default to 100 MB per account and 1024 MB across active photo records. Configure `USER_PHOTO_LIMIT_MB` and `TOTAL_PHOTO_LIMIT_MB` (minimum 8 MB each). The passport shows personal usage. Failed/unmatched review photos older than seven days are removed at startup and during six-hour maintenance; collected memories remain until the neighbourhood is removed. Backups use additional disk space and are not included in the active-photo quota.

## Map, milestones and postcards

Switch Cards/Map to see numbered pins at stored place coordinates. Clicking a pin opens its quest. Discovery prompts have no invented map location. Leaflet is served locally; OpenStreetMap tiles load only when opening map view, with attribution. The tile service receives the requested map area and browser connection information. Quests/directions remain usable if tiles cannot load. No bulk tile downloading or offline tile prefetching is performed. [Leaflet documentation](https://leafletjs.com/reference.html), [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/).

Explorer stamps derive from collected cards: first discovery, food, greenery, landmarks and neighbourhood completion. Targets adapt to smaller guides. Make a postcard lets the user choose up to four collected photos, optionally include their username, preview the image and save a PNG. No photos are selected by default, no personal notes are included, and nothing is published or sent to anyone. Rendering happens in the browser.

## Backups and recovery

Before serving requests, startup creates at most one automatic snapshot per UTC day when a database already exists. The latest three automatic snapshots are retained; manual backups are retained until you remove them. Each snapshot contains a SQLite online backup, its referenced photos and SHA-256 checksums, under ignored `data/backups/`. Keep backups private: they contain account/session records and photographs. This is startup protection, not a scheduled daily backup of an app left continuously running. [Node SQLite backup API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).

Stop the app before manual backup or restore, so files and database stay consistent:

```sh
npm run backup
npm run restore -- data/backups/<backup-folder>
npm run dev
```

Restore checks file hashes, SQLite integrity, foreign keys and referenced photos before modifying current data, and preserves a safety copy of the previous state. If the current database is corrupt, its raw files/photos are preserved for manual inspection. An active server lock prevents restore while the app is running. Account/password recovery is a separate future feature.

## Quick local demo

1. Keep Ollama running; `gemma3:4b` is configured by default.
2. Start the app and create an explorer account.
3. Add Saket, Delhi and wait for the local quests.
4. Open a food/nature/landmark/discovery card and follow its mission outside.
5. Capture the expected evidence, submit it, and watch the card reveal your memory.
6. Add a note, close/reopen the app, and confirm your collection persists.

Use actual outdoor photos for your hackathon story. Technical diagnostic images do not demonstrate a real outing.

### Validation

`npm test` covers authentication/isolation, persistent limits, confirmed locality choices, storage quotas, FIFO jobs and restart recovery, cached search reuse after writing failures, compact guides, grounded evidence, image normalization, private photo access, notes, rapid photo selection, map-pin wiring, opt-in postcard contents, backup restoration and corrupted-file rejection. DOM/graphics tests use lightweight fixtures rather than a rendered browser and do not establish visual layout accuracy. They consume no search credits.

Optional real Ollama smoke test (uses clearly synthetic place records, never calls SerpApi):

```sh
node scripts/check-local-gemma.mjs
```

Real SerpApi + Gemma diagnostic (four search requests; saves `data/live-saket.json` without credentials):

```sh
node scripts/check-live-adventure.mjs
# Or test another locality:
node scripts/check-live-adventure.mjs "Connaught Place" "Delhi"
```

Real vision diagnostic (uses a synthetic red-square illustration to check positive and negative outcomes, not an outdoor completion):

```sh
node scripts/check-live-vision.mjs
```

Provider references: [SerpApi Google Maps](https://serpapi.com/google-maps-api), [Ollama chat and JSON output](https://docs.ollama.com/api/chat).

## Before public deployment

Use HTTPS, set NODE_ENV=production and APP_ORIGIN to the canonical HTTPS origin behind a reverse proxy, set HOST=0.0.0.0, and use durable storage for the database, photos and backups. A remote deployment cannot reach laptop Ollama through its own localhost: configure a secured reachable inference endpoint. The app is designed for one server process; horizontal scaling needs coordinated workers and shared storage. Auth limits use the direct connection IP; configure trusted proxy behavior before exposing it behind a proxy. Configure external/off-machine backup retention and account recovery before production. Never expose Ollama publicly without authentication, and never put model/search API keys in browser code.

For the local demo, use http://localhost:3000 on this laptop. `localhost` on a phone refers to the phone itself; mobile remote access and camera behavior need an appropriately secured deployment or local network setup.

## Hackathon write-up checklist

Show the full add-neighbourhood → sourced quests → outside photo → collected-card flow. Explain why SerpApi grounds the place data and why Gemma can run locally, keep photos under your control, and be replaced without a closed-model API. Include the actual model name, source provenance, tests, a short demo video, and your outdoor experience. Claim only categories for technologies actually used: SerpApi and Gemma are integrated here; no Render deployment has been performed. Credit Ollama, Gemma, SerpApi and Sharp. Publish the source without `.env`, `data/`, passwords or personal photos.
