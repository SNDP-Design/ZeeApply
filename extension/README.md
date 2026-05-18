# ZeeApply — Apply Assistant (Chrome extension)

Auto-fills name, email, phone, LinkedIn, portfolio, work-auth statement, and your ZeeApply-drafted cover letter on **Greenhouse**, **Lever**, and **Ashby** apply pages.

Designed for the workflow: open job in ZeeApply → copy cover letter → open apply page → one click in the extension → fields filled in 2 seconds → you review and submit.

## What it does NOT do

- It does **not** auto-submit applications. You always click Submit yourself.
- It does **not** fill resume file uploads (you still attach the PDF yourself).
- It does **not** fill custom per-job screening questions ("Why this company?") — those need a human.
- It does **not** fill EEOC / gender / race / veteran-status fields — intentionally left for you.

## Install (~1 minute, no Chrome Web Store needed)

1. Open **chrome://extensions** in Chrome
2. Top-right: turn on **Developer mode**
3. Click **Load unpacked**
4. Pick the `extension/` folder inside this repo (the one containing `manifest.json`)
5. The ZeeApply puzzle icon appears in your toolbar. Pin it for easy access.

To update later: just `git pull`, then click the refresh icon next to ZeeApply on `chrome://extensions`.

## First-time setup

1. Click the ZeeApply icon → enter your profile fields once (name, email, phone, LinkedIn, portfolio, work-auth statement)
2. Click **Save profile**
3. Profile syncs across all your Chrome installs via `chrome.storage.sync` (it's encrypted at rest by Chrome — stays in your Google account, never leaves)

## Per-application workflow

1. In ZeeApply: open a high-scoring job → **Draft tailored cover letter** → review → click **Copy**
2. Click **Open posting** → opens the apply URL in a new tab
3. Click the ZeeApply icon → **paste** the cover letter into the box
4. Click **Fill this page →**
5. A green pill appears: *"ZeeApply: filled 7 / 8 fields. Review carefully before submitting."*
6. Review every field, attach your resume, fill any custom screening questions, click Submit.

The cover letter field is cleared after each fill so the next job starts fresh.

## Supported sites today

| ATS | Domain | Coverage |
|---|---|---|
| Greenhouse | `boards.greenhouse.io`, `job-boards.greenhouse.io` | Most fields |
| Lever | `jobs.lever.co` | Most fields (uses combined "name" field — extension handles it) |
| Ashby | `jobs.ashbyhq.com` | Most fields (React forms; events dispatched correctly) |

If a field doesn't fill: the field label/name is non-standard. Tell the maintainer (you) which ATS + which field, and add the label to `FIELD_SIGNALS` in `content.js`.

## How field detection works

For each profile field, the script tries 4 strategies in order:

1. **Input `type` attribute** — `type="email"` is unambiguous
2. **Input `name`/`id`/`autocomplete`/`aria-label` substring** — covers most ATS conventions
3. **Visible label text** — handles the cases where attribute names are randomized (Greenhouse hashes some IDs)
4. **Placeholder text** — last resort

Multiple-match disambiguation: more specific fields (firstName) match before generic ones (fullName). Already-filled inputs are claimed and not overwritten.

## Privacy

- All profile data lives in **your Chrome's `chrome.storage.sync`**. Synced via your Google account, never sent to ZeeApply servers.
- The cover letter lives in popup memory only — cleared after each fill, not stored anywhere persistent.
- No analytics, no telemetry, no remote logging.
