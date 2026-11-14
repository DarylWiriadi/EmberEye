"""Export individual hotspot points: all of them for R2, demo regions for the API.

Points are the observed detections of the sensor the harmonized record uses
each day (harmonized/days.parquet), so overlapping sensors are never double
counted. They are *observed* data; harmonization applies to counts only.

Outputs:
    data/r2/points/year=<YYYY>/base=<NNN>.parquet   all points, by year and H3 res 0
                                                    base cell (upload this folder to R2)
    ../api/data/points_manifest.json                which R2 files exist (+ date ranges)
    ../api/data/regions/<slug>.parquet              full-history points per demo region
    ../api/data/regions/regions.json                region names and bboxes

Columns: date, time_utc (HHMM), lat, lon, sensor, confidence, frp, daynight, cell8
Rows are sorted by date (then cell) so date filters skip most of each file.

Usage:  python export_points.py            # both
        python export_points.py --regions  # demo regions only (fast)
"""
import argparse
import json
import shutil
import sys
import time

import config as C
from clean import connect, run

PQ = "FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 50000"
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
    for year in years:
        t = time.time()
        ydir = out / f"year={year}"
        ydir.mkdir(parents=True)
        # One file per H3 base cell (res 0, ~122 worldwide) so a query only
        # downloads the parts of the world it touches.
        run(con, f"""
            COPY (
                SELECT {COLUMNS}, ((h.cell8 >> 45) & 127)::INTEGER AS base
                FROM pts h WHERE h.y = {year}
                ORDER BY base, date, cell8
            ) TO '{ydir.as_posix()}' ({PQ}, PARTITION_BY (base),
                                      FILENAME_PATTERN 'points', OVERWRITE_OR_IGNORE true)
        """)
        print(f"  {year}: {time.time() - t:.0f}s")

    # Flatten base=N/points.parquet -> base=NNN.parquet and build the manifest.
    files = []
    for f in sorted(out.glob("year=*/base=*/*.parquet")):
        year = int(f.parent.parent.name.split("=")[1])
        base = int(f.parent.name.split("=")[1])
        dest = f.parent.parent / f"base={base:03d}.parquet"
        f.rename(dest)
        f.parent.rmdir()
        rows, first, last = run(con, f"SELECT count(*), min(date), max(date) FROM '{dest.as_posix()}'")[0]
        files.append({"year": year, "base": base, "rows": rows, "first": str(first),
                      "last": str(last), "bytes": dest.stat().st_size,
                      "path": dest.relative_to(C.R2_STAGE_DIR).as_posix()})
    manifest = {"layout": "points/year=<YYYY>/base=<H3 res 0 base cell, 3 digits>.parquet",
                "first": min(f["first"] for f in files), "last": max(f["last"] for f in files),
                "rows": sum(f["rows"] for f in files), "files": files}
    (C.API_DATA_DIR / "points_manifest.json").write_text(json.dumps(manifest))
    total = sum(f["bytes"] for f in files)
    print(f"R2 stage: {len(files)} files, {manifest['rows']:,} points, {total / 1e9:.2f} GB "
          f"-> {out}")


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
    export_regions(con)
    if not args.regions:
        export_all(con)
    print(f"Done in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--regions", action="store_true", help="demo regions only")
    main(p.parse_args())
