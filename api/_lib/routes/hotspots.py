"""GET /hotspots: individual hotspot points for the map.

Returns columns as parallel arrays (compact for deck.gl). If the area/date
range holds more than `limit` points, a deterministic spread-out sample is
returned with `truncated: true`; zooming in or narrowing the dates gives all
of them.
"""
from datetime import date

import duckdb
from fastapi import APIRouter, HTTPException, Query

from _lib import db
from _lib import points

router = APIRouter()

LONG_RANGE_DAYS = 366

DEFAULT_LIMIT = 20_000
MAX_LIMIT = 50_000


def clamp_dates(start: date | None, end: date | None):
    """Clamp to the point archive; default is the latest day."""
    first, last = db.points_coverage()
    if start and end and start > end:
        raise HTTPException(400, "start must be on or before end")
    return max(start or last, first), min(end or last, last), first, last


@router.get("/hotspots")
def hotspots(
    bbox: str | None = Query(None, description="west,south,east,north (degrees)"),
    cells: str | None = Query(None, description="comma-separated H3 cells, any resolution"),
    start: date | None = Query(None, description="first day (default: latest day)"),
    end: date | None = Query(None, description="last day (default: latest day)"),
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
):
    cur = db.cursor()   # first: this also loads the manifest and sets up R2
    start, end, first, last = clamp_dates(start, end)

    def count(src):
        return cur.execute(f"SELECT count(*) FROM {src.from_sql} WHERE {src.where}",
                           src.params).fetchone()[0]

    def pick(src):
        return cur.execute(f"""
            SELECT strftime(date, '%Y-%m-%d'), time_utc, round(lat::DOUBLE, 4),
                   round(lon::DOUBLE, 4), round(frp::DOUBLE, 1), confidence, sensor, daynight
            FROM {src.from_sql} WHERE {src.where}
            ORDER BY hash(cell8, date, time_utc)   -- deterministic, spatially spread sample
            LIMIT {limit}
        """, src.params).fetchall()

    # Reading every point is slow for big requests (a world view touches ~100
    # files on R2), so those use a subset of the points instead:
    #   far more points than `limit` (and the sample alone gives a decent share
    #   of `limit`), or a range over a year -> the 1-in-32 sample
    #   a continent or the world     -> the 1-in-4 sample (one file per year)
    #   otherwise                    -> every point
    rows = None
    try:
        sample = points.build_sample(cur, bbox, cells, start, end, "sample")
        if sample:
            src, every, n_bases = sample
            n = count(src)
            total = n * every
            if (total > 2 * limit and n >= limit // 4) or (end - start).days >= LONG_RANGE_DAYS:
                rows = pick(src)
            elif n_bases > points.WIDE_BASES:
                wide = points.build_sample(cur, bbox, cells, start, end, "wide")
                if wide:
                    src, every, _ = wide
                    total = count(src) * every
                    rows = pick(src)
    except duckdb.Error as e:
        db.record_r2_error(e)
        rows = None
    estimated = rows is not None
    if rows is None:
        def query(src):
            return count(src), pick(src)
        src, (total, rows) = points.run(cur, bbox, cells, start, end, query)
    cols = ["date", "time_utc", "lat", "lon", "frp_mw", "confidence", "sensor", "daynight"]
    notes = ["Observed detections (not harmonized)."]
    if not src.complete:
        notes.append(points.regions_note())
    return {
        "start": str(start), "end": str(end),
        "available": {"first": str(first), "last": str(last)},
        "source": src.source, "complete": src.complete, "notes": notes,
        "count": len(rows), "total": total, "total_estimated": estimated,
        "truncated": estimated or total > len(rows),
        "data": {c: [r[i] for r in rows] for i, c in enumerate(cols)},
    }
