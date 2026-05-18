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
const stripHtml = (s) => (s || '').replace(TAG_RE, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

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
    description: stripHtml(j.content || '').slice(0, 8000),
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
      description: stripHtml(descParts.join('\n\n')).slice(0, 8000),
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
    description: stripHtml(j.description || '').slice(0, 8000),
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
    description: stripHtml(j.description || '').slice(0, 8000),
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
      description: stripHtml(j.description || '').slice(0, 8000),
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
    description: stripHtml(j.jobDescription || '').slice(0, 8000),
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
      description: stripHtml(item.description || '').slice(0, 8000),
      postedAt: item.pubDate || null,
    };
  });
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
    description: stripHtml(j.description || '').slice(0, 8000),
    postedAt: j.pub_date || null,
  }));
}

// ────────────────────────────────────────────────────────────────────────────
// Filter helpers (server-side so we don't ship 4000 jobs over the wire)
// ────────────────────────────────────────────────────────────────────────────

function titleMatches(title, filters) {
  if (!filters || filters.length === 0) return true;
  const t = (title || '').toLowerCase();
  return filters.some(f => f && t.includes(f.toLowerCase().trim()));
}

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
  'anthropic', 'airbnb', 'stripe', 'discord', 'cloudflare', 'figma',
  'databricks', 'gitlab', 'duolingo', 'reddit', 'pinterest', 'asana',
  'instacart', 'doordashusa', 'robinhood',
];
const DEFAULT_LEVER = ['palantir', 'mistral'];

async function handleFetchJobs(request) {
  const body = await request.json().catch(() => ({}));
  const titleFilters = Array.isArray(body.titleFilters) ? body.titleFilters : [];
  const country = (body.country || '').trim();
  const gh = Array.isArray(body.greenhouseCompanies) && body.greenhouseCompanies.length
    ? body.greenhouseCompanies : DEFAULT_GREENHOUSE;
  const lv = Array.isArray(body.leverCompanies) && body.leverCompanies.length
    ? body.leverCompanies : DEFAULT_LEVER;

  // All fetches in parallel via Promise.allSettled — one failure doesn't sink the rest.
  const tasks = [
    ...gh.map(s => ['greenhouse:' + s, () => fetchGreenhouse(s)]),
    ...lv.map(s => ['lever:' + s, () => fetchLever(s)]),
    ['remoteok', fetchRemoteOK],
    ['remotive', fetchRemotive],
    ['arbeitnow', fetchArbeitnow],
    ['jobicy', fetchJobicy],
    ['weworkremotely', fetchWeWorkRemotely],
    ['workingnomads', fetchWorkingNomads],
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
  const titleFiltered = dedup.filter(j => titleMatches(j.title, titleFilters));

  // Tag US-only excluded
  const nonUs = country && !['united states', 'usa', 'us'].includes(country.toLowerCase());
  const final = titleFiltered.map(j => {
    const excluded = nonUs ? detectUsOnly(j) : null;
    return { ...j, excluded };
  });

  return {
    fetched: all.length,
    afterDedupe: dedup.length,
    afterTitleFilter: titleFiltered.length,
    excludedUsOnly: final.filter(j => j.excluded).length,
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

      if (path === '/fetch-jobs') return json(await handleFetchJobs(request));
      if (path === '/score') return json(await handleScore(env, request));
      if (path === '/cover-letter') return json(await handleCoverLetter(env, request));

      return json({ error: `Unknown path ${path}` }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e).slice(0, 500) }, 500);
    }
  },
};
