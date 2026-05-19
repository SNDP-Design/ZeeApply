/**
 * ZeeApply API — Cloudflare Worker.
 *
 * Endpoints:
 *   GET  /health      → ping
 *   POST /fetch-jobs  → aggregates from all free job sources
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
// for the Worker free tier. So Ashby jobs have a minimal description; users
// click through to the Ashby page for the full posting.
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

// ────────────────────────────────────────────────────────────────────────────
// Visa / right-to-work filter
//
// Returns an exclusion reason string if the job demands citizenship,
// residency, or right-to-work in a country that isn't the candidate's —
// or refuses visa sponsorship in a country the candidate isn't already in.
// Returns null otherwise. The /fetch-jobs handler drops excluded jobs
// entirely so they never reach Firestore or the UI.
// ────────────────────────────────────────────────────────────────────────────

// Positive signal that short-circuits exclusion: job explicitly welcomes
// worldwide candidates or offers visa sponsorship.
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
function isGlobalFriendly(text) {
  return GLOBAL_FRIENDLY_PATTERNS.some(re => re.test(text));
}

// Country tokens we recognize. The keys are the canonical token; values
// are the regex alternation fragments used in both the demand patterns
// (capturing which country the job demands) and the location patterns
// (deciding whether the job is in the candidate's own country).
const COUNTRY_DEMAND_NAMES = {
  us: 'U\\.?\\s*S\\.?|U\\.?S\\.?A|United\\s+States|American',
  uk: 'UK|U\\.?K\\.?|United\\s+Kingdom|British',
  eu: 'EU|EEA|European(?:\\s+Union)?',
  ca: 'Canada|Canadian',
  au: 'Australia|Australian',
  sg: 'Singapore|Singaporean',
  in: 'India|Indian',
  de: 'Germany|German',
  fr: 'France|French',
  nl: 'Netherlands|Dutch',
  ie: 'Ireland|Irish',
  ch: 'Switzerland|Swiss',
  il: 'Israel|Israeli',
  jp: 'Japan|Japanese',
};
const COUNTRY_LOCATION_PATTERNS = {
  us: /\b(united\s+states|u\.?\s*s\.?\s*a?\b|usa\b|new\s+york|san\s+francisco|seattle|chicago|boston|austin|los\s+angeles|atlanta|denver|miami)\b/i,
  uk: /\b(united\s+kingdom|u\.?\s*k\.?\b|britain|england|london|manchester|edinburgh|bristol|cambridge\s*,?\s*uk)\b/i,
  eu: /\b(european\s+union|eu\s+only|eea\b)\b/i,
  ca: /\b(canada|toronto|vancouver|montreal|ottawa|calgary)\b/i,
  au: /\b(australia|sydney|melbourne|brisbane|perth)\b/i,
  sg: /\bsingapore\b/i,
  in: /\b(india|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|chennai|kolkata|noida|gurgaon|gurugram|ahmedabad|jaipur|kochi|trivandrum|thiruvananthapuram|indore|chandigarh|kerala|karnataka|maharashtra|tamil\s*nadu|telangana|gujarat)\b/i,
  de: /\b(germany|berlin|munich|hamburg|frankfurt)\b/i,
  fr: /\b(france|paris|lyon|marseille)\b/i,
  nl: /\b(netherlands|amsterdam|rotterdam|the\s+hague)\b/i,
  ie: /\b(ireland|dublin|cork)\b/i,
  ch: /\b(switzerland|zurich|geneva|basel|bern)\b/i,
  il: /\b(israel|tel\s*aviv|jerusalem|haifa)\b/i,
  jp: /\b(japan|tokyo|osaka|kyoto)\b/i,
};

// Build "country-demanding" patterns once. Each pattern is paired with a
// callback that resolves the captured country fragment to a canonical token.
function buildCountryDemandPatterns() {
  const altParts = [];
  const altToToken = [];
  for (const [token, frag] of Object.entries(COUNTRY_DEMAND_NAMES)) {
    altParts.push(frag);
    altToToken.push(token);
  }
  const alt = altParts.map(p => `(?:${p})`).join('|');
  // The captured group is the whole country fragment text — we resolve to a
  // token by re-running each token's regex against the match. Cheap enough.
  const c = `(${alt})`;
  const wrap = (body) => new RegExp(body.replace('__C__', c), 'i');
  return [
    wrap(`\\bmust\\s+be\\s+(?:a\\s+)?__C__\\s+(?:citizen|national|resident|passport\\s+holder)\\b`),
    wrap(`\\b__C__\\s+(?:citizens?|nationals?|residents?|passport\\s+holders?)\\s+only\\b`),
    wrap(`\\bmust\\s+(?:reside|live|be\\s+based)\\s+in\\s+(?:the\\s+)?__C__\\b`),
    wrap(`\\bmust\\s+have\\s+(?:the\\s+)?(?:legal\\s+)?right\\s+to\\s+work\\s+in\\s+(?:the\\s+)?__C__\\s+without\\s+sponsorship\\b`),
    wrap(`\\bauthoriz(?:ed|ation)\\s+to\\s+work\\s+in\\s+(?:the\\s+)?__C__\\s+without\\s+(?:current\\s+or\\s+future\\s+)?sponsorship\\b`),
    wrap(`\\bonly\\s+(?:open\\s+to\\s+)?__C__\\s+(?:citizens|nationals|residents)\\b`),
    wrap(`\\b__C__[\\s-]based\\s+(?:candidates?|applicants?)\\s+only\\b`),
  ];
}
const COUNTRY_DEMAND_PATTERNS = buildCountryDemandPatterns();

function resolveCountryToken(matchedText) {
  const t = (matchedText || '').toLowerCase();
  for (const [token, frag] of Object.entries(COUNTRY_DEMAND_NAMES)) {
    if (new RegExp(`^(?:${frag})$`, 'i').test(matchedText)) return token;
    // Fallback substring check in case the token's fragment doesn't fully match
    if (new RegExp(`\\b(?:${frag})\\b`, 'i').test(t)) return token;
  }
  return '';
}

// US-only phrasings that don't name a country in a single capture group
// (clearance, ITAR, etc). Always excluded for non-US candidates.
const US_CLEARANCE_PATTERNS = [
  /\b(?:active\s+|current\s+)?(?:U\.?\s*S\.?\s+)?security\s+clearance\b/i,
  /\bsecret\s+clearance\b/i,
  /\btop\s+secret\s+clearance\b/i,
  /\bTS\/?SCI\b/i,
  /\bpublic\s+trust\s+clearance\b/i,
  /\bITAR\b/i,
  /\bEAR\s+regulations\b/i,
  /\bexport[- ]controlled\b/i,
  /\bU\.?\s*S\.?\s*persons?\s+only\b/i,
  /\bmust\s+be\s+(?:a\s+)?U\.?\s*S\.?\s*person\b/i,
];

// Country-agnostic no-sponsorship clauses. Excluded unless the job's
// location matches the candidate's country (so they don't need sponsorship).
const NO_SPONSORSHIP_PATTERNS = [
  /\bno\s+(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:available|offered|provided)\b/i,
  /\bunable\s+to\s+(?:provide|offer|sponsor)\s+(?:visa\s+)?sponsorship\b/i,
  /\bdo(?:es)?\s+not\s+(?:provide|offer|sponsor)\s+(?:visa\s+)?sponsorship\b/i,
  /\bvisa\s+sponsorship\s+(?:is\s+)?not\s+(?:available|offered|provided)\b/i,
  /\bwe\s+(?:cannot|don'?t|do\s+not)\s+sponsor\b/i,
];

function normalizeCountry(c) {
  const s = (c || '').toLowerCase().trim();
  if (!s) return '';
  if (/\b(us|usa|u\.?s\.?|united\s*states|america)\b/.test(s)) return 'us';
  if (/\b(uk|u\.?k\.?|united\s*kingdom|britain|england)\b/.test(s)) return 'uk';
  if (/india/.test(s)) return 'in';
  if (/canad/.test(s)) return 'ca';
  if (/austral/.test(s)) return 'au';
  if (/german/.test(s)) return 'de';
  if (/(france|french)/.test(s)) return 'fr';
  if (/singapore/.test(s)) return 'sg';
  if (/(netherlands|dutch|holland)/.test(s)) return 'nl';
  if (/(ireland|irish)/.test(s)) return 'ie';
  if (/(switzerland|swiss)/.test(s)) return 'ch';
  if (/israel/.test(s)) return 'il';
  if (/japan/.test(s)) return 'jp';
  if (/\b(eu|eea|european)\b/.test(s)) return 'eu';
  return '';
}

function jobIsInCandidateCountry(job, candidateToken) {
  if (!candidateToken) return false;
  const loc = job.location || '';
  const re = COUNTRY_LOCATION_PATTERNS[candidateToken];
  return re ? re.test(loc) : false;
}

function detectVisaExclusion(job, candidateCountry) {
  const candidateToken = normalizeCountry(candidateCountry);
  // If we don't know the candidate's country, we can't make a relative
  // judgement — skip filtering entirely.
  if (!candidateToken) return null;

  const text = `${job.title || ''}\n${job.location || ''}\n${job.description || ''}`;
  if (isGlobalFriendly(text)) return null;

  // 1. US clearance / ITAR / "US persons only" — excludes everyone except US.
  if (candidateToken !== 'us') {
    for (const re of US_CLEARANCE_PATTERNS) {
      const m = re.exec(text);
      if (m) return `US-only: "${m[0].slice(0, 60)}"`;
    }
  }

  // 2. Explicit country demand — exclude if the demanded country isn't the
  //    candidate's own country.
  for (const re of COUNTRY_DEMAND_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const demanded = resolveCountryToken(m[1]);
    if (!demanded || demanded === candidateToken) continue;
    // EU candidates are also OK with EU-wide demands and vice versa is too
    // permissive, but we treat EU as its own bucket — candidates set "EU"
    // explicitly to opt in.
    return `Local-only (${demanded.toUpperCase()}): "${m[0].slice(0, 80)}"`;
  }

  // 3. Country-agnostic "no sponsorship" — exclude unless the job is in the
  //    candidate's own country (where they don't need sponsorship).
  if (!jobIsInCandidateCountry(job, candidateToken)) {
    for (const re of NO_SPONSORSHIP_PATTERNS) {
      const m = re.exec(text);
      if (m) return `No-sponsorship: "${m[0].slice(0, 60)}"`;
    }
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
  // Adzuna is hard-coded to the India tier for now — that's where this app
  // currently adds the most non-overlapping postings. Make it configurable
  // when supporting more candidate countries.
  const adzunaCountry = 'in';

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

  // Visa filter: drop jobs that require right-to-work in a country other
  // than the candidate's, or refuse visa sponsorship for jobs located
  // outside the candidate's country. The client never sees these.
  const kept = [];
  const excludedSamples = [];
  let excludedCount = 0;
  for (const j of titleFiltered) {
    const reason = detectVisaExclusion(j, country);
    if (reason) {
      excludedCount++;
      if (excludedSamples.length < 5) {
        excludedSamples.push({ title: j.title, company: j.company, reason });
      }
      continue;
    }
    kept.push(j);
  }

  return {
    fetched: all.length,
    afterDedupe: dedup.length,
    afterTitleFilter: titleFiltered.length,
    excludedVisa: excludedCount,
    excludedSamples,
    counts,
    errors,
    jobs: kept,
  };
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

      return json({ error: `Unknown path ${path}` }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e).slice(0, 500) }, 500);
    }
  },
};
