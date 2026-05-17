"""WeWorkRemotely — design category RSS feed.

Free, no auth, well-maintained. Updated multiple times per day.
"""
from __future__ import annotations

import re
from xml.etree import ElementTree as ET

import httpx

# Design-specific RSS feed. WWR also exposes programming, devops, etc.
RSS_URL = "https://weworkremotely.com/categories/remote-design-jobs.rss"

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str) -> str:
    return _TAG_RE.sub("", html or "").replace("&nbsp;", " ").strip()


async def fetch_weworkremotely() -> list[dict]:
    async with httpx.AsyncClient(
        timeout=20,
        headers={"User-Agent": "ZeeApply/0.1 (personal use)"},
        follow_redirects=True,
    ) as client:
        r = await client.get(RSS_URL)
        r.raise_for_status()

    root = ET.fromstring(r.text)
    out: list[dict] = []
    for item in root.iter("item"):
        title_node = item.find("title")
        link_node = item.find("link")
        guid_node = item.find("guid")
        desc_node = item.find("description")
        date_node = item.find("pubDate")

        full_title = (title_node.text or "").strip() if title_node is not None else ""
        # WWR titles look like "Company Name: Senior Product Designer"
        company, sep, role = full_title.partition(":")
        if sep:
            company, role = company.strip(), role.strip()
        else:
            company, role = "", full_title

        out.append({
            "source": "weworkremotely",
            "external_id": (guid_node.text or link_node.text or full_title).strip()
                if (guid_node is not None or link_node is not None) else full_title,
            "title": role,
            "company": company,
            "location": "Remote",
            "url": (link_node.text or "").strip() if link_node is not None else "",
            "description": _strip_html(desc_node.text or "")[:8000]
                if desc_node is not None else "",
            "posted_at": (date_node.text or "").strip() if date_node is not None else None,
        })
    return out
