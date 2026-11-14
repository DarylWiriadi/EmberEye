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
from datetime import date

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
        rows = cur.execute(f"""
            WITH d3 AS (   -- daily series on the res 3 grid around the area
                SELECT date, sum(fire_days) AS f, sum(detections) AS d, sum(frp_sum) AS frp
                FROM daily WHERE cell3 IN (SELECT DISTINCT cell3 FROM sel) GROUP BY date
            ),
            m5 AS (        -- the area's own monthly totals
                SELECT month, sum(fire_days) AS f, sum(detections) AS d, sum(frp_sum) AS frp
                FROM monthly WHERE cell5 IN (SELECT cell5 FROM sel) GROUP BY month
            ),
            k AS (         -- per-month scale so the days add up to the area's month
                SELECT m3.month,
                       coalesce(m5.f, 0) / nullif(m3.f, 0) AS kf,
                       coalesce(m5.d, 0) / nullif(m3.d, 0) AS kd,
                       coalesce(m5.frp, 0) / nullif(m3.frp, 0) AS kp
                FROM (SELECT date_trunc('month', date)::DATE AS month,
                             sum(f) AS f, sum(d) AS d, sum(frp) AS frp
                      FROM d3 GROUP BY 1) m3
                LEFT JOIN m5 USING (month)
            ),
            ds AS (
                SELECT d3.date, d3.f * coalesce(k.kf, 0) AS f, d3.d * coalesce(k.kd, 0) AS d,
                       d3.frp * coalesce(k.kp, 0) AS frp
                FROM d3 JOIN k ON k.month = date_trunc('month', d3.date)
            ),
            b AS (         -- baseline days, zero-filled, data gaps skipped
                SELECT days.date, coalesce(ds.f, 0) AS f
                FROM days LEFT JOIN ds USING (date)
                WHERE year(days.date) BETWEEN {lo} AND {hi} AND NOT days.gap
            ),
            cal AS (
                SELECT unnest(generate_series(?::DATE, ?::DATE, INTERVAL 1 DAY))::DATE AS date
            ),
            base AS (
                SELECT cal.date, median(b.f) AS med, avg(b.f) AS mean
                FROM cal JOIN b
                  ON least(abs(dayofyear(b.date) - dayofyear(cal.date)),
                           366 - abs(dayofyear(b.date) - dayofyear(cal.date))) <= {DAY_WINDOW}
                GROUP BY cal.date
            )
            SELECT strftime(cal.date, '%Y-%m-%d'), coalesce(ds.f, 0), coalesce(ds.d, 0),
                   coalesce(ds.frp, 0), coalesce(base.med, 0), coalesce(base.mean, 0),
                   days.sensor, days.gap
            FROM cal
            LEFT JOIN ds USING (date)
            LEFT JOIN base USING (date)
            LEFT JOIN days USING (date)
            ORDER BY cal.date
        """, [start, end]).fetchall()
        data = []
        for period, f, d, frp, med, mean, sensor, gap in rows:
            ratio, pct = _anomaly(f, med)
            data.append({
                "period": period, "fire_days": _round(f), "detections": _round(d, 1),
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
