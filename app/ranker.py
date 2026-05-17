from __future__ import annotations

import json
import os
import re
from typing import Optional

from anthropic import Anthropic

MODEL = "claude-opus-4-7"
_client: Optional[Anthropic] = None


def client() -> Anthropic:
    global _client
    if _client is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        _client = Anthropic()
    return _client


SCORE_SYSTEM = """You are a precise job-fit evaluator helping a candidate prioritize applications.

Given the candidate's profile and a single job posting, output strict JSON:
{"score": <int 0-100>, "reason": "<<=200 char explanation>"}

Scoring rubric:
- 85-100: Strong fit — title/seniority/tech stack/location all line up; clear ROI to apply.
- 60-84: Reasonable fit — most criteria match, 1-2 gaps the candidate could bridge.
- 30-59: Stretch — partial match; would need a tailored pitch.
- 0-29: Poor fit — skip.

HARD ZERO (score 0) when:
- The candidate's country is non-US and the job requires US citizenship, security clearance,
  Public Trust, ITAR/EAR, or explicitly states "must be authorized to work in the US without
  sponsorship" with no remote option.
- The job is on-site in a country/region the candidate cannot work in.
- Any of the candidate's exclusions hit.

Penalize: title seniority mismatch, location mismatch when candidate is strict, missing must-have
skills, "preferred US-based" without remote, visa-sponsorship gaps for the candidate's situation.
Reward: keyword overlap, domain experience, salary alignment, remote-global postings, explicit
visa sponsorship mention when the candidate needs it.
Return JSON only, no prose."""


COVER_SYSTEM = """You are drafting a tailored cover letter for the candidate to send for a specific job.

Constraints:
- 150-220 words, 3 short paragraphs.
- Open by referencing the specific role and one concrete thing about the company/product (inferred from job desc).
- Middle: pull 2-3 specific achievements from the resume that map to the job's must-haves. Use real numbers.
- Close: one-sentence ask for a conversation. No generic filler ("I am writing to apply for...").
- Do NOT fabricate experience the resume doesn't support. If the resume is thin on a requirement, omit it rather than invent.
- Plain text, no markdown, no greeting line beyond "Hi <Company> team," and no signature block.

Output the letter only — no preamble, no explanation."""


def _profile_text(profile: dict) -> str:
    parts = [
        f"Target role: {profile.get('target_role') or 'unspecified'}",
        f"Based in country: {profile.get('country') or 'unspecified'}",
        f"Work authorization: {profile.get('work_authorization') or 'unspecified'}",
        f"Locations open to: {profile.get('locations') or 'any'}",
        f"Minimum salary: {profile.get('min_salary') or 'flexible'}",
        f"Must-have keywords: {profile.get('keywords') or '(none)'}",
        f"Exclusions: {profile.get('exclusions') or '(none)'}",
        "",
        "Resume:",
        profile.get("resume") or "(no resume on file)",
    ]
    return "\n".join(parts)


def _job_text(job: dict) -> str:
    return (
        f"Title: {job['title']}\n"
        f"Company: {job['company']}\n"
        f"Location: {job.get('location') or 'unspecified'}\n"
        f"URL: {job.get('url')}\n\n"
        f"Description:\n{(job.get('description') or '')[:6000]}"
    )


_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


def score_job(profile: dict, job: dict) -> tuple[int, str]:
    msg = client().messages.create(
        model=MODEL,
        max_tokens=300,
        system=SCORE_SYSTEM,
        messages=[{
            "role": "user",
            "content": f"CANDIDATE PROFILE\n{_profile_text(profile)}\n\nJOB\n{_job_text(job)}",
        }],
    )
    text = msg.content[0].text.strip()
    match = _JSON_RE.search(text)
    if not match:
        return 0, "Could not parse score response"
    try:
        data = json.loads(match.group(0))
        score = max(0, min(100, int(data.get("score", 0))))
        reason = str(data.get("reason", ""))[:300]
        return score, reason
    except (ValueError, json.JSONDecodeError) as e:
        return 0, f"Parse error: {e}"


def draft_cover_letter(profile: dict, job: dict) -> str:
    msg = client().messages.create(
        model=MODEL,
        max_tokens=800,
        system=COVER_SYSTEM,
        messages=[{
            "role": "user",
            "content": f"CANDIDATE\n{_profile_text(profile)}\n\nJOB\n{_job_text(job)}",
        }],
    )
    return msg.content[0].text.strip()
