"""CSV downloads.

GET /export.csv          individual hotspots (streamed, no size limit), full record
GET /export-estimate     approximate size of /export.csv
GET /export-summary.csv  monthly harmonized counts + medians + anomalies, full record
"""
import csv
import io
import re
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from _lib import db
from _lib import points
from _lib.routes.calendar import calendar
from _lib.routes.hotspots import clamp_dates

router = APIRouter()

BATCH = 50_000

HOTSPOT_COLUMNS = ["date", "time_utc", "latitude", "longitude", "sensor", "confidence",
                   "frp_mw", "daynight", "h3_res8", "data_type"]


def _csv_line(values) -> str:
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\n").writerow(values)
    return buf.getvalue()


@router.get("/export.csv")
def export_hotspots(
    bbox: str | None = Query(None, description="west,south,east,north (degrees)"),
    cells: str | None = Query(None, description="comma-separated H3 cells, any resolution"),
    start: date | None = Query(None),
    end: date | None = Query(None),
    token: str | None = Query(None, description="echoed back in a cookie once the download starts"),
):
    cur = db.cursor()   # first: this also loads the manifest and sets up R2
    start, end, first, last = clamp_dates(start, end)
    if start > end:
        raise HTTPException(404, f"Hotspots are available from {first} to {last}.")

    # Checks R2 is reachable (falling back to the bundled regions if not).
    src, _ = points.run(cur, bbox, cells, start, end, lambda s: cur.execute(
        f"SELECT 1 FROM {s.from_sql} WHERE {s.where} LIMIT 1", s.params).fetchall())
    if not src.complete:
        raise HTTPException(503, points.regions_note() + " Try again later, or download "
                                 "the monthly summary (always available).")

    def rows():
        yield _csv_line(HOTSPOT_COLUMNS)
        # A month at a time, in date order: no sorting of years of points at once,
        # and the first rows go out straight away.
        for m_start, m_end in _months(start, end):
            part = points.build(cur, bbox, cells, m_start, m_end, use_r2=src.source == "r2")
            result = cur.execute(f"""
                SELECT strftime(date, '%Y-%m-%d'),
                       printf('%02d:%02d', time_utc // 100, time_utc % 100),
                       round(lat::DOUBLE, 5), round(lon::DOUBLE, 5), sensor, confidence,
                       round(frp::DOUBLE, 2), daynight, printf('%x', cell8), 'observed'
                FROM {part.from_sql} WHERE {part.where}
                ORDER BY date, time_utc
            """, part.params)
            while batch := result.fetchmany(BATCH):
                buf = io.StringIO()
                csv.writer(buf, lineterminator="\n").writerows(batch)
                yield buf.getvalue()

    name = f"embereye_hotspots_{start}_{end}.csv"
    headers = {"Content-Disposition": f'attachment; filename="{name}"', "X-Hotspot-Source": src.source}
    # Lets the page see that the download has started (it waits for this cookie).
    if token and re.fullmatch(r"[A-Za-z0-9]{1,32}", token):
        headers["Set-Cookie"] = f"embereye_download={token}; Path=/; Max-Age=120; SameSite=Lax"
    return StreamingResponse(rows(), media_type="text/csv", headers=headers)


def _months(start: date, end: date):
    m = start.replace(day=1)
    while m <= end:
        nxt = (m.replace(day=28) + timedelta(days=4)).replace(day=1)
        yield max(m, start), min(nxt - timedelta(days=1), end)
        m = nxt


BYTES_PER_ROW = 81   # measured: 1,336,038 rows -> 108.7 MB


@router.get("/export-estimate")
def export_estimate(
    bbox: str | None = Query(None, description="west,south,east,north (degrees)"),
    cells: str | None = Query(None, description="comma-separated H3 cells, any resolution"),
    start: date | None = Query(None),
    end: date | None = Query(None),
):
    """How big /export.csv would be: from the 1-in-32 sample for big searches
    (about a second), counted exactly for small ones."""
    cur = db.cursor()
    start, end, _, _ = clamp_dates(start, end)

    def count(src):
        return cur.execute(f"SELECT count(*) FROM {src.from_sql} WHERE {src.where}",
                           src.params).fetchone()[0]

    hotspots, exact = None, False
    sample = points.build_sample(cur, bbox, cells, start, end, "sample")
    if sample:
        hotspots = count(sample[0]) * sample[1]
    if hotspots is None or hotspots < 50_000:
        _, hotspots = points.run(cur, bbox, cells, start, end, count)
        exact = True
    return {"hotspots": hotspots, "exact": exact, "bytes": hotspots * BYTES_PER_ROW + 100}


@router.get("/export-summary.csv")
def export_summary(
    bbox: str | None = Query(None, description="west,south,east,north (degrees)"),
    cells: str | None = Query(None, description="comma-separated H3 cells, any resolution"),
    start: date | None = Query(None),
    end: date | None = Query(None),
):
    res = calendar(bbox=bbox, cells=cells, start=start, end=end, level="month")
    cols = ["month", "fire_days", "detections", "frp_mw", "median", "mean",
            "ratio_to_median", "anomaly_pct", "gap_days", "sensors", "partial_month"]
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(cols)
    for d in res["data"]:
        w.writerow([d["period"], d["fire_days"], d["detections"], d["frp_mw"], d["median"],
                    d["mean"], d["ratio_to_median"], d["anomaly_pct"], d["gap_days"],
                    "+".join(d["sensors"] or []), d["partial"]])
    name = f"embereye_monthly_summary_{res['start']}_{res['end']}.csv"
    return StreamingResponse(iter([out.getvalue()]), media_type="text/csv", headers={
        "Content-Disposition": f'attachment; filename="{name}"',
    })
