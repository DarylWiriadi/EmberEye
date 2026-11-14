"""Shared settings for the pipeline: paths, H3 resolutions, thresholds, sensor dates.

Paths can be overridden with environment variables, e.g. to put the interim
files on another drive:  EMBEREYE_INTERIM=D:/EmberEye/interim
"""
import os
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# --- Paths -----------------------------------------------------------------
RAW_DIR = Path(os.environ.get("EMBEREYE_RAW", ROOT / "data" / "raw"))
RAW_WORLD = RAW_DIR / "world"
INTERIM_DIR = Path(os.environ.get("EMBEREYE_INTERIM", ROOT / "data" / "interim"))
HOTSPOTS_DIR = INTERIM_DIR / "hotspots"        # cleaned points, hive-partitioned sensor=/year=
QA_DIR = INTERIM_DIR / "qa"                    # data-gap flags, mask checks
DUCKDB_TEMP = INTERIM_DIR / "_duckdb_tmp"       # spill space for big queries
DUCKDB_EXT_DIR = ROOT / "data" / "duckdb_ext"   # h3 extension (installed once, then offline)

# DuckDB resources. The machine has ~24 GB RAM; leave room for everything else.
DUCKDB_MEMORY_LIMIT = os.environ.get("EMBEREYE_DUCKDB_MEMORY", "6GB")
DUCKDB_THREADS = int(os.environ.get("EMBEREYE_DUCKDB_THREADS", "8"))

# --- Sensors ---------------------------------------------------------------
# Internal sensor names used in every table from here on.
MODIS_AQUA = "MODIS_AQUA"
VIIRS_SNPP = "VIIRS_SNPP"
VIIRS_NOAA20 = "VIIRS_NOAA20"

MODIS_AQUA_START = date(2002, 7, 4)
SNPP_START = date(2012, 1, 20)
SNPP_END = date(2026, 11, 2)          # S-NPP stopped delivering new data after this day
NOAA20_START = date(2018, 4, 1)

# --- Cleaning thresholds ---------------------------------------------------
KEEP_TYPES = (0,)                     # 0 = presumed vegetation fire (incl. agricultural burns)
MODIS_MIN_CONFIDENCE = 30             # MODIS confidence is 0-100; FIRMS "low" class is < 30
VIIRS_DROP_CONFIDENCE = ("l",)        # VIIRS confidence is l / n / h

# NRT files have no `type` column, so static sources (gas flares, volcanoes,
# offshore platforms) are removed with a mask learned from the SP history:
# an H3 cell is "static" if non-vegetation detections make up at least this
# share of its SP detections, with at least this many of them.
STATIC_MASK_RES = 8
STATIC_MASK_MIN_SHARE = 0.5
STATIC_MASK_MIN_COUNT = 2

# A day is flagged as a possible data gap when its detection count is below
# this fraction of the centred 31-day median for that sensor.
GAP_FRACTION = 0.25
GAP_WINDOW_DAYS = 31

# --- H3 --------------------------------------------------------------------
H3_FIRE_RES = 8          # fire cell-days (~0.7 km2)
H3_CALIB_RES = 2         # calibration regions
H3_GLOBAL_MONTHLY_RES = 5
H3_GLOBAL_DAILY_RES = 3
H3_REGION_RES = 7
