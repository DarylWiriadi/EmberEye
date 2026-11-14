"""GET /risk: a fire activity outlook per H3 res 3 cell (~12,000 km2) for a month.

Not an official fire danger rating. For month M it averages three percentiles:

  fwi       the Fire Weather Index in the month before M (GFWED), against the same
            calendar month in earlier years at that place (higher = more fire-prone)
  dryness   topsoil wetness in the latest month before M with MERRA-2 data, against
            the same calendar month in earlier years there (drier = higher)
  activity  how much usually burns there in M's calendar month (harmonized
            fire cell-days, mean over earlier years), against every other place

Places with no fire in that calendar month in any earlier year aren't rated.
"""
from datetime import date
from functools import lru_cache

from fastapi import APIRouter, HTTPException, Query, Response

from _lib import db

router = APIRouter()

CLASSES = ["Low", "Moderate", "High", "Very high", "Extreme"]
BREAKS = [0.4, 0.55, 0.7, 0.85]
MIN_YEARS = 5


def _prev(m: date) -> date:
    return date(m.year - 1, 12, 1) if m.month == 1 else date(m.year, m.month - 1, 1)


def _latest(cur, col: str, before: date) -> date | None:
    row = cur.execute(f"SELECT max(month) FROM weather WHERE {col} IS NOT NULL AND month < ?", [before]).fetchone()
    return row[0]


def _percentiles(cur, col: str, month: date, wetter_is_lower: bool = False) -> dict[int, float]:
    """Each cell's value in `month` ranked among the same calendar month in earlier years."""
    above, below = (">", "<") if wetter_is_lower else ("<", ">")
    rows = cur.execute(f"""
        WITH c AS (SELECT cell3, {col} AS v FROM weather WHERE month = ? AND {col} IS NOT NULL)
        SELECT c.cell3,
               (count(*) FILTER (WHERE h.{col} {above} c.v) + 0.5 * count(*) FILTER (WHERE h.{col} = c.v)) / count(*)
        FROM c JOIN weather h USING (cell3)
        WHERE month(h.month) = ? AND h.month < ? AND h.{col} IS NOT NULL
        GROUP BY c.cell3
        HAVING count(*) >= ?
    """, [month, month.month, month, MIN_YEARS]).fetchall()
    return {int(c): float(p) for c, p in rows}


def _activity(cur, month: date) -> dict[int, float]:
    """Mean fire cell-days in this calendar month over earlier years, ranked across places."""
    years = month.year - 2003
    rows = cur.execute("""
        SELECT c.cell3, sum(m.fire_days) / ? AS mean
        FROM monthly m JOIN cells c USING (cell5)
        WHERE month(m.month) = ? AND m.month >= DATE '2003-01-01' AND m.month < ?
        GROUP BY 1 HAVING sum(m.fire_days) > 0
    """, [years, month.month, date(month.year, 1, 1)]).fetchall()
    rows.sort(key=lambda r: r[1])
    n = len(rows)
    return {int(c): (i + 0.5) / n for i, (c, _) in enumerate(rows)}


@lru_cache(maxsize=24)
def _outlook(month: date) -> dict:
    cur = db.cursor()
    fwi_month = _latest(cur, "fwi", month)
    soil_month = _latest(cur, "soil", month)
    # Conditions older than ~2 months say little about this month.
    if fwi_month and (month.year - fwi_month.year) * 12 + month.month - fwi_month.month > 2:
        fwi_month = None
    if soil_month and (month.year - soil_month.year) * 12 + month.month - soil_month.month > 2:
        soil_month = None
    fwi = _percentiles(cur, "fwi", fwi_month) if fwi_month else {}
    dry = _percentiles(cur, "soil", soil_month, wetter_is_lower=True) if soil_month else {}
    act = _activity(cur, month)

    cells = []
    for cell, a in act.items():
        parts = [p for p in (fwi.get(cell), dry.get(cell)) if p is not None]
        if not parts:
            continue
        score = (a + sum(parts)) / (1 + len(parts))
        cls = sum(score >= b for b in BREAKS)
        pct = lambda p: None if p is None else round(p * 100)
        cells.append([format(cell, "x"), round(score * 100), cls, pct(fwi.get(cell)), pct(dry.get(cell)), pct(a)])
    return {
        "month": month.strftime("%Y-%m"),
        "conditions": {"fwi": fwi_month and fwi_month.strftime("%Y-%m"),
                       "soil": soil_month and soil_month.strftime("%Y-%m")},
        "classes": CLASSES,
        "breaks": [round(b * 100) for b in BREAKS],
        "columns": ["cell3", "score", "class", "fwi_pct", "dryness_pct", "activity_pct"],
        "cells": cells,
        "sources": ["GFWED Fire Weather Index (NASA GISS)", "MERRA-2 soil wetness (NASA GMAO)",
                    "Harmonized MODIS + VIIRS fire record (NASA FIRMS)"],
        "note": "Fire activity outlook, not an official fire danger rating.",
    }


@router.get("/risk")
def risk(response: Response, month: str | None = Query(None, pattern=r"^\d{4}-\d{2}$", description="YYYY-MM")):
    cur = db.cursor()
    last_fwi = _latest(cur, "fwi", date(9999, 1, 1))
    default = date(last_fwi.year + (last_fwi.month == 12), last_fwi.month % 12 + 1, 1)
    m = default if month is None else date(int(month[:4]), int(month[5:]), 1)
    if m < date(2003 + MIN_YEARS, 1, 1) or m > default:
        raise HTTPException(400, f"month must be between {2003 + MIN_YEARS}-01 and {default:%Y-%m}")
    response.headers["Cache-Control"] = "public, max-age=3600, s-maxage=86400"
    return {**_outlook(m), "latest": default.strftime("%Y-%m")}
