import re
import httpx

API = "https://remoteok.com/api"

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str) -> str:
    return _TAG_RE.sub("", html or "").replace("&nbsp;", " ").strip()


async def fetch_remoteok() -> list[dict]:
    async with httpx.AsyncClient(
        timeout=20,
        headers={"User-Agent": "ZeeApply/0.1 (personal use)"},
    ) as client:
        r = await client.get(API)
        r.raise_for_status()
        data = r.json()
    out: list[dict] = []
    # First element is a legal/metadata object; jobs follow.
    for job in data[1:] if data else []:
        if not isinstance(job, dict) or "id" not in job:
            continue
        out.append({
            "source": "remoteok",
            "external_id": str(job["id"]),
            "title": job.get("position", ""),
            "company": job.get("company", ""),
            "location": job.get("location") or "Remote",
            "url": job.get("url") or job.get("apply_url", ""),
            "description": _strip_html(job.get("description", ""))[:8000],
            "posted_at": job.get("date"),
        })
    return out
