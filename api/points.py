"""Where individual hotspot points come from.

* R2 (when configured): every point 2002 -> latest, stored as
  points/year=<YYYY>/base=<NNN>.parquet. Only the files for the requested years
  and the H3 base cells (res 0) the area touches are read, and only the row
  groups matching the dates are downloaded.
* Demo regions (fallback): full-history points for a few regions bundled in
  data/regions/. Used when R2 isn't configured or can't be reached; results
  outside those regions are incomplete, which the response says.
"""
from dataclasses import dataclass
from datetime import date

import duckdb
import h3

import db
from area import parse_bbox, select_area

GRID = 24  # sample points per side when finding which base cells a bbox touches


@dataclass
class PointsSource:
    from_sql: str      # a table expression with the point columns + cell5
    where: str         # area + date condition
    params: list
    source: str        # "r2" | "demo-regions"
    complete: bool     # False if the area extends beyond the bundled regions


def _bbox_bases(w, s, e, n) -> set[int]:
    width = (e - w) % 360 or (360 if w != e else 0)
    bases = set()
    for i in range(GRID + 1):
        lat = s + (n - s) * i / GRID
        for j in range(GRID + 1):
            lon = ((w + width * j / GRID + 180) % 360) - 180
            bases.add(h3.get_base_cell_number(h3.latlng_to_cell(lat, lon, 0)))
    return bases


def _area(cur, bbox, cells):
    """(condition, params, base cells, extent w,s,e,n)."""
    if bool(bbox) == bool(cells):
        from fastapi import HTTPException
        raise HTTPException(400, "give exactly one of 'bbox' or 'cells'")
    if bbox:
        w, s, e, n = parse_bbox(bbox)
        lng = "lon BETWEEN ? AND ?" if w <= e else "(lon >= ? OR lon <= ?)"
        bases = _bbox_bases(w, s, e, n)
        bases |= {r[0] for r in cur.execute(
            "SELECT DISTINCT ((cell5 >> 45) & 127)::INTEGER FROM cells "
            "WHERE lat BETWEEN ? AND ? AND " + lng.replace("lon", "lng"), [s, n, w, e]).fetchall()}
        return f"lat BETWEEN ? AND ? AND {lng}", [s, n, w, e], bases, (w, s, e, n)
    select_area(cur, None, cells)
    bases = {h3.get_base_cell_number(c.strip()) for c in cells.split(",") if c.strip()}
    ext = cur.execute("SELECT min(lng), min(lat), max(lng), max(lat) FROM sel").fetchone()
    return "cell5 IN (SELECT cell5 FROM sel)", [], bases, ext


def _inside_a_region(ext) -> bool:
    if not ext or ext[0] is None:
        return True  # nothing burnable selected: an empty answer is complete
    w, s, e, n = ext
    return any(rw <= w and e <= re and rs <= s and n <= rn
               for rw, rs, re, rn in (r["bbox"] for r in db.regions.values()))


def build(cur, bbox, cells, start: date, end: date, use_r2=True) -> PointsSource:
    cond, params, bases, ext = _area(cur, bbox, cells)
    where = f"date BETWEEN ? AND ? AND {cond}"
    params = [start, end, *params]
    if use_r2 and db.r2_enabled:
        urls = [f"r2://{db.R2_BUCKET}/{f['path']}" for f in db.manifest["files"]
                if start.year <= f["year"] <= end.year and f["base"] in bases]
        if not urls:
            return PointsSource("(SELECT * FROM region_points WHERE false)", where, params, "r2", True)
        files = ", ".join(f"'{u}'" for u in urls)
        from_sql = f"(SELECT *, {db.CELL5_FROM_CELL8} AS cell5 FROM read_parquet([{files}]))"
        return PointsSource(from_sql, where, params, "r2", True)
    return PointsSource("region_points", where, params, "demo-regions", _inside_a_region(ext))


def run(cur, bbox, cells, start, end, fn):
    """Build the source and call fn(src); if R2 fails, retry on the demo regions."""
    src = build(cur, bbox, cells, start, end)
    try:
        return src, fn(src)
    except duckdb.Error as e:
        if src.source != "r2":
            raise
        db.record_r2_error(e)
        db.log.warning("R2 read failed (%s); falling back to demo regions", db.r2_last_error)
        src = build(cur, bbox, cells, start, end, use_r2=False)
        return src, fn(src)


def regions_note() -> str:
    names = ", ".join(r["name"] for r in db.regions.values())
    return f"The full hotspot archive is unavailable right now; offline copies cover: {names}."
