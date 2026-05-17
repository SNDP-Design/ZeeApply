from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "zeeapply.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    resume TEXT NOT NULL DEFAULT '',
    target_role TEXT NOT NULL DEFAULT '',
    locations TEXT NOT NULL DEFAULT '',
    min_salary INTEGER,
    exclusions TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    work_authorization TEXT NOT NULL DEFAULT '',
    title_filters TEXT NOT NULL DEFAULT 'ui designer, ux designer, product designer, ui/ux designer, ux/ui designer, design lead, head of design, principal designer, staff designer, senior designer, design manager, visual designer, interaction designer',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT,
    url TEXT NOT NULL,
    description TEXT,
    posted_at TEXT,
    fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
    score INTEGER,
    score_reason TEXT,
    cover_letter TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    UNIQUE(source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(score DESC);

INSERT OR IGNORE INTO profile (id) VALUES (1);
"""


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript(SCHEMA)
        # Lightweight migration: add columns that may be missing in pre-existing DBs.
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(profile)")}
        _designer_default = (
            "ui designer, ux designer, product designer, ui/ux designer, "
            "ux/ui designer, design lead, head of design, principal designer, "
            "staff designer, senior designer, design manager, visual designer, "
            "interaction designer"
        )
        for col, ddl in [
            ("country", "ALTER TABLE profile ADD COLUMN country TEXT NOT NULL DEFAULT ''"),
            ("work_authorization", "ALTER TABLE profile ADD COLUMN work_authorization TEXT NOT NULL DEFAULT ''"),
            ("title_filters", f"ALTER TABLE profile ADD COLUMN title_filters TEXT NOT NULL DEFAULT '{_designer_default}'"),
        ]:
            if col not in existing:
                conn.execute(ddl)


def get_profile() -> dict:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM profile WHERE id = 1").fetchone()
        return dict(row) if row else {}


def update_profile(data: dict) -> None:
    fields = [
        "resume", "target_role", "locations", "min_salary",
        "exclusions", "keywords", "country", "work_authorization",
        "title_filters",
    ]
    sets = ", ".join(f"{f} = ?" for f in fields)
    values = [data.get(f) for f in fields]
    with get_db() as conn:
        conn.execute(
            f"UPDATE profile SET {sets}, updated_at = CURRENT_TIMESTAMP WHERE id = 1",
            values,
        )


def upsert_job(job: dict) -> int | None:
    """Insert a job if new. Returns row id if inserted, None if it already existed."""
    with get_db() as conn:
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO jobs
                (source, external_id, title, company, location, url, description, posted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job["source"],
                job["external_id"],
                job["title"],
                job["company"],
                job.get("location"),
                job["url"],
                job.get("description"),
                job.get("posted_at"),
            ),
        )
        return cur.lastrowid if cur.rowcount else None


def list_jobs(status: str | None = None, limit: int = 100) -> list[dict]:
    query = "SELECT * FROM jobs"
    params: list = []
    if status:
        query += " WHERE status = ?"
        params.append(status)
    query += " ORDER BY COALESCE(score, -1) DESC, fetched_at DESC LIMIT ?"
    params.append(limit)
    with get_db() as conn:
        return [dict(r) for r in conn.execute(query, params).fetchall()]


def get_job(job_id: int) -> dict | None:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return dict(row) if row else None


def update_job(job_id: int, **fields) -> None:
    if not fields:
        return
    sets = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [job_id]
    with get_db() as conn:
        conn.execute(f"UPDATE jobs SET {sets} WHERE id = ?", values)


def unscored_jobs(limit: int = 50) -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs WHERE score IS NULL AND status = 'new' ORDER BY fetched_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
