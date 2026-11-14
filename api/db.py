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
manifest: dict = {}         # points_manifest.json (which R2 files exist)
regions: dict = {}          # data/regions/regions.json


def _p(*parts: str) -> str:
    return DATA.joinpath(*parts).as_posix()


def _sql_str(v: str) -> str:
    return "'" + v.replace("'", "''") + "'"


def _setup_r2(con) -> bool:
    keys = [os.environ.get(k, "") for k in
            ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")]
    if not (all(keys) and R2_BUCKET):
        log.info("R2 not configured; using bundled demo regions for hotspot points")
        return False
    account, key_id, secret = keys
    try:
        con.execute("LOAD httpfs")
        con.execute(f"""CREATE SECRET r2 (TYPE r2, KEY_ID {_sql_str(key_id)},
                        SECRET {_sql_str(secret)}, ACCOUNT_ID {_sql_str(account)})""")
        con.execute("SET enable_http_metadata_cache = true")
        con.execute("SET parquet_metadata_cache = true")
        return True
    except duckdb.Error as e:
        log.warning("R2 setup failed (%s); using bundled demo regions", e)
        return False


def _connect() -> duckdb.DuckDBPyConnection:
    global r2_enabled, manifest, regions
    con = duckdb.connect()
    # Vercel's filesystem is read-only except /tmp.
    con.execute(f"SET temp_directory = '{Path(tempfile.gettempdir()).as_posix()}'")
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
    regions = json.loads((DATA / "regions" / "regions.json").read_text())
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
