"""Export individual hotspot points: all of them for R2, demo regions for the API.

Points are the observed detections of the sensor the harmonized record uses
each day (harmonized/days.parquet), so overlapping sensors are never double
counted. They are *observed* data; harmonization applies to counts only.

Outputs:
    data/r2/points/year=<YYYY>/base=<NNN>.parquet   all points, by year and H3 res 0
                                                    base cell (upload this folder to R2)
    data/r2/{sample,wide}/year=<YYYY>.parquet       subsets for zoomed-out maps (see SAMPLES)
    ../api/data/points_manifest.json                which R2 files exist (+ date ranges)
    ../api/data/regions/<slug>.parquet              full-history points per demo region
    ../api/data/regions/regions.json                region names and bboxes

Columns: date, time_utc (HHMM), lat, lon, sensor, confidence, frp, daynight, cell8
Point files are sorted by H3 res 2 area (~300 km), then date, in small row groups,
so a zoomed-in request only downloads the row groups near it (lat/lon/date stats).

Usage:  python export_points.py            # both
        python export_points.py --regions  # demo regions only (fast)
        python export_points.py --sample   # the sample files only
        python export_points.py --points   # the R2 point files only
"""
import argparse
import json
import shutil
import sys
import time

import config as C
from clean import connect, run

PQ = "FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 50000"
PQ_POINTS = "FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 20000"
CELL2 = "((h.cell8 & ~(15::UBIGINT << 52)) | (2::UBIGINT << 52) | ((1::UBIGINT << 39) - 1))"
# (folder, 1 in N, sort order). "sample": long date ranges, sorted by base cell
# so regional requests skip most of the file. "wide": a day or a few over a
# continent or the world, sorted by date so it's a small part of one file.
SAMPLES = [("sample", 32, "base, date, cell8"), ("wide", 4, "date, cell8")]
# Must match api/_lib/points.py: the same hash orders the API's samples.
SAMPLE_HASH = "hash(h.cell8, h.acq_date, h.acq_time)"
COLUMNS = """h.acq_date AS date, h.acq_time AS time_utc,
             round(h.latitude, 5)::FLOAT AS lat, round(h.longitude, 5)::FLOAT AS lon,
             h.sensor, h.confidence, h.frp, h.daynight, h.cell8"""


def source_view(con):
    run(con, f"""
        CREATE OR REPLACE VIEW pts AS
        SELECT h.*, h.year AS y
        FROM read_parquet('{(C.HOTSPOTS_DIR / "**" / "*.parquet").as_posix()}',
                          hive_partitioning = true) h
        JOIN '{(C.HARMONIZED_DIR / "days.parquet").as_posix()}' d
          ON d.acq_date = h.acq_date AND d.sensor = h.sensor
    """)


def export_all(con):
    out = C.R2_STAGE_DIR / "points"
    if out.exists():
        shutil.rmtree(out)
    years = [r[0] for r in run(con, "SELECT DISTINCT y FROM pts ORDER BY 1")]
    files = []
    for year in years:
        t = time.time()
        ydir = out / f"year={year}"
        ydir.mkdir(parents=True)
        # One file per H3 base cell (res 0, ~122 worldwide) so a query only
        # downloads the parts of the world it touches. Written one by one:
        # a partitioned COPY doesn't keep the sort order inside each file.
        run(con, f"""
            CREATE OR REPLACE TEMP TABLE yr AS
            SELECT {COLUMNS}, ((h.cell8 >> 45) & 127)::INTEGER AS base,
                   {CELL2} AS cell2
            FROM pts h WHERE h.y = {year}
        """)
        for (base,) in run(con, "SELECT DISTINCT base FROM yr ORDER BY 1"):
            dest = ydir / f"base={base:03d}.parquet"
            run(con, f"""
                COPY (SELECT * EXCLUDE (base, cell2) FROM yr WHERE base = {base}
                      ORDER BY cell2, date, cell8)
                TO '{dest.as_posix()}' ({PQ_POINTS})
            """)
            rows, first, last = run(con, f"SELECT count(*), min(date), max(date) FROM '{dest.as_posix()}'")[0]
            files.append({"year": year, "base": base, "rows": rows, "first": str(first),
                          "last": str(last), "bytes": dest.stat().st_size,
                          "path": dest.relative_to(C.R2_STAGE_DIR).as_posix()})
        print(f"  {year}: {time.time() - t:.0f}s")
    run(con, "DROP TABLE IF EXISTS yr")

    mpath = C.API_DATA_DIR / "points_manifest.json"
    manifest = json.loads(mpath.read_text()) if mpath.exists() else {}   # keeps the samples
    manifest.update({"layout": "points/year=<YYYY>/base=<H3 res 0 base cell, 3 digits>.parquet",
                     "first": min(f["first"] for f in files), "last": max(f["last"] for f in files),
                     "rows": sum(f["rows"] for f in files), "files": files})
    mpath.write_text(json.dumps(manifest))
    total = sum(f["bytes"] for f in files)
    print(f"R2 stage: {len(files)} files, {manifest['rows']:,} points, {total / 1e9:.2f} GB "
          f"-> {out}")


def export_samples(con):
    """Subsets of the points for maps showing big areas, where reading every point
    would take too long. Every point with hash % N == 0, so the 1-in-32 sample is
    a subset of the 1-in-4 one."""
    mpath = C.API_DATA_DIR / "points_manifest.json"
    manifest = json.loads(mpath.read_text())
    years = [r[0] for r in run(con, "SELECT DISTINCT y FROM pts ORDER BY 1")]
    for name, every, order in SAMPLES:
        out = C.R2_STAGE_DIR / name
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        files = []
        for year in years:
            dest = out / f"year={year}.parquet"
            run(con, f"""
                COPY (
                    SELECT {COLUMNS}, ((h.cell8 >> 45) & 127)::UTINYINT AS base
                    FROM pts h WHERE h.y = {year} AND {SAMPLE_HASH} % {every} = 0
                    ORDER BY {order}
                ) TO '{dest.as_posix()}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 10000)
            """)
            rows = run(con, f"SELECT count(*) FROM '{dest.as_posix()}'")[0][0]
            files.append({"year": year, "rows": rows, "bytes": dest.stat().st_size,
                          "path": dest.relative_to(C.R2_STAGE_DIR).as_posix()})
        size = sum(f["bytes"] for f in files) / 1e6
        print(f"  {name}: 1 in {every}, {sum(f['rows'] for f in files):,} points, {size:.0f} MB")
        manifest[name] = {"every": every, "files": files}
    mpath.write_text(json.dumps(manifest))


def export_regions(con):
    out = C.API_DATA_DIR / "regions"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    meta = {}
    for slug, (name, (w, s, e, n)) in C.DEMO_REGIONS.items():
        dest = out / f"{slug}.parquet"
        run(con, f"""
            COPY (SELECT {COLUMNS} FROM pts h
                  WHERE h.latitude BETWEEN {s} AND {n} AND h.longitude BETWEEN {w} AND {e}
                  ORDER BY date, cell8)
            TO '{dest.as_posix()}' ({PQ})
        """)
        rows, first, last = run(con, f"SELECT count(*), min(date), max(date) FROM '{dest.as_posix()}'")[0]
        meta[slug] = {"name": name, "bbox": [w, s, e, n], "rows": rows,
                      "first": str(first), "last": str(last)}
        print(f"  region {slug}: {rows:,} points, {dest.stat().st_size / 1e6:.1f} MB")
    (out / "regions.json").write_text(json.dumps(meta, indent=2))


def main(args):
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = time.time()
    con = connect()
    source_view(con)
    if args.sample:
        export_samples(con)
    elif args.points:
        export_all(con)
    else:
        export_regions(con)
        if not args.regions:
            export_all(con)
            export_samples(con)
    print(f"Done in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--regions", action="store_true", help="demo regions only")
    p.add_argument("--sample", action="store_true", help="sample files only")
    p.add_argument("--points", action="store_true", help="the R2 point files only")
    main(p.parse_args())
