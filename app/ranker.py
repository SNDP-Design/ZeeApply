"""Gemini-powered job scorer and cover-letter drafter.

Uses google-genai SDK (the new one, not the deprecated google-generativeai).
gemini-2.5-flash sits comfortably in Google's free tier for hobbyist volumes
(thousands of jobs/day). Scoring uses native JSON-output mode so we get
structured results without regex parsing.
"""
from __future__ import annotations

import json
import os
from typing import Optional

from google import genai
from google.genai import types

MODEL = "gemini-2.5-flash"
_client: Optional[genai.Client] = None


def client() -> genai.Client:
    global _client
    if _client is None:
        if not os.environ.get("GEMINI_API_KEY"):
            raise RuntimeError(
                "GEMINI_API_KEY is not set. Get one free at https://aistudio.google.com/apikey"
            )
        _client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    return _client


SCORE_SYSTEM = """You are a precise job-fit evaluator helping a candidate prioritize applications.

Given the candidate's profile and a single job posting, return JSON:
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
visa sponsorship mention when the candidate needs it."""


COVER_SYSTEM = """You are drafting a tailored cover letter for the candidate to send for a specific job.

Constraints:
- 150-220 words, 3 short paragraphs.
- Open by referencing the specific role and one concrete thing about the company/product (inferred from job desc).
- Middle: pull 2-3 specific achievements from the resume that map to the job's must-haves. Use real numbers.
- Close: one-sentence ask for a conversation. No generic filler ("I am writing to apply for...").
- Do NOT fabricate experience the resume doesn't support. If the resume is thin on a requirement, omit it rather than invent.
- Plain text, no markdown, no greeting line beyond "Hi <Company> team," and no signature block.

Output the letter only — no preamble, no explanation."""


# Schema for the scorer — forces Gemini to return exactly these two fields.
_SCORE_SCHEMA = {
    "type": "object",
    "properties": {
        "score": {"type": "integer", "minimum": 0, "maximum": 100},
        "reason": {"type": "string"},
    },
    "required": ["score", "reason"],
}


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


def score_job(profile: dict, job: dict) -> tuple[int, str]:
    prompt = f"CANDIDATE PROFILE\n{_profile_text(profile)}\n\nJOB\n{_job_text(job)}"
    response = client().models.generate_content(
        model=MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=SCORE_SYSTEM,
            response_mime_type="application/json",
            response_schema=_SCORE_SCHEMA,
            max_output_tokens=300,
            temperature=0.2,
        ),
    )
    raw = (response.text or "").strip()
    if not raw:
        return 0, "Empty response from Gemini"
    try:
        data = json.loads(raw)
        score = max(0, min(100, int(data.get("score", 0))))
        reason = str(data.get("reason", ""))[:300]
        return score, reason
    except (ValueError, json.JSONDecodeError) as e:
        return 0, f"Parse error: {e}"


def draft_cover_letter(profile: dict, job: dict) -> str:
    prompt = f"CANDIDATE\n{_profile_text(profile)}\n\nJOB\n{_job_text(job)}"
    response = client().models.generate_content(
        model=MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=COVER_SYSTEM,
            max_output_tokens=800,
            temperature=0.7,
        ),
    )
    return (response.text or "").strip()
