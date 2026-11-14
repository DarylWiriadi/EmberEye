"""
Download global FIRMS hotspots through the FIRMS Area API.

Default plan (S-NPP is downloaded separately through the archive form):
- MODIS:        4 Jul 2002 -> 31 Dec 2019   (history before VIIRS + 2012-2019 calibration)
- VIIRS NOAA-20: all of 2024 (calibration year vs S-NPP) + 3 Nov 2026 -> latest
  (carries the record after S-NPP stopped)

Science-quality (SP) data is used where available, NRT after that, with no overlap.
5-day chunks (the API maximum) for the whole world, saved as gzipped CSV.
Safe to stop and re-run: chunks already on disk are skipped.
Checks the MAP_KEY quota before every call so it never hits the limit.

Usage (Windows PowerShell):
    $env:FIRMS_MAP_KEY="your_key"
    python firms_download.py --test                        test one VIIRS call
    python firms_download.py --test --test-source MODIS_SP test one MODIS call
    python firms_download.py                               full download (overnight)
    python firms_download.py --sources MODIS               only MODIS
    python firms_download.py --sources VIIRS_SNPP          S-NPP too, if the archive route fails

Needs only the Python standard library.
"""

import argparse
import csv
import gzip
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

BASE = "https://firms.modaps.eosdis.nasa.gov"
WORLD = "-180,-90,180,90"
HALVES = {"W": "-180,-90,0,90", "E": "0,-90,180,90"}
FAR_FUTURE = date(2100, 1, 1)

# sensor -> (SP source, NRT source, list of date windows to fetch)
SENSORS = {
    "MODIS": ("MODIS_SP", "MODIS_NRT", [(date(2002, 7, 4), date(2019, 12, 31))]),
    "VIIRS_NOAA20": ("VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT",
                     [(date(2024, 1, 1), date(2024, 12, 31)),
                      (date(2026, 11, 3), FAR_FUTURE)]),
    "VIIRS_SNPP": ("VIIRS_SNPP_SP", "VIIRS_SNPP_NRT", [(date(2012, 1, 20), date(2026, 11, 2))]),
}
DEFAULT_SENSORS = ["MODIS", "VIIRS_NOAA20"]

# Used only if the availability endpoint can't be reached.
FALLBACK_SP_START = {"MODIS_SP": date(2000, 11, 1), "VIIRS_SNPP_SP": date(2012, 1, 20),
                     "VIIRS_NOAA20_SP": date(2018, 4, 1)}


def http_get(url, timeout=300):
    req = urllib.request.Request(url, headers={"User-Agent": "space-apps-firms-download"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def key_status(key):
    try:
        return json.loads(http_get(f"{BASE}/mapserver/mapkey_status/?MAP_KEY={key}", timeout=60))
    except Exception as e:
        print(f"  (could not read key status: {e})")
        return None


class Quota:
    """Waits before each call until there's room for it under the transaction limit."""

    def __init__(self, key, first_guess=200):
        self.key = key
        self.cost = first_guess  # transactions per call, updated from measurements

    def wait(self):
        while True:
            st = key_status(self.key)
            if not st:
                time.sleep(30)
                return None
            used, limit = st.get("current_transactions", 0), st.get("transaction_limit", 5000)
            if used + self.cost <= limit * 0.95:
                return used
            print(f"  quota {used}/{limit} used, next call needs ~{self.cost}; waiting 30 s...")
            time.sleep(30)

    def record(self, used_before):
        if used_before is None:
            return
        st = key_status(self.key)
        if st:
            spent = st.get("current_transactions", 0) - used_before
            if spent > 0:  # ignore resets of the 10-minute window
                self.cost = max(int(0.7 * self.cost + 0.3 * spent), spent)


def availability(key):
    """Return {source: (min_date, max_date)} from the FIRMS availability endpoint."""
    out = {}
    try:
        text = http_get(f"{BASE}/api/data_availability/csv/{key}/ALL", timeout=60)
        for row in csv.DictReader(io.StringIO(text)):
            out[row["data_id"]] = (date.fromisoformat(row["min_date"]), date.fromisoformat(row["max_date"]))
    except Exception as e:
        print(f"Could not read data availability ({e}); using fallback dates.")
    return out


def plan_ranges(avail, sensors):
    """Build [(source, start, end)]: SP where available, NRT only after SP ends."""
    plan = []
    yesterday = date.today() - timedelta(days=1)
    for name in sensors:
        sp, nrt, windows = SENSORS[name]
        sp_min, sp_max = avail.get(sp, (FALLBACK_SP_START[sp], yesterday - timedelta(days=150)))
        nrt_min, nrt_max = avail.get(nrt, (sp_max + timedelta(days=1), yesterday))
        for w_start, w_end in windows:
            s, e = max(w_start, sp_min), min(w_end, sp_max)
            if s <= e:
                plan.append((sp, s, e))
            s, e = max(w_start, sp_max + timedelta(days=1), nrt_min), min(w_end, nrt_max)
            if s <= e:
                plan.append((nrt, s, e))
    return plan


def looks_like_data(text):
    first = text.lstrip().split("\n", 1)[0].lower()
    return "latitude" in first and "longitude" in first


def fetch_chunk(key, source, area, start, days, out_file, max_tries=5):
    url = f"{BASE}/api/area/csv/{key}/{source}/{area}/{days}/{start.isoformat()}"
    for attempt in range(1, max_tries + 1):
        try:
            text = http_get(url)
            if looks_like_data(text):
                tmp = out_file.with_suffix(".tmp")
                with gzip.open(tmp, "wt", encoding="utf-8") as f:
                    f.write(text)
                tmp.replace(out_file)
                return text.count("\n") - 1  # rows, excluding header
            msg = text.strip()[:200]
            if "limit" in msg.lower():
                print(f"  transaction limit hit, waiting 2 min ({msg})")
                time.sleep(120)
                continue
            if "invalid" in msg.lower() and "key" in msg.lower():
                sys.exit(f"MAP_KEY rejected: {msg}")
            print(f"  unexpected response (try {attempt}): {msg}")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace").strip()[:500]
            print(f"  HTTP {e.code} from FIRMS (try {attempt}): {body or '(no message)'}")
            print(f"  URL (key hidden): {url.replace(key, '<KEY>')}")
            if 400 <= e.code < 500 and e.code != 429:
                return None  # a bad request won't fix itself by retrying
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            print(f"  network error (try {attempt}): {e}")
        time.sleep(min(10 * 2 ** attempt, 300))
    return None


def run(args):
    key = os.environ.get("FIRMS_MAP_KEY")
    if not key:
        sys.exit("Set FIRMS_MAP_KEY first (see the top of this file).")

    out_root = Path(args.out)
    areas = HALVES if args.split else {"": WORLD}

    if args.test:
        area = args.area or (HALVES["W"] if args.split else WORLD)
        print(f"Test: {args.test_source}, area {area}, {args.days} day(s) from 2019-12-01")
        before = key_status(key)
        print("Key status before:", before)
        test_file = out_root / "_test" / f"{args.test_source}_2019-12-01.csv.gz"
        test_file.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        rows = fetch_chunk(key, args.test_source, area, date(2019, 12, 1), args.days, test_file, max_tries=1)
        secs = time.time() - t0
        after = key_status(key)
        if rows is None:
            print("Test call failed.")
        else:
            print(f"Rows: {rows}, time: {secs:.1f} s, file: {test_file} "
                  f"({test_file.stat().st_size / 1e6:.1f} MB gzipped)")
        print("Key status after:", after)
        if before and after:
            print("Transactions used by one call:",
                  after.get("current_transactions", 0) - before.get("current_transactions", 0))
        return

    avail = availability(key)
    sensors = args.sources or DEFAULT_SENSORS
    plan = plan_ranges(avail, sensors)
    total = sum(((e - s).days // args.days + 1) * len(areas) for _, s, e in plan)
    print("Plan:")
    for src, s, e in plan:
        print(f"  {src}: {s} -> {e}")
    print(f"About {total} calls in total (already-downloaded chunks are skipped).")

    quota = Quota(key)
    failures = out_root / "failures.txt"
    done = 0
    t_start = time.time()
    for source, start, end in plan:
        for suffix, area in areas.items():
            folder = out_root / source
            folder.mkdir(parents=True, exist_ok=True)
            day = start
            while day <= end:
                days = min(args.days, (end - day).days + 1)
                name = f"{day.isoformat()}{'_' + suffix if suffix else ''}.csv.gz"
                out_file = folder / name
                done += 1
                if not out_file.exists():
                    used_before = quota.wait()
                    rows = quota_rows = fetch_chunk(key, source, area, day, days, out_file)
                    quota.record(used_before)
                    elapsed = (time.time() - t_start) / 3600
                    if quota_rows is None:
                        with open(failures, "a") as f:
                            f.write(f"{source},{area},{day},{days}\n")
                        print(f"  [{done}/{total}] FAILED {source} {day} {suffix}")
                    else:
                        print(f"  [{done}/{total}] {source} {day} {suffix or 'world'}: {rows} rows "
                              f"(~{quota.cost} transactions/call, {elapsed:.1f} h elapsed)")
                    time.sleep(args.pause)
                day += timedelta(days=days)

    print("Done. Any failed chunks are listed in", failures, "(re-run the script to retry them).")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Download global FIRMS hotspots via the Area API.")
    p.add_argument("--test", action="store_true", help="one test call, then stop")
    p.add_argument("--test-source", default="VIIRS_SNPP_SP",
                   help="source for --test, e.g. MODIS_SP or VIIRS_NOAA20_SP")
    p.add_argument("--out", default="data/raw/world", help="output folder")
    p.add_argument("--days", type=int, default=5, choices=range(1, 6), metavar="1-5",
                   help="days per call (the API accepts 1-5)")
    p.add_argument("--pause", type=float, default=1.0, help="seconds between calls")
    p.add_argument("--split", action="store_true", help="split the world into east/west halves")
    p.add_argument("--area", help="test only: custom bbox west,south,east,north")
    p.add_argument("--sources", nargs="*", choices=list(SENSORS),
                   help=f"sensors to fetch (default: {' '.join(DEFAULT_SENSORS)})")
    run(p.parse_args())