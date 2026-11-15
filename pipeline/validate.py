"""Validate the harmonization with a holdout test (CLAUDE.md section 5, step 7).

1. Calibrate MODIS -> S-NPP ratios exactly as harmonize.py does, but on
   2012-01-20..2016-12-31 only.
2. Predict S-NPP fire cell-days for 2017-2019 from MODIS alone (MODIS x ratio).
3. Compare with what S-NPP actually saw, on days both sensors observed normally,
   and against raw MODIS (no conversion) as the baseline.

Metrics: monthly worldwide totals (36 months) and region-months (H3 res 1,
~600,000 km2, with at least MIN_REGION_CELLDAYS actual cell-days).

Outputs:
    reports/validation.csv              the metrics
    ../web/src/data/validation.json     metrics + series for the home page chart
"""
import json
import sys
import time
from datetime import date

import config as C
import harmonize as H
from clean import connect, run

TRAIN = (C.SNPP_START, date(2016, 12, 31))
TEST = (date(2017, 1, 1), date(2019, 12, 31))
MIN_REGION_CELLDAYS = 100
OUT_JSON = C.ROOT.parent / "web" / "src" / "data" / "validation.json"


def load(con):
    run(con, f"""
        CREATE OR REPLACE VIEW celldays AS
        SELECT * FROM read_parquet('{(C.CELLDAYS_DIR / "**" / "*.parquet").as_posix()}',
                                   hive_partitioning = true)
    """)
    H.build_ratios(con, {C.MODIS_AQUA: TRAIN}, C.QA_DIR / "holdout_ratios.parquet")


def build_test(con):
    """MODIS, predicted and actual S-NPP cell-days per calibration region and month, 2017-2019."""
    m, v = C.MODIS_AQUA, C.VIIRS_SNPP
    run(con, f"""
        CREATE OR REPLACE TEMP TABLE test AS
        WITH ok AS (
            SELECT acq_date FROM daily_counts
            WHERE acq_date BETWEEN DATE '{TEST[0]}' AND DATE '{TEST[1]}'
              AND sensor IN ('{m}', '{v}') AND NOT possible_gap
            GROUP BY acq_date HAVING count(*) = 2
        ),
        c AS (
            SELECT h3_cell_to_parent(cell8, {C.H3_CALIB_RES}) AS cell2,
                   date_trunc('month', acq_date)::DATE AS month,
                   count(*) FILTER (WHERE sensor = '{m}') AS modis,
                   count(*) FILTER (WHERE sensor = '{v}') AS actual
            FROM celldays
            WHERE sensor IN ('{m}', '{v}') AND year BETWEEN {TEST[0].year} AND {TEST[1].year}
              AND acq_date IN (SELECT acq_date FROM ok)
            GROUP BY ALL
        )
        SELECT c.cell2, h3_cell_to_parent(c.cell2, 1) AS cell1, c.month, c.modis, c.actual,
               c.modis * coalesce(r.ratio, 0) AS predicted
        FROM c LEFT JOIN ratios r ON r.cell2 = c.cell2 AND r.moy = month(c.month)
    """)
    days = run(con, "SELECT count(DISTINCT month) FROM test")[0][0]
    missing = run(con, "SELECT count(*) FROM test WHERE modis > 0 AND predicted = 0")[0][0]
    print(f"  test months: {days}, region-months with MODIS fire but no ratio: {missing}")


def metrics(con) -> dict:
    g = run(con, """
        WITH t AS (SELECT month, sum(actual) a, sum(predicted) p, sum(modis) m FROM test GROUP BY 1)
        SELECT count(*), avg(abs(p - a) / a), avg(abs(m - a) / a),
               sum(p) / sum(a) - 1, sum(m) / sum(a) - 1, corr(p, a)
        FROM t
    """)[0]
    r = run(con, f"""
        WITH t AS (SELECT cell1, month, sum(actual) a, sum(predicted) p, sum(modis) m
                   FROM test GROUP BY 1, 2 HAVING sum(actual) >= {MIN_REGION_CELLDAYS})
        SELECT count(*), median(abs(p - a) / a), median(abs(m - a) / a),
               avg((abs(p - a) / a <= 0.25)::INT), avg((abs(m - a) / a <= 0.25)::INT), corr(p, a)
        FROM t
    """)[0]
    ratios = run(con, f"""
        SELECT sensor, sum(n_ref) / sum(n_sensor)
        FROM '{(C.HARMONIZED_DIR / "ratios.parquet").as_posix()}' WHERE level = 2 GROUP BY 1
    """)
    pct = lambda x: round(100 * float(x), 1)
    return {
        "global_monthly": {"months": g[0], "mape_harmonized": pct(g[1]), "mape_raw_modis": pct(g[2]),
                           "bias_harmonized": pct(g[3]), "bias_raw_modis": pct(g[4]), "r": round(g[5], 3)},
        "regional_monthly": {"region_months": r[0], "median_ape_harmonized": pct(r[1]),
                             "median_ape_raw_modis": pct(r[2]), "within_25pct_harmonized": pct(r[3]),
                             "within_25pct_raw_modis": pct(r[4]), "r": round(r[5], 3),
                             "min_actual_celldays": MIN_REGION_CELLDAYS},
        "ratios_used": {s: round(v, 3) for s, v in ratios},
    }


def series(con) -> dict:
    holdout = run(con, """
        SELECT strftime(month, '%Y-%m'), sum(actual), round(sum(predicted)), sum(modis)
        FROM test GROUP BY month ORDER BY month
    """)
    # Raw = what you'd get by stitching each sensor's counts end to end; harmonized
    # = the published record. Fire cell-days per month, worldwide; the last
    # (incomplete) month is left out.
    rows = run(con, f"""
        SELECT strftime(month::DATE, '%Y-%m') AS m,
               CASE WHEN month::DATE < DATE '2012-02-01' THEN MODIS_AQUA_cell_days
                    WHEN month::DATE <= DATE '{C.SNPP_END:%Y-%m-01}' THEN VIIRS_SNPP_cell_days
                    ELSE VIIRS_NOAA20_cell_days END AS raw,
               round(harmonized_fire_days) AS harmonized,
               MODIS_AQUA_cell_days AS modis, VIIRS_SNPP_cell_days AS snpp
        FROM '{(C.REPORTS_DIR / "series_monthly.csv").as_posix()}'
        ORDER BY 1
    """)[:-1]
    return {
        "holdout": {"columns": ["month", "actual_snpp", "predicted_from_modis", "raw_modis"],
                    "rows": [list(r) for r in holdout]},
        "monthly": {"columns": ["month", "raw_stitched", "harmonized", "raw_modis", "raw_snpp"],
                    "rows": [[m, *(None if x is None else int(x) for x in rest)] for m, *rest in rows]},
    }


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = time.time()
    con = connect()
    run(con, f"CREATE OR REPLACE TEMP TABLE daily_counts AS SELECT * FROM '{(C.QA_DIR / 'daily_counts.parquet').as_posix()}'")
    load(con)
    build_test(con)
    result = {
        "generated": date.today().isoformat(),
        "method": {
            "train": f"{TRAIN[0]} to {TRAIN[1]}", "test": f"{TEST[0]} to {TEST[1]}",
            "unit": "fire cell-days (H3 res 8 cell x day with at least one detection)",
            "reference": "VIIRS S-NPP 375 m", "calibration": "ratio per H3 res 2 region and calendar month, "
            "falling back to coarser regions when sparse (as in harmonize.py)",
            "test_days": "days both sensors observed normally (no flagged data gaps)",
        },
        **metrics(con),
        **series(con),
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(result, separators=(",", ":")))
    C.REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    with open(C.REPORTS_DIR / "validation.csv", "w", encoding="utf-8") as f:
        f.write("scope,metric,value\n")
        for scope in ("global_monthly", "regional_monthly", "ratios_used"):
            for k, v in result[scope].items():
                f.write(f"{scope},{k},{v}\n")
    print(json.dumps({k: result[k] for k in ("global_monthly", "regional_monthly", "ratios_used")}, indent=2))
    print(f"Wrote {OUT_JSON} ({OUT_JSON.stat().st_size / 1024:.0f} KB) in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
