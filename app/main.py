from __future__ import annotations

import asyncio
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import auth, db, ranker
from .filters import should_exclude_for_country, title_matches
from .sources import fetch_all

load_dotenv()

BASE = Path(__file__).parent
templates = Jinja2Templates(directory=str(BASE / "templates"))

app = FastAPI(title="Job Hunter")
auth.install(app)
app.mount("/static", StaticFiles(directory=str(BASE / "static")), name="static")


@app.on_event("startup")
def startup() -> None:
    db.init_db()


@app.get("/", response_class=HTMLResponse)
def index(request: Request, status: str = "new"):
    jobs = db.list_jobs(status=status if status != "all" else None)
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "jobs": jobs, "status": status, "counts": _counts()},
    )


def _counts() -> dict:
    counts = {}
    for s in ("new", "interested", "applied", "skipped", "excluded", "all"):
        counts[s] = len(db.list_jobs(status=None if s == "all" else s, limit=10000))
    return counts


@app.get("/profile", response_class=HTMLResponse)
def profile_page(request: Request):
    return templates.TemplateResponse(
        "profile.html", {"request": request, "profile": db.get_profile()}
    )


@app.post("/profile")
def save_profile(
    resume: str = Form(""),
    target_role: str = Form(""),
    locations: str = Form(""),
    min_salary: str = Form(""),
    exclusions: str = Form(""),
    keywords: str = Form(""),
    country: str = Form(""),
    work_authorization: str = Form(""),
    title_filters: str = Form(""),
):
    db.update_profile({
        "resume": resume,
        "target_role": target_role,
        "locations": locations,
        "min_salary": int(min_salary) if min_salary.strip().isdigit() else None,
        "exclusions": exclusions,
        "keywords": keywords,
        "country": country,
        "work_authorization": work_authorization,
        "title_filters": title_filters,
    })
    return RedirectResponse("/profile", status_code=303)


@app.post("/fetch")
async def fetch_jobs():
    profile = db.get_profile()
    country = (profile.get("country") or "").strip()
    title_filters = profile.get("title_filters") or ""

    # Use target_role as the keyword for Adzuna/USAJobs/HN; fall back to first
    # keyword, then to first title filter, then to "designer".
    keyword = (profile.get("target_role") or "").strip()
    if not keyword and profile.get("keywords"):
        keyword = profile["keywords"].split(",")[0].strip()
    if not keyword and title_filters:
        keyword = title_filters.split(",")[0].strip()
    if not keyword:
        keyword = "designer"

    jobs = await fetch_all(keyword=keyword, country=country)

    # Drop anything whose title doesn't match the user's title filters BEFORE
    # we write to the DB. Cheap, no LLM cost, and keeps the table small.
    filtered = [j for j in jobs if title_matches(j.get("title", ""), title_filters)]
    dropped_titles = len(jobs) - len(filtered)

    inserted = 0
    excluded = 0
    for j in filtered:
        new_id = db.upsert_job(j)
        if not new_id:
            continue
        inserted += 1
        # Auto-exclude US-only jobs for non-US candidates
        reason = should_exclude_for_country(j, country)
        if reason:
            db.update_job(new_id, status="excluded", score=-1, score_reason=reason)
            excluded += 1

    return {
        "fetched": len(jobs),
        "after_title_filter": len(filtered),
        "dropped_title_mismatch": dropped_titles,
        "new": inserted,
        "excluded_us_only": excluded,
        "keyword": keyword,
        "country": country or "(any)",
    }


@app.post("/score")
async def score_pending(limit: int = 25):
    profile = db.get_profile()
    if not (profile.get("resume") or "").strip():
        return {"error": "Set your resume in /profile first"}
    pending = db.unscored_jobs(limit=limit)
    loop = asyncio.get_event_loop()
    scored = 0
    for job in pending:
        try:
            score, reason = await loop.run_in_executor(None, ranker.score_job, profile, job)
            db.update_job(job["id"], score=score, score_reason=reason)
            scored += 1
        except Exception as e:
            db.update_job(job["id"], score=-1, score_reason=f"error: {e}")
    return {"scored": scored, "remaining": max(0, len(pending) - scored)}


@app.get("/job/{job_id}", response_class=HTMLResponse)
def job_detail(request: Request, job_id: int):
    job = db.get_job(job_id)
    if not job:
        return HTMLResponse("Not found", status_code=404)
    return templates.TemplateResponse("job.html", {"request": request, "job": job})


@app.post("/job/{job_id}/cover-letter")
async def gen_cover_letter(job_id: int):
    job = db.get_job(job_id)
    profile = db.get_profile()
    if not job:
        return {"error": "not found"}
    loop = asyncio.get_event_loop()
    letter = await loop.run_in_executor(None, ranker.draft_cover_letter, profile, job)
    db.update_job(job_id, cover_letter=letter)
    return RedirectResponse(f"/job/{job_id}", status_code=303)


@app.post("/job/{job_id}/status")
def set_status(job_id: int, status: str = Form(...)):
    db.update_job(job_id, status=status)
    return RedirectResponse(f"/job/{job_id}", status_code=303)


@app.post("/job/{job_id}/cover-letter/edit")
def save_cover_letter(job_id: int, cover_letter: str = Form("")):
    db.update_job(job_id, cover_letter=cover_letter)
    return RedirectResponse(f"/job/{job_id}", status_code=303)
