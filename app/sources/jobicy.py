import re
import httpx

API = "https://jobicy.com/api/v2/remote-jobs"
# Jobicy "industry" slug for design roles.
DEFAULT_INDUSTRY = "design-multimedia"

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str) -> str:
    return _TAG_RE.sub("", html or "").replace("&nbsp;", " ").strip()


async def fetch_jobicy(industry: str = DEFAULT_INDUSTRY) -> list[dict]:
    params = {"industry": industry, "count": 50} if industry else {"count": 50}
    async with httpx.AsyncClient(
        timeout=20,
        headers={"User-Agent": "job-hunter/0.1 (personal use)"},
    ) as client:
        r = await client.get(API, params=params)
        r.raise_for_status()
        data = r.json()
    out: list[dict] = []
    for job in data.get("jobs", []):
        out.append({
            "source": "jobicy",
            "external_id": str(job.get("id", "")),
            "title": job.get("jobTitle", ""),
            "company": job.get("companyName", ""),
            "location": job.get("jobGeo") or "Remote",
            "url": job.get("url", ""),
            "description": _strip_html(job.get("jobDescription", ""))[:8000],
            "posted_at": job.get("pubDate"),
        })
    return out
