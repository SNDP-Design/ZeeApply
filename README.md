# ZeeApply

Your private, designer-focused, AI-powered job hunter — built like [XGrowth](https://www.xgrowth.uno): static frontend on GitHub Pages, serverless backend on Cloudflare Workers, free forever, always on, no signup-of-the-month.

**Architecture**

```
┌──────────────────────────┐      ┌──────────────────────────┐
│  GitHub Pages (static)   │      │  Cloudflare Worker (JS)  │
│                          │      │                          │
│  /            landing    │      │  /fetch-jobs   sources   │
│  /app/        the app    │ ───▶ │  /score        Gemini    │
│                          │      │  /cover-letter Gemini    │
│  Firebase Auth + store   │      │                          │
└──────────────────────────┘      └──────────────────────────┘
        │                                    │
        ▼                                    ▼
   Per-user Firestore               Public job APIs +
   (your profile, jobs,             Google Gemini
    cover letters)                  (with 4-model fallback)
```

**What it does**

1. **Aggregates** designer jobs from 8 free public sources: Greenhouse (15+ companies), Lever (Palantir, Mistral), RemoteOK, Remotive, Arbeitnow, Jobicy, WeWorkRemotely (design RSS), Working Nomads.
2. **Filters** to your target titles (`ui designer`, `product designer`, etc.) before anything touches your storage.
3. **Auto-excludes** US-only jobs (citizenship, security clearance, ITAR, no-sponsorship language) when you're based outside the US.
4. **Scores** each job 0–100 with Gemini against your resume, with a one-line "why" reason.
5. **Drafts** tailored 180-word cover letters on demand for high-scoring jobs.
6. **Tracks** every job through `new → interested → applied / skipped` in your private Firestore.

**Privacy:** Your resume and pipeline are stored in your own Firestore under your Google account. No shared database. Resume only ever leaves your browser when you trigger a scoring call (sent to Gemini via the Worker; never stored).

**Cost:** $0/month. GitHub Pages + Cloudflare Workers + Firebase Spark + Gemini free tier together cover thousands of jobs/day.

---

## Local development

```bash
# Backend (Cloudflare Worker) — terminal 1
cd worker
npm install
npx wrangler dev --port 8787 --local

# Frontend — terminal 2
cd ..
python3 -m http.server 8000

# Open http://localhost:8000
```

The app auto-detects `localhost` and points at the local Worker at `http://127.0.0.1:8787`. For scoring + cover-letter calls to work locally, set the secret:

```bash
cd worker
npx wrangler secret put GEMINI_API_KEY    # paste your AIza... key
```

Get a free Gemini key at https://aistudio.google.com/apikey.

---

## Deploy (one-time, ~25 min)

### 1. Firebase project (~10 min)

1. Open https://console.firebase.google.com → **Add project** → name it `zeeapply` (or anything). Disable Google Analytics for simplicity.
2. Left sidebar → **Authentication** → **Get started** → enable **Google** as a sign-in provider.
3. Left sidebar → **Firestore Database** → **Create database** → start in **production mode** → pick a region close to you.
4. Firestore → **Rules** → paste this and **Publish**:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{userId}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
       }
     }
   }
   ```
   This makes each user's data accessible only to themselves.
5. **Project Settings** (gear icon) → scroll to **Your apps** → click `</>` web → register the app (name: `ZeeApply`).
6. Copy the `firebaseConfig` object Firebase shows you.
7. Open `app/index.html`, find the `const firebaseConfig = { … }` block near the bottom, paste your values in.
8. Project Settings → **Authorized domains** → add `sndp-design.github.io` (or your custom domain) so Google sign-in works from production.

### 2. Cloudflare Worker (~5 min)

```bash
cd worker
npx wrangler login        # opens browser; sign in / sign up with Cloudflare (free)
npx wrangler secret put GEMINI_API_KEY    # paste your Gemini key
npx wrangler deploy
```

Wrangler prints the Worker URL — looks like `https://zeeapply-api.<your-subdomain>.workers.dev`. Copy it.

### 3. Wire frontend to production Worker

Open `app/index.html`, find:
```js
const API_BASE = (location.hostname === 'localhost' || …)
  ? 'http://127.0.0.1:8787'
  : 'https://zeeapply-api.YOUR_SUBDOMAIN.workers.dev';
```
Replace `YOUR_SUBDOMAIN` with what Wrangler gave you.

Also open `worker/src/index.js`, find `ALLOWED_ORIGINS`, and confirm your GitHub Pages domain (`https://sndp-design.github.io`) is listed. Add a custom domain there too if you point one at the site. Re-deploy after edits: `npx wrangler deploy`.

### 4. GitHub Pages (~5 min)

```bash
git add -A && git commit -m "Wire prod Firebase + Worker URLs" && git push
```

Then on GitHub: **Settings → Pages → Source: `main` branch / `/` root → Save**.

After ~1 min, your app is live at:
- Landing: `https://sndp-design.github.io/ZeeApply/`
- App: `https://sndp-design.github.io/ZeeApply/app/`

**(Optional) Custom domain:** drop a `CNAME` file at the repo root with your domain (e.g. `zeeapply.uno`), and configure DNS to point at `sndp-design.github.io`. Then add the same domain to Firebase's Authorized Domains and the Worker's `ALLOWED_ORIGINS`.

---

## File layout

```
ZeeApply/
├── index.html              ← landing page (GitHub Pages serves this at /)
├── app/index.html          ← the actual webapp (auth + UI + Firestore + API calls)
├── worker/
│   ├── src/index.js        ← Cloudflare Worker: job sources + Gemini proxy
│   ├── wrangler.toml       ← Cloudflare config
│   └── package.json
├── assets/                 ← logos / images (optional)
├── .nojekyll               ← tells GitHub Pages "don't run Jekyll"
└── README.md
```

That's it. No build step. Edit, push, refresh.

---

## Gemini fallback chain

`worker/src/index.js` tries models in this order:

```
gemini-3-flash-preview  →  gemini-2.5-flash  →  gemini-2.5-flash-lite  →  gemini-2.0-flash
```

If a model 429s (rate limit), 503s (server overload), 404s (not yet released — likely for `gemini-3-flash-preview`), or returns `RESOURCE_EXHAUSTED`, the next one tries automatically. Auth errors and malformed requests surface immediately. This means scoring keeps working even when one model hits daily quota.
