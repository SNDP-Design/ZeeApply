import os
import re
import httpx

API = "https://data.usajobs.gov/api/Search"

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str) -> str:
    return _TAG_RE.sub("", html or "").replace("&nbsp;", " ").strip()


async def fetch_usajobs(keyword: str = "", per_page: int = 50) -> list[dict]:
    """US federal jobs from data.usajobs.gov.

    Free, no rate-limit headaches at hobbyist volume.
    Requires USAJOBS_EMAIL (used as User-Agent per their ToS) and USAJOBS_API_KEY
    (free signup at https://developer.usajobs.gov/APIRequest/Index).
    """
    email = os.environ.get("USAJOBS_EMAIL")
    api_key = os.environ.get("USAJOBS_API_KEY")
    if not email or not api_key:
        raise RuntimeError(
            "USAJobs disabled: set USAJOBS_EMAIL and USAJOBS_API_KEY in .env "
            "(free signup at https://developer.usajobs.gov/APIRequest/Index)"
        )

    headers = {
        "User-Agent": email,
        "Authorization-Key": api_key,
        "Host": "data.usajobs.gov",
    }
    params = {"ResultsPerPage": per_page}
    if keyword.strip():
        params["Keyword"] = keyword.strip()

    async with httpx.AsyncClient(timeout=20, headers=headers) as client:
        r = await client.get(API, params=params)
        r.raise_for_status()
        data = r.json()

    items = (data.get("SearchResult") or {}).get("SearchResultItems", []) or []
    out: list[dict] = []
    for item in items:
        d = item.get("MatchedObjectDescriptor") or {}
        details = (d.get("UserArea") or {}).get("Details") or {}
        locs = d.get("PositionLocationDisplay") or ""
        out.append({
            "source": "usajobs",
            "external_id": str(d.get("PositionID") or item.get("MatchedObjectId", "")),
            "title": d.get("PositionTitle", ""),
            "company": d.get("OrganizationName", "") or d.get("DepartmentName", ""),
            "location": locs,
            "url": d.get("PositionURI", ""),
            "description": _strip_html(
                details.get("JobSummary", "") or d.get("QualificationSummary", "")
            )[:8000],
            "posted_at": d.get("PublicationStartDate"),
        })
    return out
