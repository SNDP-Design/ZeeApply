from __future__ import annotations

import os
import re
import httpx

API = "https://api.adzuna.com/v1/api/jobs/{country}/search/{page}"

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str) -> str:
    return _TAG_RE.sub("", html or "").replace("&nbsp;", " ").strip()


async def fetch_adzuna(
    keyword: str = "",
    country: str | None = None,
    pages: int = 2,
    per_page: int = 50,
) -> list[dict]:
    """Adzuna aggregated listings (Indeed-style coverage).

    Free tier: 250 calls/month. Each page = 1 call. Default: 2 pages = 100 jobs/fetch.
    Requires ADZUNA_APP_ID + ADZUNA_APP_KEY (free signup at developer.adzuna.com).
    """
    app_id = os.environ.get("ADZUNA_APP_ID")
    app_key = os.environ.get("ADZUNA_APP_KEY")
    if not app_id or not app_key:
        raise RuntimeError(
            "Adzuna disabled: set ADZUNA_APP_ID and ADZUNA_APP_KEY in .env "
            "(free signup at https://developer.adzuna.com)"
        )

    country = (country or os.environ.get("ADZUNA_COUNTRY") or "us").lower()
    params_base = {
        "app_id": app_id,
        "app_key": app_key,
        "results_per_page": per_page,
        "content-type": "application/json",
    }
    if keyword.strip():
        params_base["what"] = keyword.strip()

    out: list[dict] = []
    async with httpx.AsyncClient(timeout=20) as client:
        for page in range(1, pages + 1):
            r = await client.get(API.format(country=country, page=page), params=params_base)
            r.raise_for_status()
            data = r.json()
            results = data.get("results", []) or []
            if not results:
                break
            for job in results:
                out.append({
                    "source": f"adzuna:{country}",
                    "external_id": str(job.get("id", "")),
                    "title": job.get("title", ""),
                    "company": (job.get("company") or {}).get("display_name", ""),
                    "location": (job.get("location") or {}).get("display_name"),
                    "url": job.get("redirect_url", ""),
                    "description": _strip_html(job.get("description", ""))[:8000],
                    "posted_at": job.get("created"),
                })
    return out
