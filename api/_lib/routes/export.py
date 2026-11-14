"""CSV downloads.

GET /export.csv          individual hotspots (streamed), full record
GET /export-summary.csv  monthly harmonized counts + medians + anomalies, full record
"""
import csv
import io
from datetime import date

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from _lib import db
from _lib import points
from _lib.routes.calendar import calendar
from _lib.routes.hotspots import clamp_dates

router = APIRouter()

EXPORT_CAP = 500_000
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
):
    cur = db.cursor()   # first: this also loads the manifest and sets up R2
    start, end, first, last = clamp_dates(start, end)
    if start > end:
        raise HTTPException(404, f"Hotspots are available from {first} to {last}.")

    def count(src):
        return cur.execute(f"SELECT count(*) FROM {src.from_sql} WHERE {src.where}",
                           src.params).fetchone()[0]

    src, total = points.run(cur, bbox, cells, start, end, count)
    if not src.complete:
        raise HTTPException(503, points.regions_note() + " Try again later, or download "
                                 "the monthly summary (always available).")
    if total > EXPORT_CAP:
        raise HTTPException(413, f"This search has {total:,} hotspots, more than the "
                                 f"{EXPORT_CAP:,} export limit. Narrow the area or date range, "
                                 "or download the monthly summary instead.")

    def rows():
        yield _csv_line(HOTSPOT_COLUMNS)
        result = cur.execute(f"""
            SELECT strftime(date, '%Y-%m-%d'),
                   printf('%02d:%02d', time_utc // 100, time_utc % 100),
                   round(lat::DOUBLE, 5), round(lon::DOUBLE, 5), sensor, confidence,
                   round(frp::DOUBLE, 2), daynight, printf('%x', cell8), 'observed'
            FROM {src.from_sql} WHERE {src.where}
            ORDER BY date, time_utc
        """, src.params)
        while batch := result.fetchmany(BATCH):
            buf = io.StringIO()
            csv.writer(buf, lineterminator="\n").writerows(batch)
            yield buf.getvalue()

    name = f"embereye_hotspots_{start}_{end}.csv"
    return StreamingResponse(rows(), media_type="text/csv", headers={
        "Content-Disposition": f'attachment; filename="{name}"',
        "X-Hotspot-Count": str(total),
        "X-Hotspot-Source": src.source,
    })


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
