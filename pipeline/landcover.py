"""MODIS land cover (MCD12C1) -> share of fire activity by land type.

extract: each yearly HDF (~1.2 GB) -> interim/landcover/<year>.npz with 6 land
         groups as percentages on the 0.05 degree grid. The HDF can then be deleted.
assign:  each harmonized fire cell gets the land-group percentages at its location
         (nearest land-cover year), totalled per H3 res 5 cell and year
         (interim/landcover/fires_by_year/), then combined over all years into
         api/data/global/landcover_res5.parquet (~1.4 MB). The API weights each
         cell's mix by its fire_days for the requested period.

Usage:  python landcover.py [extract|assign]   (default: both)
"""
import argparse
import re
import sys
import time

import numpy as np
import pyarrow as pa
from pyhdf.SD import SD, SDC

import config as C
from clean import connect, run

# IGBP classes in Land_Cover_Type_1_Percent, grouped
GROUPS = {
    "forest": [1, 2, 3, 4, 5],
    "shrubland": [6, 7],
    "savanna": [8, 9],
    "grassland": [10],
    "cropland": [12, 14],
    "other": [0, 11, 13, 15, 16],  # water, wetland, urban, snow/ice, barren
}
RES = 0.05
NY, NX = 3600, 7200


def extract():
    C.LANDCOVER_DIR.mkdir(parents=True, exist_ok=True)
    for f in sorted(C.LANDCOVER_RAW.glob("MCD12C1.A*.hdf")):
        year = int(re.search(r"\.A(\d{4})001\.", f.name).group(1))
        out = C.LANDCOVER_DIR / f"{year}.npz"
        if out.exists():
            print(f"  {year}: already extracted")
            continue
        t = time.time()
        sd = SD(str(f), SDC.READ)
        pct = sd.select("Land_Cover_Type_1_Percent")[:]
        sd.end()
        pct[pct == 255] = 0
        groups = np.empty((len(GROUPS), NY, NX), np.uint8)
        for i, layers in enumerate(GROUPS.values()):
            groups[i] = np.minimum(pct[:, :, layers].sum(axis=2, dtype=np.uint16), 100)
        np.savez_compressed(out, groups=groups)
        print(f"  {year}: {out.stat().st_size / 1e6:.0f} MB ({time.time() - t:.0f}s)")


def assign():
    years = sorted(int(p.stem) for p in C.LANDCOVER_DIR.glob("*.npz"))
    if not years:
        sys.exit("No extracted land cover; run: python landcover.py extract")
    out = C.LANDCOVER_DIR / "fires_by_year"
    out.mkdir(parents=True, exist_ok=True)
    for f in out.glob("*.parquet"):
        f.unlink()

    con = connect()
    names = list(GROUPS)
    loaded_year, groups = None, None
    for ydir in sorted(C.HARMONIZED_DIR.glob("year=*")):
        fire_year = int(ydir.name.split("=")[1])
        lc_year = min(years, key=lambda y: (abs(y - fire_year), -y))
        if lc_year != loaded_year:
            groups = np.load(C.LANDCOVER_DIR / f"{lc_year}.npz")["groups"]
            loaded_year = lc_year

        tbl = con.execute(f"""
            SELECT h3_cell_to_parent(cell8, {C.H3_GLOBAL_MONTHLY_RES}) AS cell5,
                   h3_cell_to_lat(cell8) AS lat, h3_cell_to_lng(cell8) AS lng,
                   sum(weight) AS w
            FROM read_parquet('{(ydir / "*.parquet").as_posix()}')
            GROUP BY cell8
        """).to_arrow_table()
        lat = tbl["lat"].to_numpy()
        lng = tbl["lng"].to_numpy()
        w = tbl["w"].to_numpy()
        row = np.clip(((90 - lat) / RES).astype(np.int32), 0, NY - 1)
        col = np.clip(((lng + 180) / RES).astype(np.int32), 0, NX - 1)
        shares = groups[:, row, col].astype(np.float32) / 100

        cols = {"cell5": tbl["cell5"], "w": pa.array(w, pa.float32())}
        for i, name in enumerate(names):
            cols[name] = pa.array(shares[i] * w, pa.float32())
        con.register("lc", pa.table(cols))
        pct = ", ".join(
            f"round(100 * sum({n}) / nullif(sum({n_all}), 0))::UTINYINT AS {n}"
            for n, n_all in ((n, " + ".join(names)) for n in names)
        )
        run(con, f"""
            COPY (
                SELECT cell5, {fire_year}::SMALLINT AS year, sum(w)::FLOAT AS fire_days, {pct}
                FROM lc GROUP BY cell5 ORDER BY cell5
            ) TO '{(out / f"{fire_year}.parquet").as_posix()}'
              (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 19)
        """)
        con.unregister("lc")
        print(f"  fires {fire_year} <- land cover {lc_year}: {len(tbl):,} fire cells")

    print(con.sql(f"""
        SELECT year, round(sum(fire_days) / 1e6, 2) AS fire_days_M,
               {", ".join(f"round(sum({n} * fire_days) / sum(fire_days))::INT AS {n}" for n in names)}
        FROM read_parquet('{(out / "*.parquet").as_posix()}')
        GROUP BY year ORDER BY year
    """))
    final = C.API_DATA_DIR / "global" / "landcover_res5.parquet"
    mix = ", ".join(
        f"round(sum({n} * fire_days) / sum(fire_days))::UTINYINT AS {n}" for n in names
    )
    run(con, f"""
        COPY (
            SELECT cell5, {mix}
            FROM read_parquet('{(out / "*.parquet").as_posix()}')
            GROUP BY cell5 ORDER BY cell5
        ) TO '{final.as_posix()}' (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 19)
    """)
    print(f"Output: {final} ({final.stat().st_size / 1e6:.1f} MB), "
          f"land cover years used: {years[0]}-{years[-1]}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("step", nargs="?", choices=["extract", "assign"])
    args = p.parse_args()
    if args.step in (None, "extract"):
        extract()
    if args.step in (None, "assign"):
        assign()
