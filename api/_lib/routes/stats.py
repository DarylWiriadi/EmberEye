"""GET /stats: the area's monthly weather and what's burning, for the stats panel.

Fire activity over time comes from /calendar; this adds the context:

  weather    per month: air temperature (degC), relative humidity (%), wind speed
             (m/s) and the direction it blows from (deg), topsoil wetness (%,
             0 = dry) from MERRA-2, and the Fire Weather Index from GFWED.
             Averaged over the H3 res 3 cells the area's burnable res 5 cells
             fall in, weighted by how many of them each holds. Wind is averaged
             as a vector.
  landcover  share of fire activity in each land type (MODIS MCD12C1), weighted
             by each cell's harmonized fire activity in the date range (or over
             the whole record if nothing burned in it).
  latest     the most recent month (up to a year before the range end) with
             MERRA-2 weather, and with FWI, for when the range is newer than both.
"""
import math
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Query

from _lib import db
from _lib.area import select_area

router = APIRouter()

LAND_TYPES = ["forest", "shrubland", "savanna", "grassland", "cropland", "other"]


def _num(v, nd=1):
    return None if v is None else round(float(v), nd)


def _weather(cur, start: date, end: date) -> list[dict]:
    rows = cur.execute("""
        WITH s AS (SELECT cell3, count(*) AS n FROM sel GROUP BY 1),
        w AS (
            SELECT w.*, s.n,
                   w.wind / 2.0 * -sin(radians(w.wind_from * 22.5)) AS u,
                   w.wind / 2.0 * -cos(radians(w.wind_from * 22.5)) AS v
            FROM weather w JOIN s USING (cell3)
            WHERE w.month BETWEEN date_trunc('month', ?::DATE) AND ?::DATE
        )
        SELECT strftime(month, '%Y-%m'),
               sum(t2m * n) FILTER (WHERE t2m IS NOT NULL) / sum(n) FILTER (WHERE t2m IS NOT NULL),
               sum(rh * n) FILTER (WHERE rh IS NOT NULL) / sum(n) FILTER (WHERE rh IS NOT NULL),
               sum(u * n) FILTER (WHERE u IS NOT NULL) / sum(n) FILTER (WHERE u IS NOT NULL),
               sum(v * n) FILTER (WHERE v IS NOT NULL) / sum(n) FILTER (WHERE v IS NOT NULL),
               sum(soil * n) FILTER (WHERE soil IS NOT NULL) / sum(n) FILTER (WHERE soil IS NOT NULL),
               sum(fwi * n) FILTER (WHERE fwi IS NOT NULL) / sum(n) FILTER (WHERE fwi IS NOT NULL)
        FROM w GROUP BY month ORDER BY month
    """, [start, end]).fetchall()
    out = []
    for month, t2m, rh, u, v, soil, fwi in rows:
        speed = None if u is None else math.hypot(u, v)
        frm = None if u is None else (math.degrees(math.atan2(-u, -v)) + 360) % 360
        out.append({"month": month, "t2m": _num(t2m), "rh": _num(rh, 0),
                    "wind_ms": _num(speed), "wind_from_deg": _num(frm, 0),
                    "soil": _num(soil, 0), "fwi": _num(fwi)})
    return out


@router.get("/stats")
def stats(
    bbox: str | None = Query(None, description="west,south,east,north (degrees)"),
    cells: str | None = Query(None, description="comma-separated H3 cells, any resolution"),
    start: date | None = Query(None),
    end: date | None = Query(None),
):
    cur = db.cursor()
    first, last = db.coverage(cur)
    start = max(start or first, first)
    end = min(end or last, last)
    if start > end:
        raise HTTPException(400, f"empty date range; data covers {first} to {last}")
    n_cells = select_area(cur, bbox, cells)

    weather_rows = _weather(cur, start, end)
    # Weather data ends before the fire record does (MERRA-2 a month or two behind,
    # GFWED FWI a little less): also give the latest month that has each.
    recent = _weather(cur, end - timedelta(days=400), end)
    latest = {
        "weather": next((w for w in reversed(recent) if w["t2m"] is not None), None),
        "fwi": next((w for w in reversed(recent) if w["fwi"] is not None), None),
    }

    shares = ", ".join(f"sum({t} * w) / nullif(sum(w), 0)" for t in LAND_TYPES)
    lc_sql = f"""
        WITH f AS (
            SELECT cell5, sum(fire_days) AS w FROM monthly
            WHERE month BETWEEN date_trunc('month', ?::DATE) AND ?::DATE
              AND cell5 IN (SELECT cell5 FROM sel)
            GROUP BY 1
        )
        SELECT {shares}, sum(w) FROM landcover JOIN f USING (cell5)
    """
    lc = cur.execute(lc_sql, [start, end]).fetchone()
    in_range = lc is not None and lc[-1] is not None and lc[-1] > 0
    if not in_range:
        lc = cur.execute(lc_sql, [first, last]).fetchone()

    centre = cur.execute("SELECT avg(c.lat), avg(c.lng) FROM sel JOIN cells c USING (cell5)").fetchone()
    return {
        "start": str(start), "end": str(end),
        "area": {"cells_res5": n_cells,
                 "centre": None if centre[0] is None else [_num(centre[0], 3), _num(centre[1], 3)]},
        "weather": weather_rows,
        "latest": latest,
        "landcover": None if lc is None or lc[-1] is None else {
            "shares": {t: _num(v) for t, v in zip(LAND_TYPES, lc[:-1])},
            "basis": "date range" if in_range else "whole record",
        },
        "units": {"t2m": "degC", "rh": "%", "wind_ms": "m/s", "wind_from_deg": "deg, direction the wind blows from",
                  "soil": "% topsoil wetness (0 dry, 100 saturated)", "fwi": "Fire Weather Index (GFWED)",
                  "landcover": "% of fire activity in each land type"},
        "sources": ["MERRA-2 monthly (NASA GMAO)", "GFWED (NASA GISS)", "MODIS MCD12C1 land cover"],
    }
