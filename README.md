# Job Hunter

Semi-autonomous job search: fetch postings from public job boards, rank them against your resume with Claude, draft tailored cover letters, and queue applications for your review before you submit. No auto-submit, no scraping that violates ToS.

## How it works

1. **Fetch** — pulls jobs from free public APIs:
   - **No key needed:** Greenhouse boards, Lever postings, RemoteOK, Remotive, Arbeitnow, Jobicy, WeWorkRemotely (design RSS), Working Nomads, Hacker News "Who is hiring" thread
   - **Free key (optional):** Adzuna (Indeed-style aggregator), USAJobs (US federal jobs)
   Keyword-driven sources (Adzuna, USAJobs) use your profile's `target_role` as the search query.
   Defaults are tuned for designer roles — see Profile → "Job titles to keep".
2. **Score** — Claude reads each job against your profile and assigns 0–100 with a one-line reason.
3. **Draft** — for any job you open, generate a tailored cover letter grounded in your resume.
4. **Review** — mark `interested` / `applied` / `skipped`. Open the apply page in a new tab and paste your cover letter.

LinkedIn / Indeed adapters are intentionally **not** included in the MVP — they require fragile session-cookie scraping. Phase 2.

## Setup

Dependencies are already installed to your user site-packages (`~/Library/Python/3.9/`). To run:

```bash
cd "job-hunter"
cp .env.example .env
# Edit .env: set ANTHROPIC_API_KEY=sk-ant-...

/usr/bin/python3 -c "from uvicorn import run; run('app.main:app', host='127.0.0.1', port=8000, reload=True)"
```

Open http://localhost:8000.

If you'd rather use a venv:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

## First-run flow

1. Go to **Profile** and paste your resume + target role + locations + keywords.
2. Click **Fetch jobs** in the nav (pulls ~hundreds of postings; takes 10-30s).
3. Click **Score new** (Claude scores in batches of 25; rerun until "remaining" is 0).
4. Browse the ranked list. Open a high-scoring job, click **Draft tailored cover letter**, edit, mark **Applied** after you submit.

## Adding companies

Edit `app/sources/__init__.py` and add Greenhouse / Lever slugs. The slug is the path segment in their board URL:
- `boards.greenhouse.io/anthropic` → `anthropic`
- `jobs.lever.co/figma` → `figma`

## Optional API keys

Both add real value but are entirely optional — the app runs fine without them.

**Adzuna** (broad aggregator, covers Indeed-style listings; ~100 jobs/fetch):
1. Sign up at https://developer.adzuna.com (free, 250 calls/month)
2. Add `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` to `.env`
3. Optional: `ADZUNA_COUNTRY=us` (or `gb`, `in`, `ca`, `au`, `de`, `fr`, …)

**USAJobs** (US federal government roles):
1. Request an API key at https://developer.usajobs.gov/APIRequest/Index (free, instant)
2. Add `USAJOBS_EMAIL` (the email you registered) and `USAJOBS_API_KEY` to `.env`

## Phase 2 ideas (not built)

- LinkedIn adapter (requires `li_at` cookie; fragile)
- Ashby + Workable adapters
- Scheduled daily fetch + email digest
- Workday and Taleo (these are the hard ones — every install is custom)
