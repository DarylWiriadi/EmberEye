"""EmberEye API: harmonized FIRMS fire activity served from Parquet with DuckDB."""
import os
import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

import db
from routes import calendar, export, hotspots

app = FastAPI(title="EmberEye API", version="0.1.0")

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    # Comma-separated list, e.g. "https://embereye.vercel.app,http://localhost:4321"
    allow_origins=[o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",")],
    allow_methods=["GET"],
    allow_headers=["*"],
)

app.include_router(calendar.router)
app.include_router(hotspots.router)
app.include_router(export.router)


@app.get("/")
def root():
    return {"name": "EmberEye API", "docs": "/docs", "health": "/health"}


@app.get("/health")
def health():
    """Also used to warm up the function before a demo."""
    t = time.perf_counter()
    cur = db.cursor()
    first, last = db.coverage(cur)
    return {"ok": True, "coverage": {"first": str(first), "last": str(last)},
            "hotspot_archive": {"r2": db.r2_status, "last_r2_error": db.r2_last_error,
                                "fallback_regions": [r["name"] for r in db.regions.values()]},
            "query_ms": round((time.perf_counter() - t) * 1000, 1)}
