import re
import httpx

API = "https://www.arbeitnow.com/api/job-board-api"

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str) -> str:
    return _TAG_RE.sub("", html or "").replace("&nbsp;", " ").strip()


async def fetch_arbeitnow() -> list[dict]:
    async with httpx.AsyncClient(
        timeout=20,
        headers={"User-Agent": "ZeeApply/0.1 (personal use)"},
    ) as client:
        r = await client.get(API)
        r.raise_for_status()
        data = r.json()
    out: list[dict] = []
    for job in data.get("data", []):
        loc = job.get("location") or ""
        if job.get("remote") and "remote" not in loc.lower():
            loc = f"{loc} (Remote)".strip()
        out.append({
            "source": "arbeitnow",
            "external_id": job.get("slug", ""),
            "title": job.get("title", ""),
            "company": job.get("company_name", ""),
            "location": loc or "—",
            "url": job.get("url", ""),
            "description": _strip_html(job.get("description", ""))[:8000],
            "posted_at": str(job.get("created_at") or ""),
        })
    return out
