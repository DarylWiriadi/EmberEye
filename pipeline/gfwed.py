"""GFWED monthly fire weather -> an `fwi` column in weather_res3.parquet.

GFWED (NASA GISS Global Fire WEather Database), monthly files, land only, 58S-75N:
  * MERRA-2 "corrected" (~0.5 deg), Jul 2002 -> Apr 2026: the reference record.
  * GEOS-5 (~0.25 deg), 2025 -> latest: carries the record past April 2026,
    rescaled to MERRA-2 per H3 res 3 cell using the months both cover (the same
    idea as the MODIS -> VIIRS harmonization). Validated by calibrating on 2025
    and comparing with MERRA-2 for the 2026 overlap months.

Sampled like weather.py: each H3 res 5 cell that ever burned takes its nearest
grid point, averaged per res 3 parent.

    fwi  Fire Weather Index, whole units (capped at 255)

The Drought Code is left out to stay within the API's 225 MB limit (soil wetness
already covers dryness). Deserts and northern winters (GFWED computes nothing
there) are null. Months after the MERRA-2 weather (none of t2m/rh/...) get rows
with only `fwi`. Re-running replaces the column.

Inputs: data/raw/gfwed/FWI.MERRA2.CORRECTED.Monthly.Default.<YYYYMM>.nc
        data/raw/gfwed_geos5/FWI.GEOS-5.Monthly.Default.<YYYYMM>.nc
"""
import re
import sys
import time
import warnings

import numpy as np
import pyarrow as pa
from scipy.io import netcdf_file

import config as C
from clean import connect, run

SOURCES = {
    "merra2": (C.RAW_DIR / "gfwed", "FWI.MERRA2.CORRECTED.Monthly.*.nc", "MERRA2.CORRECTED_FWI"),
    "geos5": (C.RAW_DIR / "gfwed_geos5", "FWI.GEOS-5.Monthly.*.nc", "GEOS-5_FWI"),
}
MERRA2_LAST = "2026-04-01"   # GFWED's MERRA-2 version ends here
PRIOR = 50.0   # FWI units: pulls a cell's GEOS-5 -> MERRA-2 ratio towards the global one


def read(path, var):
    with netcdf_file(path, "r", mmap=False) as f:
        lat = np.array(f.variables["lat"][:], dtype=np.float64)
        lon = np.array(f.variables["lon"][:], dtype=np.float64)
        g = np.array(f.variables[var][0], dtype=np.float64)
    g[~np.isfinite(g) | (g < 0) | (g > 1e10)] = np.nan
    return lat, lon, fill_coast(g)


def fill_coast(g, steps=2):
    """Sea squares next to land take the mean of their land neighbours, so coastal
    places (whose nearest square can be sea) still get a value. Big gaps, such as
    winter in the north where GFWED computes nothing, stay empty."""
    for _ in range(steps):
        pad = np.pad(g, 1, constant_values=np.nan)
        pad[:, 0], pad[:, -1] = pad[:, -2], pad[:, 1]   # longitude wraps around
        shifted = np.stack([pad[1 + dy:pad.shape[0] - 1 + dy, 1 + dx:pad.shape[1] - 1 + dx]
                            for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            near = np.nanmean(shifted, axis=0)
        g = np.where(np.isnan(g), near, g)
    return g


def load(source, clat, clng, group, n_cells):
    """{YYYYMM: FWI per res 3 cell} for one GFWED version."""
    folder, pattern, var = SOURCES[source]
    files = {re.search(r"\.(\d{6})\.nc$", p.name).group(1): p for p in folder.glob(pattern)}
    out, sampler = {}, None
    for m in sorted(files):
        lat, lon, g = read(files[m], var)
        if sampler is None:
            iy = np.rint((clat - lat[0]) / (lat[1] - lat[0])).astype(int)
            ix = np.rint((clng - lon[0]) / (lon[1] - lon[0])).astype(int) % len(lon)
            inside = (iy >= 0) & (iy < len(lat))   # GFWED stops at 58S / 75N
            sampler = (np.clip(iy, 0, len(lat) - 1), ix, inside)
        iy, ix, inside = sampler
        v = np.where(inside, g[iy, ix], np.nan)
        ok = ~np.isnan(v)
        s = np.bincount(group, np.where(ok, v, 0), minlength=n_cells)
        n = np.bincount(group, ok.astype(float), minlength=n_cells)
        with np.errstate(invalid="ignore", divide="ignore"):
            out[m] = np.where(n > 0, s / n, np.nan)
    return out


def saved_merra2(con, uniq):
    """MERRA-2 FWI from an earlier run (weather_res3.parquet), for when its raw
    files have been deleted. Only months before the first GEOS-5-only month count:
    later ones were rescaled GEOS-5."""
    path = (C.API_DATA_DIR / "global" / "weather_res3.parquet").as_posix()
    t = con.sql(f"""
        SELECT strftime(month, '%Y%m') AS m, cell3, fwi FROM '{path}'
        WHERE fwi IS NOT NULL AND month <= DATE '{MERRA2_LAST}'
    """).to_arrow_table()
    idx = {c: i for i, c in enumerate(uniq)}
    out = {}
    for m, c, v in zip(t["m"].to_pylist(), t["cell3"].to_pylist(), t["fwi"].to_pylist()):
        out.setdefault(m, np.full(len(uniq), np.nan))[idx[c]] = v
    print(f"MERRA-2 raw files not found; using the {len(out)} months saved in {path}")
    return out


def ratios(m2, g5, months):
    """GEOS-5 -> MERRA-2 scale per cell from `months`, shrunk towards the global
    ratio where a cell has little fire weather to go on."""
    a = np.stack([m2[m] for m in months])
    b = np.stack([g5[m] for m in months])
    both = ~np.isnan(a) & ~np.isnan(b)
    sa, sb = np.where(both, a, 0).sum(0), np.where(both, b, 0).sum(0)
    world = sa.sum() / sb.sum()
    return np.clip((sa + PRIOR * world) / (sb + PRIOR), world / 3, world * 3), world


def compare(m2, g5, r, months):
    a = np.concatenate([m2[m] for m in months])
    b = np.concatenate([g5[m] * r for m in months])
    ok = ~np.isnan(a) & ~np.isnan(b)
    a, b = a[ok], b[ok]
    return np.corrcoef(a, b)[0, 1], np.mean(np.abs(a - b)), np.mean(b) / np.mean(a), ok.sum()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = time.time()
    con = connect()
    cells = con.sql(f"""
        SELECT cell3, lat, lng FROM '{(C.API_DATA_DIR / "global" / "cells_res5.parquet").as_posix()}'
        ORDER BY cell3
    """).to_arrow_table()
    uniq, group = np.unique(cells["cell3"].to_numpy(), return_inverse=True)
    args = (cells["lat"].to_numpy(), cells["lng"].to_numpy(), group, len(uniq))

    m2 = load("merra2", *args) or saved_merra2(con, uniq)
    g5 = load("geos5", *args)
    overlap = sorted(set(m2) & set(g5))
    print(f"MERRA-2 {min(m2)}-{max(m2)} ({len(m2)} months), GEOS-5 {min(g5)}-{max(g5)} "
          f"({len(g5)} months), overlap {len(overlap)} months")

    fwi = dict(m2)
    if overlap:
        cal = [m for m in overlap if m < "202601"] or overlap
        test = [m for m in overlap if m >= "202601"]
        if test and cal != overlap:
            r_cal, w_cal = ratios(m2, g5, cal)
            raw = compare(m2, g5, np.ones_like(r_cal), test)
            fit = compare(m2, g5, r_cal, test)
            print(f"Check (calibrated on {cal[0]}-{cal[-1]}, tested on {test[0]}-{test[-1]}):")
            print(f"  GEOS-5 as is:   r={raw[0]:.3f}  mean abs diff {raw[1]:.1f} FWI  mean ratio {raw[2]:.2f}")
            print(f"  GEOS-5 rescaled: r={fit[0]:.3f}  mean abs diff {fit[1]:.1f} FWI  mean ratio {fit[2]:.2f}"
                  f"  ({fit[3]:,} cell-months)")
        r, world = ratios(m2, g5, overlap)
        print(f"GEOS-5 -> MERRA-2 world ratio {world:.3f} (per-cell median {np.median(r):.3f})")
        for m in sorted(set(g5) - set(m2)):
            fwi[m] = g5[m] * r

    g = pa.concat_tables([pa.table({
        "cell3": pa.array(uniq, pa.uint64()),
        "month": pa.array(np.full(len(uniq), np.datetime64(f"{m[:4]}-{m[4:]}-01")), pa.date32()),
        "fwi": pa.array(np.minimum(np.rint(v), 255), pa.uint8(), from_pandas=True),
    }) for m, v in sorted(fwi.items())])
    con.register("g", g)

    out = C.API_DATA_DIR / "global" / "weather_res3.parquet"
    before = out.stat().st_size
    existing = con.sql(f"DESCRIBE SELECT * FROM '{out.as_posix()}'").to_arrow_table()["column_name"].to_pylist()
    drop = [c for c in ("fwi", "dc") if c in existing]
    keep = f"* EXCLUDE ({', '.join(drop)})" if drop else "*"
    run(con, f"""
        CREATE TEMP TABLE merged AS
        SELECT * FROM (SELECT {keep} FROM '{out.as_posix()}') w
        FULL JOIN (SELECT * FROM g WHERE fwi IS NOT NULL) USING (cell3, month)
    """)
    run(con, f"""
        COPY (SELECT * FROM merged ORDER BY cell3, month)
        TO '{out.as_posix()}' (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 19)
    """)
    print(con.sql("""
        SELECT count(*) AS rows, count(fwi) AS with_fwi,
               min(month) FILTER (WHERE fwi IS NOT NULL) AS first,
               max(month) FILTER (WHERE fwi IS NOT NULL) AS last,
               max(month) FILTER (WHERE t2m IS NOT NULL) AS weather_last,
               round(avg(fwi), 1) AS mean_fwi
        FROM merged
    """))
    print(f"Output: {out} ({before / 1e6:.1f} -> {out.stat().st_size / 1e6:.1f} MB) "
          f"in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
