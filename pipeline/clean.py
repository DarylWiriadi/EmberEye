"""Clean FIRMS hotspots and stack all sensors into one table.

Reads the raw downloads in place (gzipped API chunks and the S-NPP yearly zips,
nothing is extracted) and writes slim, cleaned points to
    interim/hotspots/sensor=<SENSOR>/year=<YYYY>/<PRODUCT>_<LABEL>_<i>.parquet

Rules (see CLAUDE.md section 5, step 2):
  * keep FIRMS type 0 only (vegetation fires, including agricultural burns)
  * MODIS: Aqua only, confidence >= MODIS_MIN_CONFIDENCE
  * VIIRS: drop low ('l') confidence
  * SP (science quality) wherever it exists; NRT only for dates after the
    sensor's last SP date, so nothing is double counted
  * NRT files have no `type` column: their static sources are removed with a
    mask of H3 cells learned from the SP history (written to qa/static_cells.parquet)
  * days with unusually low detection counts are flagged as possible data gaps
    (qa/daily_counts.parquet, qa/data_gaps.csv), not treated as quiet periods

Usage:
    python clean.py                 # everything
    python clean.py --years 2019    # quick sample run (only units for those years)
"""
import argparse
import sys
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.csv as pacsv

import config as C

COLUMNS = ["latitude", "longitude", "acq_date", "acq_time", "satellite",
           "confidence", "frp", "daynight", "type"]


@dataclass
class Unit:
    """One batch of raw input that is cleaned in a single pass."""
    sensor: str
    product: str           # "SP" or "NRT"
    label: str             # year label, used in output file names
    files: list[Path]      # gz chunks, or a single zip
    member: str | None = None  # CSV name inside the zip

    @property
    def name(self):
        return f"{self.sensor} {self.product} {self.label}"


# --------------------------------------------------------------------------
# Connection
# --------------------------------------------------------------------------
def run(con, sql):
    """Execute and fully read the result (DuckDB 2 won't run the next statement
    on a connection until the previous result has been consumed)."""
    return con.execute(sql).fetchall()


def connect():
    for d in (C.DUCKDB_TEMP, C.DUCKDB_EXT_DIR, C.HOTSPOTS_DIR, C.QA_DIR):
        d.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    run(con, f"SET extension_directory = '{C.DUCKDB_EXT_DIR.as_posix()}'")
    run(con, f"SET temp_directory = '{C.DUCKDB_TEMP.as_posix()}'")
    run(con, f"SET memory_limit = '{C.DUCKDB_MEMORY_LIMIT}'")
    run(con, f"SET threads = {C.DUCKDB_THREADS}")
    run(con, "SET preserve_insertion_order = false")
    try:
        run(con, "LOAD h3")
    except duckdb.Error:
        run(con, "INSTALL h3 FROM community")
        run(con, "LOAD h3")
    return con


# --------------------------------------------------------------------------
# Discover inputs
# --------------------------------------------------------------------------
def gz_units(folder: Path, sensor: str, product: str, years):
    """Group 5-day API chunks (named <start-date>.csv.gz) into one unit per year."""
    by_year: dict[str, list[Path]] = {}
    for f in sorted(folder.glob("*.csv.gz")):
        by_year.setdefault(f.name[:4], []).append(f)
    return [Unit(sensor, product, y, fs) for y, fs in by_year.items()
            if not years or int(y) in years]


def zip_units(folder: Path, sensor: str, years):
    """One unit per CSV inside each FIRMS archive zip (archive = SP, nrt = NRT)."""
    units = []
    for z in sorted(folder.glob("*.zip")):
        with zipfile.ZipFile(z) as zf:
            for member in zf.namelist():
                if not member.endswith(".csv"):
                    continue
                with zf.open(member) as f:
                    f.readline()
                    year = f.readline().decode()[:200].split(",")[5][:4]
                product = "NRT" if "_nrt_" in member else "SP"
                if not years or int(year) in years:
                    units.append(Unit(sensor, product, year, [z], member))
    return units


def discover(years):
    w = C.RAW_WORLD
    units = []
    units += gz_units(w / "MODIS_SP", C.MODIS_AQUA, "SP", years)
    units += zip_units(w / "VIIRS_SNPP_archive", C.VIIRS_SNPP, years)
    units += gz_units(w / "VIIRS_NOAA20_SP", C.VIIRS_NOAA20, "SP", years)
    units += gz_units(w / "VIIRS_NOAA20_NRT", C.VIIRS_NOAA20, "NRT", years)
    return units


# --------------------------------------------------------------------------
# Load one unit into a slim temp table
# --------------------------------------------------------------------------
def register_source(con, unit: Unit):
    """Expose the unit's raw rows as view `src` with the COLUMNS above."""
    if unit.member:  # stream the CSV straight out of the zip with pyarrow
        zf = zipfile.ZipFile(unit.files[0])
        reader = pacsv.open_csv(
            zf.open(unit.member),
            read_options=pacsv.ReadOptions(block_size=64 << 20),
            convert_options=pacsv.ConvertOptions(
                include_columns=COLUMNS,
                include_missing_columns=True,
                column_types={"latitude": pa.float64(), "longitude": pa.float64(),
                              "acq_date": pa.date32(), "acq_time": pa.int16(),
                              "satellite": pa.string(), "confidence": pa.string(),
                              "frp": pa.float32(), "daynight": pa.string(),
                              "type": pa.int8()},
            ),
        )
        con.register("src", reader)
        return zf

    import gzip
    with gzip.open(unit.files[0], "rt") as f:
        header = f.readline().strip().split(",")
    types = {"acq_date": "DATE", "acq_time": "SMALLINT", "confidence": "VARCHAR",
             "satellite": "VARCHAR"}
    if "type" in header:
        types["type"] = "TINYINT"
    files = ", ".join(f"'{p.as_posix()}'" for p in unit.files)
    type_types = ", ".join(f"'{k}': '{v}'" for k, v in types.items())
    type_col = "type" if "type" in header else "NULL::TINYINT AS type"
    run(con, f"""
        CREATE OR REPLACE TEMP VIEW src AS
        SELECT latitude, longitude, acq_date, acq_time, satellite, confidence,
               frp, daynight, {type_col}
        FROM read_csv([{files}], header = true, union_by_name = true,
                      types = {{{type_types}}})
    """)
    return None


def load_slim(con, unit: Unit):
    """Materialise the unit as temp table `slim` (sensor filter applied, H3 added)."""
    keep = []
    if unit.sensor == C.MODIS_AQUA:
        keep.append("satellite IN ('Aqua', 'A')")
        low_conf = f"TRY_CAST(confidence AS INTEGER) < {C.MODIS_MIN_CONFIDENCE}"
    else:
        drop = ", ".join(f"'{c}'" for c in C.VIIRS_DROP_CONFIDENCE)
        low_conf = f"lower(trim(confidence)) IN ({drop})"
    if unit.sensor == C.VIIRS_SNPP:
        keep.append(f"acq_date <= DATE '{C.SNPP_END}'")
    where = " AND ".join(keep) or "true"

    zf = register_source(con, unit)
    try:
        run(con, f"""
            CREATE OR REPLACE TEMP TABLE slim AS
            SELECT '{unit.sensor}' AS sensor,
                   '{unit.product}' AS product,
                   acq_date,
                   acq_time,
                   latitude,
                   longitude,
                   frp::FLOAT AS frp,
                   lower(trim(confidence)) AS confidence,
                   upper(trim(daynight)) AS daynight,
                   type::TINYINT AS type,
                   coalesce({low_conf}, false) AS low_conf,
                   h3_latlng_to_cell(latitude, longitude, {C.H3_FIRE_RES}) AS cell8
            FROM src
            WHERE {where}
        """)
    finally:
        con.unregister("src") if zf else run(con, "DROP VIEW IF EXISTS src")
        if zf:
            zf.close()


# --------------------------------------------------------------------------
# Write
# --------------------------------------------------------------------------
def clear_outputs(unit: Unit):
    pattern = f"sensor={unit.sensor}/year=*/{unit.product}_{unit.label}_*.parquet"
    for f in C.HOTSPOTS_DIR.glob(pattern):
        f.unlink()


def write_kept(con, unit: Unit, extra_where="true"):
    clear_outputs(unit)
    out = (C.HOTSPOTS_DIR / f"sensor={unit.sensor}").as_posix()
    run(con, f"""
        COPY (
            SELECT product, acq_date, acq_time, latitude, longitude, frp,
                   confidence, daynight, cell8, year(acq_date) AS year
            FROM slim
            WHERE NOT low_conf AND {extra_where}
            ORDER BY acq_date, cell8
        ) TO '{out}' (FORMAT parquet, COMPRESSION zstd, PARTITION_BY (year),
                      FILENAME_PATTERN '{unit.product}_{unit.label}_{{i}}',
                      OVERWRITE_OR_IGNORE true)
    """)


def record_counts(con, unit: Unit, kept_where):
    """Append per-unit reason counts to `summary`, and raw daily counts to `daily`."""
    nonveg = ("type IS NOT NULL AND type NOT IN ("
              + ", ".join(map(str, C.KEEP_TYPES)) + ")")
    run(con, f"""
        INSERT INTO summary
        SELECT '{unit.sensor}', '{unit.product}', '{unit.label}',
               count(*),
               count(*) FILTER (WHERE {nonveg}),
               count(*) FILTER (WHERE NOT ({nonveg}) AND low_conf),
               count(*) FILTER (WHERE NOT ({nonveg}) AND NOT low_conf AND NOT ({kept_where})),
               count(*) FILTER (WHERE NOT low_conf AND {kept_where}),
               min(acq_date), max(acq_date)
        FROM slim
    """)
    run(con, f"""
        INSERT INTO daily
        SELECT sensor, product, acq_date, count(*) FROM slim GROUP BY ALL
    """)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main(args):
    sys.stdout.reconfigure(encoding="utf-8")  # DuckDB tables use box-drawing characters
    t0 = time.time()
    years = set(args.years or [])
    con = connect()
    run(con, """
        CREATE TEMP TABLE summary (sensor VARCHAR, product VARCHAR, label VARCHAR,
            rows BIGINT, dropped_nonveg BIGINT, dropped_low_conf BIGINT,
            dropped_other BIGINT, kept BIGINT, first_date DATE, last_date DATE);
        CREATE TEMP TABLE daily (sensor VARCHAR, product VARCHAR, acq_date DATE, n BIGINT);
        CREATE TEMP TABLE mask_stats (cell8 UBIGINT, n_nonveg BIGINT, n BIGINT);
    """)

    units = discover(years)
    sp = [u for u in units if u.product == "SP"]
    nrt = [u for u in units if u.product == "NRT"]
    print(f"{len(sp)} SP units, {len(nrt)} NRT units -> {C.HOTSPOTS_DIR}")

    # 1. SP: real `type` column available.
    keep_types = "type IN (" + ", ".join(map(str, C.KEEP_TYPES)) + ")"
    for i, u in enumerate(sp, 1):
        t = time.time()
        load_slim(con, u)
        record_counts(con, u, keep_types)
        run(con, f"""
            INSERT INTO mask_stats
            SELECT cell8, count(*) FILTER (WHERE NOT ({keep_types})), count(*)
            FROM slim GROUP BY cell8
        """)
        # Compact to one row per cell so the tally doesn't grow with every unit.
        run(con, """
            CREATE OR REPLACE TEMP TABLE mask_stats AS
            SELECT cell8, sum(n_nonveg)::BIGINT AS n_nonveg, sum(n)::BIGINT AS n
            FROM mask_stats GROUP BY cell8
        """)
        write_kept(con, u, keep_types)
        kept = run(con, "SELECT kept FROM summary ORDER BY rowid DESC LIMIT 1")[0][0]
        print(f"  [{i}/{len(sp)}] {u.name}: {kept:,} kept ({time.time() - t:.0f}s)")

    # 2. Static-source mask from the SP history.
    run(con, f"""
        CREATE TEMP TABLE cell_stats AS
        SELECT cell8, sum(n_nonveg) AS n_nonveg, sum(n) AS n
        FROM mask_stats GROUP BY cell8;
        CREATE TEMP TABLE static_cells AS
        SELECT cell8, n_nonveg, n FROM cell_stats
        WHERE n_nonveg >= {C.STATIC_MASK_MIN_COUNT}
          AND n_nonveg >= {C.STATIC_MASK_MIN_SHARE} * n;
    """)
    if args.years:
        print("  note: sample run, so the static mask only uses the sampled years")
    run(con, f"COPY static_cells TO '{(C.QA_DIR / 'static_cells.parquet').as_posix()}'"
                " (FORMAT parquet)")
    check = run(con, """
        SELECT count(*) FILTER (WHERE s.cell8 IS NOT NULL),
               sum(c.n_nonveg) FILTER (WHERE s.cell8 IS NOT NULL) / nullif(sum(c.n_nonveg), 0),
               sum(c.n - c.n_nonveg) FILTER (WHERE s.cell8 IS NOT NULL) / nullif(sum(c.n - c.n_nonveg), 0)
        FROM cell_stats c LEFT JOIN static_cells s USING (cell8)
    """)[0]
    print(f"  static mask: {check[0]:,} cells; on SP data it removes "
          f"{(check[1] or 0):.1%} of non-vegetation detections and "
          f"{(check[2] or 0):.2%} of vegetation fires (in-sample)")

    # 3. NRT: only after the sensor's last SP date; static mask instead of `type`.
    sp_end = {}
    for sensor in {u.sensor for u in nrt}:
        files = list((C.HOTSPOTS_DIR / f"sensor={sensor}").glob("year=*/SP_*.parquet"))
        if files:
            lst = ", ".join(f"'{f.as_posix()}'" for f in files)
            sp_end[sensor] = run(con, f"SELECT max(acq_date) FROM read_parquet([{lst}])")[0][0]
    for i, u in enumerate(nrt, 1):
        t = time.time()
        load_slim(con, u)
        after = f"acq_date > DATE '{sp_end[u.sensor]}'" if u.sensor in sp_end else "true"
        run(con, f"DELETE FROM slim WHERE NOT ({after})")
        not_static = "cell8 NOT IN (SELECT cell8 FROM static_cells)"
        record_counts(con, u, not_static)
        write_kept(con, u, not_static)
        kept = run(con, "SELECT kept FROM summary ORDER BY rowid DESC LIMIT 1")[0][0]
        print(f"  [{i}/{len(nrt)}] {u.name} (after {sp_end.get(u.sensor, 'n/a')}): "
              f"{kept:,} kept ({time.time() - t:.0f}s)")

    # 4. Data-gap flags: daily count vs centred rolling median, per sensor,
    #    only within each sensor's covered date span(s).
    half = C.GAP_WINDOW_DAYS // 2
    run(con, f"""
        CREATE TEMP TABLE daily_counts AS
        WITH d AS (SELECT sensor, acq_date, sum(n) AS n FROM daily GROUP BY ALL),
        breaks AS (  -- a new coverage span starts after more than 10 missing days
            SELECT sensor, acq_date,
                   coalesce(acq_date - lag(acq_date) OVER (PARTITION BY sensor ORDER BY acq_date) > 10,
                            false)::INT AS new_span
            FROM d
        ),
        spans AS (
            SELECT sensor, acq_date,
                   sum(new_span) OVER (PARTITION BY sensor ORDER BY acq_date
                                       ROWS UNBOUNDED PRECEDING) AS span
            FROM breaks
        ),
        cal AS (
            SELECT sensor, span,
                   unnest(generate_series(min(acq_date), max(acq_date), INTERVAL 1 DAY))::DATE AS acq_date
            FROM spans GROUP BY sensor, span
        ),
        f AS (SELECT cal.sensor, cal.acq_date, coalesce(d.n, 0) AS n
              FROM cal LEFT JOIN d USING (sensor, acq_date))
        SELECT *, n < {C.GAP_FRACTION} * rolling_median AS possible_gap
        FROM (SELECT *, median(n) OVER (PARTITION BY sensor ORDER BY acq_date
                  ROWS BETWEEN {half} PRECEDING AND {half} FOLLOWING) AS rolling_median
              FROM f)
        ORDER BY sensor, acq_date
    """)
    run(con, f"COPY daily_counts TO '{(C.QA_DIR / 'daily_counts.parquet').as_posix()}' (FORMAT parquet)")
    run(con, f"COPY (SELECT * FROM daily_counts WHERE possible_gap) "
                f"TO '{(C.QA_DIR / 'data_gaps.csv').as_posix()}' (HEADER)")
    run(con, f"COPY summary TO '{(C.QA_DIR / 'clean_summary.csv').as_posix()}' (HEADER)")

    print("\nSummary by sensor:")
    print(con.sql("""
        SELECT sensor, product, sum(rows) AS rows, sum(dropped_nonveg) AS nonveg,
               sum(dropped_low_conf) AS low_conf, sum(dropped_other) AS other,
               sum(kept) AS kept, min(first_date) AS first, max(last_date) AS last
        FROM summary GROUP BY ALL ORDER BY sensor, product
    """))
    print(con.sql("""
        SELECT sensor, count(*) FILTER (WHERE possible_gap) AS gap_days, count(*) AS days
        FROM daily_counts GROUP BY ALL ORDER BY sensor
    """))
    print(f"Done in {(time.time() - t0) / 60:.1f} min. QA files in {C.QA_DIR}")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--years", type=int, nargs="*", help="only process units for these years")
    main(p.parse_args())
