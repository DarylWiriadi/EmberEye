"""EmberEye API: harmonized FIRMS fire activity served from Parquet with DuckDB.

Deployed as a Vercel Python function inside the website project: Vercel turns
api/index.py into the function, and vercel.json sends every /api/* request
here. Helpers live in api/_lib/ (the underscore stops Vercel from turning each
helper file into its own function). All routes are under /api.

Local:  cd api && .venv/Scripts/python -m uvicorn index:app --port 8000
"""
import os
import sys
import time

# Make `_lib` importable however the function is loaded (Vercel or uvicorn).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import APIRouter, FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.middleware.gzip import GZipMiddleware  # noqa: E402

from _lib import db  # noqa: E402
from _lib.routes import calendar, export, hotspots  # noqa: E402

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


for r in (meta, calendar.router, hotspots.router, export.router):
    app.include_router(r, prefix=PREFIX)
