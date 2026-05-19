/**
 * ZeeApply API — Cloudflare Worker.
 *
 * Endpoints:
 *   GET  /health                         → ping
 *   POST /fetch-jobs                     → aggregates from all free job sources
 *   POST /score        body: {profile, job}   → Gemini score 0-100 + reason
 *   POST /cover-letter body: {profile, job}   → Gemini-drafted tailored letter
 *
 * Free + always-on. The Gemini API key lives ONLY as a Wrangler secret
 * (env.GEMINI_API_KEY) — never sent to the browser.
 *
 * CORS is locked to known ZeeApply origins (GitHub Pages + localhost).
 */

// ────────────────────────────────────────────────────────────────────────────
// CORS
// ────────────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://sndp-design.github.io',
  // Custom domain (uncomment + edit when you point one at the GitHub Pages site)
  // 'https://www.zeeapply.uno',
  // 'https://zeeapply.uno',
  // Local dev
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

function corsHeaders(origin, allowed) {
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Gemini fallback chain
// Tries each model in order; falls through on rate-limit / quota / 404 / 503.
// ────────────────────────────────────────────────────────────────────────────

// Try models in this exact order. The first one whose API call succeeds wins.
// Models that 404 (not yet released for your account), 429 (per-minute quota),
// 503 (overloaded), or RESOURCE_EXHAUSTED (daily quota) are skipped and the
// chain falls through. Auth errors surface immediately.
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
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// Recoverable: try next model.
function isRecoverable(status, bodyText) {
  if (status === 429 || status === 503 || status === 404 || status === 403) return true;
  const t = (bodyText || '').toLowerCase();
  return [
    'resource_exhausted', 'quota', 'rate', 'unavailable',
    'not_found', 'not found', 'model not found', 'permission_denied',
  ].some(tok => t.includes(tok));
}

async function callGemini(env, { systemInstruction, prompt, responseSchema, maxTokens = 800, temperature = 0.7 }) {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY secret is not set. Run: wrangler secret put GEMINI_API_KEY');
  }
  const generationConfig = { maxOutputTokens: maxTokens, temperature };
  if (responseSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = responseSchema;
  }
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig,
  };

  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    const url = `${GEMINI_BASE}${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const data = await r.json();
        const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
        return { text, model };
      }
      const errText = await r.text();
      if (isRecoverable(r.status, errText)) {
        lastErr = new Error(`${model} ${r.status}: ${errText.slice(0, 200)}`);
        continue;
      }
      // Non-recoverable (likely 400 / auth) — surface immediately.
      throw new Error(`${model} ${r.status}: ${errText.slice(0, 300)}`);
    } catch (e) {
      lastErr = e;
      // Network errors are usually transient — keep trying.
      continue;
    }
  }
  throw lastErr || new Error('All Gemini models failed');
}

// ────────────────────────────────────────────────────────────────────────────
// Prompts
// ────────────────────────────────────────────────────────────────────────────

const SCORE_SYSTEM = `You are a precise job-fit evaluator helping a candidate prioritize applications.

Given the candidate's profile and a single job posting, return JSON:
{"score": <int 0-100>, "reason": "<<=200 char explanation>"}

Scoring rubric:
- 85-100: Strong fit — title/seniority/tech stack/location all line up; clear ROI to apply.
- 60-84: Reasonable fit — most criteria match, 1-2 gaps the candidate could bridge.
- 30-59: Stretch — partial match; would need a tailored pitch.
- 0-29: Poor fit — skip.

HARD ZERO (score 0) when:
- The candidate's country is non-US and the job requires US citizenship, security clearance,
  Public Trust, ITAR/EAR, or explicitly states "must be authorized to work in the US without
  sponsorship" with no remote option.
- The job is on-site in a country/region the candidate cannot work in.
- Any of the candidate's exclusions hit.

Penalize: title seniority mismatch, location mismatch when candidate is strict, missing must-have
skills, "preferred US-based" without remote, visa-sponsorship gaps.
Reward: keyword overlap, domain experience, salary alignment, remote-global postings, explicit
visa sponsorship mention when needed.`;

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    reason: { type: 'string' },
  },
  required: ['score', 'reason'],
};

const COVER_SYSTEM = `You are drafting a tailored cover letter for the candidate to send for a specific job.

Constraints:
- 150-220 words, 3 short paragraphs.
- Open by referencing the specific role and one concrete thing about the company/product (inferred from job desc).
- Middle: pull 2-3 specific achievements from the resume that map to the job's must-haves. Use real numbers.
- Close: one-sentence ask for a conversation. No generic filler ("I am writing to apply for...").
- Do NOT fabricate experience the resume doesn't support. If the resume is thin on a requirement, omit it.
- Plain text, no markdown, no greeting beyond "Hi <Company> team," and no signature block.

Output the letter only — no preamble, no explanation.`;

function profileText(p) {
  return [
    `Target role: ${p?.targetRole || 'unspecified'}`,
    `Based in country: ${p?.country || 'unspecified'}`,
    `Work authorization: ${p?.workAuthorization || 'unspecified'}`,
    `Locations open to: ${p?.locations || 'any'}`,
    `Minimum salary: ${p?.minSalary || 'flexible'}`,
    `Must-have keywords: ${p?.keywords || '(none)'}`,
    `Exclusions: ${p?.exclusions || '(none)'}`,
    '',
    'Resume:',
    p?.resume || '(no resume on file)',
  ].join('\n');
}

function jobText(j) {
  return `Title: ${j.title}\nCompany: ${j.company}\nLocation: ${j.location || 'unspecified'}\nURL: ${j.url || ''}\n\nDescription:\n${(j.description || '').slice(0, 6000)}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const TAG_RE = /<[^>]+>/g;

// Robust HTML → plain text. Handles:
//   • CDATA-wrapped descriptions (already unwrapped by the RSS parser)
//   • HTML-encoded descriptions (`&lt;p&gt;…&lt;/p&gt;`) — decode entities
//     before stripping tags so encoded tags don't leak through
//   • Multi-level encoding (`&amp;lt;` → `&lt;` → `<`) — loops until stable
//   • Preserves paragraph / list structure as newlines + bullets
function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// Block-level tags we want to convert into newlines so paragraph structure
// survives the strip. Anything not in this list is just deleted.
const BLOCK_CLOSE_RE = /<\/(?:p|div|li|h[1-6]|tr|blockquote|ul|ol|section|article)>/gi;
const BR_RE = /<br\s*\/?>/gi;
const LI_OPEN_RE = /<li[^>]*>/gi;

function htmlToText(s) {
  return s
    .replace(BR_RE, '\n')
    .replace(BLOCK_CLOSE_RE, '\n')
    .replace(LI_OPEN_RE, '\n• ')
    .replace(TAG_RE, '');
}

function stripHtml(s) {
  if (!s) return '';
  // Pre-truncate. We slice to 8KB downstream anyway, so processing a
  // 50KB blob is wasted CPU. This caps the worst-case work per call.
  const trimmed = s.length > 16000 ? s.slice(0, 16000) : s;
  // First pass: decode entities, convert block tags to newlines, strip rest.
  let out = htmlToText(decodeEntities(trimmed));
  // Conditional second pass: only when double-encoding left behind entities
  // like &amp;nbsp; → &nbsp; that should have been resolved. Skipped for
  // most jobs, so the amortized CPU cost stays inside the free-tier limit.
  if (/&[a-z]+;|&#\d+;/i.test(out)) {
    out = htmlToText(decodeEntities(out));
  }
  // Whitespace normalization: collapse runs of spaces, trim around newlines,
  // cap at 2 consecutive newlines so paragraphs stay separated.
  return out
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const UA_HEADERS = { 'User-Agent': 'ZeeApply/0.1 (personal use)' };

async function getJson(url, opts = {}) {
  const r = await fetch(url, { headers: { ...UA_HEADERS, ...(opts.headers || {}) }, ...opts });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function getText(url, opts = {}) {
  const r = await fetch(url, { headers: { ...UA_HEADERS, ...(opts.headers || {}) }, ...opts });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

// ────────────────────────────────────────────────────────────────────────────
// Job sources — ported from the Python adapters
// ────────────────────────────────────────────────────────────────────────────

async function fetchGreenhouse(slug) {
  const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  return (data.jobs || []).map(j => ({
    source: `greenhouse:${slug}`,
    externalId: String(j.id),
    title: j.title || '',
    company: slug,
    location: j.location?.name || null,
    url: j.absolute_url || '',
    description: (j.content || '').slice(0, 16000),
    postedAt: j.updated_at || null,
  }));
}

async function fetchLever(slug) {
  const data = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return (data || []).map(j => {
    const descParts = [j.descriptionPlain || ''];
    for (const section of (j.lists || [])) descParts.push(section.text || '');
    return {
      source: `lever:${slug}`,
      externalId: j.id,
      title: j.text || '',
      company: slug,
      location: j.categories?.location || null,
      url: j.hostedUrl || '',
      description: descParts.join('\n\n').slice(0, 16000),
      postedAt: null,
    };
  });
}

async function fetchRemoteOK() {
  const data = await getJson('https://remoteok.com/api');
  return (data.slice(1) || []).filter(j => j && j.id).map(j => ({
    source: 'remoteok',
    externalId: String(j.id),
    title: j.position || '',
    company: j.company || '',
    location: j.location || 'Remote',
    url: j.url || j.apply_url || '',
    description: (j.description  || '').slice(0, 16000),
    postedAt: j.date || null,
  }));
}

async function fetchRemotive() {
  const data = await getJson('https://remotive.com/api/remote-jobs?category=design');
  return (data.jobs || []).map(j => ({
    source: 'remotive',
    externalId: String(j.id),
    title: j.title || '',
    company: j.company_name || '',
    location: j.candidate_required_location || 'Remote',
    url: j.url || '',
    description: (j.description  || '').slice(0, 16000),
    postedAt: j.publication_date || null,
  }));
}

async function fetchArbeitnow() {
  const data = await getJson('https://www.arbeitnow.com/api/job-board-api');
  return (data.data || []).map(j => {
    let loc = j.location || '';
    if (j.remote && !loc.toLowerCase().includes('remote')) loc = `${loc} (Remote)`.trim();
    return {
      source: 'arbeitnow',
      externalId: j.slug || '',
      title: j.title || '',
      company: j.company_name || '',
      location: loc || '—',
      url: j.url || '',
      description: (j.description  || '').slice(0, 16000),
      postedAt: String(j.created_at || ''),
    };
  });
}

async function fetchJobicy() {
  const data = await getJson('https://jobicy.com/api/v2/remote-jobs?industry=design-multimedia&count=50');
  return (data.jobs || []).map(j => ({
    source: 'jobicy',
    externalId: String(j.id || ''),
    title: j.jobTitle || '',
    company: j.companyName || '',
    location: j.jobGeo || 'Remote',
    url: j.url || '',
    description: (j.jobDescription  || '').slice(0, 16000),
    postedAt: j.pubDate || null,
  }));
}

// Crude but reliable RSS parser for WWR. We only need 4 fields per <item>.
function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const grab = (tag) => {
      const t = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const hit = t.exec(block);
      if (!hit) return '';
      let val = hit[1].trim();
      // Strip CDATA wrappers
      val = val.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
      return val;
    };
    items.push({
      title: grab('title'),
      link: grab('link'),
      guid: grab('guid'),
      description: grab('description'),
      pubDate: grab('pubDate'),
    });
  }
  return items;
}

async function fetchWeWorkRemotely() {
  const xml = await getText('https://weworkremotely.com/categories/remote-design-jobs.rss');
  const items = parseRssItems(xml);
  return items.map(item => {
    const fullTitle = item.title || '';
    const colon = fullTitle.indexOf(':');
    let company = '', role = fullTitle;
    if (colon > 0) {
      company = fullTitle.slice(0, colon).trim();
      role = fullTitle.slice(colon + 1).trim();
    }
    return {
      source: 'weworkremotely',
      externalId: (item.guid || item.link || fullTitle).trim(),
      title: role,
      company,
      location: 'Remote',
      url: item.link || '',
      description: (item.description  || '').slice(0, 16000),
      postedAt: item.pubDate || null,
    };
  });
}

// Ashby — JSON GraphQL endpoint, no auth. Used by Linear, Notion, OpenAI,
// Ramp, Mistral, Lovable, replit, Posthog, Sentry, Plaid, etc.
// The jobBoardWithTeams op only exposes brief fields (id, title, locationName).
// Full descriptions would need 1 follow-up call per job — too many subrequests
// for the Worker free tier. So Ashby jobs have minimal description; the LLM
// scorer falls back on title + company + location, and users click through
// to the Ashby page for the full posting.
async function fetchAshby(slug) {
  const query = `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
    jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
      jobPostings { id title locationName }
    }
  }`;
  const r = await fetch('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams', {
    method: 'POST',
    headers: { ...UA_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operationName: 'ApiJobBoardWithTeams',
      variables: { organizationHostedJobsPageName: slug },
      query,
    }),
  });
  if (!r.ok) throw new Error(`ashby:${slug} -> ${r.status}`);
  const data = await r.json();
  if (data?.errors?.length) {
    throw new Error(`ashby:${slug} GraphQL: ${data.errors[0].message.slice(0, 120)}`);
  }
  const jobBoard = data?.data?.jobBoard;
  if (!jobBoard) return [];   // org doesn't have a public Ashby board
  return (jobBoard.jobPostings || []).map(j => ({
    source: `ashby:${slug}`,
    externalId: j.id,
    title: j.title || '',
    company: slug,
    location: j.locationName || null,
    url: `https://jobs.ashbyhq.com/${slug}/${j.id}`,
    description: `${j.title} · ${slug}${j.locationName ? ' · ' + j.locationName : ''}. Open the apply page for full description.`,
    postedAt: null,
  }));
}

// The Muse — public API, no auth. "Design and UX" category includes a steady
// stream of designer roles from mid-size to large companies. Paginated.
async function fetchTheMuse(maxPages = 5) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await getJson(
      `https://www.themuse.com/api/public/jobs?category=Design+and+UX&page=${page}`
    );
    const results = data?.results || [];
    if (!results.length) break;
    for (const r of results) {
      out.push({
        source: 'themuse',
        externalId: String(r.id || ''),
        title: r.name || '',
        company: r.company?.name || '',
        location: (r.locations || []).map(l => l.name).join(', ') || 'Various',
        url: r.refs?.landing_page || '',
        description: (r.contents  || '').slice(0, 16000),
        postedAt: r.publication_date || null,
      });
    }
    if (page >= (data?.page_count || 1)) break;
  }
  return out;
}

// Adzuna — aggregated job listings from across the web with country-specific
// coverage. India tier (country=in) returns real India-based postings that
// none of the ATS adapters surface. Free tier: 250 calls/month per app.
// Gated on env vars — silently returns [] when ADZUNA_APP_ID/KEY aren't set.
// Set via wrangler:
//   wrangler secret put ADZUNA_APP_ID
//   wrangler secret put ADZUNA_APP_KEY
async function fetchAdzuna(env, { keyword = 'designer', country = 'in', pages = 2 } = {}) {
  if (!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY) return [];
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const params = new URLSearchParams({
      app_id: env.ADZUNA_APP_ID,
      app_key: env.ADZUNA_APP_KEY,
      results_per_page: '50',
      what: keyword,
      'content-type': 'application/json',
    });
    let data;
    try {
      data = await getJson(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${params}`);
    } catch (e) {
      // Quota exhausted or transient — stop pagination but keep what we have
      break;
    }
    const results = data?.results || [];
    if (!results.length) break;
    for (const r of results) {
      out.push({
        source: `adzuna:${country}`,
        externalId: String(r.id),
        title: r.title || '',
        company: r.company?.display_name || '',
        location: r.location?.display_name || '',
        url: r.redirect_url || '',
        description: (r.description  || '').slice(0, 16000),
        postedAt: r.created || null,
      });
    }
    if (results.length < 50) break;  // last page
  }
  return out;
}

async function fetchWorkingNomads() {
  const data = await getJson('https://www.workingnomads.com/api/exposed_jobs/');
  const DESIGN = ['design', 'ux', 'ui'];
  return (data || []).filter(j => {
    if (!j || typeof j !== 'object') return false;
    const tags = ((j.category_name || '') + ' ' + (j.tags || '')).toLowerCase();
    return DESIGN.some(t => tags.includes(t));
  }).map(j => ({
    source: 'workingnomads',
    externalId: String(j.id || j.url || ''),
    title: j.title || '',
    company: j.company_name || '',
    location: j.location || 'Remote',
    url: j.url || '',
    description: (j.description  || '').slice(0, 16000),
    postedAt: j.pub_date || null,
  }));
}

// ────────────────────────────────────────────────────────────────────────────
// Filter helpers (server-side so we don't ship 4000 jobs over the wire)
// ────────────────────────────────────────────────────────────────────────────

// Build a fast title-matcher with the filters pre-lowercased ONCE. Avoids
// re-calling toLowerCase + trim on every (filter × job) pair, which adds up
// to ~80,000 string allocations at the scale of 6000+ jobs × 13 filters and
// can blow the Workers free-tier 10ms CPU budget.
function buildTitleMatcher(filters) {
  if (!Array.isArray(filters) || filters.length === 0) return () => true;
  const lowered = filters
    .map(f => (f || '').toString().toLowerCase().trim())
    .filter(Boolean);
  if (!lowered.length) return () => true;
  return (title) => {
    const t = (title || '').toLowerCase();
    for (const f of lowered) if (t.includes(f)) return true;
    return false;
  };
}

// Positive signal: job explicitly welcomes worldwide candidates or offers
// visa sponsorship. We surface these with a 🌍 badge in the UI.
const GLOBAL_FRIENDLY_PATTERNS = [
  /\bremote\s+(?:from\s+)?(?:any|anywhere|worldwide|globally?)\b/i,
  /\b(?:work|hire)\s+from\s+anywhere\b/i,
  /\b(?:fully\s+)?remote(?:[,.\s]+(?:global|worldwide|anywhere))\b/i,
  /\bglobal(?:ly)?\s+remote\b/i,
  /\bremote\s+(?:globally|first|anywhere)\b/i,
  /\b(?:open\s+to|hiring|hire)\s+candidates?\s+(?:from\s+)?(?:anywhere|worldwide|globally|any\s+country)\b/i,
  /\bvisa\s+sponsorship\s+(?:is\s+)?(?:available|offered|provided)\b/i,
  /\b(?:we|will)\s+sponsor\s+(?:your\s+)?(?:visa|work\s+permit|relocation)\b/i,
  /\brelocation\s+(?:assistance|support|package)\s+(?:available|offered|provided)\b/i,
];

function detectGlobalFriendly(job) {
  const text = `${job.title || ''}\n${job.location || ''}\n${job.description || ''}`;
  return GLOBAL_FRIENDLY_PATTERNS.some(re => re.test(text));
}

// Generic "requires citizenship/residency of a specific country" detector.
// Catches the most common phrasings across regions: US, UK, EU/EEA, Canada,
// Australia, Singapore, India, Germany, etc. The earlier US-specific list
// remains as well to handle ITAR / clearance language that is US-only.
const COUNTRY_ONLY_PATTERNS = [
  // Generic citizenship/residency requirements — match any country name
  /\bmust\s+be\s+(?:a\s+)?(?:U\.?\s*S\.?|UK|British|EU|EEA|European|Canadian|Australian|Singaporean|Indian|German|French|Dutch|Irish|Swiss|Israeli|Japanese)\s+(?:citizen|national|resident|passport\s+holder)\b/i,
  /\b(?:U\.?\s*S\.?|UK|British|EU|EEA|European|Canadian|Australian|Singaporean|Indian|German|French|Dutch|Irish|Swiss|Israeli|Japanese)\s+(?:citizens?|nationals?|residents?|passport\s+holders?)\s+only\b/i,
  /\bmust\s+(?:reside|live|be\s+based)\s+in\s+(?:the\s+)?(?:U\.?\s*S\.?|United\s+States|UK|United\s+Kingdom|Canada|Australia|Germany|France|Singapore|Ireland|Netherlands|Switzerland|Israel|Japan)\b/i,
  /\bmust\s+have\s+(?:the\s+)?(?:legal\s+)?right\s+to\s+work\s+in\s+(?:the\s+)?(?:U\.?\s*S\.?|United\s+States|UK|United\s+Kingdom|Canada|Australia|Germany|France|Singapore|Ireland|Netherlands|Switzerland|Israel|Japan|EU|EEA)\s+without\s+sponsorship\b/i,
  /\bauthoriz(?:ed|ation)\s+to\s+work\s+in\s+(?:the\s+)?(?:U\.?\s*S\.?|United\s+States|UK|United\s+Kingdom|Canada|Australia|Germany|France|Singapore|Ireland|Netherlands|Switzerland|Israel|Japan|EU|EEA)\s+without\s+(?:current\s+or\s+future\s+)?sponsorship\b/i,
  /\b(?:U\.?\s*S\.?|UK|British|EU|EEA|European|Canadian|Australian|Singaporean|Indian|German|French|Dutch|Irish|Swiss|Israeli|Japanese)[\s-]based\s+candidates?\s+only\b/i,
  // No-sponsorship clauses (independent of country)
  /\bno\s+(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:available|offered|provided)\b/i,
  /\bunable\s+to\s+(?:provide|offer|sponsor)\s+(?:visa\s+)?sponsorship\b/i,
  /\bdo(?:es)?\s+not\s+(?:provide|offer|sponsor)\s+(?:visa\s+)?sponsorship\b/i,
  /\bvisa\s+sponsorship\s+(?:is\s+)?not\s+(?:available|offered|provided)\b/i,
  /\bwe\s+(?:cannot|don'?t|do\s+not)\s+sponsor\b/i,
];

const US_ONLY_PATTERNS = [
  /\bU\.?\s*S\.?\s*citizen(?:ship)?\s+(?:is\s+)?(?:required|mandatory|a\s+requirement)\b/i,
  /\bmust\s+be\s+(?:a\s+)?U\.?\s*S\.?\s*citizen\b/i,
  /\bonly\s+U\.?\s*S\.?\s*citizens\b/i,
  /\bU\.?\s*S\.?\s*citizens?\s+only\b/i,
  /\bU\.?\s*S\.?\s*persons?\s+only\b/i,
  /\bmust\s+be\s+(?:a\s+)?U\.?\s*S\.?\s*person\b/i,
  /\bno\s+(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:available|offered|provided)\b/i,
  /\bunable\s+to\s+(?:provide\s+|offer\s+)?(?:visa\s+)?sponsorship\b/i,
  /\bdo(?:es)?\s+not\s+(?:provide|offer|sponsor)\s+(?:visa\s+)?sponsorship\b/i,
  /\bmust\s+be\s+(?:legally\s+)?authoriz(?:ed|able)\s+to\s+work\s+in\s+(?:the\s+)?(?:U\.?\s*S\.?|United\s+States)(?:\s+without\s+sponsorship)?\b/i,
  /\bauthoriz(?:ed|ation)\s+to\s+work\s+in\s+the\s+(?:U\.?\s*S\.?|United\s+States)\s+without\s+(?:current\s+or\s+future\s+)?sponsorship\b/i,
  /\b(?:active\s+|current\s+)?(?:U\.?\s*S\.?\s+)?security\s+clearance\b/i,
  /\bsecret\s+clearance\b/i,
  /\btop\s+secret\s+clearance\b/i,
  /\bTS\/?SCI\b/i,
  /\bpublic\s+trust\s+clearance\b/i,
  /\bITAR\b/i,
  /\bEAR\s+regulations\b/i,
  /\bexport[- ]controlled\b/i,
  /\bmust\s+(?:reside|live|be\s+based)\s+in\s+the\s+(?:U\.?\s*S\.?|United\s+States)\b/i,
  /\bU\.?\s*S\.?[- ]?based\s+candidates?\s+only\b/i,
];

function detectUsOnly(job) {
  const text = `${job.title || ''}\n${job.description || ''}`;
  for (const re of US_ONLY_PATTERNS) {
    const m = re.exec(text);
    if (m) return `US-only: matched "${m[0].slice(0, 60)}"`;
  }
  return null;
}

// Worldwide-friendly visa check. Returns exclusion reason if the job
// requires citizenship/residency of a specific country that doesn't match
// the candidate's. Used for non-US candidates so they don't see UK-only,
// EU-only, Canada-only, etc. jobs either.
function detectCountrySpecific(job, candidateCountry) {
  const text = `${job.title || ''}\n${job.location || ''}\n${job.description || ''}`;
  // Skip if the job is explicitly global-friendly — sponsorship offered etc.
  if (detectGlobalFriendly(job)) return null;
  for (const re of COUNTRY_ONLY_PATTERNS) {
    const m = re.exec(text);
    if (m) return `Local-only: matched "${m[0].slice(0, 80)}"`;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// /fetch-jobs handler
// Body (all optional):
//   {
//     titleFilters: ["ui designer", "product designer", ...],
//     country: "India",
//     greenhouseCompanies: ["anthropic", "stripe", ...],
//     leverCompanies: ["palantir", ...]
//   }
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_GREENHOUSE = [
  // US / global
  'anthropic', 'airbnb', 'stripe', 'discord', 'cloudflare', 'figma',
  'databricks', 'gitlab', 'duolingo', 'reddit', 'pinterest', 'asana',
  'instacart', 'doordashusa', 'robinhood',
  // India / India-heavy (verified public boards as of build time)
  'groww', 'postman', 'phonepe', 'druva',
];
const DEFAULT_LEVER = [
  'palantir', 'mistral',
  // India / India-heavy
  'meesho', 'paytm', 'mindtickle', 'cred',
];
// Ashby — every slug here was confirmed live with public board access.
const DEFAULT_ASHBY = [
  'openai', 'Linear', 'Notion', 'Ramp', 'Mistral', 'Cohere',
  'Lovable', 'browserbase', 'replit', 'Posthog', 'Sentry', 'Plaid', 'stytch',
  // India
  'Atlan',
];

async function handleFetchJobs(request, env) {
  const body = await request.json().catch(() => ({}));
  const titleFilters = Array.isArray(body.titleFilters) ? body.titleFilters : [];
  const country = (body.country || '').trim();
  const gh = Array.isArray(body.greenhouseCompanies) && body.greenhouseCompanies.length
    ? body.greenhouseCompanies : DEFAULT_GREENHOUSE;
  const lv = Array.isArray(body.leverCompanies) && body.leverCompanies.length
    ? body.leverCompanies : DEFAULT_LEVER;
  const ab = Array.isArray(body.ashbyCompanies) && body.ashbyCompanies.length
    ? body.ashbyCompanies : DEFAULT_ASHBY;

  // Pick the most useful keyword for Adzuna: first explicit titleFilter,
  // otherwise the generic 'designer'. Adzuna doesn't accept arbitrary lists.
  const adzunaKeyword = titleFilters[0] || 'designer';
  // Default to India for the candidate's country; fall back to 'gb' or 'us'
  // if it'd return nothing — but India is the design intent here.
  const adzunaCountry = /india/i.test(country) ? 'in' : 'in';

  // All fetches in parallel via Promise.allSettled — one failure doesn't sink the rest.
  const tasks = [
    ...gh.map(s => ['greenhouse:' + s, () => fetchGreenhouse(s)]),
    ...lv.map(s => ['lever:' + s, () => fetchLever(s)]),
    ...ab.map(s => ['ashby:' + s, () => fetchAshby(s)]),
    ['remoteok', fetchRemoteOK],
    ['remotive', fetchRemotive],
    ['arbeitnow', fetchArbeitnow],
    ['jobicy', fetchJobicy],
    ['weworkremotely', fetchWeWorkRemotely],
    ['workingnomads', fetchWorkingNomads],
    ['themuse', () => fetchTheMuse(5)],
    // Adzuna India — only runs if ADZUNA_APP_ID/KEY secrets are set on the
    // Worker. Returns [] silently otherwise.
    [`adzuna:${adzunaCountry}`, () => fetchAdzuna(env, { keyword: adzunaKeyword, country: adzunaCountry })],
  ];

  const settled = await Promise.allSettled(tasks.map(([_, fn]) => fn()));
  const all = [];
  const errors = {};
  const counts = {};
  settled.forEach((r, i) => {
    const name = tasks[i][0];
    if (r.status === 'fulfilled') {
      counts[name] = r.value.length;
      all.push(...r.value);
    } else {
      errors[name] = String(r.reason).slice(0, 200);
      counts[name] = 0;
    }
  });

  // Dedupe by source+externalId
  const seen = new Set();
  const dedup = [];
  for (const j of all) {
    const key = `${j.source}|${j.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(j);
  }

  // Filter to matching titles (cheap, no LLM needed)
  const matchTitle = buildTitleMatcher(titleFilters);
  const titleFiltered = dedup.filter(j => matchTitle(j.title));

  // Now strip HTML from descriptions — ONLY on the survivors (~100 jobs)
  // instead of all 6000+. Deferred to keep the Worker free-tier CPU budget
  // happy. Adapters return raw description capped at 16KB; here we strip +
  // slice to 8KB final.
  for (const j of titleFiltered) {
    j.description = stripHtml(j.description || '').slice(0, 8000);
  }

  // Two-pass tagging:
  //   excluded     — hard-block jobs requiring local citizenship anywhere
  //   globalFriendly — surface jobs that explicitly welcome worldwide candidates
  const nonUs = country && !['united states', 'usa', 'us'].includes(country.toLowerCase());
  const final = titleFiltered.map(j => {
    // For non-US candidates, exclude both US-only AND any-other-country-only language.
    // For US-based candidates, only exclude truly local-only (uses the generic check).
    const excluded = nonUs
      ? (detectUsOnly(j) || detectCountrySpecific(j, country))
      : null;
    return {
      ...j,
      excluded,
      globalFriendly: !excluded && detectGlobalFriendly(j),
    };
  });

  return {
    fetched: all.length,
    afterDedupe: dedup.length,
    afterTitleFilter: titleFiltered.length,
    excludedUsOnly: final.filter(j => j.excluded).length,
    globalFriendly: final.filter(j => j.globalFriendly).length,
    counts,
    errors,
    jobs: final,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// /score and /cover-letter handlers
// ────────────────────────────────────────────────────────────────────────────

async function handleScore(env, request) {
  const { profile, job } = await request.json();
  if (!profile || !job) return { error: 'Body must include {profile, job}' };
  const prompt = `CANDIDATE PROFILE\n${profileText(profile)}\n\nJOB\n${jobText(job)}`;
  const { text, model } = await callGemini(env, {
    systemInstruction: SCORE_SYSTEM,
    prompt,
    responseSchema: SCORE_SCHEMA,
    maxTokens: 300,
    temperature: 0.2,
  });
  let score = 0, reason = '';
  try {
    const data = JSON.parse(text);
    score = Math.max(0, Math.min(100, parseInt(data.score, 10) || 0));
    reason = String(data.reason || '').slice(0, 300);
  } catch (e) {
    reason = `Parse error: ${String(e).slice(0, 120)}`;
  }
  return { score, reason, model };
}

async function handleCoverLetter(env, request) {
  const { profile, job } = await request.json();
  if (!profile || !job) return { error: 'Body must include {profile, job}' };
  const prompt = `CANDIDATE\n${profileText(profile)}\n\nJOB\n${jobText(job)}`;
  const { text, model } = await callGemini(env, {
    systemInstruction: COVER_SYSTEM,
    prompt,
    maxTokens: 800,
    temperature: 0.7,
  });
  return { text, model };
}

// ────────────────────────────────────────────────────────────────────────────
// Entry
// ────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
      });

    try {
      if (path === '/' || path === '/health') {
        return json({ ok: true, service: 'zeeapply-api', time: new Date().toISOString() });
      }

      // Same-origin lock for write endpoints. /health stays public for monitoring.
      if (!allowed && origin) {
        return json({ error: `Origin ${origin} not allowed` }, 403);
      }

      if (request.method !== 'POST') {
        return json({ error: 'Use POST' }, 405);
      }

      if (path === '/fetch-jobs') return json(await handleFetchJobs(request, env));
      if (path === '/score') return json(await handleScore(env, request));
      if (path === '/cover-letter') return json(await handleCoverLetter(env, request));

      return json({ error: `Unknown path ${path}` }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e).slice(0, 500) }, 500);
    }
  },
};
