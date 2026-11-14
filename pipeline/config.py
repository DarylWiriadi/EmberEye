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

# --- Harmonization -------------------------------------------------------
CELLDAYS_DIR = INTERIM_DIR / "celldays"        # one row per (cell8, date, sensor)
HARMONIZED_DIR = INTERIM_DIR / "harmonized"    # chosen sensor per day, VIIRS-equivalent weights
API_DATA_DIR = ROOT.parent / "api" / "data"    # final outputs served by the API (committed)
REPORTS_DIR = ROOT / "reports"                 # small QA/validation files (committed)

# Overlap windows used to calibrate each sensor against S-NPP (the reference).
# MODIS: 2012-2019 only (Terra/Aqua orbit drift after 2019 changed overpass times).
CALIB_WINDOWS = {
    MODIS_AQUA: (date(2012, 1, 20), date(2019, 12, 31)),
    VIIRS_NOAA20: (date(2024, 1, 1), date(2024, 12, 31)),
}
# Minimum fire cell-days (of the sensor being calibrated) for a region-month
# ratio; below this we fall back to H3 res 1, then res 0, then global.
CALIB_MIN_CELLDAYS = 100

# Baseline years for medians / multi-year means (complete years only).
CLIMATOLOGY_YEARS = (2003, 2025)


# --- Individual hotspot points ----------------------------------------------
# All points go to Cloudflare R2 (too big for the deployment); the export is
# staged here, then uploaded. Layout: points/year=<YYYY>/base=<H3 res 0 cell>.parquet
R2_STAGE_DIR = ROOT / "data" / "r2"
# Demo regions also ship inside api/data/regions/ as an offline fallback.
# name: (west, south, east, north)
# Only one fits: Vercel limits the API (code + data) to 225 MB. All points are in R2;
# these are just the offline backup. Add more back if the API moves to Fly.io.
DEMO_REGIONS = {
    "se-australia": ("South-east Australia", (140.0, -39.5, 154.0, -28.0)),
    # "california": ("California", (-124.5, 32.5, -114.0, 42.0)),            # ~11 MB
    # "western-canada": ("Western Canada", (-139.0, 48.5, -110.0, 60.0)),    # ~26 MB
    # "mediterranean": ("Mediterranean", (-10.0, 35.0, 28.0, 45.0)),         # ~15 MB
}
