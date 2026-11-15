"""EmberEye API: harmonized FIRMS fire activity served from Parquet with DuckDB.

Deployed as a Vercel Python function inside the website project: Vercel turns
api/index.py into the function, and vercel.json sends every /api/* request
here. Helpers live in api/_lib/ (the underscore stops Vercel from turning each
helper file into its own function). All routes are under /api.

Local:  cd api && .venv/Scripts/python -m uvicorn index:app --port 8000
"""
import os
from datetime import date, timedelta
import sys
import time

# Make `_lib` importable however the function is loaded (Vercel or uvicorn).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import duckdb  # noqa: E402
from fastapi import APIRouter, FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.middleware.gzip import GZipMiddleware  # noqa: E402

from _lib import db  # noqa: E402
from _lib.routes import burned, calendar, export, hotspots, risk, sim, stats  # noqa: E402

PREFIX = "/api"

app = FastAPI(title="EmberEye API", version="0.2.0",
              docs_url=f"{PREFIX}/docs", openapi_url=f"{PREFIX}/openapi.json")

app.add_middleware(GZipMiddleware, minimum_size=1000)
# Same origin as the website in production; CORS only matters for local dev
# or other sites using the API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",")],
    allow_methods=["GET"],
    allow_headers=["*"],
)

# Map data responses are cached on Vercel's CDN, so the same view (a featured fire,
# the default view) is computed once rather than for every visitor. The data only
# changes with a new deploy, which clears the CDN cache.
CACHED = {f"{PREFIX}/{p}" for p in ("hotspots", "burned", "calendar", "stats")}
RECENT_DAYS = 14


@app.middleware("http")
async def cdn_cache(request: Request, call_next):
    response = await call_next(request)
    if (request.method != "GET" or request.url.path not in CACHED or response.status_code != 200
            or "cache-control" in response.headers):
        return response
    try:
        end = date.fromisoformat(request.query_params["end"])
    except (KeyError, ValueError):
        end = None
    recent = end is None or end >= db.points_coverage()[1] - timedelta(days=RECENT_DAYS)
    response.headers["Cache-Control"] = (
        "public, max-age=60, s-maxage=3600, stale-while-revalidate=600" if recent
        else "public, max-age=300, s-maxage=604800, stale-while-revalidate=86400")
    return response



@app.exception_handler(duckdb.FatalException)
@app.exception_handler(duckdb.InternalException)
def database_crashed(_request: Request, exc: Exception):
    # DuckDB refuses every query after a fatal error; start over on the next request.
    db.log.error("DuckDB fatal error, reconnecting: %s", exc)
    db.reset()
    return JSONResponse(status_code=503, content={
        "detail": "The data service hit an internal error and has restarted. Please try again."})


meta = APIRouter()


@meta.get("")
def root():
    return {"name": "EmberEye API", "docs": f"{PREFIX}/docs", "health": f"{PREFIX}/health"}


@meta.get("/health")
def health():
    """Also used to warm up the function before a demo."""
    t = time.perf_counter()
    cur = db.cursor()
    first, last = db.coverage(cur)
    return {"ok": True, "coverage": {"first": str(first), "last": str(last)},
            "hotspot_archive": {"r2": db.r2_status, "last_r2_error": db.r2_last_error,
                                "fallback_regions": [r["name"] for r in db.regions.values()]},
            "query_ms": round((time.perf_counter() - t) * 1000, 1)}


for r in (meta, calendar.router, hotspots.router, burned.router, export.router, stats.router, sim.router, risk.router):
    app.include_router(r, prefix=PREFIX)
