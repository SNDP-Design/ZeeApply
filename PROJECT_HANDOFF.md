# ZeeApply — Project Handoff

A complete dump of everything that exists, how it works, what was tried, and where to pick up. Paste this into a new chat to continue building.

---

## 1. Quick reference — URLs, accounts, secrets

| Thing | Value |
|---|---|
| **GitHub repo** | https://github.com/SNDP-Design/ZeeApply  (public, main branch) |
| **Landing page (live)** | https://sndp-design.github.io/ZeeApply/ |
| **App (live)** | https://sndp-design.github.io/ZeeApply/app/ |
| **Cloudflare Worker (live)** | https://zeeapply-api.xgrowth.workers.dev |
| **Worker health check** | https://zeeapply-api.xgrowth.workers.dev/health |
| **Local project path (Mac)** | `/Users/sandeeprathi/Desktop/Claude Code/ZeeApply` |
| **Owner GitHub account** | `SNDP-Design` (authed via `gh` CLI) |
| **Cloudflare subdomain** | `xgrowth` (inherited from owner's prior XGrowth project) |
| **Firebase project ID** | `zeeapply-037` |
| **Firebase Console** | https://console.firebase.google.com/project/zeeapply-037 |
| **Firestore region** | `asia-south1` (Mumbai) |
| **Gemini API key** | Set as Worker secret `GEMINI_API_KEY` (free tier, AIza... format) |
| **Owner / candidate** | Sandeep Rathi · sndpdesign@gmail.com · based in India · Product Designer |

### Worker secrets (Cloudflare)

Set via `cd worker && npx wrangler secret put <NAME>` from the local repo:

| Secret | Status | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | ✅ Set | Required. Powers /score endpoint. Free tier. |
| `ADZUNA_APP_ID` | ⚠ Not set | Optional. Enables Adzuna India source. Free at developer.adzuna.com. |
| `ADZUNA_APP_KEY` | ⚠ Not set | Optional. Paired with ADZUNA_APP_ID. |

### Firebase config (in `app/index.html`, public — security is at the Firestore-rules layer)

```js
const firebaseConfig = {
  apiKey: "AIzaSyDl2dosiomIp993XJl3Uom0B8LbGXyCias",
  authDomain: "zeeapply-037.firebaseapp.com",
  projectId: "zeeapply-037",
  storageBucket: "zeeapply-037.firebasestorage.app",
  messagingSenderId: "757358228364",
  appId: "1:757358228364:web:6fba64d5c6c4d3a82adca9",
};
```

### Firestore security rules (active, paste into Console → Firestore → Rules)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

---

## 2. What ZeeApply is

A free, always-on, private webapp for a designer (currently Sandeep, based in Bangalore, India) hunting Product Designer / UI-UX Designer roles. It aggregates jobs from ~25 public sources, filters to designer titles, auto-excludes US-only postings, ranks each job 0–100 against the candidate's resume using Google Gemini, and surfaces India-based postings with a 🇮🇳 badge. Built as a single-page app on GitHub Pages with a Cloudflare Worker backend — **modeled exactly on the [XGrowth](https://github.com/SNDP-Design/XGrowth) architecture**. Total monthly cost: $0.

---

## 3. Architecture

```
┌────────────────────────────────────────┐       ┌──────────────────────────────────────────┐
│  GitHub Pages (static, no build step)  │       │  Cloudflare Worker (single index.js)    │
│  sndp-design.github.io/ZeeApply/       │       │  zeeapply-api.xgrowth.workers.dev       │
│                                        │       │                                          │
│  /            index.html  (landing)    │       │  GET  /health           ping             │
│  /app/        app/index.html  (SPA)    │ ────▶ │  POST /fetch-jobs       all 25 sources   │
│                                        │       │  POST /score            Gemini score     │
│  Firebase Auth (Google sign-in)        │       │  POST /cover-letter     unused, kept     │
│  Firestore (per-user storage)          │       │                                          │
└────────────────────────────────────────┘       └──────────────────────────────────────────┘
              │                                                 │
              ▼                                                 ▼
   users/{uid}                                   25+ free public job APIs
   users/{uid}/jobs/{key}                        + Google Gemini API
```

### Why this stack

| Choice | Why |
|---|---|
| Static frontend on GitHub Pages | Free, instant global CDN, always-on, no sleep |
| Cloudflare Worker for backend | Free, always-on, 100k req/day, runs at the edge, env-secret support |
| No build step | Vanilla HTML/CSS/JS — edit, push, refresh. No webpack, no React, no `npm run build`. |
| Firebase Auth + Firestore | Per-user private data; security via rules. Free Spark tier. |
| Public repo | Privacy is at the data layer (Firestore rules), not code. Code is just HTML/JS. |
| Gemini over Claude | Free tier covers thousands of jobs/day; no credit card. |

---

## 4. File structure

```
ZeeApply/
├── index.html              ← Marketing landing page (XGrowth-style dark theme)
├── app/
│   └── index.html          ← The SPA: auth + UI + Firestore + Worker calls (~900 lines)
├── worker/
│   ├── src/
│   │   └── index.js        ← The Worker: source adapters + Gemini proxy (~700 lines)
│   ├── wrangler.toml       ← Cloudflare deploy config
│   ├── package.json        ← Wrangler dev-dep
│   └── package-lock.json
├── assets/                 ← (empty — for future logos/images)
├── .nojekyll               ← Tells GitHub Pages: don't run Jekyll
├── .gitignore              ← Excludes node_modules, .wrangler, .DS_Store, .env
├── README.md               ← Setup + deploy guide
└── PROJECT_HANDOFF.md      ← This file
```

That's it. No `package.json` at the root, no build artifacts, no migration scripts.

---

## 5. Current feature inventory (every feature in the live app)

### Landing page (`/`)

- Dark theme, aurora-gradient background (matches XGrowth aesthetic)
- Hero: headline + sub + "Open app →" CTA
- 6-card feature grid (Designer-focused, Country-aware, Gemini-scored, Cover letters [stale copy], Private, Free)
- Source strip showing aggregated boards
- 4-step "how it works" timeline
- Footer with GitHub link

### App shell (`/app/`)

#### Auth gate
- Shown until Firebase `onAuthStateChanged` fires with a user
- Single "Sign in with Google" button using `firebase.auth.GoogleAuthProvider`
- Popup flow with redirect fallback for mobile / popup blockers
- Footer "← back to landing"
- "Firebase not configured" guard shown if `firebaseConfig.apiKey === 'REPLACE_ME'` (safety check that fires before initialization in case the config was forgotten — currently inactive since config is set)

#### Sidebar (always visible after sign-in)
- Brand: "ZeeApply · private build"
- Two nav buttons:
  - **📋 Jobs** — main feed (with running count badge)
  - **👤 Profile** — settings form
- User footer: avatar + display name + email + "Sign out" button

#### Jobs view (default)
- **Topbar actions:**
  - `↻ Reset feed` — ghost button. Wipes all jobs in Firestore (with confirm dialog showing count). Batched delete at 400/batch.
  - `Fetch jobs` — primary button. POSTs to Worker `/fetch-jobs`, upserts new jobs to Firestore, automatically triggers `autoScore()` when done.
- **Toolbar:**
  - Live status pill (left): `Ready` / `Fetching from 8 job sources…` / `Scoring 14 of 140…` / `✓ Scored 140`
  - **🇮🇳 India / Bangalore only** toggle — filters the list to jobs whose location matches `INDIA_LOCATION_RE`
  - Right-aligned meta: `<N> 🇮🇳 India / Bangalore`
- **Job list:**
  - Each row: score chip (color-bucketed by 20s) · company name (18px bold, the headline) · job title (15px) · location · source · score reason
  - 🇮🇳 INDIA badge (blue) appears next to company name when location matches India regex
  - Whole row is clickable → goes to job detail
- **Empty state:** copy depends on whether India filter is on

#### Profile view
Full form. Fields:
- Target role (placeholder: "Senior Product Designer, UI/UX Designer")
- Job titles to keep (CSV — drives the title filter on Worker side)
- Country (placeholder: "India")
- Work authorization (free text)
- Locations open to (CSV)
- Minimum salary (USD)
- Must-have keywords (CSV)
- Exclusions (CSV)
- Resume (big textarea)
- Greenhouse companies (CSV custom slugs; empty = use seeded defaults)
- Lever companies (CSV)
- Ashby companies (CSV)

Save button writes to Firestore `users/{uid}.profile` with a clear toast + console log + Saving… button state.

**First-time profile defaults** (`DEFAULT_PROFILE` in `app/index.html`):
- targetRole: "Senior Product Designer"
- titleFilters: "ui designer, ux designer, product designer, ui/ux designer, ux/ui designer, design lead, head of design, principal designer, staff designer, senior designer, design manager, visual designer, interaction designer"
- country: "India"
- workAuthorization: "Need visa sponsorship outside India; remote-global preferred"
- locations: "Remote, Bengaluru, India"
- (other fields blank)

These are written to Firestore on first sign-in if no profile doc exists yet.

#### Job detail view
- Big company name (28px bold) + 🇮🇳 INDIA badge if applicable
- Job title as subtitle (18px lighter)
- Score chip + reason
- Location · source
- **Open posting ↗** — primary button, opens apply URL in new tab
- Job description (system-ui, 16px, 1.65 line-height, max-width 72ch, paragraph-formatted via Worker + frontend `cleanDesc()`)

#### Routing
- Hash-based, no library
- `#/jobs` (default)
- `#/profile`
- `#/job/<encoded_jobKey>`
- `routeFromHash()` runs on hashchange and on initial load

#### Auto-scoring
- `autoScore()` triggers on:
  - Initial app load if Firestore has any unscored jobs from previous sessions
  - Immediately after every successful `Fetch jobs`
- Re-entrancy lock (`state.scoring`) prevents double-firing
- Scores sequentially through all unscored jobs (no cap)
- Per-job: POST to Worker `/score`, save `{score, scoreReason, scoreModel}` to Firestore
- On error: marks job with `score=-1` and the error message
- Re-renders the list every 10 jobs to show progress without flicker
- Status pill shows live count

#### Firestore long-polling fix
- `db.settings({ experimentalAutoDetectLongPolling: true, useFetchStreams: false })` runs right after init
- Workaround for privacy extensions (uBlock, Brave Shields, AdGuard) that silently kill Firestore's streaming WebChannel
- Triggers a console warning ("You are overriding the original host") — harmless

#### `withTimeout` helper
- Wraps the Firestore write with a 15-second timeout
- If the write hangs (extension/network/db-missing), surfaces a clear toast instead of an infinite spinner
- The error message tells the user to try Incognito mode if it triggers

---

## 6. Worker (`worker/src/index.js`) feature inventory

### Endpoints
- `GET /health` — returns `{ok, service, time}`. Public.
- `POST /fetch-jobs` — body `{titleFilters, country, greenhouseCompanies?, leverCompanies?, ashbyCompanies?}`. Returns `{fetched, afterDedupe, afterTitleFilter, excludedUsOnly, globalFriendly, counts, errors, jobs}`. CORS-gated.
- `POST /score` — body `{profile, job}`. Returns `{score, reason, model}`. CORS-gated.
- `POST /cover-letter` — body `{profile, job}`. Returns `{text, model}`. CORS-gated but **frontend no longer calls this** (cover letter feature removed from UI). Endpoint kept for trivial future re-add.

### CORS
Locked to: `https://sndp-design.github.io`, `http://localhost:8000`, `http://127.0.0.1:8000`, `http://localhost:5500`, `http://127.0.0.1:5500`. Edit `ALLOWED_ORIGINS` in `worker/src/index.js` to add a custom domain.

### Gemini fallback chain
Try top to bottom; fall through on recoverable errors (429 rate-limit, 503 overload, 404 model not found, 403 permission_denied, "RESOURCE_EXHAUSTED" body, "quota"/"rate" tokens):

```js
const GEMINI_MODELS = [
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
];
```

Most 3.x models 404 today for free-tier accounts; the chain naturally lands on `gemini-2.5-pro` or `gemini-2.5-flash` in practice. Score endpoint uses native JSON-output mode with a schema for strict structured responses.

### Job source adapters

| Adapter | Type | Auth | Filter | Yield |
|---|---|---|---|---|
| `fetchGreenhouse(slug)` | JSON | None | None | varies, ~50-800 per company |
| `fetchLever(slug)` | JSON | None | None | varies |
| `fetchAshby(slug)` | GraphQL POST | None | None | varies, **description is auto-generated** (real desc requires per-job query, exceeds subrequest budget) |
| `fetchRemoteOK()` | JSON | None | None | ~100 |
| `fetchRemotive()` | JSON | None | `category=design` (ignored by upstream — title filter catches it) | ~18 |
| `fetchArbeitnow()` | JSON | None | None | ~100 |
| `fetchJobicy()` | JSON | None | `industry=design-multimedia` | ~20 |
| `fetchWeWorkRemotely()` | RSS XML | None | Design RSS feed | ~30 |
| `fetchWorkingNomads()` | JSON | None | Client-side `design`/`ux`/`ui` tag filter | usually 0 (small feed, varies) |
| `fetchTheMuse(pages=5)` | JSON | None | `category=Design+and+UX` | ~100 (paginated) |
| `fetchAdzuna(env, ...)` | JSON | **Env-gated** | Defaults `country=in`, `keyword=designer` | 0 until secrets are set; ~100 with India tier |

### Seeded company lists

```js
DEFAULT_GREENHOUSE = [
  // US / global
  'anthropic', 'airbnb', 'stripe', 'discord', 'cloudflare', 'figma',
  'databricks', 'gitlab', 'duolingo', 'reddit', 'pinterest', 'asana',
  'instacart', 'doordashusa', 'robinhood',
  // India
  'groww', 'postman', 'phonepe', 'druva',
];

DEFAULT_LEVER = [
  'palantir', 'mistral',
  // India
  'meesho', 'paytm', 'mindtickle', 'cred',
];

DEFAULT_ASHBY = [
  'openai', 'Linear', 'Notion', 'Ramp', 'Mistral', 'Cohere',
  'Lovable', 'browserbase', 'replit', 'Posthog', 'Sentry', 'Plaid', 'stytch',
  // India
  'Atlan',
];
```

Ashby slugs are **case-sensitive** — `Linear` not `linear`, `Notion` not `notion`. User can override any list via the profile CSV fields; an empty list falls back to these defaults.

### Filters applied in the Worker

1. **Title filter** (`buildTitleMatcher`): pre-lowercases + trims filters once, then substring-matches each job's title. Pre-computation is critical — without it, 6000 jobs × 13 filters × per-call allocations blew the 10ms CPU budget.
2. **HTML strip** (`stripHtml`): runs ONLY on the ~110 jobs that pass the title filter (deferred from adapter level). One-pass decode entities → convert `<br>`/`</p>`/`</li>` to newlines+bullets → strip remaining tags. Conditional second pass only when double-encoded entities (`&amp;nbsp;` etc) remain. Caps input at 16KB before strip, output at 8KB after.
3. **US-only exclusion** (`detectUsOnly`): regex list catches "must be a US citizen", "no visa sponsorship", "security clearance", "ITAR", "TS/SCI", etc. Runs only for non-US candidates.
4. **Country-specific exclusion** (`detectCountrySpecific`): same idea generalized to UK/EU/Canada/Australia/Germany/etc. Short-circuits if `detectGlobalFriendly` matches.
5. **Global-friendly tagging** (`detectGlobalFriendly`): "remote worldwide", "sponsor your visa", etc. Returned in response but **frontend ignores it** — UI was removed when the user asked for India-only focus.

### Response shape

```json
{
  "fetched": 6180,
  "afterDedupe": 6180,
  "afterTitleFilter": 140,
  "excludedUsOnly": 5,
  "globalFriendly": 3,
  "counts": { "greenhouse:anthropic": 405, ... },
  "errors": { "arbeitnow": "Error: ... -> 403" },
  "jobs": [{ "source", "externalId", "title", "company", "location", "url", "description", "postedAt", "excluded", "globalFriendly" }, ...]
}
```

Per-source `errors` map lets one bad source not sink the rest (`Promise.allSettled`).

---

## 7. Firestore data model

```
users/{uid}                                  ← single doc per user
  ├─ profile:
  │   ├─ targetRole
  │   ├─ titleFilters         (CSV string)
  │   ├─ country
  │   ├─ workAuthorization
  │   ├─ locations            (CSV)
  │   ├─ minSalary
  │   ├─ keywords             (CSV)
  │   ├─ exclusions           (CSV)
  │   ├─ resume               (free text)
  │   ├─ greenhouseCompanies  (CSV custom slugs)
  │   ├─ leverCompanies       (CSV)
  │   └─ ashbyCompanies       (CSV)
  └─ meta:
      ├─ createdAt
      └─ updatedAt

users/{uid}/jobs/{key}                       ← subcollection, one doc per job
  ├─ source                  (e.g. "greenhouse:anthropic", "lever:meesho", "ashby:Linear")
  ├─ externalId              (provider's ID)
  ├─ title
  ├─ company
  ├─ location
  ├─ url
  ├─ description             (cleaned plain text, max 6000 chars)
  ├─ postedAt
  ├─ score                   (0-100, or -1 if excluded/errored, null if not scored yet)
  ├─ scoreReason             (one-line Gemini explanation, or error message)
  ├─ scoreModel              (which Gemini model produced the score)
  ├─ status                  ("new" | "excluded" — other statuses are unused after the simplification)
  └─ savedAt                 (epoch ms)
```

Where `key = source__externalId` (with `/`, `#`, `?` stripped to keep Firestore happy).

---

## 8. Cumulative decision log — every "why" we made

### Architecture decisions

1. **Picked Render/FastAPI/SQLite first, then scrapped it for XGrowth pattern** when user pointed at the XGrowth repo. The Render free tier sleeps after 15 min and wipes SQLite — bad for daily use. Static + Worker has no sleep and no DB churn.
2. **Made the GitHub repo public** so GitHub Pages works on the free tier. Privacy is enforced by Firestore security rules (per-user UID match) and Worker CORS allowlist — code being public is fine since no secrets are in the repo.
3. **Used Firestore over localStorage** for per-user sync across devices, multi-device access, and the user-asked-for "private to just me" via Google sign-in.
4. **Switched LLM from Claude to Gemini** when the user asked. Gemini's free tier is generous (1,500 req/day on 2.5-flash); covers all expected scoring volume without a credit card.
5. **Removed the Apply-Assistant Chrome extension** that was briefly built — user said they didn't want it. Code preserved in git history at commit `545d773` if ever needed.
6. **Removed status pipeline** (Interested/Applied/Skipped/Excluded) per user request — simplified to a single "Jobs" feed with auto-filtering for excluded.
7. **Removed cover letter feature** (draft/copy/regenerate) per user request. Worker `/cover-letter` endpoint kept (unused) for trivial re-add.
8. **Removed worldwide-friendly 🌍 badge/toggle** per user request — replaced with 🇮🇳 India badge/toggle.

### Technical decisions

1. **Gemini fallback chain** instead of single-model calls: gracefully degrades when preview models 404 for the account or when the daily quota for one model is exhausted. No code change needed when Google enables new models.
2. **Native JSON-output mode** for `/score` (`response_mime_type` + `response_schema`) — strict typed JSON, no regex parsing on the response.
3. **`experimentalAutoDetectLongPolling: true`** + **`useFetchStreams: false`** on Firestore — privacy extensions kill the streaming WebChannel; long-polling works through them.
4. **15s timeout wrapper** on Firestore writes — converts silent hangs (extension/network issues) into actionable error toasts.
5. **Defer `stripHtml` until after title filter** — was running on all 6,000+ jobs (CPU 1102 errors). Now runs on the ~140 survivors. ~50× fewer regex ops.
6. **Pre-computed `buildTitleMatcher`** — was running `f.toLowerCase().trim()` per `(filter × job)` pair. ~80k allocations per fetch. Pre-computing once eliminated this.
7. **Pre-truncate to 16KB before strip, slice to 8KB after** — caps worst-case CPU per call inside the Workers free-tier 10ms budget.
8. **Adapters return raw HTML descriptions**; strip happens in `handleFetchJobs` after title-filter. Cleaner separation of concerns.
9. **Frontend `cleanDesc()`** mirrors Worker `stripHtml` logic — defensive cleanup so jobs saved in Firestore with old/dirty HTML still render cleanly without re-fetching.
10. **Use `<pre class="desc">` for job descriptions with explicit `font-family: system-ui`** — `<pre>` defaults to monospace which looked terrible; explicit override fixes it while keeping `white-space: pre-wrap` for the paragraph breaks the Worker preserves.
11. **`max-width: 72ch` on description** — reading sweet spot, ~12 words per line.
12. **Hash-based routing** (no library) — `#/jobs`, `#/profile`, `#/job/<key>`. Works on GitHub Pages without server-side rewrites.
13. **Auto-score on page load + after fetch** — replaces the manual "Score new" button. Re-entrancy lock prevents double loops.
14. **Score sequentially (no parallel batch)** — Gemini's per-minute rate limit is 15 req/min on 2.5-flash; parallel calls would 429 frequently. Sequential + fallback chain absorbs hiccups gracefully.

### Visual / UX decisions

1. **system-ui font everywhere, 16px body** per user request. Dropped `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter"` stack.
2. **Company name promoted to the headline** in both job list and detail view per user request. Bumped to 18px bold in rows, 28px bold on detail.
3. **🇮🇳 India badge** added per user request to surface Bangalore/India-located jobs.
4. **Dark theme + aurora gradient + radial-glow background** copied from XGrowth for brand consistency.

---

## 9. Things tried, found, removed

### Tried and rejected

| Thing | Why rejected |
|---|---|
| LinkedIn scraping | Active anti-bot, ToS prohibition, IP bans |
| Indeed / Glassdoor scraping | Same as LinkedIn |
| NotFoundJobs.com scraping | `robots.txt Disallow: /`, `<meta robots="noindex,nofollow">`, base44 API requires auth. Explicit signals not to scrape. |
| Naukri / Instahyre / Wellfound | Cloudflare-protected or auth-required public surface |
| Hirist / Foundit / Updazz / Authentic Jobs / NoDesk RSS | Feeds dead or returned HTML instead of XML |
| Himalayas.app jobs API | Filter params ignored by upstream; would need to paginate 100k jobs |
| Findwork.dev API | Returns empty arrays |
| The Muse without category | Yields 100% non-design jobs at top of feed |
| Auto-submit applications (Selenium/Playwright) | Needs separate server, CAPTCHAs, ToS issues, ruins reputation. We built a manual-trigger Chrome extension instead, then removed it. |

### Built then removed (still in git history)

| Feature | Removed at | Reason | Recover from commit |
|---|---|---|---|
| Apply Assistant Chrome extension | After 1 round | User changed mind | `545d773` |
| Status pipeline (Interested/Applied/Skipped/Excluded) | Per user request | Simplified to single feed | Earlier than `60af70e` |
| Cover letter feature (draft/edit/copy/regenerate) | Per user request | Not needed right now | Earlier than `2b2752a` |
| Worldwide-friendly badge + toggle | Per user request | Replaced with India badge | Earlier than `2b2752a` |
| FastAPI/Render version (Python) | Replaced with XGrowth pattern | Render free tier sleeps + wipes SQLite | Earlier than `cc447c9` |

### Source companies seeded but underperformed (kept for future)

Some seeded companies have 0 designer jobs *today* but high volume overall — left in seeds because companies cycle through hiring rounds:

- Greenhouse: `postman` (118 total, 0 design), `phonepe` (44, 0), `druva` (23, 0)
- Lever: `cred` (7, 0)
- Ashby: `Atlan` (7, 0)

---

## 10. Gotchas (real bugs hit and how they were solved)

1. **Firestore database was named `zeeapply` not `(default)`** when user created it via Firebase Console. Firebase JS SDK only connects to `(default)` by default. All writes silently hung 15 seconds. Fix: delete the named DB in Google Cloud Console, recreate via Firebase Console → first DB always gets name `(default)`.

2. **Privacy extensions block `firestore.googleapis.com`** with `net::ERR_BLOCKED_BY_CLIENT`. Fix: user whitelists `firestore.googleapis.com`, `firebase.googleapis.com`, `securetoken.googleapis.com`, `identitytoolkit.googleapis.com`, and the site domain in the blocker.

3. **Privacy extensions also kill streaming WebChannel** even with HTTP allowed. Fix: `experimentalAutoDetectLongPolling: true` + `useFetchStreams: false` in Firestore settings.

4. **Ashby `jobBoardWithTeams` GraphQL only exposes basic fields** — full descriptions need per-job queries. With 13+ Ashby companies and 50-subrequest Worker limit, can't afford one query per job. Solution: synthesize a one-line description from title + location; users click through for full posting.

5. **Workers free-tier 10ms CPU limit (error 1102)** hit when stripping HTML across 6000+ jobs. Multiple iterations of fixes:
   - First: reduce stripHtml from 3-pass to 1-pass — helped
   - Then: defer stripHtml until after title filter (50× fewer calls) — main fix
   - Plus: pre-compute title filters once instead of per-iteration

6. **Workers free-tier 50 subrequest limit** — we're at ~45 in the steady state. Adding The Muse (5 pages) was the largest single addition. Adzuna adds 2 more when enabled. Headroom is tight.

7. **`<pre>` element defaulted to monospace** for the job description even with body `system-ui`. Fix: explicit `font-family: system-ui` on `.desc`.

8. **WeWorkRemotely RSS uses HTML-encoded descriptions** (`&lt;p&gt;` not `<p>`). Original `stripHtml` decoded entities AFTER stripping tags — encoded tags became real tags AFTER the strip and leaked through. Fix: decode FIRST, then strip.

9. **Cloudflare Worker auto-named the service** using owner's existing `xgrowth` subdomain — URL is `zeeapply-api.xgrowth.workers.dev` not `zeeapply-api.workers.dev`. Coincidentally clean.

10. **Adzuna India keyword limited to one phrase** — API doesn't accept arrays. Worker uses `titleFilters[0]` (currently "ui designer" → narrow). Could iterate over filters but each is a paid API call (250/month free).

---

## 11. Current state of the live deployment

### Live and verified working
- ✅ Landing page renders
- ✅ App loads, sign-in works
- ✅ Profile loads/saves to Firestore
- ✅ `/fetch-jobs` returns ~6,180 raw → ~140 designer-filtered jobs in 5-7 seconds
- ✅ 5 India-located designer jobs currently in the feed (Meesho Bangalore, Paytm Noida ×2, Designit Bangalore, Uber Bangalore)
- ✅ Auto-score runs after fetch + on page load, scores via gemini-2.5-pro / gemini-2.5-flash (3.x models 404 for the account)
- ✅ 🇮🇳 India badge + India-only toggle filter working
- ✅ Job descriptions display in clean paragraph-formatted system-ui prose
- ✅ Reset feed wipes all jobs cleanly
- ✅ Open posting opens apply URL in new tab

### Not yet enabled (one wrangler command away)
- ⚠ Adzuna India source (set `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` Worker secrets after free signup at developer.adzuna.com)

### Known minor issues (none blocking)
- Worker `errors` object sometimes lists `arbeitnow: 403` — they rate-limit our origin sporadically. Other sources unaffected.
- Some Ashby companies show 0 jobs (their boards exist but no current postings).

---

## 12. Commands cheat sheet

### Run locally

```bash
# Backend (terminal 1)
cd "/Users/sandeeprathi/Desktop/Claude Code/ZeeApply/worker"
npx wrangler dev --port 8787 --local

# Frontend (terminal 2)
cd "/Users/sandeeprathi/Desktop/Claude Code/ZeeApply"
python3 -m http.server 8000

# Open
open http://localhost:8000
```

The app auto-detects localhost and points at `http://127.0.0.1:8787` for the Worker. Production builds point at `https://zeeapply-api.xgrowth.workers.dev`.

### Deploy

```bash
# Worker
cd "/Users/sandeeprathi/Desktop/Claude Code/ZeeApply/worker"
npx wrangler deploy

# Frontend (auto-deploys via GitHub Pages on push to main)
cd "/Users/sandeeprathi/Desktop/Claude Code/ZeeApply"
git add -A && git commit -m "..." && git push
# Pages rebuild takes ~30-90 seconds
```

### Set / rotate Worker secrets

```bash
cd "/Users/sandeeprathi/Desktop/Claude Code/ZeeApply/worker"
npx wrangler secret put GEMINI_API_KEY     # prompts for value
npx wrangler secret put ADZUNA_APP_ID
npx wrangler secret put ADZUNA_APP_KEY
npx wrangler secret list                   # see what's set
```

### Tail Worker logs (live)

```bash
cd "/Users/sandeeprathi/Desktop/Claude Code/ZeeApply/worker"
npx wrangler tail
```

### Check Pages deploy status

```bash
gh api repos/SNDP-Design/ZeeApply/pages/builds/latest --jq '{commit, status, error}'
```

### Manual fetch test against live Worker

```bash
curl -sS -X POST https://zeeapply-api.xgrowth.workers.dev/fetch-jobs \
  -H 'Origin: https://sndp-design.github.io' \
  -H 'Content-Type: application/json' \
  -d '{"titleFilters":["product designer","ux designer"],"country":"India"}'
```

---

## 13. How to extend — common recipes

### Add a new company to an existing ATS (Greenhouse / Lever / Ashby)

**Two paths:**

A. **Per-user (no code):** in the app's Profile form, add the slug to the appropriate CSV field (Greenhouse companies / Lever companies / Ashby companies). Save. Next fetch includes it.

B. **Default for everyone:** edit `DEFAULT_GREENHOUSE` / `DEFAULT_LEVER` / `DEFAULT_ASHBY` in `worker/src/index.js`. Deploy. Don't forget Ashby is case-sensitive.

Verify the slug works by curling:
- Greenhouse: `curl "https://boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true" | head`
- Lever: `curl "https://api.lever.co/v0/postings/<slug>?mode=json" | head`
- Ashby: see the Ashby GraphQL probe pattern in chat history (or use the working pattern in `fetchAshby`)

### Add a new job source (entirely new adapter)

In `worker/src/index.js`:

1. Add an async function `fetchYourSource()` that returns an array of jobs matching the standard shape:
   ```js
   {
     source: 'yoursource',         // or 'yoursource:slug'
     externalId: 'unique-per-source-id',
     title: '',
     company: '',
     location: '',
     url: '',
     description: '',              // raw HTML OK — Worker strips after title filter
     postedAt: null,               // ISO string preferred
   }
   ```
2. Add it to the `tasks` array in `handleFetchJobs`. Example: `['yoursource', fetchYourSource]`.
3. Deploy with `npx wrangler deploy`.

If the source returns >100 jobs and most won't match designer titles, that's fine — the title filter trims them in the Worker before the response.

### Add a new env-gated source (like Adzuna)

Same as above but:
1. Function takes `env` as first param
2. Returns `[]` silently if the required secrets aren't set
3. Pass via closure: `[`yoursource`, () => fetchYourSource(env, ...)]`
4. Set the secrets with `wrangler secret put`

### Add a new profile field

1. Add input to the `<form id="profileForm">` in `app/index.html`
2. Add the field name to the `FIELDS` array (popup.js? — no, scratch that, popup.js is the deleted extension). In `app/index.html` the `readProfileForm` uses `FormData` so it picks up any `name="..."` input automatically.
3. Add it to `DEFAULT_PROFILE`
4. If the Worker should use it, add it to `profilePayload()` and reference it in `profileText()` or wherever
5. Done — Firestore handles arbitrary shape

### Add a new view / sidebar item

1. Add `<button data-view="myview">My View</button>` to the `<div class="nav">` in `app/index.html`
2. Add `<section id="view-myview" class="view hidden">...</section>` to `<main>`
3. Add a case in `routeFromHash()`: `else if (parts[0] === 'myview') { show($('view-myview')); ... }`
4. Add `routeTo('myview')` call
5. Done

### Change the Gemini model chain order

Edit `GEMINI_MODELS` array in `worker/src/index.js`. Deploy. No frontend change.

### Add a custom domain

1. Buy domain
2. CNAME at root of repo: `echo "yourapp.com" > CNAME` and commit
3. Configure DNS to point at `sndp-design.github.io`
4. Firebase Console → Authentication → Authorized Domains → add `yourapp.com`
5. `worker/src/index.js` → add to `ALLOWED_ORIGINS`: `'https://yourapp.com'`
6. `npx wrangler deploy`
7. Wait for DNS propagation + GitHub Pages SSL cert issuance (~10 min to a few hours)

---

## 14. Open ideas / unbuilt features (for your next chat)

- **Enable Adzuna India** for 50-100 more India-specific designer jobs per fetch (1 free signup + 2 wrangler secret commands)
- **Workable adapter** to unlock Razorpay (Bangalore design team) and other Workable-hosted Indian boards
- **Recruitee adapter** for EU companies with designer teams
- **Reintroduce Hacker News "Who is hiring"** as a separate `/fetch-hn` endpoint (keeps subrequest count safe; the Python version did this)
- **Bring back the Apply Assistant Chrome extension** (commit `545d773`) when user is ready for faster applications
- **Bring back the cover letter feature** when user is ready
- **Score caching** — if a job description hasn't changed and the resume hasn't changed, skip re-scoring
- **Daily auto-fetch** via Cloudflare Cron Triggers — would require a paid Worker plan or a separate scheduled task
- **Email digest** of top 10 new scores — needs an outbound email service (Resend, Postmark, etc.)
- **Multi-user support** — already works trivially since Firestore is per-uid; just point others at the same URL and they sign in with their own Google
- **Custom domain** — `zeeapply.uno` or similar (matches XGrowth's pattern)

---

## 15. Commit history landmarks (chronological)

| Commit (short) | What |
|---|---|
| `cc447c9` | Full XGrowth-style rewrite (dropped Python/FastAPI/SQLite) |
| `dafcd71` | Switched LLM from Claude to Gemini |
| `4aa406f` | Renamed project from job-hunter to ZeeApply |
| `c8f18b4` | Final Gemini model chain (8 models) |
| `2f433c5` | Wired in user's Firebase + deployed Worker URL |
| `8625a20` | Save profile error reporting + Firestore rules guidance |
| `678af8c` | Firestore long-polling fix for privacy extensions |
| `(found-it)` | Diagnosed "database doesn't exist" — user recreated as (default) |
| `077a7dd` | Added Ashby + The Muse sources + worldwide filter |
| `5bd7342` | Paragraph-preserving stripHtml + system-ui description |
| `545d773` | (Removed) Apply Assistant Chrome extension |
| `5a028a1` | Removed Chrome extension per user request |
| `b4db708` | system-ui everywhere, body 16px |
| `5654d71` | Reset feed button |
| `60af70e` | **Major simplification**: single jobs view, removed status pipeline, auto-scoring |
| `2b2752a` | Removed cover letter, worldwide tags; added India badge + bigger company name |
| `99b962e` | India company seeds + Adzuna adapter + CPU optimizations (deferred stripHtml, pre-computed title matcher) |

---

## 16. The person using this

**Sandeep Rathi** — Product Designer, based in **Bangalore, India**, looking for Senior Product Designer / UI-UX Designer roles. Needs visa sponsorship for non-India locations. Open to remote-global. Owns Cloudflare account (subdomain `xgrowth`) and `SNDP-Design` GitHub. Built XGrowth previously, so familiar with the architecture and prefers vanilla HTML+JS+Worker over frameworks.

---

## 17. Next-chat starter prompt (copy this to bootstrap a new conversation)

> Hey, I'm continuing work on ZeeApply — a designer job hunter I built with you in the previous chat. It's a static frontend on GitHub Pages + Cloudflare Worker + Firebase. The full handoff is in `PROJECT_HANDOFF.md` at the repo root (https://github.com/SNDP-Design/ZeeApply). Repo is public, Worker is live at `zeeapply-api.xgrowth.workers.dev`, frontend at `sndp-design.github.io/ZeeApply/`. Read the handoff and then help me with: **[your next ask here]**.

---

End of handoff. Last updated: 2026-05-18.
