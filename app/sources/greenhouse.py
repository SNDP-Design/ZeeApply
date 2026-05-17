import re
import httpx

API = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str) -> str:
    return _TAG_RE.sub("", html or "").replace("&nbsp;", " ").strip()


async def fetch_greenhouse(slug: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(API.format(slug=slug))
        r.raise_for_status()
        data = r.json()
    out: list[dict] = []
    for job in data.get("jobs", []):
        out.append({
            "source": f"greenhouse:{slug}",
            "external_id": str(job["id"]),
            "title": job.get("title", ""),
            "company": slug,
            "location": (job.get("location") or {}).get("name"),
            "url": job.get("absolute_url", ""),
            "description": _strip_html(job.get("content", ""))[:8000],
            "posted_at": job.get("updated_at"),
        })
    return out
