import re
import httpx

API = "https://api.lever.co/v0/postings/{slug}?mode=json"

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str) -> str:
    return _TAG_RE.sub("", html or "").replace("&nbsp;", " ").strip()


async def fetch_lever(slug: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(API.format(slug=slug))
        r.raise_for_status()
        data = r.json()
    out: list[dict] = []
    for job in data:
        cats = job.get("categories") or {}
        desc_parts = [job.get("descriptionPlain", "")]
        for section in job.get("lists", []) or []:
            desc_parts.append(section.get("text", ""))
        out.append({
            "source": f"lever:{slug}",
            "external_id": job["id"],
            "title": job.get("text", ""),
            "company": slug,
            "location": cats.get("location"),
            "url": job.get("hostedUrl", ""),
            "description": _strip_html("\n\n".join(desc_parts))[:8000],
            "posted_at": None,
        })
    return out
