# NeighbourDex 🌿

### Your neighbourhood has side quests.

A Pokédex-inspired web app that turns nearby food spots, landmarks, greenery, and everyday details into a collectible adventure. 

**Pick a neighbourhood. Find a small mission. Go outside. Bring back a memory.**

Built for the [Hacktoberfest Open-Source AI Challenge — Week 1: Touch Grass](https://dev.to/challenges/hacktoberfest-week1-2026-10-05), using **Gemma 3 through local Ollama inference** and **SerpApi Google Maps search**.

<img width="1535" height="700" alt="Screenshot 2026-10-11 234758" src="https://github.com/user-attachments/assets/4cc979ca-7e3a-401f-8c3a-609b85584253" />
[demo video](https://www.youtube.com/watch?v=9pbhOmn5MLU)

## Why NeighbourDex?

“Go outside” sounds simple—until you ask yourself what to do there.

Meanwhile, staying home always has a plan: another video, another feed, another hour of scrolling.

NeighbourDex gives you a small starting point. A nearby place to try, something interesting to photograph, or a detail you might normally walk past.

You don’t need to plan an entire trip. Start with one card.

## What you can do

- **Build multiple neighbourhood collections** under your own account.
- **Confirm your starting point** and choose a three- or five-kilometre search radius.
- **Explore food, landmarks, and nature**, alongside two discovery prompts.
- **Switch between cards and a map**, with numbered pins, source links, and directions.
- **Take or upload photographs** for local Gemma review.
- **Unlock cards with your own photos** and add personal memory notes.
- **Earn explorer stamps** as your collection grows.
- **Create a downloadable postcard** using up to four collected photographs.
- **Return later** with your collections, notes, and progress saved.

Standard guides contain **10–12 cards**. Areas with fewer suitable results can use an explicitly selected compact guide containing **6–12 cards**, with missing categories shown.

The current release is a **local demo** with a responsive, mobile-first interface.

<img width="1535" height="705" alt="Screenshot 2026-10-11 233418" src="https://github.com/user-attachments/assets/60850aab-9024-4b2a-b50e-f7b994e59d00" />
<img width="757" height="680" alt="Screenshot 2026-10-11 233951" src="https://github.com/user-attachments/assets/45878d0c-0147-428e-9265-ac41b20ee7f9" />

## How an adventure works

1. Create an account and add a neighbourhood, such as **Saket, Delhi**.
2. Confirm the suggested starting point and choose your search radius.
3. Wait while the app finds nearby places and prepares your field guide.
4. Open a card and read its mission and photo requirements.
5. Head outside and capture what the quest asks for.
6. Submit the photograph for Gemma review.
7. Collect the card, add a memory, and choose your next adventure.

A collected card replaces its placeholder artwork with your photograph. Over time, the guide becomes a collection of experiences you made yourself.

<img width="1535" height="702" alt="Screenshot 2026-10-11 233357" src="https://github.com/user-attachments/assets/2f3f5cd6-f357-40ed-8d3f-777d86818188" />
<img width="1535" height="700" alt="Screenshot 2026-10-11 234151" src="https://github.com/user-attachments/assets/92e489c5-f2e8-422b-b90b-ff8e3f3089be" />

## Quick start

### Requirements

- **Node.js 24 or later**
- **Ollama**
- A **SerpApi API key**
- Enough memory to run the configured vision-capable Gemma model

### 1. Clone and install

```bash
git clone https://github.com/SarveshDujari/NeighbourDex.git
cd NeighbourDex
npm install
```

### 2. Download Gemma

```bash
ollama pull gemma3:4b
```

Keep Ollama running. If its application or service is not already running:

```bash
ollama serve
```

### 3. Configure the app

Copy `.env.example` to `.env` and add your SerpApi key:

```dotenv
SERPAPI_API_KEY=your_serpapi_key
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma3:4b

HOST=127.0.0.1
PORT=3000

USER_PHOTO_LIMIT_MB=100
TOTAL_PHOTO_LIMIT_MB=1024
```

Keep `.env` private. API keys belong on the server.

### 4. Start exploring

```bash
npm run dev
```

Open **http://localhost:3000**.

The app creates its SQLite database and local storage inside `data/`, which is excluded from Git.

## Architecture

The stack is intentionally small:

| Component | Responsibility |
|---|---|
| HTML, CSS, JavaScript | Responsive interface, cards, capture flow, and postcards |
| Node.js | Authentication, API routes, validation, and job processing |
| SQLite | Accounts, sessions, collections, reviews, caches, and persistent jobs |
| SerpApi | Neighbourhood lookup and nearby Google Maps place results |
| Gemma 3 via Ollama | Playful quest titles and image-evidence review |
| Leaflet + OpenStreetMap | Interactive map and numbered place markers |
| Sharp | Image decoding, resizing, and metadata removal |

### Adventure generation

```text
Neighbourhood + city
        ↓
SerpApi resolves possible starting points
        ↓
User confirms a location
        ↓
Search food, landmarks, and nature
        ↓
Filter duplicates, unsuitable entries, and distant places
        ↓
Gemma writes titles for fixed entries
        ↓
Code attaches missions and photo requirements
        ↓
Save the collection in SQLite
```

**Search supplies place information. Gemma supplies titles. Application code controls the quest structure.**

Gemma is not asked to invent venue facts or directions. Place names, coordinates, and source links come from retrieved results. The server validates the collection before saving it.

The radius describes proximity to the confirmed starting point, rather than an exact administrative neighbourhood boundary.

### Photo review

```text
Camera or gallery upload
        ↓
Validate, resize, and normalize the image
        ↓
Gemma describes the photo without seeing the quest
        ↓
Compare those observations with the required evidence
        ↓
Matched / Uncertain / Not matched
        ↓
Update collection progress only after a valid match
```

The first observation step keeps the quest’s expected answer out of the initial image description. This reduces conflicting instructions, although model mistakes remain possible.

## Why local Gemma?

NeighbourDex defaults to **`gemma3:4b`**, a vision-capable open-weight model running through Ollama.

Local inference lets the project:

- Review photographs without sending them to a hosted AI provider.
- Experiment with prompts without a per-request model API charge.
- Keep model configuration under the operator’s control.
- Switch to another compatible model as hardware and requirements change.

Larger Gemma variants can be configured if your hardware supports them.

The entire app is **not offline**: new place searches require SerpApi, and map tiles require internet access. Gemma inference runs locally with the default configuration.

## Reliable generation and retries

Generation and photo reviews share a persistent queue. One job runs at a time, and the interface displays queue positions and actual processing stages.

Interrupted jobs resume after a server restart. An unfinished model call may need to run again.

Retrieved places are cached for **24 hours**, independently of title generation. A failed writing step can therefore retry using the same sources without repeating paid searches.

Successful adventure blueprints can also be reused for matching settings. Each account still has its own progress, photographs, and notes.

An uncached generation normally uses one locality lookup, three category searches, and one title-generation call. Actual inference time depends on the machine.

## Photo reviews: what they mean

| Result | Behaviour |
|---|---|
| **Matched** | Unlock the card and use your photograph as its artwork |
| **Uncertain** | Keep the card undiscovered and suggest trying clearer evidence |
| **Not matched** | Keep the card undiscovered and explain the mismatch |
| **Error** | Leave progress unchanged and allow another attempt |

Gemma evaluates **visible evidence**. A generic dish photograph cannot establish which restaurant served it, and a photograph cannot prove a visit’s time or location.

Food and greenery quests check visible subjects. Named-place quests require recognizable identifying features.

NeighbourDex is a playful exploration app. It does not provide anti-cheat or verified-location guarantees.

## Privacy and storage

- Passwords use asynchronous, salted **scrypt** hashing.
- Sessions use **HttpOnly, SameSite=Lax** cookies.
- Collections, reviews, photographs, and notes are scoped to the owning account.
- Photographs are stored outside the public directory.
- Images are resized to a maximum of **1280 pixels** and re-encoded with embedded metadata removed.
- The app does not request or store device GPS.
- Photos are sent to the configured Ollama instance, not SerpApi.
- Postcards are rendered in the browser and downloaded only when requested.

Uploads support non-animated **JPEG, PNG, and WebP** images under **8 MB**.

Default active-photo limits are **100 MB per account** and **1024 MB overall**. Failed or unmatched review photographs older than seven days are cleaned up; collected photographs remain until the neighbourhood is removed.

Backups occupy additional disk space and retain their own copies.

OpenStreetMap receives the map area requested by the browser and connection information when tiles load.

## Backups and restore

Startup creates at most one automatic snapshot per UTC day when a database already exists. The latest three automatic snapshots are retained.

This is startup protection, rather than a scheduled backup for a continuously running server.

For manual backup or restore, stop the app first:

```bash
npm run backup
```

To restore a snapshot:

```bash
npm run restore -- data/backups/<backup-folder>
npm run dev
```

Restore checks file hashes, database integrity, and referenced photographs before replacing current data. It also preserves a safety copy of the previous state.

Backups contain private account records and photographs. Keep them out of public repositories.

## Tests

```bash
npm test
npm run check
```

The automated suite covers:

- Authentication and account isolation.
- Locality confirmation and collection validation.
- Cached searches and compact guides.
- Persistent queues and restart recovery.
- Image processing, private photo access, and storage limits.
- Memory notes and rapid photo-selection handling.
- Map-pin wiring and postcard selection.
- Backup restoration and corrupted-file rejection.

These tests use fixtures and do not consume SerpApi credits. Client tests check behaviour without establishing rendered visual layout accuracy.

Optional real-model checks:

```bash
# Local generation with synthetic place records; no SerpApi requests
node scripts/check-local-gemma.mjs

# Local vision check using a synthetic diagnostic image
node scripts/check-live-vision.mjs

# Real place searches and local Gemma; consumes SerpApi requests
node scripts/check-live-adventure.mjs "Connaught Place" "Delhi"
```

## Project structure

```text
NeighbourDex/
├── public/
│   ├── index.html       # Interface
│   ├── style.css        # Visual design and responsive layout
│   ├── app.js           # Accounts, adventures, photos, and notes
│   └── experience.js    # Maps, stamps, and postcards
├── adventure.mjs        # Place retrieval and quest generation
├── photos.mjs           # Image processing and Gemma review
├── runtime.mjs          # Persistent queue and rate limits
├── storage.mjs          # Quotas, retention, backups, and restore
├── server.mjs           # HTTP server and API routes
├── scripts/             # Diagnostics and maintenance tools
├── tests/               # Automated tests
└── .env.example         # Configuration template
```

## Current limitations

- Generation and review speed depend on local hardware.
- Search-provider categories and AI reviews can be inaccurate.
- Sparse areas may require a compact guide.
- Opening hours, access, and estimated durations should be checked before visiting.
- Account/password recovery is not implemented.
- Public deployment and device GPS are not included in this release.

For public hosting, the app needs HTTPS, persistent storage, appropriate production configuration, and a secured inference endpoint reachable by the deployed server. A hosted server cannot reach laptop Ollama through its own `localhost`.

The layout supports mobile screens, but opening it on a phone requires an accessible server address. Camera capture may require HTTPS, depending on the browser.

## Built with

Thanks to the projects and services behind NeighbourDex:

- [Gemma](https://ai.google.dev/gemma)
- [Ollama](https://ollama.com/)
- [SerpApi](https://serpapi.com/google-maps-api)
- [Node.js](https://nodejs.org/)
- [SQLite](https://www.sqlite.org/)
- [Leaflet](https://leafletjs.com/)
- [OpenStreetMap](https://www.openstreetmap.org/)
- [Sharp](https://sharp.pixelplumbing.com/)

## License

Released under the **MIT License**. See [LICENSE](LICENSE).

---

**One neighbourhood. A handful of side quests. A reason to step outside.**
