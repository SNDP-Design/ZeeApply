"""Working Nomads — remote-only jobs, public JSON, no auth.

Working Nomads tags each listing with categories ("design", "development", etc.).
We pull the full feed and filter to design-tagged listings client-side because
the API doesn't accept a category param.
"""
from __future__ import annotations

import re
import httpx

API = "https://www.workingnomads.com/api/exposed_jobs/"

# Tags that indicate design roles (substring match on the comma-joined tags string).
DESIGN_TAGS = ("design", "ux", "ui")

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str) -> str:
    return _TAG_RE.sub("", html or "").replace("&nbsp;", " ").strip()


async def fetch_workingnomads() -> list[dict]:
    async with httpx.AsyncClient(
        timeout=25,
        headers={"User-Agent": "job-hunter/0.1 (personal use)"},
    ) as client:
        r = await client.get(API)
        r.raise_for_status()
        data = r.json()

    out: list[dict] = []
    for job in data:
        if not isinstance(job, dict):
            continue
        tags = (job.get("category_name") or "") + " " + (job.get("tags") or "")
        tags_l = tags.lower()
        if not any(t in tags_l for t in DESIGN_TAGS):
            continue
        out.append({
            "source": "workingnomads",
            "external_id": str(job.get("id") or job.get("url", "")),
            "title": job.get("title", ""),
            "company": job.get("company_name", ""),
            "location": job.get("location") or "Remote",
            "url": job.get("url", ""),
            "description": _strip_html(job.get("description", ""))[:8000],
            "posted_at": job.get("pub_date"),
        })
    return out
