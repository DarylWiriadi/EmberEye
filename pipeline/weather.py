"""MERRA-2 monthly weather -> monthly weather per H3 res 3 cell (stats panel).

Each H3 res 5 cell that ever burned samples its nearest MERRA-2 grid point; the
values are averaged per res 3 parent, so each cell's weather reflects where its
fires occur. Output: api/data/global/weather_res3.parquet

    t2m        air temperature at 2 m, whole degC
    rh         relative humidity at 2 m, %  (from temperature and dew point)
    wind       wind speed at 10 m, in 0.5 m/s steps  } of the monthly mean wind vector
    wind_from  direction the wind blows from, 0-15  } ("resultant"), not mean speed;
                                                      0 = N, 4 = E, 8 = S, 12 = W
    soil       topsoil wetness, % (0 = dry, 100 = saturated)

Rounded to keep the file ~11 MB (the API has a 225 MB size limit).
"""
import re
import sys
import time

import h5py
import numpy as np
import pyarrow as pa

import config as C
from clean import connect, run

FILL = 1e14


def read(path, names):
    with h5py.File(path, "r") as h:
        lat, lon = h["lat"][:], h["lon"][:]
        out = {}
        for n in names:
            a = h[n][0].astype(np.float64)
            a[a > FILL] = np.nan
            out[n] = a
    return lat, lon, out


def month_of(path):
    return re.search(r"\.(\d{6})[._]", path.name).group(1)


def rel_humidity(t_k, td_k):
    t, td = t_k - 273.15, td_k - 273.15
    es = lambda x: np.exp(17.625 * x / (243.04 + x))  # noqa: E731  (Magnus)
    return np.clip(100 * es(td) / es(t), 0, 100)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = time.time()
    weather = {month_of(p): p for p in (C.MERRA2_RAW / "monthly_weather").glob("*.nc4")}
    soil = {month_of(p): p for p in (C.MERRA2_RAW / "monthly_soil").glob("*.nc4")}
    months = sorted(weather)
    print(f"{len(months)} months ({months[0]}-{months[-1]}), soil for {len(soil)}")

    con = connect()
    cells = con.sql(f"""
        SELECT cell3, lat, lng FROM '{(C.API_DATA_DIR / "global" / "cells_res5.parquet").as_posix()}'
        ORDER BY cell3
    """).to_arrow_table()
    cell3 = cells["cell3"].to_numpy()
    uniq, group = np.unique(cell3, return_inverse=True)
    counts = np.bincount(group)

    lat0, lon0, _ = read(weather[months[0]], [])
    dlat, dlon = lat0[1] - lat0[0], lon0[1] - lon0[0]
    iy = np.clip(np.rint((cells["lat"].to_numpy() - lat0[0]) / dlat).astype(int), 0, len(lat0) - 1)
    ix = np.rint((cells["lng"].to_numpy() - lon0[0]) / dlon).astype(int) % len(lon0)

    def per_cell3(grid):
        v = grid[iy, ix]
        ok = ~np.isnan(v)
        s = np.bincount(group, np.where(ok, v, 0))
        n = np.bincount(group, ok.astype(float))
        with np.errstate(invalid="ignore", divide="ignore"):
            return np.where(n > 0, s / n, np.nan)

    parts = []
    for m in months:
        _, _, w = read(weather[m], ["T2M", "T2MDEW", "U10M", "V10M"])
        t2m = per_cell3(w["T2M"])
        rh = per_cell3(rel_humidity(w["T2M"], w["T2MDEW"]))
        u10 = per_cell3(w["U10M"])
        v10 = per_cell3(w["V10M"])
        sw = per_cell3(read(soil[m], ["GWETTOP"])[2]["GWETTOP"]) if m in soil else np.full(len(uniq), np.nan)
        speed = np.hypot(u10, v10)
        wind_from = (np.degrees(np.arctan2(-u10, -v10)) + 360) % 360
        month = np.datetime64(f"{m[:4]}-{m[4:]}-01")
        parts.append(pa.table({
            "cell3": pa.array(uniq, pa.uint64()),
            "month": pa.array(np.full(len(uniq), month), pa.date32()),
            "t2m": pa.array(np.rint(t2m - 273.15), pa.int8(), from_pandas=True),
            "rh": pa.array(np.rint(rh), pa.uint8(), from_pandas=True),
            "wind": pa.array(np.rint(speed * 2), pa.uint8(), from_pandas=True),
            "wind_from": pa.array(np.rint(wind_from / 22.5) % 16, pa.uint8(), from_pandas=True),
            "soil": pa.array(np.rint(sw * 100), pa.uint8(), from_pandas=True),
        }))

    con.register("w", pa.concat_tables(parts))
    out = C.API_DATA_DIR / "global" / "weather_res3.parquet"
    run(con, f"""
        COPY (SELECT * FROM w ORDER BY cell3, month)
        TO '{out.as_posix()}' (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 19)
    """)
    print(con.sql("""
        SELECT count(*) AS rows, count(DISTINCT cell3) AS cells, min(month) AS first, max(month) AS last,
               round(avg(t2m), 1) AS mean_t_c, round(avg(rh)) AS mean_rh,
               round(avg(wind) / 2, 1) AS mean_wind_ms,
               round(avg(soil)) AS mean_soil, count(*) FILTER (WHERE soil IS NULL) AS soil_missing
        FROM w
    """))
    print(f"Output: {out} ({out.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.0f}s "
          f"(cells per res 3 parent: median {int(np.median(counts))})")


if __name__ == "__main__":
    main()
