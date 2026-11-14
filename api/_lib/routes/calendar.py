"""GET /calendar: harmonized fire activity per month or day for an area,
with the historical median / mean for comparison.

Month level uses the H3 res 5 monthly counts directly.

Day level: daily counts only exist on the coarser H3 res 3 grid, so the
area's daily *pattern* comes from the res 3 cells around it, scaled each month
so the days add up to the area's own res 5 monthly total. Month and day views
therefore always agree. Daily values are estimates (the response says so).

Baselines (`median`, `mean`) use the complete years in db.BASELINE_YEARS, with
fire-free periods counted as zero:
  * month level: the same calendar month in every baseline year
  * day level: the same day of year +-3 days in every baseline year,
    skipping data-gap days
"""
import statistics
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Query

from _lib import db
from _lib.area import select_area

router = APIRouter()

MAX_DAYS = 366
DAY_WINDOW = 3  # +- days around the same day of year for the daily baseline


def _round(v, nd=2):
    return None if v is None else round(float(v), nd)


def _anomaly(value, median):
    if median is None or median <= 0:
        return None, None
    ratio = value / median
    return round(ratio, 3), round((ratio - 1) * 100, 1)


@router.get("/calendar")
def calendar(
    bbox: str | None = Query(None, description="west,south,east,north (degrees)"),
    cells: str | None = Query(None, description="comma-separated H3 cells, any resolution"),
    start: date | None = Query(None, description="first day (default: start of record)"),
    end: date | None = Query(None, description="last day (default: latest data)"),
    level: str = Query("month", pattern="^(month|day)$"),
):
    cur = db.cursor()
    first, last = db.coverage(cur)
    start = max(start or first, first)
    end = min(end or last, last)
    if start > end:
        raise HTTPException(400, f"empty date range; data covers {first} to {last}")
    if level == "day" and (end - start).days + 1 > MAX_DAYS:
        raise HTTPException(400, f"day level is limited to {MAX_DAYS} days; use level=month")

    n_cells = select_area(cur, bbox, cells)
    lo, hi = db.BASELINE_YEARS
    n_years = hi - lo + 1

    if level == "month":
        rows = cur.execute(f"""
            WITH m AS (
                SELECT month, sum(fire_days) AS f, sum(detections) AS d, sum(frp_sum) AS frp
                FROM monthly WHERE cell5 IN (SELECT cell5 FROM sel) GROUP BY month
            ),
            base AS (
                SELECT month(month) AS moy,
                       list_aggregate(list_resize(list(f::DOUBLE), {n_years}, 0.0), 'median') AS med,
                       sum(f) / {n_years} AS mean
                FROM m WHERE year(month) BETWEEN {lo} AND {hi} GROUP BY moy
            ),
            g AS (
                SELECT date_trunc('month', date)::DATE AS month,
                       count(*) FILTER (WHERE gap) AS gap_days,
                       list(DISTINCT sensor ORDER BY sensor) AS sensors,
                       min(date) AS first_day, max(date) AS last_day
                FROM days GROUP BY 1
            ),
            cal AS (
                SELECT unnest(generate_series(date_trunc('month', ?::DATE),
                                              date_trunc('month', ?::DATE),
                                              INTERVAL 1 MONTH))::DATE AS month
            )
            SELECT strftime(cal.month, '%Y-%m'), coalesce(m.f, 0), coalesce(m.d, 0),
                   coalesce(m.frp, 0), coalesce(base.med, 0), coalesce(base.mean, 0),
                   g.gap_days, g.sensors,
                   g.first_day > cal.month OR g.last_day < last_day(cal.month) AS partial
            FROM cal
            LEFT JOIN m USING (month)
            LEFT JOIN base ON base.moy = month(cal.month)
            LEFT JOIN g USING (month)
            ORDER BY cal.month
        """, [start, end]).fetchall()
        data = []
        for period, f, d, frp, med, mean, gap_days, sensors, partial in rows:
            ratio, pct = _anomaly(f, med)
            data.append({
                "period": period, "fire_days": _round(f), "detections": int(d),
                "frp_mw": _round(frp, 1), "median": _round(med), "mean": _round(mean),
                "ratio_to_median": ratio, "anomaly_pct": pct,
                "gap_days": gap_days, "sensors": sensors, "partial": bool(partial),
            })
        notes = []
    else:
        # Three small queries and the arithmetic in Python. As one SQL query this
        # made DuckDB 2.0 spill >15 GB of temp files, or crash, for large areas.
        d3 = {r[0]: r[1:] for r in cur.execute("""
            SELECT date, sum(fire_days), sum(detections), sum(frp_sum)
            FROM daily WHERE cell3 IN (SELECT DISTINCT cell3 FROM sel) GROUP BY date
        """).fetchall()}   # daily pattern on the res 3 grid around the area
        m5 = {r[0]: r[1:] for r in cur.execute("""
            SELECT month, sum(fire_days), sum(detections), sum(frp_sum)
            FROM monthly WHERE cell5 IN (SELECT cell5 FROM sel) GROUP BY month
        """).fetchall()}   # the area's own monthly totals
        days = cur.execute("SELECT date, sensor, gap FROM days ORDER BY date").fetchall()

        # Scale each month's days so they add up to the area's own monthly total.
        m3: dict = {}
        for d, vals in d3.items():
            tot = m3.setdefault(d.replace(day=1), [0.0, 0.0, 0.0])
            for i, v in enumerate(vals):
                tot[i] += float(v or 0)
        scale = {m: [float(m5.get(m, (0, 0, 0))[i] or 0) / tot[i] if tot[i] else 0.0
                     for i in range(3)] for m, tot in m3.items()}
        ds = {d: [float(v or 0) * scale[d.replace(day=1)][i] for i, v in enumerate(vals)]
              for d, vals in d3.items()}

        # Baseline: the same day of year +-DAY_WINDOW in every baseline year,
        # zero-filled, data-gap days skipped.
        by_doy: dict[int, list[float]] = {}
        for d, _, gap in days:
            if lo <= d.year <= hi and not gap:
                by_doy.setdefault(d.timetuple().tm_yday, []).append(ds.get(d, (0.0,))[0])

        def baseline(d):
            doy = d.timetuple().tm_yday
            vals = [v for o, vs in by_doy.items()
                    if min(abs(o - doy), 366 - abs(o - doy)) <= DAY_WINDOW for v in vs]
            return (statistics.median(vals), statistics.fmean(vals)) if vals else (0.0, 0.0)

        info = {d: (sensor, gap) for d, sensor, gap in days}
        data = []
        for n in range((end - start).days + 1):
            d = start + timedelta(days=n)
            f, det, frp = ds.get(d, (0.0, 0.0, 0.0))
            med, mean = baseline(d)
            sensor, gap = info.get(d, (None, False))
            ratio, pct = _anomaly(f, med)
            data.append({
                "period": d.isoformat(), "fire_days": _round(f), "detections": _round(det, 1),
                "frp_mw": _round(frp, 1), "median": _round(med), "mean": _round(mean),
                "ratio_to_median": ratio, "anomaly_pct": pct,
                "gap": bool(gap), "sensor": sensor,
            })
        notes = ["Daily values are estimates: the area's monthly totals spread over days "
                 "using the daily pattern of the surrounding H3 res 3 cells."]

    return {
        "level": level,
        "start": str(start),
        "end": str(end),
        "coverage": {"first": str(first), "last": str(last)},
        "area": {"cells_res5": n_cells},
        "baseline_years": [lo, hi],
        "units": {
            "fire_days": "harmonized fire cell-days (VIIRS S-NPP equivalent, H3 res 8 cells)",
            "detections": "observed hotspots from the sensor used that day",
            "frp_mw": "observed fire radiative power, MW",
        },
        "notes": notes,
        "data": data,
    }
