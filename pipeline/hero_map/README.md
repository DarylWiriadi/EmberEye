# Hero map

The glowing world map behind the home page hero (`web/src/assets/fire-map.webp`)
and its pulsing spots (`web/src/components/home/HeroMap.astro`) are built from
our own harmonized data, so every dot is real:

- **Grey dots**: land, on a 1-degree grid (Natural Earth, via `world-atlas`).
- **Ember dots**: total harmonized fire cell-days per 1-degree box over the
  whole record (`api/data/global/monthly_res5` + `cells_res5`). Only boxes above
  the median (~2,000 fire cell-days) glow; brightness and size are on a log scale.
- **Pulsing spots**: the 12 busiest boxes, at least 15 degrees apart.

## Regenerate (after the global data changes)

From `pipeline/`, with the pipeline's Python environment:

```
pip install pillow
python hero_map/hero_map.py --preview data/interim/fire-map.png
```

This overwrites `web/src/assets/fire-map.webp` and prints the spot list. Paste
it into `spots` in `HeroMap.astro`, add a place name to each, and update the
date span in that file's comment if the record got longer.

## Land mask

`land-1deg.txt` is committed (136 rows x 360 columns, 77.5N to 57.5S, `1` = land),
so Node is only needed to change the grid:

```
cd pipeline/hero_map
npm install
npm run land
```
