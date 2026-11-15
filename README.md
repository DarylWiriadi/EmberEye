# EmberEye

This project harmonizes MODIS and VIIRS into one consistent global fire record, and turns it into a web app that helps researchers and first responders understand how fire activity is changing in a warming climate.

- **Live site:** [embereye-atlas.vercel.app](https://embereye-atlas.vercel.app)

## What it covers

- **Fire Record from July 2002 to November 2026:** NASA's VIIRS and MODIS sensors have recorded fire hotspots for over 20 years. However, data varies in resolution, where VIIRS (375 m, from 2012) sees smaller fires than MODIS (1 km), so raw counts jump fourfold in 2012. EmberEye harmonizes them into a single record that is accessible to all users.

- **Weather, dryness and terrain:** Monthly weather and soil wetness (MERRA-2), the Fire Weather Index (GFWED), land cover (MODIS) and elevation (SRTM) are used in the statistical graphs, the fire activity outlook and the fire-spread simulation.

- **Data delivery:** Suomi NPP's VIIRS sensor stopped delivering hotspot data on 2 Nov 2026, so from 3 Nov 2026 the record uses the identical VIIRS sensor on NOAA-20, adjusted to the Suomi NPP scale using their 2024 overlap.

**How the harmonization works**

1. **Count burning places, not dots:** Each hexagon of ground that burned on a given day counts once, no matter which satellite saw it or how many hotspots it recorded. This removes most of the difference between MODIS and VIIRS. The map's fire trail shows similar hexagons.

2. **Calibrate where both sensors watched:** From 2012 to 2019 MODIS (Aqua) and VIIRS (Suomi NPP) observed the same fires. For each region and calendar month we measure how many burning hexagons VIIRS records for each one MODIS records (about 4.2 worldwide), falling back to larger regions where fires are rare.

3. **One scale:** Older MODIS years are scaled up to match VIIRS data so that the whole record reads as if one sensor had watched from 2002 to today.

**Validation:** Calibrated on 2012-2016 only, then predicted 2017-2019 VIIRS from MODIS alone (`pipeline/validate.py`):

| 2017-2019, held out | Harmonized | Raw MODIS |
|---|---|---|
| Error, worldwide monthly totals | **2.2%** | 76.9% |
| Median error, regional months | **16.9%** | 82.2% |
| Regional months within ±25% | **64%** | 0.1% |

**Limitations:**
- Map dots before 2012 are original MODIS detections; the calendar, charts and downloads use harmonized counts.
- A single region-month is typically within ~17%.
- The latest months are near-real-time data until FIRMS replaces them with science-quality data, about five months later.
- The simulation is an estimate, not a forecast. The risk view is a fire activity outlook, **not an official fire danger rating:** always follow your local fire services.

## What it does

| | |
|---|---|
| **Map** | Hotspots coloured by fire intensity, plus recent fire outlines ("fire trail"), both toggleable.|
| **Burning calendar** | Calendar heatmap covering July 2002 to November 2026. Click to jump to a date, drag to pick a range. Counts, or "vs usual" (% of the median). Colour-blind-safe colours. |
| **Any area, any dates** | The map view, a drawn rectangle, or a point + radius; start and end dates; a time slider that plays through the range. |
| **Compare against history** | How busy each month is compared with that place's own multi-year median. |
| **Stats** | Fire activity, anomaly, intensity, weather, Fire Weather Index and what's burning, synced to the slider. |
| **Downloads** | Hotspot CSV for any search, monthly summary CSV, and PNG + CSV per chart. |
| **Fire-spread simulation** | Click a point; choose 24/48/72 h, wind and dryness. Runs in the browser in under a second and plays from ignition. Clearly labelled an estimate. |
| **Fire activity outlook** | Where fire is more likely than usual this month, from fire weather, soil dryness and fire history. Check it on December 2019, the month before Black Summer. |
| **Featured fires** | One click to Black Summer 2019-20, Amazon 2019, California 2020 or Canada 2023. |
| **Share** | One link restores exactly what you were looking at: map, dates, area, panel and simulation. |

## How to build

The repository has three parts: `pipeline/` (offline Python data pipeline), `api/` (FastAPI + DuckDB, served at `/api`) and `web/` (Astro site and React dashboard). Requirements: **Node 22.23+** and **Python 3.12+**.

### Run it locally

The commands below are for a bash shell (Git Bash on Windows, or Terminal on macOS/Linux).

**1. API** (hotspot points and simulation tiles are read from Cloudflare R2; without the R2 keys only the bundled south-east Australia points are available):

```bash
cp pipeline/.env.example pipeline/.env
# Use .env.example structure to insert R2 values
cd api
python -m venv .venv

# windows
.venv/Scripts/pip install -r requirements.txt

# macOS/Linux:
# .venv/bin/pip install -r requirements.txt

set -a && . ../pipeline/.env && set +a

# windows
.venv/Scripts/python -m uvicorn index:app --port 8000

# macOS/Linux:
# .venv/bin/python -m uvicorn index:app --port 8000
```

**2. Website** (in a second terminal, with the API running; the dev server forwards `/api` to port 8000):

```bash
cd web
npm ci
npm run dev
```

Then open http://localhost:4321.

### Rebuilding the Data (optional)

The data is already processed and compressed in both `api/data/` and R2. Rebuilding needs raw downloads and a free [NASA Earthdata Login](https://urs.earthdata.nasa.gov/).

```bash
cd pipeline
python -m venv .venv

# windows (macOS/Linux: .venv/bin/pip)
.venv/Scripts/pip install "duckdb>=1.4" "pyarrow>=20" "boto3>=1.34" "numpy>=2" "h5py>=3.11" "scipy>=1.14" "pyhdf>=0.11" "pyshp>=2.3"
```

1. **Download** the datasets listed under [Dataset credits](#dataset-credits). VIIRS Suomi NPP yearly world files come from the [FIRMS archive](https://firms.modaps.eosdis.nasa.gov/download/) into `data/raw/world/VIIRS_SNPP_archive/`. MODIS and NOAA-20 come from `python download.py`, which needs `FIRMS_MAP_KEY` set in your terminal, takes about 9 hours, and is safe to stop and re-run.
2. **Process**, in order:
   ```bash
   # filter, stack sensors
   python clean.py

   # fire cell-days, calibration, harmonized record
   python harmonize.py

   # Parquet outputs into api/data/
   python aggregate.py

   # land cover per cell
   python landcover.py

   # MERRA-2 monthly weather
   python weather.py

   # Fire Weather Index
   python gfwed.py

   # hotspot point files
   python export_points.py

   # simulation tiles
   python sim_inputs.py

   # holdout test + home page chart data
   python validate.py

   # upload points and simulation tiles to R2
   python upload_r2.py
   ```

### Deploy

One Vercel project with the root directory set to the repository root; `vercel.json` builds `web/` and runs `api/index.py` as a Python function at `/api`. Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` in the project settings, and turn **Deployment Protection off** so the site is public.

## Dataset credits

| Dataset | Provider | Used for |
|---|---|---|
| [FIRMS](https://www.earthdata.nasa.gov/data/tools/firms) active fires: MODIS Aqua (Collection 6.1), VIIRS 375 m Suomi NPP and NOAA-20 | NASA LANCE / ESDIS | The fire record |
| [GFWED](https://data.giss.nasa.gov/impacts/gfwed/) Global Fire WEather Database (Fire Weather Index) | NASA GISS | Stats, risk outlook, simulation dryness |
| [MERRA-2](https://gmao.gsfc.nasa.gov/reanalysis/MERRA-2/) monthly temperature, humidity, wind and soil wetness | NASA GMAO | Stats, risk outlook, simulation wind |
| [MODIS MCD12Q1](https://doi.org/10.5067/MODIS/MCD12Q1.061) and [MCD12C1](https://doi.org/10.5067/MODIS/MCD12C1.061) land cover | NASA LP DAAC | Simulation fuel, stats |
| [SRTM](https://lpdaac.usgs.gov/) elevation (SRTMGL30) | NASA / USGS | Simulation slope |
| [GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api) Blue Marble and Reference Labels | NASA | Basemap and map labels |
| [Natural Earth](https://www.naturalearthdata.com/) roads | Natural Earth | Simulation |
| Place names in the map labels | © OpenStreetMap contributors, via NASA GIBS | Map |
| [H3](https://h3geo.org/) hexagonal grid | Open source | Spatial index |

We acknowledge the use of data and imagery from LANCE FIRMS operated by NASA's Earth Science Data and Information System (ESDIS) with funding provided by NASA Headquarters.

## Use of AI

AI use is allowed by the NASA Space Apps rules; here is exactly what we used and where.

**Tool:** Claude Code (Anthropic), an AI coding assistant running in our editor and terminal. Both team members used it.

**How we used it:** we described what we wanted and reviewed what it produced. It wrote and edited code, ran our scripts and tests, and helped find and fix bugs. We tested features ourselves on the local and live site and asked for changes until they worked the way we wanted.

**Where:**
- **Data pipeline (`pipeline/`):** cleaning and harmonizing the FIRMS records, the holdout validation (`validate.py`), weather, Fire Weather Index and land cover processing, the simulation input tiles and the home page hero map (`hero_map/`).
- **API (`api/`):** the FastAPI + DuckDB routes (calendar, hotspots, stats, exports, risk outlook, simulation tiles) and performance work (sampled files, caching).
- **Dashboard (`web/`):** map layers, burning calendar, stats charts, downloads and the "Download all" ZIP, share links, the fire-spread simulation model and the risk outlook.
- **Home page and docs:** the home page, its design and animations, this README and in-app text.

**What the team did:** chose the approach and features, found and downloaded the NASA datasets, made the design and data decisions, tested everything, and reviewed and approved all changes. Every number shown, such as the validation results, comes from running our code on NASA data.

**What AI did not do:** no data was generated by AI. Hotspots, weather and fire activity come from the NASA datasets listed above, and simulated fire spread is clearly labelled as an estimate.

## Team and license

Daryl Allen Wiriadi and Nicholas Aidan Halim. [MIT License](LICENSE). Not affiliated with or endorsed by NASA.
