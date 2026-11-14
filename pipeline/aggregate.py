"""Aggregate harmonized fire cell-days into the final files served by the API.

Writes to api/data/ (committed to git, so keep every file < 100 MB):

    global/monthly_res5/<YYYY>.parquet cell5, month, fire_days, detections, frp_sum
    global/daily_res3/<YYYY>.parquet cell3, date, fire_days, detections, frp_sum
    global/days.parquet              date, sensor, gap
    global/series_monthly.parquet    whole-world monthly series: raw per sensor + harmonized
    climatology/monthly_res5.parquet cell5, moy, median, mean, active_years
    calibration/ratios.parquet       per region-month calibration ratios

Column meanings:
    fire_days   harmonized fire cell-days (S-NPP VIIRS equivalent, H3 res 8 cells)
    detections  observed hotspots from the sensor used that day (not harmonized)
    frp_sum     observed fire radiative power, MW (not harmonized)
"""
import shutil
import sys
import time

import config as C
from clean import connect, run

OUT = C.API_DATA_DIR
H = (C.HARMONIZED_DIR / "year=*" / "*.parquet").as_posix()
PQ = "FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880"


def monthly_res5(con):
    run(con, f"""
        CREATE OR REPLACE TEMP TABLE monthly AS
        SELECT h3_cell_to_parent(cell8, {C.H3_GLOBAL_MONTHLY_RES}) AS cell5,
               date_trunc('month', acq_date)::DATE AS month,
               sum(weight)::FLOAT AS fire_days,
               sum(n_det)::INTEGER AS detections,
               sum(frp_sum)::FLOAT AS frp_sum
        FROM read_parquet('{H}')
        GROUP BY ALL
    """)
    out = OUT / "global" / "monthly_res5"   # one file per year keeps each well under 100 MB
    out.mkdir(parents=True, exist_ok=True)
    for (year,) in run(con, "SELECT DISTINCT year(month) FROM monthly ORDER BY 1"):
        run(con, f"""COPY (SELECT * FROM monthly WHERE year(month) = {year} ORDER BY cell5, month)
                     TO '{(out / f"{year}.parquet").as_posix()}' ({PQ})""")


def daily_res3(con):
    out = OUT / "global" / "daily_res3"
    out.mkdir(parents=True, exist_ok=True)
    for year_dir in sorted(C.HARMONIZED_DIR.glob("year=*")):
        year = year_dir.name.split("=")[1]
        run(con, f"""
            COPY (
                SELECT h3_cell_to_parent(cell8, {C.H3_GLOBAL_DAILY_RES}) AS cell3,
                       acq_date AS date,
                       sum(weight)::FLOAT AS fire_days,
                       sum(n_det)::INTEGER AS detections,
                       sum(frp_sum)::FLOAT AS frp_sum
                FROM read_parquet('{(year_dir / "*.parquet").as_posix()}')
                GROUP BY ALL ORDER BY cell3, date
            ) TO '{(out / f"{year}.parquet").as_posix()}' ({PQ})
        """)


def days(con):
    run(con, f"""COPY (SELECT acq_date AS date, sensor, gap
                       FROM '{(C.HARMONIZED_DIR / "days.parquet").as_posix()}' ORDER BY date)
                 TO '{(OUT / "global" / "days.parquet").as_posix()}' ({PQ})""")


def series_monthly(con):
    """Whole-world monthly series for the raw-vs-harmonized chart."""
    cd = (C.CELLDAYS_DIR / "**" / "*.parquet").as_posix()
    run(con, f"""
        CREATE OR REPLACE TEMP TABLE series AS
        WITH raw AS (
            PIVOT (SELECT date_trunc('month', acq_date)::DATE AS month, sensor,
                          count(*) AS cell_days, sum(n_det) AS detections
                   FROM read_parquet('{cd}', hive_partitioning = true) GROUP BY ALL)
            ON sensor USING first(cell_days) AS cell_days, first(detections) AS detections
        ),
        harm AS (
            SELECT date_trunc('month', acq_date)::DATE AS month,
                   sum(weight) AS harmonized_fire_days
            FROM read_parquet('{H}') GROUP BY ALL
        ),
        gaps AS (
            SELECT date_trunc('month', acq_date)::DATE AS month,
                   count(*) FILTER (WHERE gap) AS gap_days
            FROM '{(C.HARMONIZED_DIR / "days.parquet").as_posix()}' GROUP BY ALL
        )
        SELECT * FROM harm LEFT JOIN raw USING (month) LEFT JOIN gaps USING (month)
        ORDER BY month
    """)
    run(con, f"""COPY series TO '{(OUT / "global" / "series_monthly.parquet").as_posix()}' ({PQ})""")
    run(con, f"""COPY series TO '{(C.REPORTS_DIR / "series_monthly.csv").as_posix()}' (HEADER)""")


def climatology(con):
    lo, hi = C.CLIMATOLOGY_YEARS
    n = hi - lo + 1
    run(con, f"""
        COPY (
            SELECT cell5, month(month) AS moy,
                   -- months with no fire count as zero
                   list_aggregate(list_resize(list(fire_days::DOUBLE), {n}, 0.0), 'median')::FLOAT AS median,
                   (sum(fire_days) / {n})::FLOAT AS mean,
                   count(*)::TINYINT AS active_years
            FROM monthly
            WHERE year(month) BETWEEN {lo} AND {hi}
            GROUP BY ALL ORDER BY cell5, moy
        ) TO '{(OUT / "climatology" / "monthly_res5.parquet").as_posix()}' ({PQ})
    """)


def calibration(con):
    run(con, f"""COPY (SELECT * FROM '{(C.HARMONIZED_DIR / "ratios.parquet").as_posix()}'
                       ORDER BY sensor, cell2, moy)
                 TO '{(OUT / "calibration" / "ratios.parquet").as_posix()}' ({PQ})""")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = time.time()
    for sub in ("global", "climatology", "calibration"):
        if (OUT / sub).exists():
            shutil.rmtree(OUT / sub)
        (OUT / sub).mkdir(parents=True)
    C.REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    con = connect()
    for name, fn in [("monthly res5", monthly_res5), ("daily res3", daily_res3), ("days", days),
                     ("series", series_monthly), ("climatology", climatology),
                     ("calibration", calibration)]:
        t = time.time()
        fn(con)
        print(f"  {name}: {time.time() - t:.0f}s")

    for f in ("data_gaps.csv", "clean_summary.csv"):
        shutil.copy(C.QA_DIR / f, C.REPORTS_DIR / f)

    print("\nFiles in", OUT)
    total = 0
    for f in sorted(OUT.rglob("*.parquet")):
        size = f.stat().st_size
        total += size
        flag = "  <-- over 100 MB" if size > 100e6 else ""
        print(f"  {f.relative_to(OUT).as_posix():45s} {size / 1e6:8.1f} MB{flag}")
    print(f"  {'total':45s} {total / 1e6:8.1f} MB")
    print(f"Done in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
