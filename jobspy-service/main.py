# /// script
# requires-python = ">=3.10"
# dependencies = ["python-jobspy==1.5.0"]
# ///
"""
JobSpy service for LeadGenAI (Settings → JobSpy import).

A small HTTP service that runs JobSpy and returns the jobs as JSON. It never touches the database:
the Next.js app calls it, saves the jobs and enforces the cooldown. Run it on its own machine/IP so
a board blocking it affects nothing else.

  Local:   JOBSPY_SERVICE_KEY=<secret> uv run jobspy-service/main.py
  Docker:  see Dockerfile next to this file.

Env:
  JOBSPY_SERVICE_KEY   required; callers send it as "Authorization: Bearer <key>"
  JOBSPY_SERVICE_HOST  default 127.0.0.1 (Docker sets 0.0.0.0)
  JOBSPY_SERVICE_PORT  default 8766

Endpoints:
  GET  /health  -> {"ok": true}
  POST /search  {"boards": [...], "search_term": str, "location": str, "results_wanted": 1-50,
                 "hours_old": int | null}
             -> {"jobs": [...], "errors": {board: message}}
"""

import hmac
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BOARDS = {"indeed", "linkedin", "glassdoor", "zip_recruiter"}
MAX_RESULTS = 50
MAX_BODY = 10_000
KEY = os.environ.get("JOBSPY_SERVICE_KEY", "")
# One search at a time: parallel searches from one IP are what gets it blocked.
busy = threading.Lock()


def parse(body: dict) -> dict:
    boards = body.get("boards")
    if not isinstance(boards, list) or not boards or not set(boards) <= BOARDS:
        raise ValueError(f"boards must be a non-empty subset of {sorted(BOARDS)}")
    term = str(body.get("search_term") or "").strip()
    location = str(body.get("location") or "").strip()
    if not term or len(term) > 200 or not location or len(location) > 200:
        raise ValueError("search_term and location are required (max 200 characters)")
    wanted = body.get("results_wanted")
    if not isinstance(wanted, int) or not 1 <= wanted <= MAX_RESULTS:
        raise ValueError(f"results_wanted must be 1-{MAX_RESULTS}")
    hours = body.get("hours_old")
    if hours is not None and (not isinstance(hours, int) or not 1 <= hours <= 24 * 90):
        raise ValueError("hours_old must be null or 1-2160")
    return {
        "site_name": sorted(set(boards)),
        "search_term": term,
        "location": location,
        "results_wanted": wanted,
        "hours_old": hours,
        "country_indeed": "usa",  # The platform is US-only.
        "description_format": "markdown",
        "verbose": 0,
    }


def search(args: dict) -> dict:
    from jobspy import scrape_jobs  # Imported lazily so /health answers while pandas loads.

    df = scrape_jobs(**args)
    errors = {site: str(message) for site, message in (df.attrs.get("errors") or {}).items()}
    # to_json turns NaN into null and dates into ISO strings.
    jobs = json.loads(df.to_json(orient="records", date_format="iso"))
    for job in jobs:
        job.pop("emails", None)  # Never pass personal contact data on.
    return {"jobs": jobs, "errors": errors}


class Handler(BaseHTTPRequestHandler):
    server_version = "LeadGenAI-JobSpy/1"

    def reply(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self) -> bool:
        sent = self.headers.get("Authorization", "")
        return hmac.compare_digest(sent.encode(), f"Bearer {KEY}".encode())

    def do_GET(self) -> None:
        if self.path == "/health":
            self.reply(200, {"ok": True})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/search":
            return self.reply(404, {"error": "not found"})
        if not self.authorized():
            return self.reply(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self.reply(400, {"error": "body missing or too large"})
        try:
            args = parse(json.loads(self.rfile.read(length)))
        except (ValueError, json.JSONDecodeError, AttributeError) as e:
            return self.reply(400, {"error": str(e)})
        if not busy.acquire(blocking=False):
            return self.reply(429, {"error": "a search is already running"})
        try:
            self.reply(200, search(args))
        except Exception as e:  # noqa: BLE001 - report any scraper failure to the caller
            self.reply(502, {"error": f"{type(e).__name__}: {e}"[:500]})
        finally:
            busy.release()

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        print(f"[jobspy-service] {self.address_string()} {format % args}", flush=True)


def main() -> None:
    if len(KEY) < 16:
        raise SystemExit("Set JOBSPY_SERVICE_KEY (at least 16 characters).")
    host = os.environ.get("JOBSPY_SERVICE_HOST", "127.0.0.1")
    port = int(os.environ.get("JOBSPY_SERVICE_PORT", "8766"))
    print(f"[jobspy-service] listening on http://{host}:{port}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
