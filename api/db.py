"""DuckDB connection over the Parquet files in ./data.

One in-memory database per process; each request gets its own cursor
(cursors are separate connections to the same database, so per-request temp
tables don't clash). Big tables stay as views over Parquet; small lookups are
loaded into memory once.
"""
import tempfile
import threading
from pathlib import Path

import duckdb

DATA = Path(__file__).resolve().parent / "data"

# Must match the pipeline's config.CLIMATOLOGY_YEARS.
BASELINE_YEARS = (2003, 2025)

_con: duckdb.DuckDBPyConnection | None = None
_lock = threading.Lock()


def _p(*parts: str) -> str:
    return DATA.joinpath(*parts).as_posix()


def _connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    # Vercel's filesystem is read-only except /tmp.
    con.execute(f"SET temp_directory = '{Path(tempfile.gettempdir()).as_posix()}'")
    con.execute("SET memory_limit = '1GB'")
    con.execute(f"""
        CREATE VIEW monthly AS SELECT * FROM read_parquet('{_p("global", "monthly_res5", "*.parquet")}');
        CREATE VIEW daily AS SELECT * FROM read_parquet('{_p("global", "daily_res3", "*.parquet")}');
        CREATE TABLE cells AS SELECT * FROM '{_p("global", "cells_res5.parquet")}';
        CREATE TABLE days AS SELECT * FROM '{_p("global", "days.parquet")}';
    """)
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
