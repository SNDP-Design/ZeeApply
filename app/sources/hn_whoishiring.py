"""Hacker News 'Ask HN: Who is hiring?' monthly thread.

Each month around the 1st, user `whoishiring` posts a "Who is hiring?" thread
with hundreds of top-level comments — one per company. We pull the latest
thread via HN's free public Firebase API, fetch top-level comments in parallel,
and return only the ones that mention a designer-related keyword.

Cost: 1 user fetch + 1 thread fetch + ~N comment fetches (capped). No auth.
"""
from __future__ import annotations

import asyncio
import html
import re
import httpx

HN_API = "https://hacker-news.firebaseio.com/v0"

# Keywords that strongly suggest a designer role in a freeform HN comment.
DESIGN_KEYWORDS = (
    "designer", "design lead", "head of design", "ux ", "ui ", "ui/ux",
    "ux/ui", "product design",
)

_TAG_RE = re.compile(r"<[^>]+>")
# Try to pull the first line as "Company | Role | Location" or similar.
_FIRST_LINE_RE = re.compile(r"^(.{1,160})", re.MULTILINE)


def _clean(html_text: str) -> str:
    text = _TAG_RE.sub("\n", html_text or "")
    return html.unescape(text).strip()


def _looks_like_design(text: str) -> bool:
    t = text.lower()
    return any(k in t for k in DESIGN_KEYWORDS)


def _extract_company(text: str) -> str:
    """Best-effort: take the first non-empty line, strip Markdown emphasis."""
    for line in text.splitlines():
        line = line.strip().lstrip("*_# ").rstrip("*_")
        if line:
            return line[:120]
    return "Hacker News post"


async def _get_json(client: httpx.AsyncClient, path: str):
    r = await client.get(f"{HN_API}/{path}.json")
    r.raise_for_status()
    return r.json()


async def fetch_hn_whoishiring(max_comments: int = 200, concurrency: int = 20) -> list[dict]:
    async with httpx.AsyncClient(
        timeout=20,
        headers={"User-Agent": "ZeeApply/0.1 (personal use)"},
    ) as client:
        user = await _get_json(client, "user/whoishiring")
        submitted = user.get("submitted") or []
        # Find the most recent "Ask HN: Who is hiring?" thread.
        thread_id = None
        for sid in submitted[:30]:  # newest first; only scan recent 30
            item = await _get_json(client, f"item/{sid}")
            if not item:
                continue
            title = (item.get("title") or "").lower()
            if "who is hiring" in title and not item.get("deleted"):
                thread_id = sid
                break
        if not thread_id:
            return []

        thread = await _get_json(client, f"item/{thread_id}")
        kids = (thread.get("kids") or [])[:max_comments]
        if not kids:
            return []

        sem = asyncio.Semaphore(concurrency)

        async def fetch_comment(cid: int):
            async with sem:
                try:
                    return await _get_json(client, f"item/{cid}")
                except Exception:
                    return None

        comments = await asyncio.gather(*[fetch_comment(c) for c in kids])

    out: list[dict] = []
    for c in comments:
        if not c or c.get("deleted") or c.get("dead"):
            continue
        text = _clean(c.get("text") or "")
        if not text or not _looks_like_design(text):
            continue
        cid = c.get("id")
        company = _extract_company(text)
        out.append({
            "source": "hn-whoishiring",
            "external_id": str(cid),
            "title": (company.split("|")[0] if "|" in company else company)[:120],
            "company": company,
            "location": "See post",
            "url": f"https://news.ycombinator.com/item?id={cid}",
            "description": text[:8000],
            "posted_at": None,
        })
    return out
