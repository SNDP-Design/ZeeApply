from .greenhouse import fetch_greenhouse
from .lever import fetch_lever
from .remoteok import fetch_remoteok
from .remotive import fetch_remotive
from .arbeitnow import fetch_arbeitnow
from .jobicy import fetch_jobicy
from .adzuna import fetch_adzuna
from .usajobs import fetch_usajobs
from .weworkremotely import fetch_weworkremotely
from .workingnomads import fetch_workingnomads
from .hn_whoishiring import fetch_hn_whoishiring

# Seed companies you'd like to follow on Greenhouse/Lever.
# Slugs come from the board URL: boards.greenhouse.io/<slug> / jobs.lever.co/<slug>
# Verified live (returns jobs) at build time. To add more, find the slug
# in the board URL: boards.greenhouse.io/<slug> or jobs.lever.co/<slug>.
GREENHOUSE_COMPANIES = [
    "anthropic",
    "airbnb",
    "stripe",
    "discord",
    "cloudflare",
    "figma",
    "databricks",
    "gitlab",
    "duolingo",
    "reddit",
    "pinterest",
    "asana",
    "instacart",
    "doordashusa",
    "robinhood",
]

LEVER_COMPANIES = [
    "palantir",
    "mistral",
]


async def fetch_all(keyword: str = "", country: str = "") -> list[dict]:
    """Fetch from every wired-up source.

    `keyword` is used by keyword-driven sources (Adzuna, USAJobs).
    `country` controls source eligibility — USAJobs is skipped entirely
    for non-US candidates since every federal role requires US citizenship.
    """
    is_us = country.strip().lower() in {"", "united states", "usa", "us"}
    jobs: list[dict] = []

    # Company boards (no keyword needed)
    for slug in GREENHOUSE_COMPANIES:
        try:
            jobs.extend(await fetch_greenhouse(slug))
        except Exception as e:
            print(f"[greenhouse:{slug}] {e}")
    for slug in LEVER_COMPANIES:
        try:
            jobs.extend(await fetch_lever(slug))
        except Exception as e:
            print(f"[lever:{slug}] {e}")

    # Open boards (no auth). Several use a design-only endpoint internally.
    for name, fn in [
        ("remoteok", fetch_remoteok),
        ("remotive", fetch_remotive),
        ("arbeitnow", fetch_arbeitnow),
        ("jobicy", fetch_jobicy),
        ("weworkremotely", fetch_weworkremotely),
        ("workingnomads", fetch_workingnomads),
        ("hn-whoishiring", fetch_hn_whoishiring),
    ]:
        try:
            jobs.extend(await fn())
        except Exception as e:
            print(f"[{name}] {e}")

    # Keyword-driven sources (env-key gated; skip silently if not configured)
    keyword_sources = [("adzuna", fetch_adzuna)]
    if is_us:
        keyword_sources.append(("usajobs", fetch_usajobs))
    else:
        print("[usajobs] skipped: federal roles require US citizenship")
    for name, fn in keyword_sources:
        try:
            jobs.extend(await fn(keyword=keyword))
        except Exception as e:
            print(f"[{name}] {e}")

    return jobs
