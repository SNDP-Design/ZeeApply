"""US-only / citizenship-only job detection.

Catches the most common phrases recruiters use when a role legally cannot
accept non-US applicants. Conservative: we err on the side of excluding only
when the language is unambiguous, so the LLM scorer remains the safety net
for fuzzier cases ("preferred US-based", etc.).
"""
from __future__ import annotations

import re
from typing import Optional

# Hard blockers — citizenship / clearance / "must reside in US" language.
# All patterns are case-insensitive and matched against title + description.
_US_ONLY_PATTERNS = [
    # Citizenship / nationality requirements
    r"\bU\.?\s*S\.?\s*citizen(?:ship)?\s+(?:is\s+)?(?:required|mandatory|a\s+requirement)\b",
    r"\bmust\s+be\s+(?:a\s+)?U\.?\s*S\.?\s*citizen\b",
    r"\bonly\s+U\.?\s*S\.?\s*citizens\b",
    r"\bU\.?\s*S\.?\s*citizens?\s+only\b",
    r"\bU\.?\s*S\.?\s*persons?\s+only\b",  # "US persons" is an ITAR term
    r"\bmust\s+be\s+(?:a\s+)?U\.?\s*S\.?\s*person\b",
    # No-sponsorship + US-location combos
    r"\bno\s+(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:available|offered|provided)\b",
    r"\bunable\s+to\s+(?:provide\s+|offer\s+)?(?:visa\s+)?sponsorship\b",
    r"\bdo(?:es)?\s+not\s+(?:provide|offer|sponsor)\s+(?:visa\s+)?sponsorship\b",
    r"\bmust\s+be\s+(?:legally\s+)?authoriz(?:ed|able)\s+to\s+work\s+in\s+(?:the\s+)?(?:U\.?\s*S\.?|United\s+States)(?:\s+without\s+sponsorship)?\b",
    r"\bauthoriz(?:ed|ation)\s+to\s+work\s+in\s+the\s+(?:U\.?\s*S\.?|United\s+States)\s+without\s+(?:current\s+or\s+future\s+)?sponsorship\b",
    # Security clearances (de facto citizens-only)
    r"\b(?:active\s+|current\s+)?(?:U\.?\s*S\.?\s+)?security\s+clearance\b",
    r"\bsecret\s+clearance\b",
    r"\btop\s+secret\s+clearance\b",
    r"\bTS/?SCI\b",
    r"\bpublic\s+trust\s+clearance\b",
    # Export-control regimes that legally restrict to US persons
    r"\bITAR\b",
    r"\bEAR\s+regulations\b",
    r"\bexport[- ]controlled\b",
    # Residency
    r"\bmust\s+(?:reside|live|be\s+based)\s+in\s+the\s+(?:U\.?\s*S\.?|United\s+States)\b",
    r"\bU\.?\s*S\.?[- ]?based\s+candidates?\s+only\b",
]

_COMPILED = [re.compile(p, re.IGNORECASE) for p in _US_ONLY_PATTERNS]


def detect_us_only(text: str) -> Optional[str]:
    """Return a short reason string if text looks US-only, else None."""
    if not text:
        return None
    for pattern in _COMPILED:
        m = pattern.search(text)
        if m:
            return f"US-only: matched '{m.group(0)[:60]}'"
    return None


def title_matches(title: str, filters_csv: str) -> bool:
    """True if any comma-separated filter substring appears in the job title.

    Empty filters_csv => match everything (no filtering).
    Matching is case-insensitive and substring-based, so "ui designer" matches
    "Senior UI Designer (Remote)" but not "UI Engineer". Whitespace around the
    filter token is trimmed.
    """
    if not filters_csv or not filters_csv.strip():
        return True
    t = (title or "").lower()
    for raw in filters_csv.split(","):
        token = raw.strip().lower()
        if token and token in t:
            return True
    return False


def should_exclude_for_country(job: dict, country: str) -> Optional[str]:
    """Top-level check used at fetch time.

    Returns an exclusion reason if the job is incompatible with the candidate's
    country, else None. No-ops when country is empty or 'United States'.
    """
    if not country or country.strip().lower() in {"united states", "usa", "us"}:
        return None
    haystack = " ".join([
        job.get("title", "") or "",
        job.get("description", "") or "",
    ])
    return detect_us_only(haystack)
