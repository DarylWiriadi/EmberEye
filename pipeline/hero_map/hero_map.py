"""Home page hero map: land dots + total harmonized fire activity, as two layers.

Reads the global monthly counts the API serves (api/data/global), adds up the
fire cell-days per 1-degree box over the whole record, and draws two
transparent images of the same size (2880 x 1088), stacked on the page so the
fire can light up over the land when the page loads:
  - web/src/assets/land-map.webp: a grey dot for every land box
    (land-1deg.txt, built by land.mjs)
  - web/src/assets/fire-map.webp: an ember dot for every box above the median
    (~2,000 fire cell-days), sized and coloured on a log scale, with a soft
    glow on the busiest ones
Also prints the 12 busiest boxes (at least 15 degrees apart) as the pulsing
spots for HeroMap.astro.

Usage (from pipeline/, after the global Parquet files exist):
    pip install pillow
    python hero_map/hero_map.py [--preview out.png]
"""
import argparse
import io
import json
import math
import sys
from pathlib import Path

import duckdb
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
GLOBAL = REPO / "api" / "data" / "global"
ASSETS = REPO / "web" / "src" / "assets"
OUT_LAND = ASSETS / "land-map.webp"
OUT_FIRE = ASSETS / "fire-map.webp"
LAND = HERE / "land-1deg.txt"

TOP_LAT = 77.5          # centre of the first row in land-1deg.txt
CELL_PX = 8             # pixels per degree -> 2880 x 1088
GLOW_FROM = 2000        # fire cell-days per box where dots start to glow (~ the median box)
SPOTS = 12
SPOT_MIN_DEGREES = 15
WEBP_QUALITY = 82


def fire_boxes():
    """Total fire cell-days per 1-degree box over the whole record."""
    con = duckdb.connect()
    monthly, cells = GLOBAL / "monthly_res5" / "*.parquet", GLOBAL / "cells_res5.parquet"
    rows = con.sql(f"""
        with totals as (select cell5, sum(fire_days) as fd from '{monthly}' group by 1)
        select floor(c.lat)::int as lat0, floor(c.lng)::int as lon0, sum(t.fd) as fire_days
        from totals t join '{cells}' c using (cell5)
        group by 1, 2
    """).fetchall()
    span = con.sql(f"select min(month), max(month) from '{monthly}'").fetchall()[0]
    return rows, span


def ramp(t):
    """Dim ember -> ember -> amber."""
    stops = [(0.0, (110, 50, 24)), (0.55, (232, 112, 58)), (1.0, (255, 194, 71))]
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        if t <= t1:
            k = (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * k) for a, b in zip(c0, c1))
    return stops[-1][1]


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--preview", type=Path, help="also save both layers combined as a PNG here")
    args = parser.parse_args()

    land = LAND.read_text().split("\n")
    rows_n, cols_n = len(land), len(land[0])
    width, height = cols_n * CELL_PX, rows_n * CELL_PX

    boxes, span = fire_boxes()
    fd = {}
    for lat0, lon0, v in boxes:
        r, c = int(TOP_LAT - (lat0 + 0.5)), int(lon0 + 180)
        if 0 <= r < rows_n and 0 <= c < cols_n:
            fd[(r, c)] = fd.get((r, c), 0) + v
    lo, hi = math.log10(GLOW_FROM), math.log10(max(fd.values()))

    def strength(v):
        return max(0.0, min(1.0, (math.log10(v) - lo) / (hi - lo))) if v > 0 else 0.0

    land_img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    dots = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw_land, draw_dots, draw_glow = ImageDraw.Draw(land_img), ImageDraw.Draw(dots), ImageDraw.Draw(glow)
    for r in range(rows_n):
        for c in range(cols_n):
            cx, cy = c * CELL_PX + CELL_PX / 2, r * CELL_PX + CELL_PX / 2
            t = strength(fd.get((r, c), 0))
            if t > 0.05:
                rad, col = 1.7 + 1.6 * t, ramp(t)
                draw_dots.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=col + (round(150 + 105 * t),))
                if t > 0.55:
                    gr = 4 + 8 * t
                    draw_glow.ellipse([cx - gr, cy - gr, cx + gr, cy + gr], fill=col + (round(70 * t),))
            # Every land box gets a land dot, also under fire dots, so the world
            # is complete before the fire layer lights up
            if land[r][c] == "1":
                draw_land.ellipse([cx - 1.6, cy - 1.6, cx + 1.6, cy + 1.6], fill=(84, 98, 118, 150))
    fire_img = Image.alpha_composite(glow.filter(ImageFilter.GaussianBlur(9)), dots)

    if args.preview:
        Image.alpha_composite(land_img, fire_img).save(args.preview, optimize=True)
    for path, image in ((OUT_LAND, land_img), (OUT_FIRE, fire_img)):
        buffer = io.BytesIO()
        image.save(buffer, "WEBP", quality=WEBP_QUALITY, method=6)
        path.write_bytes(buffer.getvalue())
        print(f"{path.relative_to(REPO)}: {width} x {height}, {len(buffer.getvalue()) / 1024:.0f} KB")
    print(f"record {span[0]} to {span[1]}")

    # Pulsing spots: busiest boxes, at least SPOT_MIN_DEGREES apart
    picked = []
    for (r, c), v in sorted(fd.items(), key=lambda kv: -kv[1]):
        if all(math.hypot(r - pr, c - pc) >= SPOT_MIN_DEGREES for pr, pc in picked):
            picked.append((r, c))
        if len(picked) == SPOTS:
            break
    print("\nSpots for web/src/components/home/HeroMap.astro (add a place name to each):")
    for r, c in picked:
        x, y = round((c + 0.5) / cols_n * 100, 2), round((r + 0.5) / rows_n * 100, 2)
        print(f"  {{ x: {x}, y: {y}, place: '' }},  // {TOP_LAT - r:.1f}, {c - 179.5:.1f}")


if __name__ == "__main__":
    sys.exit(main())
