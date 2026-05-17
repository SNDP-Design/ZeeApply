"""Gemini-powered job scorer and cover-letter drafter.

Uses google-genai SDK with a model fallback chain so that the call survives
when the preferred model is rate-limited, quota-exhausted, temporarily down,
or simply not yet released. The first model that succeeds is used; failed
models go into a short per-process cooldown so we don't keep hammering them.

Chain (top = preferred):
    gemini-3-flash-preview   (latest preview — may 404 until Google publishes it)
    gemini-2.5-flash         (current stable workhorse)
    gemini-2.5-flash-lite    (5x higher quota; lower quality)
    gemini-2.0-flash         (older but very reliable)

Scoring uses native JSON-output mode (response_schema) so we get strict JSON
without regex parsing.
"""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Callable, Optional

from google import genai
from google.genai import types

# Try models in this exact order. Add/remove names to change the strategy.
MODEL_FALLBACK_CHAIN: list[str] = [
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
]

# When a model returns a recoverable error, skip it for this many seconds.
# Keeps per-call latency low when one model is consistently failing.
_COOLDOWN_SECONDS = 60
_cooldown_until: dict[str, float] = {}

# Substrings that mean "try the next model" rather than "fail loudly".
# Matched against both the exception message and any HTTP status string.
_RECOVERABLE_TOKENS = (
    "429", "rate", "resource_exhausted", "quota",
    "503", "unavailable", "overloaded",
    "404", "not_found", "not found", "model not found", "does not exist",
    "permission_denied",  # some preview models 403 for accounts without access
    "403",
)

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


def _is_recoverable(exc: BaseException) -> bool:
    msg = str(exc).lower()
    if any(tok in msg for tok in _RECOVERABLE_TOKENS):
        return True
    # google-genai raises ClientError / ServerError with a .status_code or .code attr
    code = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    if code in (429, 503, 404, 403):
        return True
    return False


def _call_with_fallback(make_call: Callable[[str], object]) -> tuple[object, str]:
    """Walk the model chain. Returns (response, model_name_used).

    `make_call(model_name)` should make exactly one generate_content call.
    """
    now = time.time()
    last_err: Optional[BaseException] = None
    for model in MODEL_FALLBACK_CHAIN:
        if _cooldown_until.get(model, 0) > now:
            continue
        try:
            return make_call(model), model
        except Exception as e:
            if _is_recoverable(e):
                _cooldown_until[model] = time.time() + _COOLDOWN_SECONDS
                last_err = e
                # Brief log so users can see fallback happening in the server output.
                print(f"[ranker] {model} unavailable ({type(e).__name__}: {str(e)[:120]}); trying next", file=sys.stderr)
                continue
            # Auth errors, malformed requests, etc. — surface immediately.
            raise
    # All models in cooldown or all raised recoverable errors.
    raise RuntimeError(
        f"All Gemini models in the fallback chain are unavailable. Last error: {last_err}"
    )


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

    def call(model: str):
        return client().models.generate_content(
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=SCORE_SYSTEM,
                response_mime_type="application/json",
                response_schema=_SCORE_SCHEMA,
                max_output_tokens=300,
                temperature=0.2,
            ),
        )

    response, _model_used = _call_with_fallback(call)
    raw = (getattr(response, "text", None) or "").strip()
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

    def call(model: str):
        return client().models.generate_content(
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=COVER_SYSTEM,
                max_output_tokens=800,
                temperature=0.7,
            ),
        )

    response, _model_used = _call_with_fallback(call)
    return (getattr(response, "text", None) or "").strip()
