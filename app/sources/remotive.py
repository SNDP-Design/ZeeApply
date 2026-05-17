import re
import httpx

API = "https://remotive.com/api/remote-jobs"
# Remotive uses "design" as a top-level category slug.
DEFAULT_CATEGORY = "design"

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str) -> str:
    return _TAG_RE.sub("", html or "").replace("&nbsp;", " ").strip()


async def fetch_remotive(category: str = DEFAULT_CATEGORY) -> list[dict]:
    params = {"category": category} if category else None
    async with httpx.AsyncClient(
        timeout=20,
        headers={"User-Agent": "ZeeApply/0.1 (personal use)"},
    ) as client:
        r = await client.get(API, params=params)
        r.raise_for_status()
        data = r.json()
    out: list[dict] = []
    for job in data.get("jobs", []):
        out.append({
            "source": "remotive",
            "external_id": str(job["id"]),
            "title": job.get("title", ""),
            "company": job.get("company_name", ""),
            "location": job.get("candidate_required_location") or "Remote",
            "url": job.get("url", ""),
            "description": _strip_html(job.get("description", ""))[:8000],
            "posted_at": job.get("publication_date"),
        })
    return out
