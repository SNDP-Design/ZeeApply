"""HTTP basic auth middleware, env-gated.

If APP_USERNAME and APP_PASSWORD are both set, every request must include
matching basic-auth credentials. If either is unset (e.g. local dev), auth
is disabled and the app behaves as before.

Comparison uses secrets.compare_digest to avoid timing attacks.
"""
from __future__ import annotations

import base64
import os
import secrets

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
from starlette.types import ASGIApp


# Paths that bypass auth (none right now — gate everything including /static).
# If you ever want a public health check, add it here.
_PUBLIC_PATHS: set[str] = set()


def _credentials_configured() -> tuple[str | None, str | None]:
    u = os.environ.get("APP_USERNAME")
    p = os.environ.get("APP_PASSWORD")
    if u and p:
        return u, p
    return None, None


class BasicAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        expected_user, expected_pass = _credentials_configured()
        if not expected_user:
            # Auth disabled in this environment (local dev).
            return await call_next(request)

        if request.url.path in _PUBLIC_PATHS:
            return await call_next(request)

        header = request.headers.get("authorization", "")
        if header.startswith("Basic "):
            try:
                decoded = base64.b64decode(header[6:]).decode("utf-8", errors="ignore")
                user, _, pw = decoded.partition(":")
            except Exception:
                user = pw = ""
            if (
                secrets.compare_digest(user, expected_user)
                and secrets.compare_digest(pw, expected_pass)
            ):
                return await call_next(request)

        return Response(
            "Authentication required",
            status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="job-hunter"'},
        )


def install(app: ASGIApp) -> None:
    app.add_middleware(BasicAuthMiddleware)
