# ZeeApply — Project Handoff

**Last updated:** 2026-05-19
**Latest commit:** `e56f8bb` — *feat: remove scoring, harden visa filter*
**Live app:** https://sndp-design.github.io/ZeeApply/app/
**Live Worker API:** https://zeeapply-api.xgrowth.workers.dev
**Repo:** https://github.com/SNDP-Design/ZeeApply

Paste this into a new chat and say *"Continue ZeeApply from here"* — it's everything you need.

---

## 1. What ZeeApply is

A **private, single-user job-hunting webapp for designers**. Built for one person (the owner) and a small invite list. The pitch:

- One feed of fresh design jobs aggregated from ~11 public sources.
- Authenticated with Google (Firebase Auth), per-user storage in Firestore.
- Designed for India-based candidates by default, but country-aware (won't wrongly exclude India-only roles for an Indian candidate, and won't wrongly include US-clearance-only roles).
- **No AI scoring, no cover-letter generation** (both removed in this session — see §6).
- **No build step.** Static HTML/CSS/JS frontend. Single-file Cloudflare Worker backend.

---

## 2. Architecture at a glance

```
┌──────────────────────────┐         ┌──────────────────────────────┐
│  Browser (GitHub Pages)  │ ──────▶ │  Cloudflare Worker           │
│  app/index.html          │   POST  │  worker/src/index.js         │
│  + Firebase JS SDK       │  /fetch │  Aggregates 11 job sources,  │
│                          │  -jobs  │  dedupes, title-filters,     │
│                          │         │  drops visa-required jobs    │
│                          │ ◀────── │  Returns JSON                │
│                          │         └──────────────────────────────┘
│  Writes to Firestore     │
│  users/{uid}/jobs/{id}   │
└──────────────────────────┘
```

- **Frontend:** vanilla HTML/CSS/JS in one file (`app/index.html`, ~877 lines). Firebase JS SDK from CDN. Hosted on GitHub Pages.
- **Backend:** single-file Cloudflare Worker (`worker/src/index.js`, ~785 lines). Two endpoints: `GET /health`, `POST /fetch-jobs`.
- **Auth:** Firebase Auth (Google sign-in, popup flow).
- **Storage:** Firestore. Per-user collection `users/{uid}/jobs/{jobId}`.
- **No backend DB.** Firestore is the only persistence layer.

---

## 3. Files in the repo

```
ZeeApply/
├── PROJECT_HANDOFF.md          ← this file
├── README.md                    minimal repo README
├── index.html                   ← marketing landing page (top-level)
├── app/
│   └── index.html               ← THE APP. Single-file frontend (~877 lines)
├── assets/                      images / favicon
└── worker/
    ├── src/
    │   └── index.js             ← THE WORKER. Single-file backend (~785 lines)
    ├── wrangler.toml            Cloudflare Worker config
    └── package.json             deps: wrangler (dev only)
```

Two source files matter: `app/index.html` and `worker/src/index.js`. Everything else is config / static.

---

## 4. Worker (`worker/src/index.js`) — what it does

### Endpoints
- `GET /health` → `{ ok: true, service: "zeeapply-api", time: <ISO> }`
- `POST /fetch-jobs` with body `{ candidate: { country, ... } }` → returns aggregated job list

### Pipeline
1. **Parallel fan-out** to all enabled job sources (see §4.1).
2. **Dedupe** by canonicalised `url`, then by `(company + title)` tuple.
3. **Title filter** — regex allowlist for design titles (designer, UX, UI, product designer, brand, motion, visual, illustrator, design lead, etc.). Excludes engineer/dev/PM/marketing/sales/QA noise.
4. **Country-aware visa filter** (`detectVisaExclusion`, see §4.2). Excluded jobs are **dropped entirely** — they never reach Firestore.
5. Returns:
   ```json
   {
     "fetched": 2617,
     "afterDedupe": 421,
     "afterTitleFilter": 118,
     "excludedVisa": 5,
     "excludedSamples": [{ "title": "...", "company": "...", "reason": "Local-only (US): \"...\"" }],
     "counts": { "greenhouse": 142, "lever": 87, "...": "..." },
     "errors": [],
     "jobs": [ /* 113 kept jobs */ ]
   }
   ```

### 4.1 Job sources

All public, no auth required except Adzuna (optional, has key):

| Source | Notes |
|---|---|
| Greenhouse | Per-company `boards-api.greenhouse.io/v1/boards/<co>/jobs?content=true`. Curated list of design-forward companies. |
| Lever | Per-company `api.lever.co/v0/postings/<co>?mode=json`. |
| Ashby | Per-company `api.ashbyhq.com/posting-api/job-board/<co>`. |
| RemoteOK | `remoteok.com/api`. |
| Remotive | `remotive.com/api/remote-jobs?category=design`. |
| Arbeitnow | `arbeitnow.com/api/job-board-api` (EU-heavy). |
| Jobicy | `jobicy.com/api/v2/remote-jobs?tag=design`. |
| WeWorkRemotely | RSS feed — parsed by hand. |
| WorkingNomads | `workingnomads.com/api/exposed_jobs/?category=design`. |
| TheMuse | `themuse.com/api/public/jobs?category=Creative+%26+Design`. |
| Adzuna India | `api.adzuna.com/v1/api/jobs/in/search/...` — **requires `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` Wrangler secrets**. Silently skips if absent. |

Each adapter normalises to:
```js
{ id, url, title, company, location, description, postedAt, source }
```

### 4.2 Visa / country filter — `detectVisaExclusion(job, candidateCountry)`

This is the single most subtle piece of code. Read before editing.

**Problem it solves:**
The previous filter wrongly excluded "India-only" jobs for an Indian candidate (the `candidateCountry` parameter was unused). Conversely, US-clearance-only jobs could leak through to non-US candidates.

**How it works now:**

1. **`normalizeCountry()`** maps strings like "India", "in", "IN" → canonical token `'in'`. Tokens: `us, uk, eu, ca, au, sg, in, de, fr, nl, ie, ch, il, jp`.

2. **`COUNTRY_DEMAND_NAMES`** — for each country, the regex fragment that matches how a posting says *"must be from here"*:
   ```js
   us: 'U\\.?\\s*S\\.?|U\\.?S\\.?A|United\\s+States|American'
   in: 'India|Indian|Bharat'
   ```

3. **`COUNTRY_LOCATION_PATTERNS`** — geographic mentions that prove the job *is in* that country (cities, states):
   ```js
   in: /\b(india|bangalore|mumbai|delhi|hyderabad|chennai|pune|gurgaon|noida|...)\b/i
   us: /\b(united\s+states|usa?|new york|san francisco|...)\b/i
   ```

4. **`COUNTRY_DEMAND_PATTERNS`** — built from `COUNTRY_DEMAND_NAMES` × templates like `"must be authorized to work in (...)"`, `"(...) citizens only"`, `"based in (...)"`. Each regex has capture group 1 = matched country name.

5. **`US_CLEARANCE_PATTERNS`** — security clearance + ITAR + EAR + "Secret/TS/SCI". Only triggers when candidate is *not* US.

6. **`NO_SPONSORSHIP_PATTERNS`** — "no visa sponsorship", "cannot sponsor". Only triggers when the job is *not* in the candidate's country (because "no sponsorship needed in India" is fine for an Indian candidate).

7. **`isGlobalFriendly(text)`** — short-circuits if text says "worldwide", "remote anywhere", "global". These are kept regardless.

**Decision flow:**
```
candidateToken = normalize(candidateCountry)   // e.g. 'in'
if !candidateToken: return null                // unknown → keep
if isGlobalFriendly(text): return null         // worldwide → keep
if candidateToken !== 'us':
    if US_CLEARANCE_PATTERNS match: drop
for each COUNTRY_DEMAND_PATTERN:
    if match and demanded !== candidateToken: drop
if job NOT in candidate's country (per COUNTRY_LOCATION_PATTERNS):
    if NO_SPONSORSHIP_PATTERNS match: drop
return null                                    // keep
```

**Test cases (10 hand-built fixtures, all pass):**
- ✅ "Indian citizens only" → kept for `in`, dropped for `us`
- ✅ "Must be authorized to work in the US" → kept for `us`, dropped for `in`
- ✅ "ITAR — US citizens only" → kept for `us`, dropped for `in`
- ✅ "Remote, worldwide" → kept everywhere
- ✅ Plain Bangalore role with no visa wording → kept

### 4.3 Other Worker details

- CORS: `Access-Control-Allow-Origin: https://sndp-design.github.io` (and `*` in dev).
- Timeouts: each source has a 7s `AbortController`. Failures land in `errors[]` and don't break the response.
- Sample telemetry: `excludedSamples` (first 5 dropped jobs) so you can sanity-check the filter from the browser console.
- **No Gemini code anywhere.**

---

## 5. Frontend (`app/index.html`)

Single-file HTML with `<style>` + `<script type="module">`. ~877 lines.

### Layout
1. `<head>` — Firebase config, favicon, system-ui font stack, dark theme CSS variables.
2. CSS — two-pane layout, status pill, jobrow grid (`1fr auto`), empty-state.
3. Header — Google sign-in button, Fetch button, Reset Feed button, status pill.
4. Two-pane: left = job list, right = job detail.
5. `<script type="module">` — all logic.

### State shape
```js
const state = {
  user: null,
  candidate: {
    country: 'India',
    title: 'Senior Product Designer',
    skills: '...',
    yearsExperience: 10,
    salaryExpectation: '...',
    notes: '...',
  },
  jobs: {},             // { jobKey: jobDoc }
  fetching: false,
  selectedJobKey: null,
  // NOTE: no `scoring` flag anymore.
};
```

### Firestore document shape

```
users/{uid}/jobs/{jobKey}
{
  url, title, company, location, description, postedAt, source,
  savedAt: serverTimestamp(),
  applied?: boolean,
  appliedAt?: serverTimestamp(),
  // REMOVED THIS SESSION: score, scoreReason, scoreModel, status
}
```

`jobKey` = base64-url of `(company|title)` — dedupes across sources.

### Key functions

- `signIn()` / `signOut()` — popup auth.
- `loadProfile()` — pulls `users/{uid}/profile/main`, merges into `state.candidate`. Country defaults to "India".
- `loadJobs()` — `onSnapshot` listener on `users/{uid}/jobs`. Calls `purgeLegacyExcluded()` once after first snapshot.
- **`purgeLegacyExcluded()`** — one-time cleanup. Deletes any doc with `status === 'excluded'` or `score === -1` from previous builds. Batched writes, chunk size 400.
- `fetchJobs()` — POSTs `{ candidate }` to Worker. Writes new jobs to Firestore. Status pill: `✓ Fetched N · saved K new · skipped M dupes · X visa-required dropped`.
- `resetFeed()` — confirm prompt, then batch-deletes all jobs for the user.
- `visibleJobs()` — `Object.values(state.jobs).sort((a,b) => b.savedAt - a.savedAt)`. No score filter.
- `renderJobs()` — left pane: title + company/location. No score chip, no reason line.
- `renderJobDetail()` — right pane: full description, apply button, "Mark applied" toggle.
- `autoScore()` — **DELETED.**
- `profilePayload()` — **DELETED.**

### What's still in the frontend
- Profile editor modal (country, title, skills, years, salary, notes).
- "Mark applied" toggle per job.
- Reset Feed (nukes all jobs).
- Status pill.

### What was removed in the most recent session
- All score CSS (`.score`, `.score.s-0..s-5`).
- Jobrow grid: `48px 1fr auto` → `1fr auto`.
- Score chip + reason line in rows.
- Score badge in job detail header.
- `state.scoring`.
- `autoScore()` (~40 lines) and every call site.
- `profilePayload()` helper.
- Writes of `score / scoreReason / scoreModel / status`.

---

## 6. Most recent session changes (commit `e56f8bb`)

### Trigger
User: *"remove job score functionality and there are lots of jobs that need visa to apply for that specific country. remove all those jobs from the list."*

Clarifications:
- **Gemini:** remove everything (endpoints, code, Wrangler secret optional).
- **Visa jobs:** drop entirely at the Worker. Country-aware: must not wrongly exclude India-only roles for Indian candidates.

### Worker changes
- Deleted `GEMINI_MODELS`, `GEMINI_BASE`, `isRecoverable`, `callGemini`, `SCORE_SYSTEM`, `SCORE_SCHEMA`, `COVER_SYSTEM`, `profileText`, `jobText`.
- Deleted `handleScore`, `handleCoverLetter`, and route handlers. `/score` and `/cover-letter` now return 404.
- Replaced ~85 lines of `detectUsOnly` + `detectCountrySpecific` with ~120 lines of `detectVisaExclusion`.
- Fixed prior tautology: `const adzunaCountry = /india/i.test(country) ? 'in' : 'in';` → `const adzunaCountry = 'in';`.
- `handleFetchJobs` now drops excluded jobs and returns `excludedVisa` + samples.

### Frontend changes
- Removed all score CSS + DOM.
- Removed `autoScore` and `profilePayload`.
- Added one-time `purgeLegacyExcluded()`.
- Fetch handler stopped writing score fields.

### Deploy
- Committed `e56f8bb`, pushed to `origin/main`.
- `npx wrangler deploy` — Worker version `4a1049e6-888a-44fa-abb9-622d69ef1676`.
- Verified `/health` 200, `/score` 404.

### Verified live fetch results
2617 raw → 421 after dedupe → 118 after title filter → **5 visa-required dropped** (ManTech clearance, Consensys "US-based only", Skio no-sponsorship, SpaceX ITAR ×2) → **113 returned**.

---

## 7. Deploy / dev commands

```bash
# Project root
cd "/Users/sandeeprathi/Desktop/Claude Code/ZeeApply"

# --- Frontend ---
# No build. Edit app/index.html, commit, push. GitHub Pages redeploys in 30-90s.
git add app/index.html && git commit -m "..." && git push

# --- Worker ---
cd worker
npx wrangler dev          # local at http://127.0.0.1:8787
npx wrangler deploy       # → zeeapply-api.xgrowth.workers.dev
npx wrangler tail         # live log stream
npx wrangler secret list
npx wrangler secret put ADZUNA_APP_ID
npx wrangler secret put ADZUNA_APP_KEY
npx wrangler secret delete GEMINI_API_KEY  # cleanup (see §8)
```

### Wrangler secrets currently configured
- `GEMINI_API_KEY` — **no longer used.** Safe to delete (see §8).
- `ADZUNA_APP_ID` — optional, enables Adzuna India.
- `ADZUNA_APP_KEY` — optional, enables Adzuna India.

### Firebase config
Hard-coded in `app/index.html` (public config — safe).

---

## 8. Optional follow-ups (not done; awaiting confirmation)

1. **Delete unused Gemini secret:**
   ```bash
   cd worker && npx wrangler secret delete GEMINI_API_KEY
   ```
2. **Trigger one-time legacy purge.** Open the app while logged in — `purgeLegacyExcluded()` removes old `status:'excluded'` / `score:-1` docs from Firestore.
3. **Adzuna keys.** Sign up at developer.adzuna.com → `wrangler secret put ADZUNA_APP_ID` + `ADZUNA_APP_KEY`. No code change.

---

## 9. Design decisions

- **One HTML file:** zero build, easiest deploy, easiest diff review.
- **Drop visa-required jobs (not flag):** the user was overwhelmed by 30%+ unactionable noise. Dropping at the Worker keeps Firestore clean.
- **Country-aware (not just "US-only"):** user is in India; India-only roles are the target. Generic per-country filter generalises and survives the user moving.
- **No scoring:** Gemini scoring was noisy, not load-bearing, added latency + a paid dep. Removing cut ~80 Worker lines.
- **Batched writes at 400:** Firestore cap is 500; 400 leaves headroom.
- **No framework:** ~877 lines total. Frameworks would 5× the surface.
- **Cloudflare Workers:** free tier, edge-fast, native `fetch`, single-file deploy. Workers shine at parallel HTTP fan-out.

---

## 10. Known limitations / things to watch

- **Greenhouse/Lever/Ashby company lists are hard-coded.** Adding a target company = one line.
- **WeWorkRemotely parses RSS by hand.** If WWR drops to 0 in `counts`, check the RSS shape.
- **Adzuna is silent without secrets.** Intentional; mention if confused.
- **No list virtualization.** Fine <1000 jobs; if you fetch for months, may need it.
- **Firestore quota.** Free tier is generous but watchable.
- **`detectVisaExclusion` is regex-based and conservative.** Keeps borderline cases. False positives (wrongly dropping) are worse than false negatives (showing irrelevant) since the user reviews each role.

---

## 11. How to keep building

Paste this file into a new chat and say:

> *"This is ZeeApply, my private designer job-hunting webapp. Here's the full state. Continue from here."*

Then describe the task. Common ones:

- *"Add `<source>` as a new job adapter"* → add `fetchFromX()` in `worker/src/index.js`, call in the `Promise.allSettled` block in `handleFetchJobs`, normalise to the common job shape.
- *"Show a new field in the job detail pane"* → edit `renderJobDetail()` in `app/index.html`.
- *"Filter jobs by Y"* → add a predicate in `handleFetchJobs` between title-filter and visa-filter.
- *"Track applications properly"* → there's a "Mark applied" toggle. Extend doc shape with `appliedAt`, render a counter / applied tab.

---

## 12. File map

| Path | Purpose | Size |
|---|---|---|
| `worker/src/index.js` | Cloudflare Worker — fetch/filter/dedupe | 785 lines |
| `app/index.html` | The entire frontend app | 877 lines |
| `worker/wrangler.toml` | Worker config | tiny |
| `index.html` (root) | Marketing landing page | static |
| `assets/` | Images, favicon | static |
| `README.md` | Minimal repo README | tiny |
| `PROJECT_HANDOFF.md` | This file | you're reading it |

---

## 13. Contact points

- **GitHub:** SNDP-Design/ZeeApply
- **Cloudflare account:** xgrowth — Worker `zeeapply-api`
- **Firebase project:** ZeeApply (config in `app/index.html`)
- **GitHub Pages:** auto-deploys from `main`

---

## 14. Commit history at a glance

```
e56f8bb  feat: remove scoring, harden visa filter        ← current
49bbc1d  docs: add PROJECT_HANDOFF.md
99b962e  feat(worker): India sources + Adzuna India + CPU optimizations
2b2752a  feat(app): drop cover letter + worldwide tags; bigger company name; India badge
60af70e  feat(app): simplify to one list + automatic scoring
5654d71  feat(app): add 'Reset feed' button
5bd7342  fix: readable job descriptions — system-ui + paragraphs
5a028a1  revert: remove Apply Assistant Chrome extension
545d773  feat: Apply Assistant Chrome extension + helper
b4db708  style: switch to system-ui font, body 16px
```

---

*End of handoff. Paste this into the next chat to continue.*
