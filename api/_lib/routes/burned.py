"""GET /api/burned: H3 res 7 cells (~5 km2) with at least one fire detection in
the area and date range, with the first day each cell had fire. The map draws
these, merged, as approximate outlines of the area burned so far.

Observed detections only (no modelling). Cells are much fewer than points, so
this is never sampled; very large areas are refused instead.
"""
from datetime import date

from fastapi import APIRouter, HTTPException, Query

from _lib import db, points
from _lib.routes.hotspots import clamp_dates

router = APIRouter()

MAX_CELLS = 150_000
MAX_DAYS = 366

# Parent at res 7 of a res 8 cell: set the resolution field to 7 and mark digit 8
# as unused (all digits 8..15 = 7).
CELL7 = ("((cell8 & ~(15::UBIGINT << 52)) | (7::UBIGINT << 52) "
         "| ((1::UBIGINT << 24) - 1))")


@router.get("/burned")
def burned(
    bbox: str | None = Query(None, description="west,south,east,north (degrees)"),
    cells: str | None = Query(None, description="comma-separated H3 cells, any resolution"),
    start: date | None = Query(None),
    end: date | None = Query(None),
):
    cur = db.cursor()
    start, end, first, last = clamp_dates(start, end)
    if start > end:
        raise HTTPException(404, f"Hotspots are available from {first} to {last}.")
    if (end - start).days + 1 > MAX_DAYS:
        raise HTTPException(400, f"burned areas are limited to {MAX_DAYS} days per request")

    def query(src):
        return cur.execute(f"""
            SELECT printf('%x', {CELL7}) AS cell, (min(date) - ?::DATE)::INTEGER AS first_day
            FROM {src.from_sql} WHERE {src.where}
            GROUP BY 1
            LIMIT {MAX_CELLS + 1}
        """, [start, *src.params]).fetchall()

    src, rows = points.run(cur, bbox, cells, start, end, query)
    if len(rows) > MAX_CELLS:
        raise HTTPException(413, "Too many burned cells in view; zoom in.")
    return {
        "start": str(start),
        "end": str(end),
        "res": 7,
        "source": src.source,
        "complete": src.complete,
        "count": len(rows),
        "cells": [r[0] for r in rows],
        "first_day": [r[1] for r in rows],
    }
