"""Fire-spread simulation inputs: global 1 x 1 degree tiles of fuel and elevation.

Inputs (data/raw/):
    mcd12q1/*.hdf            MODIS MCD12Q1 v061 land cover (LC_Type1, IGBP), 500 m sinusoidal tiles
    srtmgl30/*.dem.zip       SRTMGL30 elevation, 30 arc-seconds (~1 km)
    naturalearth/ne_10m_roads.zip   Natural Earth major roads (barriers)

Output: data/r2/sim/<south>_<west>.bin (gzip), one per 1 x 1 degree tile with
anything burnable, 60S-80N; plus data/r2/sim/index.json (which tiles exist).
Uploaded to R2 by upload_r2.py; the browser loads only the tiles around an ignition.

Tile layout (after gunzip), all rows north to south:
    fuel   uint8[240 * 240]    1/240 deg (~460 m) cells: IGBP class 1-17 from MCD12Q1
                               (0 = no data), + 128 where a major road crosses the cell
    elev   int16 LE[120 * 120] 1/120 deg (~920 m) cells: metres above sea level
                               (-32768 = sea / no data)

Usage:  python sim_inputs.py            # all tiles
        python sim_inputs.py --check    # one band, with a preview image of SE Australia
"""
import argparse
import gzip
import io
import json
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path

import numpy as np
import shapefile
from pyhdf.SD import SD, SDC

import config as C

RAW = C.RAW_DIR
OUT = C.R2_STAGE_DIR / "sim"
FUEL_RES = 240           # cells per degree (fuel)
ELEV_RES = 120           # cells per degree (elevation, = SRTMGL30)
SOUTH, NORTH = -60, 80   # latitude band processed
BURNABLE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14]   # IGBP classes that carry fire
ROAD_FLAG = 128
ROAD_TYPES = {"Major Highway", "Secondary Highway", "Beltway", "Bypass", "Road"}

# MODIS sinusoidal grid
R_EARTH = 6371007.181
TILE = 1111950.5197665233
X0, Y0 = -20015109.355798, 10007554.677899
PIX = TILE / 2400


def modis_tiles():
    tiles = {}
    for p in (RAW / "mcd12q1").glob("*.hdf"):
        m = re.search(r"\.h(\d\d)v(\d\d)\.", p.name)
        tiles[(int(m.group(1)), int(m.group(2)))] = p
    return tiles


class ModisCache:
    """Loads MCD12Q1 tiles on demand, keeping only the rows of tiles in use."""

    def __init__(self, paths):
        self.paths = paths
        self.loaded = {}

    def get(self, h, v):
        if (h, v) not in self.loaded:
            path = self.paths.get((h, v))
            if path is None:
                self.loaded[(h, v)] = None
            else:
                sd = SD(str(path), SDC.READ)
                self.loaded[(h, v)] = sd.select("LC_Type1").get()
                sd.end()
        return self.loaded[(h, v)]

    def drop_above(self, v_min):
        for key in [k for k in self.loaded if k[1] < v_min]:
            del self.loaded[key]


def fuel_band(cache, lat_s):
    """IGBP class for every 1/240 deg cell in the band lat_s..lat_s+1 (all longitudes)."""
    lat = lat_s + 1 - (np.arange(FUEL_RES) + 0.5) / FUEL_RES
    lon = -180 + (np.arange(360 * FUEL_RES) + 0.5) / FUEL_RES
    lat_r = np.radians(lat)[:, None]
    x = R_EARTH * np.radians(lon)[None, :] * np.cos(lat_r)
    y = np.broadcast_to(R_EARTH * lat_r, x.shape)
    h = np.floor((x - X0) / TILE).astype(np.int16)
    v = np.floor((Y0 - y) / TILE).astype(np.int16)
    col = np.clip(((x - X0) - h * TILE) // PIX, 0, 2399).astype(np.int16)
    row = np.clip(((Y0 - y) - v * TILE) // PIX, 0, 2399).astype(np.int16)
    out = np.zeros(x.shape, np.uint8)
    keys = np.unique(h.astype(np.int32) * 100 + v)
    for k in keys:
        hh, vv = divmod(int(k), 100)
        grid = cache.get(hh, vv)
        if grid is None:
            continue
        m = (h == hh) & (v == vv)
        vals = grid[row[m], col[m]]
        out[m] = np.where(vals == 255, 0, vals)
    cache.drop_above(int(v.min()))
    return out


class Srtm:
    """SRTMGL30 tiles (big-endian int16, -9999 = sea), read as needed."""

    def __init__(self):
        self.tiles = []
        for p in (RAW / "srtmgl30").glob("*.dem.zip"):
            m = re.match(r"([ew])(\d{3})([ns])(\d{2})", p.name.lower())
            west = int(m.group(2)) * (1 if m.group(1) == "e" else -1)
            north = int(m.group(4)) * (1 if m.group(3) == "n" else -1)
            self.tiles.append((west, north, p))
        self.data = {}

    def get(self, p):
        if p not in self.data:
            z = zipfile.ZipFile(p)
            raw = z.read([n for n in z.namelist() if n.upper().endswith(".DEM")][0])
            a = np.frombuffer(raw, ">i2")
            width = 7200 if a.size == 7200 * 3600 else 4800
            self.data[p] = a.reshape(-1, width)
        return self.data[p]

    def band(self, lat_s):
        """Elevation (int16, -32768 = sea) for 1/120 deg cells in lat_s..lat_s+1."""
        out = np.full((ELEV_RES, 360 * ELEV_RES), -32768, np.int16)
        for west, north, p in self.tiles:
            a = self.get(p)
            south = north - a.shape[0] // ELEV_RES
            east = west + a.shape[1] // ELEV_RES
            if not (south <= lat_s < north):
                continue
            r0 = (north - (lat_s + 1)) * ELEV_RES
            block = a[r0:r0 + ELEV_RES].astype(np.int16)
            block = np.where(block == -9999, np.int16(-32768), block)
            c0 = (west + 180) * ELEV_RES
            out[:, c0:c0 + (east - west) * ELEV_RES] = block
        return out


def road_cells():
    """Global (row, col) indices of 1/240 deg cells crossed by major roads.
    Row 0 = the cell just south of NORTH."""
    z = zipfile.ZipFile(RAW / "naturalearth" / "ne_10m_roads.zip")
    shp = [n for n in z.namelist() if n.endswith(".shp")][0]
    r = shapefile.Reader(shp=io.BytesIO(z.read(shp)), dbf=io.BytesIO(z.read(shp[:-4] + ".dbf")))
    rows, cols = [], []
    step = 0.5 / FUEL_RES   # sample every half cell, so no cell is skipped
    for sr in r.iterShapeRecords(fields=["type"]):
        if sr.record["type"] not in ROAD_TYPES:
            continue
        pts = np.asarray(sr.shape.points, dtype=np.float64)
        if len(pts) < 2:
            continue
        parts = list(sr.shape.parts) + [len(pts)]
        for a, b in zip(parts[:-1], parts[1:]):
            seg = pts[a:b]
            for (x1, y1), (x2, y2) in zip(seg[:-1], seg[1:]):
                n = max(1, int(np.ceil(max(abs(x2 - x1), abs(y2 - y1)) / step)))
                t = np.linspace(0, 1, n + 1)
                lon = x1 + (x2 - x1) * t
                lat = y1 + (y2 - y1) * t
                rows.append(np.floor((NORTH - lat) * FUEL_RES).astype(np.int32))
                cols.append(np.floor((lon + 180) * FUEL_RES).astype(np.int32) % (360 * FUEL_RES))
    rows = np.concatenate(rows)
    cols = np.concatenate(cols)
    ok = (rows >= 0) & (rows < (NORTH - SOUTH) * FUEL_RES)
    cells = np.unique(rows[ok].astype(np.int64) * (360 * FUEL_RES) + cols[ok])
    return cells


def write_tiles(lat_s, fuel, elev, roads_in_band, index, stats):
    if roads_in_band.size:
        r, c = np.divmod(roads_in_band, 360 * FUEL_RES)
        burnable_here = np.isin(fuel[r, c], BURNABLE)
        fuel[r[burnable_here], c[burnable_here]] |= ROAD_FLAG
    burnable = np.isin(fuel & 0x7F, BURNABLE)
    for lon_w in range(-180, 180):
        f = fuel[:, (lon_w + 180) * FUEL_RES:(lon_w + 181) * FUEL_RES]
        n = int(burnable[:, (lon_w + 180) * FUEL_RES:(lon_w + 181) * FUEL_RES].sum())
        if n == 0:
            continue
        e = elev[:, (lon_w + 180) * ELEV_RES:(lon_w + 181) * ELEV_RES]
        payload = np.ascontiguousarray(f).tobytes() + np.ascontiguousarray(e).astype("<i2").tobytes()
        data = gzip.compress(payload, compresslevel=9, mtime=0)
        (OUT / f"{lat_s}_{lon_w}.bin").write_bytes(data)
        index.append([lat_s, lon_w])
        stats["bytes"] += len(data)
        stats["tiles"] += 1


def preview(lat_range, lon_range, path):
    """A PNG of the fuel classes for a box of tiles, to check by eye."""
    import struct
    import zlib
    colours = {0: (40, 40, 40), 1: (20, 90, 30), 2: (30, 120, 40), 3: (40, 110, 60), 4: (60, 140, 60),
               5: (50, 130, 70), 6: (150, 120, 60), 7: (190, 170, 90), 8: (120, 150, 60), 9: (170, 180, 90),
               10: (200, 210, 120), 11: (70, 140, 160), 12: (230, 220, 150), 13: (200, 40, 40),
               14: (210, 200, 110), 15: (240, 240, 250), 16: (180, 170, 160), 17: (30, 60, 140)}
    h = (lat_range[1] - lat_range[0]) * FUEL_RES
    w = (lon_range[1] - lon_range[0]) * FUEL_RES
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = colours[17]
    for la in range(lat_range[0], lat_range[1]):
        for lo in range(lon_range[0], lon_range[1]):
            p = OUT / f"{la}_{lo}.bin"
            if not p.exists():
                continue
            fuel = np.frombuffer(gzip.decompress(p.read_bytes())[:FUEL_RES * FUEL_RES], np.uint8).reshape(FUEL_RES, FUEL_RES)
            rgb = np.array([colours.get(int(v) & 0x7F, (0, 0, 0)) for v in range(256)], np.uint8)[fuel]
            rgb[fuel >= ROAD_FLAG] = (255, 255, 255)
            r0 = (lat_range[1] - 1 - la) * FUEL_RES
            c0 = (lo - lon_range[0]) * FUEL_RES
            img[r0:r0 + FUEL_RES, c0:c0 + FUEL_RES] = rgb
    raw = b"".join(b"\x00" + img[i].tobytes() for i in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))  # noqa: E731
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) \
        + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    Path(path).write_bytes(png)


def main(args):
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = time.time()
    if OUT.exists() and not args.check:
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)
    modis = ModisCache(modis_tiles())
    srtm = Srtm()
    print(f"{len(modis.paths)} land cover tiles, {len(srtm.tiles)} elevation tiles")
    t = time.time()
    roads = road_cells()
    print(f"road cells: {roads.size:,} ({time.time() - t:.0f}s)")
    band_cells = (360 * FUEL_RES) * FUEL_RES

    bands = range(-39, -27) if args.check else range(NORTH - 1, SOUTH - 1, -1)
    index, stats = [], {"tiles": 0, "bytes": 0}
    for lat_s in sorted(bands, reverse=True):
        fuel = fuel_band(modis, lat_s)
        elev = srtm.band(lat_s)
        first = (NORTH - (lat_s + 1)) * FUEL_RES * (360 * FUEL_RES)
        in_band = roads[(roads >= first) & (roads < first + band_cells)] - first
        write_tiles(lat_s, fuel, elev, in_band, index, stats)
        if lat_s % 10 == 0 or args.check:
            print(f"  band {lat_s:+d}: {stats['tiles']:,} tiles so far, {stats['bytes'] / 1e6:.1f} MB "
                  f"({time.time() - t0:.0f}s)")
    if not args.check:
        (OUT / "index.json").write_text(json.dumps({
            "res": {"fuel": FUEL_RES, "elev": ELEV_RES}, "road_flag": ROAD_FLAG,
            "classes": "IGBP (MCD12Q1 LC_Type1)", "tiles": sorted(index)}))
    else:
        preview((-39, -27), (140, 154), OUT / "preview_se_australia.png")
    print(f"Done: {stats['tiles']:,} tiles, {stats['bytes'] / 1e6:.1f} MB in {(time.time() - t0) / 60:.1f} min -> {OUT}")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--check", action="store_true", help="SE Australia only, with a preview image")
    main(p.parse_args())
