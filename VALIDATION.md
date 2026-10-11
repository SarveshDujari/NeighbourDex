# Local release validation — 11 October 2026

## Automated checks

Twenty-four tests passed. API checks cover account isolation, confirmed locality choices, resolution reuse, generation queuing, saved search reuse after writing failure, storage quotas, rate limits surviving restart, private photos, collected memories and deletion. Generation checks cover geographical filtering, place-type classification, grounded missions/evidence, explicit compact consent and bounded repair. Photo checks cover normalization, metadata stripping, malformed/oversized input and evidence types independent of display category. Runtime/storage checks cover FIFO execution, interrupted jobs, retention, verified database/photo backups, integrity rejection and recovery from a corrupt database. DOM/graphics fixtures cover photo-selection and note-saving races, stale postcard previews, opt-in postcard contents, map pins and progress-derived milestones. These fixtures do not render browser layout.

Client/server/module syntax checks passed with no missing DOM references or duplicate HTML IDs. Dependencies installed with zero vulnerabilities reported by the install-time audit. This is not a comprehensive security audit.

## Live place discovery and generation

The supplied SerpApi key was used server-side for Saket, Delhi. Google Maps retrieval returned nearby sourced candidates; local `gemma3:4b` produced 12 valid cards: 4 food, 3 landmark, 3 nature and 2 discovery. After shortening the prompt and using a balanced shortlist with a JSON schema, the successful live run took approximately 121 seconds and one model attempt. The cached result is stored in ignored `data/live-saket.json`, and its original source records and date are preserved.

An earlier full-result prompt timed out. Generation now passes compact data for up to ten places rather than every retrieved candidate.

After a user reported an unknown/duplicate/incorrect-category validation error, generation was changed to request quest text under fixed place keys. Code now binds each draft to its trusted place and category. A fresh run with the actual local `gemma3:4b` and previously retrieved Saket records produced 12 valid cards in one attempt, in approximately 89 seconds. This check made no SerpApi requests. It demonstrates this run succeeded, not a measured reliability rate. The local server was restarted with the fix; health, HTML, JavaScript and CSS endpoints returned HTTP 200 with expected content.

The saved Manhattan/New York City and Rohini/Delhi failures both contained the earlier place/category validation error. Both were retried with fresh SerpApi searches and actual local Gemma using the corrected generator. Rohini produced 12 cards in one attempt in 80 seconds; Manhattan produced 12 cards in one attempt in 106 seconds. Their failed collections were restored and the successful results cached. These live checks do not establish reliability for every neighbourhood. Manhattan quests remain within the configured three-kilometre search radius around its resolved centre, rather than covering the entire borough.

A separate uncached test for Connaught Place, Delhi succeeded with fresh SerpApi retrieval and local Gemma: 12 cards (4 food, 3 landmark, 3 nature, 2 discovery), one model attempt, 124 seconds. The diagnostic result is stored in ignored `data/live-connaught-place.json`; it was not imported into the app cache or added to a user's account. The live diagnostic accepts neighbourhood/city arguments to test additional localities with the same shared generator.

The final enhancement requests only playful titles from Gemma. Code defines the missions, required evidence and evidence type from source records. With actual local `gemma3:4b` and previously retrieved Saket records, this version generated 12 cards in one attempt in 30 seconds, with no SerpApi requests. This timing is one observation on this machine, not a guaranteed response time. Existing ready collections were migrated without changing card numbers, matched reviews or memory notes; the live database retained two collected reviews. The automatic startup backup was verified against its checksums and database/photo references.

## Live vision check

The vision diagnostic uses a synthetic red square on a white background, not an outdoor completion. The final `gemma3:4b` review matched the shape/colour task and rejected it for a real-tree task.

An initial single-pass image prompt falsely approved the tree task. Review was changed to first observe the image without receiving the quest, reject missing category evidence, and then compare the independent description with the quest. Unit tests cover that rejection guard. Two diagnostic outcomes do not establish general model accuracy; exact venue verification and ambiguous scenes remain limitations.

## Verification limits

No real outdoor trip or personal-photo evaluation has been performed by the agent. Browser visual verification was unavailable because browser security policy blocked the preview interaction. Responsive styles and client/server JavaScript were checked, and the HTTP/API behavior was tested. The application is a completed local demo, not a public deployment. Optional GPS, account recovery, and offline support are not implemented.
