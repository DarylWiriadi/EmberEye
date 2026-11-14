"""DuckDB connection over the Parquet files in ./data (and, for individual
hotspots, Cloudflare R2).

One in-memory database per process; each request gets its own cursor
(cursors are separate connections to the same database, so per-request temp
tables don't clash). Big tables stay as views over Parquet; small lookups are
loaded into memory once.

R2 is optional: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and
R2_BUCKET. Without them (or if R2 can't be reached) individual hotspots come
from the demo regions bundled in data/regions/.
"""
import json
import logging
import os
import tempfile
import threading
from datetime import date
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
EXT_DIR = ROOT / "duckdb_ext"   # bundled extensions; nothing is downloaded at runtime

# Must match the pipeline's config.CLIMATOLOGY_YEARS.
BASELINE_YEARS = (2003, 2025)

# H3 res 5 parent of a res 8 cell with bit operations: set the resolution field
# to 5 and mark digits 6..15 as unused (7), exactly what h3 cell_to_parent does.
CELL5_FROM_CELL8 = ("((cell8 & ~(15::UBIGINT << 52)) | (5::UBIGINT << 52) "
                    "| ((1::UBIGINT << 30) - 1))")

log = logging.getLogger("embereye")
_con: duckdb.DuckDBPyConnection | None = None
_lock = threading.Lock()

R2_BUCKET = os.environ.get("R2_BUCKET", "")
r2_enabled = False          # set by _connect()
r2_status = "not started"   # shown by /health (never includes secrets)
r2_last_error = None        # last failed R2 read, shown by /health (account id masked)
manifest: dict = {}         # points_manifest.json (which R2 files exist)
regions: dict = {}          # data/regions/regions.json


def _p(*parts: str) -> str:
    return DATA.joinpath(*parts).as_posix()


def _sql_str(v: str) -> str:
    return "'" + v.replace("'", "''") + "'"


def _setup_r2(con) -> bool:
    global r2_status
    names = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
    missing = [k for k in names if not os.environ.get(k)]
    if missing:
        r2_status = "not configured, missing: " + ", ".join(missing)
        log.info("R2 %s; using bundled demo regions for hotspot points", r2_status)
        return False
    try:
        con.execute("LOAD httpfs")
        con.execute(f"""CREATE SECRET r2 (TYPE r2,
                        KEY_ID {_sql_str(os.environ["R2_ACCESS_KEY_ID"])},
                        SECRET {_sql_str(os.environ["R2_SECRET_ACCESS_KEY"])},
                        ACCOUNT_ID {_sql_str(os.environ["R2_ACCOUNT_ID"])})""")
        con.execute("SET enable_http_metadata_cache = true")
        con.execute("SET parquet_metadata_cache = true")
        r2_status = "enabled"
        return True
    except duckdb.Error as e:
        # Error text from LOAD/CREATE SECRET doesn't contain the key values.
        r2_status = f"setup failed: {type(e).__name__}: {str(e)[:300]}"
        log.warning("R2 %s; using bundled demo regions", r2_status)
        return False


def _connect() -> duckdb.DuckDBPyConnection:
    global r2_enabled, manifest, regions
    con = duckdb.connect()
    # Vercel's filesystem is read-only except /tmp.
    tmp = Path(tempfile.gettempdir()).as_posix()
    con.execute(f"SET temp_directory = '{tmp}'")
    # Serverless functions have no writable home folder; httpfs/secrets may need one.
    con.execute(f"SET home_directory = '{tmp}'")
    con.execute("SET memory_limit = '1GB'")
    con.execute(f"SET extension_directory = '{EXT_DIR.as_posix()}'")
    con.execute("SET autoinstall_known_extensions = false")
    con.execute(f"""
        CREATE VIEW monthly AS SELECT * FROM read_parquet('{_p("global", "monthly_res5", "*.parquet")}');
        CREATE VIEW daily AS SELECT * FROM read_parquet('{_p("global", "daily_res3", "*.parquet")}');
        CREATE TABLE cells AS SELECT * FROM '{_p("global", "cells_res5.parquet")}';
        CREATE TABLE days AS SELECT * FROM '{_p("global", "days.parquet")}';
        CREATE VIEW region_points AS
        SELECT *, {CELL5_FROM_CELL8} AS cell5 FROM read_parquet('{_p("regions", "*.parquet")}');
    """)
    manifest = json.loads((DATA / "points_manifest.json").read_text())
    # Only regions whose file was deployed (see .vercelignore) count as fallback.
    regions = {slug: r for slug, r in
               json.loads((DATA / "regions" / "regions.json").read_text()).items()
               if (DATA / "regions" / f"{slug}.parquet").exists()}
    r2_enabled = _setup_r2(con)
    return con


def cursor() -> duckdb.DuckDBPyConnection:
    global _con
    with _lock:
        if _con is None:
            _con = _connect()
    return _con.cursor()


def coverage(cur) -> tuple:
    """(first date, last date) of the harmonized record."""
    return cur.execute("SELECT min(date), max(date) FROM days").fetchone()


def points_coverage() -> tuple[date, date]:
    """(first date, last date) of the individual hotspot archive."""
    return date.fromisoformat(manifest["first"]), date.fromisoformat(manifest["last"])


def record_r2_error(e: Exception) -> None:
    """Remember the last R2 read failure for /health, without secrets."""
    global r2_last_error
    msg = f"{type(e).__name__}: {e}"
    for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        v = os.environ.get(k)
        if v:
            msg = msg.replace(v, f"<{k}>")
    r2_last_error = msg[:500]
