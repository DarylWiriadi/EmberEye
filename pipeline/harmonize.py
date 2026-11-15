"""Harmonize MODIS Aqua, VIIRS S-NPP and VIIRS NOAA-20 into one record.

S-NPP VIIRS is the reference. Steps (CLAUDE.md section 5, steps 3-5):

1. Fire cell-days: collapse cleaned hotspots to one row per (H3 res 8 cell, date,
   sensor). This removes most of the 1 km vs 375 m resolution difference.
2. Calibration: per calibration region (H3 res 2) and calendar month,
       ratio = S-NPP cell-days / other-sensor cell-days
   over the overlap window (MODIS 2012-2019, NOAA-20 2024), counting only days
   where neither sensor is flagged as a data gap. Region-months with too few
   cell-days fall back to H3 res 1, then res 0, then the global monthly ratio.
3. Daily source plan: which sensor represents each day.
       before 2012-01-20      MODIS x ratio
       2012-01-20..2026-11-02 S-NPP as is; on S-NPP gap days, MODIS x ratio
                              (to 2019) or NOAA-20 x ratio if available
       after 2026-11-02       NOAA-20 x ratio
   Days where the chosen sensor is itself a gap stay flagged (`gap = true`).
4. Harmonized cell-days: the chosen sensor's cell-days with a `weight` (number of
   S-NPP-equivalent fire cell-days; 1 for S-NPP, the ratio otherwise).

Outputs (interim):
    celldays/sensor=<S>/year=<Y>/data.parquet
    harmonized/year=<Y>/data.parquet     cell8, acq_date, sensor, n_det, frp_sum, weight
    harmonized/days.parquet              acq_date, sensor, gap
    harmonized/ratios.parquet            sensor, cell2, moy, level, n_sensor, n_ref, ratio
"""
import shutil
import sys
import time

import config as C
from clean import connect, run

REF = C.VIIRS_SNPP


def build_celldays(con):
    """One (sensor, year) at a time, so each GROUP BY / sort fits in memory."""
    if C.CELLDAYS_DIR.exists():
        shutil.rmtree(C.CELLDAYS_DIR)
    for year_dir in sorted(C.HOTSPOTS_DIR.glob("sensor=*/year=*")):
        sensor, year = year_dir.parent.name.split("=")[1], year_dir.name.split("=")[1]
        out = C.CELLDAYS_DIR / f"sensor={sensor}" / f"year={year}"
        out.mkdir(parents=True)
        run(con, f"""
            COPY (
                SELECT cell8, acq_date,
                       count(*)::INTEGER AS n_det,
                       sum(frp)::FLOAT AS frp_sum
                FROM read_parquet('{(year_dir / "*.parquet").as_posix()}')
                GROUP BY ALL
                ORDER BY acq_date, cell8
            ) TO '{(out / "data.parquet").as_posix()}' (FORMAT parquet, COMPRESSION zstd)
        """)
    run(con, f"""
        CREATE OR REPLACE VIEW celldays AS
        SELECT * FROM read_parquet('{(C.CELLDAYS_DIR / "**" / "*.parquet").as_posix()}',
                                   hive_partitioning = true)
    """)


def build_ratios(con, windows=None, out=None):
    """`windows` and `out` let validate.py calibrate on a shorter window."""
    run(con, f"""
        CREATE OR REPLACE TEMP TABLE daily_counts AS
        SELECT * FROM '{(C.QA_DIR / "daily_counts.parquet").as_posix()}'
    """)
    run(con, """CREATE OR REPLACE TEMP TABLE ratios (
        sensor VARCHAR, cell2 UBIGINT, moy INTEGER, level INTEGER,
        n_sensor BIGINT, n_ref BIGINT, ratio DOUBLE)""")
    for sensor, (lo, hi) in (windows or C.CALIB_WINDOWS).items():
        m = C.CALIB_MIN_CELLDAYS
        run(con, f"""
            INSERT INTO ratios
            WITH valid AS (   -- overlap days where both sensors are present and not gaps
                SELECT acq_date FROM daily_counts
                WHERE acq_date BETWEEN DATE '{lo}' AND DATE '{hi}'
                  AND sensor IN ('{sensor}', '{REF}') AND NOT possible_gap
                GROUP BY acq_date HAVING count(*) = 2
            ),
            c2 AS (
                SELECT h3_cell_to_parent(cell8, {C.H3_CALIB_RES}) AS cell2,
                       month(acq_date) AS moy,
                       count(*) FILTER (WHERE sensor = '{sensor}') AS n_s,
                       count(*) FILTER (WHERE sensor = '{REF}') AS n_r
                FROM celldays
                WHERE sensor IN ('{sensor}', '{REF}')
                  AND year BETWEEN {lo.year} AND {hi.year}
                  AND acq_date IN (SELECT acq_date FROM valid)
                GROUP BY ALL
            ),
            l1 AS (SELECT h3_cell_to_parent(cell2, 1) AS k, moy, sum(n_s) AS n_s, sum(n_r) AS n_r
                   FROM c2 GROUP BY ALL),
            l0 AS (SELECT h3_cell_to_parent(cell2, 0) AS k, moy, sum(n_s) AS n_s, sum(n_r) AS n_r
                   FROM c2 GROUP BY ALL),
            lg AS (SELECT moy, sum(n_s) AS n_s, sum(n_r) AS n_r FROM c2 GROUP BY ALL),
            targets AS (   -- every region the sensor ever burns in, x 12 months
                SELECT cell2, moy
                FROM (SELECT DISTINCT h3_cell_to_parent(cell8, {C.H3_CALIB_RES}) AS cell2
                      FROM celldays WHERE sensor = '{sensor}')
                CROSS JOIN (SELECT unnest(range(1, 13))::INTEGER AS moy)
            ),
            j AS (
                SELECT t.cell2, t.moy,
                       a.n_s AS s2, a.n_r AS r2, b.n_s AS s1, b.n_r AS r1,
                       c.n_s AS s0, c.n_r AS r0, g.n_s AS sg, g.n_r AS rg
                FROM targets t
                LEFT JOIN c2 a ON a.cell2 = t.cell2 AND a.moy = t.moy
                LEFT JOIN l1 b ON b.k = h3_cell_to_parent(t.cell2, 1) AND b.moy = t.moy
                LEFT JOIN l0 c ON c.k = h3_cell_to_parent(t.cell2, 0) AND c.moy = t.moy
                LEFT JOIN lg g ON g.moy = t.moy
            ),
            pick AS (
                SELECT cell2, moy,
                       CASE WHEN s2 >= {m} THEN 2 WHEN s1 >= {m} THEN 1
                            WHEN s0 >= {m} THEN 0 ELSE -1 END AS level,
                       CASE WHEN s2 >= {m} THEN s2 WHEN s1 >= {m} THEN s1
                            WHEN s0 >= {m} THEN s0 ELSE sg END AS n_sensor,
                       CASE WHEN s2 >= {m} THEN r2 WHEN s1 >= {m} THEN r1
                            WHEN s0 >= {m} THEN r0 ELSE rg END AS n_ref
                FROM j
            )
            SELECT '{sensor}', cell2, moy, level, n_sensor, n_ref, n_ref / n_sensor
            FROM pick
        """)
    out = out or C.HARMONIZED_DIR / 'ratios.parquet'
    run(con, f"COPY ratios TO '{out.as_posix()}' (FORMAT parquet)")


def build_plan(con):
    s, e = C.SNPP_START, C.SNPP_END
    run(con, f"""
        CREATE OR REPLACE TEMP TABLE days AS
        WITH cal AS (
            SELECT unnest(generate_series(DATE '{C.MODIS_AQUA_START}',
                                          (SELECT max(acq_date) FROM daily_counts),
                                          INTERVAL 1 DAY))::DATE AS acq_date
        ),
        w AS (
            SELECT cal.acq_date,
                   coalesce(bool_or(NOT possible_gap) FILTER (WHERE sensor = '{C.MODIS_AQUA}'), false) AS modis_ok,
                   coalesce(bool_or(NOT possible_gap) FILTER (WHERE sensor = '{C.VIIRS_SNPP}'), false) AS snpp_ok,
                   coalesce(bool_or(NOT possible_gap) FILTER (WHERE sensor = '{C.VIIRS_NOAA20}'), false) AS n20_ok
            FROM cal LEFT JOIN daily_counts USING (acq_date)
            GROUP BY cal.acq_date
        ),
        p AS (
            SELECT acq_date, modis_ok, snpp_ok, n20_ok,
                   CASE WHEN acq_date < DATE '{s}' THEN '{C.MODIS_AQUA}'
                        WHEN acq_date > DATE '{e}' THEN '{C.VIIRS_NOAA20}'
                        WHEN snpp_ok THEN '{C.VIIRS_SNPP}'
                        WHEN modis_ok THEN '{C.MODIS_AQUA}'
                        WHEN n20_ok THEN '{C.VIIRS_NOAA20}'
                        ELSE '{C.VIIRS_SNPP}' END AS sensor
            FROM w
        )
        SELECT acq_date, sensor,
               NOT CASE sensor WHEN '{C.MODIS_AQUA}' THEN modis_ok
                               WHEN '{C.VIIRS_SNPP}' THEN snpp_ok
                               ELSE n20_ok END AS gap
        FROM p ORDER BY acq_date
    """)
    run(con, f"COPY days TO '{(C.HARMONIZED_DIR / 'days.parquet').as_posix()}' (FORMAT parquet)")


def build_harmonized(con):
    """One year at a time (bounded memory)."""
    for f in C.HARMONIZED_DIR.glob("year=*"):
        shutil.rmtree(f)
    years = [r[0] for r in run(con, "SELECT DISTINCT year(acq_date) FROM days ORDER BY 1")]
    for year in years:
        out = C.HARMONIZED_DIR / f"year={year}"
        out.mkdir(parents=True)
        run(con, f"""
            COPY (
                SELECT c.cell8, c.acq_date, c.sensor, c.n_det, c.frp_sum,
                       CASE WHEN c.sensor = '{REF}' THEN 1.0 ELSE r.ratio END::FLOAT AS weight
                FROM celldays c
                JOIN days d ON d.acq_date = c.acq_date AND d.sensor = c.sensor
                LEFT JOIN ratios r ON r.sensor = c.sensor
                                  AND r.cell2 = h3_cell_to_parent(c.cell8, {C.H3_CALIB_RES})
                                  AND r.moy = month(c.acq_date)
                WHERE c.year = {year}
                ORDER BY c.acq_date, c.cell8
            ) TO '{(out / "data.parquet").as_posix()}' (FORMAT parquet, COMPRESSION zstd)
        """)
    missing = run(con, f"""SELECT count(*) FROM read_parquet(
        '{(C.HARMONIZED_DIR / "year=*" / "*.parquet").as_posix()}') WHERE weight IS NULL""")[0][0]
    assert missing == 0, f"{missing} harmonized cell-days have no ratio"


def report(con):
    C.REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    print("\nPooled monthly ratios over regions with their own ratio "
          "(S-NPP cell-days per other-sensor cell-day):")
    print(con.sql("""
        PIVOT (SELECT sensor, moy, round(sum(n_ref) / sum(n_sensor), 3) AS ratio
               FROM ratios WHERE level = 2 GROUP BY ALL)
        ON sensor USING first(ratio) ORDER BY moy
    """))
    print(con.sql("""
        SELECT sensor, level, count(*) AS region_months,
               round(median(ratio), 3) AS median_ratio,
               round(quantile_cont(ratio, 0.1), 3) AS p10, round(quantile_cont(ratio, 0.9), 3) AS p90
        FROM ratios GROUP BY ALL ORDER BY sensor, level DESC
    """))
    print(con.sql("""
        SELECT sensor, count(*) AS days, count(*) FILTER (WHERE gap) AS gap_days,
               min(acq_date) AS first, max(acq_date) AS last
        FROM days GROUP BY ALL ORDER BY first
    """))
    run(con, f"""
        COPY (SELECT sensor, level, moy, count(*) AS region_months,
                     median(ratio) AS median_ratio, sum(n_ref) / sum(n_sensor) AS pooled_ratio
              FROM ratios GROUP BY ALL ORDER BY sensor, level DESC, moy)
        TO '{(C.REPORTS_DIR / 'calibration_ratios.csv').as_posix()}' (HEADER)
    """)
    run(con, f"""
        COPY (SELECT * FROM days WHERE gap OR sensor <> CASE
                  WHEN acq_date < DATE '{C.SNPP_START}' THEN '{C.MODIS_AQUA}'
                  WHEN acq_date > DATE '{C.SNPP_END}' THEN '{C.VIIRS_NOAA20}'
                  ELSE '{C.VIIRS_SNPP}' END)
        TO '{(C.REPORTS_DIR / 'source_substitutions_and_gaps.csv').as_posix()}' (HEADER)
    """)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = time.time()
    C.HARMONIZED_DIR.mkdir(parents=True, exist_ok=True)
    con = connect()
    steps = [("fire cell-days", build_celldays), ("calibration ratios", build_ratios),
             ("daily source plan", build_plan), ("harmonized cell-days", build_harmonized),
             ("report", report)]
    for name, fn in steps:
        t = time.time()
        fn(con)
        print(f"  {name}: {time.time() - t:.0f}s")
    print(f"Done in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
