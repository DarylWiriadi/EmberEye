# CLAUDE.md

Project brief for Claude Code. Read this before writing any code.

## 1. What we're building

A web app for the **NASA Space Apps Challenge 2026** (hackathon: Sat 14 – Sun 15 Nov 2026).

The challenge: satellites have recorded fire hotspots for 20+ years, but the record is split across two sensors (MODIS and VIIRS) whose counts can't be compared directly. We must **harmonize** them into one consistent record and build a **burning activity calendar** web app on top of it, so emergency responders, scientists, land managers and firefighters can see when and where fires happen, spot unusual periods, and compare the present against history for any area on Earth.

Our differentiators on top of the brief: a **fire-spread simulation**, a **fire risk outlook**, and a **scroll-story home page**.

### Core requirements from the brief (never cut these)

1. **Harmonize MODIS + VIIRS** FIRMS hotspots, "so that by the end of that phase the sensor of origin no longer matters".
2. **Burning activity calendar**: hotspot counts from the early 2000s to now, with **accessible colour ramps** showing busy and quiet months and years.
3. **Select an area of interest** (draw on the map or enter lat/long).
4. **Select a date range.**
5. **Compare against history**: e.g. current month vs the historical median, anomalies vs multi-year averages.
6. **Download** analytics, visualizations, and a **CSV of hotspots** for the search.

Burning activity includes **agricultural and land-clearing fires**, not only wildfires. Do not filter those out.

### How we're judged

- **Criteria**: Influence, Creativity, Validity (scientifically sound), Relevance (answers the brief, complete, usable), Presentation.
- **Two stages**: local judges (Australia) first, then global judges from NASA and partner space agencies reviewing online, weeks later.
- **Submission**: a 30-second demo video (English subtitles) or a deck of up to 7 slides, plus a **public** project link (no login or password). The site must stay online until global winners are announced (~January).

## 2. Feature list (in build priority order)

| # | Feature | Priority |
|---|---|---|
| 1 | MODIS/VIIRS harmonization pipeline | Core |
| 2 | Burning calendar (corner widget, drill-down, click + drag) | Core |
| 3 | Area selection (map view, rectangle, then paint brush) | Core |
| 4 | Date range (start/end inputs, synced with calendar drag) | Core |
| 5 | Comparison against history (anomaly view) | Core |
| 6 | Downloads: hotspot CSV, summary CSV, chart PNG/CSV, Everything ZIP | Core |
| 7 | Map with time slider | Core |
| 8 | Stats panel (synced to slider) | Core |
| 9 | Fire-spread simulation | Differentiator |
| 10 | Simulation download | Differentiator |
| 11 | Simulation history (reload, compare, share links) | Differentiator |
| 12 | Risk panel (global, FWI-based) | Differentiator |
| — | Home page scroll story + methodology page | Presentation |

**Cut order if short on time**: simulation history comparison → magic wand → paint brush (keep rectangle) → risk panel level 2 → featured fires → simulation. Never cut features 1–6.

## 3. Tech stack

| Layer | Choice |
|---|---|
| Site framework | **Astro** (home + methodology pages, static) |
| Dashboard | **React + TypeScript**, mounted as `<Dashboard client:only="react" />` |
| Map | **MapLibre GL JS** via `react-map-gl/maplibre` |
| Data layers | **deck.gl** via `MapboxOverlay` (added with `useControl`) |
| State | **Zustand** (one shared store) |
| Calendar | **react-vega** (Vega-Lite heatmap) |
| Live charts | **uPlot** |
| API calls | **TanStack Query** |
| Simulation | TypeScript in a **Web Worker** |
| Home page animation | **GSAP ScrollTrigger** |
| Icons | **Lucide** everywhere: `lucide-react` in the dashboard, `astro-icon` + `@iconify-json/lucide` on Astro pages (`<Icon name="lucide:flame" />`). Don't mix icon sets |
| Backend | **Python FastAPI + DuckDB**, querying Parquet files |
| Spatial index | **H3** hexagon grid (DuckDB `h3` community extension in the pipeline; `h3` Python package in the API; `h3-js` in the browser for brush/wand selection) |
| Pipeline | Python: DuckDB, pandas/Polars, xarray, xclim |
| Hosting | **Vercel for both** `web/` and `api/` (two Vercel projects from this repo), API pinned to the **Sydney region (`syd1`)**. Fallback: Fly.io `syd` if the API outgrows Vercel (see section 6) |

Do not use GraphQL, Next.js, PostgreSQL/PostGIS, Docker (unless we fall back to Fly.io) or a separate SPA framework. Keep it simple.

## 4. Repo structure

```
nasa-space-apps-2026/
├── CLAUDE.md
├── README.md                     Setup, run instructions, data credits
├── .gitignore                    Raw data, node_modules, .venv, duckdb_ext
│
├── pipeline/                     Python, runs offline before the demo
│   ├── pyproject.toml
│   ├── config.py                 Paths, H3 resolutions, thresholds, demo regions
│   ├── download.py               FIRMS archives + NASA layers
│   ├── clean.py                  Filter type/confidence, stack sensors
│   ├── harmonize.py              Fire cell-days, overlap calibration
│   ├── aggregate.py              Daily/monthly counts, medians, anomalies
│   ├── clusters.py               Group hotspots into fire events (DBSCAN)
│   ├── risk.py                   FWI + dryness + climatology → risk tiles
│   ├── sim_inputs.py             Fuel, slope, water rasters for demo regions
│   ├── towns.py                  Pre-baked town lists for demo regions
│   ├── validate.py               Holdout test + raw-vs-harmonized chart
│   └── data/
│       ├── raw/                  Downloads (gitignored)
│       └── interim/              Intermediate files (gitignored)
│
├── api/                          FastAPI + DuckDB, deployed to Vercel (syd1)
│   ├── requirements.txt          fastapi, uvicorn[standard], duckdb, h3 (pinned)
│   ├── vercel.json               Region, includeFiles
│   ├── main.py                   App setup, CORS, routes (`app` instance)
│   ├── db.py                     DuckDB connection, views over the Parquet files
│   ├── area.py                   bbox / H3 cells → selected res 5 cells
│   ├── routes/
│   │   ├── calendar.py           GET /calendar
│   │   ├── hotspots.py           GET /hotspots
│   │   ├── stats.py              GET /stats
│   │   ├── export.py             GET /export.csv, /export-summary.csv
│   │   └── risk.py               GET /risk
│   ├── static/                   Sim inputs, presets, featured fires, towns (served from CDN)
│   └── data/                     Parquet outputs from the pipeline
│       ├── global/               Monthly counts per H3 res 5 + daily counts per H3 res 3
│       ├── regions/              Res 7 counts + raw points for demo regions
│       └── climatology/          Monthly medians, multi-year means
│
└── web/                          Astro site, deployed to Vercel
    ├── package.json
    ├── astro.config.mjs
    ├── tsconfig.json
    ├── public/
    │   ├── logo.png
    │   ├── favicon.png
    │   └── hero-simulation.mp4   Looping map recording (later)
    └── src/
        ├── layouts/
        │   └── BaseLayout.astro  Shared head, fonts, nav, footer
        ├── pages/
        │   ├── index.astro       Home (scroll story)
        │   ├── dashboard.astro   Mounts <Dashboard client:only="react" />
        │   └── methodology.astro
        ├── components/
        │   ├── home/
        │   │   ├── Hero.astro
        │   │   ├── DotGridFire.astro
        │   │   ├── HarmonizedChart.astro
        │   │   ├── FeaturedFires.astro
        │   │   └── FireTransition.astro   Red circles + final buttons
        │   └── dashboard/
        │       ├── Dashboard.tsx          Layout shell
        │       ├── map/
        │       │   ├── MapView.tsx        MapLibre + GIBS basemap
        │       │   ├── DeckOverlay.tsx    deck.gl via MapboxOverlay
        │       │   └── layers/            Hotspots, sim grid, risk, perimeters
        │       ├── calendar/
        │       │   ├── CalendarWidget.tsx Corner widget, drill-down
        │       │   ├── YearsView.tsx
        │       │   ├── MonthView.tsx
        │       │   └── useDragSelect.ts   Click + drag range selection
        │       ├── area/
        │       │   ├── AreaToolbar.tsx
        │       │   ├── RectangleTool.tsx
        │       │   ├── PaintBrush.tsx
        │       │   └── MagicWand.tsx
        │       ├── timeline/
        │       │   ├── DateRangeInputs.tsx
        │       │   └── TimeSlider.tsx
        │       ├── stats/
        │       │   ├── StatsPanel.tsx
        │       │   ├── StatCards.tsx
        │       │   └── TimeSeriesChart.tsx   uPlot
        │       ├── simulation/
        │       │   ├── SimulationPanel.tsx
        │       │   ├── SimulationHistory.tsx
        │       │   └── exportZip.ts          JSZip download
        │       ├── risk/
        │       │   └── RiskPanel.tsx
        │       └── downloads/
        │           └── DownloadMenu.tsx      Hotspot CSV, summary, PNG
        ├── store/
        │   └── useAppStore.ts     Zustand: area, dates, time, fire, sim
        ├── workers/
        │   ├── simulation.worker.ts
        │   └── simulation/        Model, seeded RNG, typed-array grid
        ├── lib/
        │   ├── api.ts             TanStack Query hooks (base URL from env)
        │   ├── h3.ts              Cell helpers (h3-js)
        │   ├── colors.ts          Cividis/viridis + blue–orange ramps
        │   ├── shareUrl.ts        ?sim= encode/decode
        │   └── historyDb.ts       IndexedDB for simulation history
        ├── types/
        │   └── index.ts           Shared types (Area, DateRange, SimRun…)
        └── styles/
            └── global.css
```

Raw downloads stay out of git (many GB). Only the smaller Parquet outputs go into `api/data/`; if they're too large for GitHub, keep them in object storage (e.g. Cloudflare R2) and fetch them in the build step.

## 5. Data pipeline (harmonization)

### Data sources

| Purpose | Dataset | Source |
|---|---|---|
| Hotspots | FIRMS **Aqua MODIS** (4 Jul 2002 →; the FIRMS MODIS files combine Terra + Aqua, filter `satellite IN ('Aqua', 'A')`, the files use the full words `Aqua` / `Terra`) | NASA |
| Hotspots | FIRMS **VIIRS S-NPP 375 m** (2012 → **2 Nov 2026**, when S-NPP stopped delivering new data; archive stays available) | NASA |
| Hotspots (continuity) | FIRMS **VIIRS NOAA-20 375 m** (from 1 Apr 2018; carries the record after S-NPP ended). NOAA-21 (from 1 Mar 2023) as backup | NASA |
| Optional extra history | FIRMS Terra MODIS (2000 →) | NASA |
| Weather | MERRA-2; **GFWED** (NASA GISS global Fire Weather Index) if current enough | NASA |
| Precipitation | GPM IMERG | NASA/JAXA |
| Soil moisture | SMAP | NASA |
| Vegetation dryness | MODIS NDVI, or NOAA-20 VIIRS NDVI (not the S-NPP version, which stopped on 2 Nov 2026; check the latest available date) | NASA |
| Land cover / fuel | MODIS MCD12Q1 | NASA |
| Elevation (slope, aspect) | NASADEM / SRTM | NASA |
| Water bodies | MODIS MOD44W water mask | NASA |
| Basemap imagery | NASA GIBS (time-enabled tiles) | NASA |
| Roads, small waterways, town names | OpenStreetMap / Geoscience Australia gazetteer | Not NASA (say so in the pitch) |

### Steps

1. **Download** the FIRMS archives (global) from the FIRMS Archive Download tool (https://firms.modaps.eosdis.nasa.gov/download/, needs a free Earthdata Login). Prefer **Standard Processing (SP)** data for history; use **NRT** only for the most recent weeks not yet in SP. Recent days can also come from the FIRMS API (free MAP_KEY).
   - Archive start dates (from the download form): MODIS Terra from 1 Nov 2000, MODIS Aqua from 4 Jul 2002, VIIRS S-NPP 20 Jan 2012 – 2 Nov 2026, VIIRS NOAA-20 from 1 Apr 2018, NOAA-21 from 1 Mar 2023. The archive covers data older than 7 days.
   - **World** is split between the website and the API, because the archive form allows **max one year per request** for areas over half the globe, and each world API call costs **~180 transactions** against a limit of **5,000 per 10 minutes** (~26 calls per 10 min):
     - **VIIRS S-NPP, 2012-01-20 → 2026-11-02** (done): website archive, **one request per year** (World, S-NPP only, CSV). Stored in `pipeline/data/raw/world/VIIRS_SNPP_archive/`.
     - **MODIS, 2002-07-04 → 2019-12-31** and **VIIRS NOAA-20, all of 2024 (calibration year) + 2026-11-03 → latest**: the **FIRMS Area API** via `pipeline/download.py`. ~1,355 calls, ~9 hours, run overnight.
   - **API details** (as tested):
     - `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/-180,-90,180,90/{DAY_RANGE}/{YYYY-MM-DD}`. Free MAP_KEY in the env var `FIRMS_MAP_KEY`; never commit it.
     - **`DAY_RANGE` is 1–5** (the API rejects larger values, despite older docs saying 10). The script uses 5-day chunks.
     - Sources: `MODIS_SP`, `VIIRS_NOAA20_SP` (+ `VIIRS_SNPP_SP` if ever needed) for history; `*_NRT` only for dates after SP ends (no overlap). Date ranges come from `/api/data_availability/csv/{MAP_KEY}/ALL`.
     - Cost is per call and depends on the **area**, not the rows returned (MODIS and VIIRS world calls both cost ~180). The script checks the quota (`/mapserver/mapkey_status/?MAP_KEY=...`) before every call, waits when needed, retries with backoff, and skips chunks already on disk, so it can be stopped and re-run safely.
     - Output: one gzipped CSV per 5-day chunk, `pipeline/data/raw/world/{SOURCE}/{start-date}.csv.gz` (~1 MB for MODIS, ~4 MB for VIIRS). Don't extract them: DuckDB reads them all with a glob like `'.../MODIS_SP/*.csv.gz'`. 7-Zip shows the inner name as `.csv.tmp` (cosmetic, from the write-then-rename step).
     - Failed chunks are logged in `failures.txt`; re-run the script to retry.
   - **Columns** (verified, MODIS SP): `latitude, longitude, brightness, scan, track, acq_date, acq_time, satellite, instrument, confidence, version, bright_t31, frp, daynight, type`. VIIRS uses `bright_ti4/bright_ti5` and letter confidence (`l/n/h`).
   - The **last 7 days** aren't in the archive; they come from the API (`*_NRT`).
   - Backup routes: the download page's yearly country files, or the original monthly global science files (MODIS MCD14ML, VIIRS VNP14IMGML) from the University of Maryland SFTP server.
   - Archive requests (CSV) are processed in the background and a download link is emailed. FIRMS delivers separate files per source (and often SP vs NRT).
   - Quick start: the same page offers **yearly summaries by country as direct CSV downloads** (no request). Handy for quick pipeline tests while global requests process.
   - NRT data is replaced by science-quality SP data with a ~5-month lag, so the most recent months are NRT. Note this on the methodology page.
2. **Clean**:
   - Keep FIRMS `type = 0` (presumed vegetation fire, includes agricultural burns). Drop volcanoes (1), static land sources like gas flares (2) and offshore (3). (Sample check: ~95% of MODIS rows are `type 0`.)
   - MODIS: keep **Aqua only** (`satellite IN ('Aqua', 'A')`).
   - Merge sources without double counting: SP/archive data where it exists, NRT only for later dates; S-NPP from the website files, MODIS/NOAA-20 from the API chunks.
   - Flag chunks with unusually low counts (possible satellite data gaps, e.g. early Aug 2002) rather than treating them as quiet periods.
   - Drop low-confidence detections (VIIRS `l`; MODIS below a configurable threshold, default 30).
   - Stack into one table with a `sensor` column.
3. **Grid + fire cell-days**: assign each hotspot an H3 index at **res 8** (~0.7 km²). Collapse to one row per `(cell, date, sensor)`: a "fire cell-day". This removes most of the resolution difference.
4. **Calibrate on the overlap (2012–2019)**:
   - Per calibration region (H3 **res 2**) and calendar month: `ratio = VIIRS cell-days / MODIS cell-days`.
   - If a region-month has too few detections (configurable minimum), fall back to a coarser region, then a global monthly ratio.
   - Avoid post-2019 years for calibration (Terra/Aqua orbit drift changed overpass times).
5. **Build the harmonized series** (S-NPP VIIRS is the reference):
   - Before 2012: MODIS cell-days × ratio ("VIIRS-equivalent").
   - 2012 → 2 Nov 2026: VIIRS S-NPP as is.
   - After 2 Nov 2026: VIIRS NOAA-20 cell-days × a NOAA-20→S-NPP ratio, calibrated the same way on their overlap year **2024** (the NOAA-20 year we downloaded globally). Expect a ratio near 1 (same sensor, same orbit ~50 min apart), but compute and report it.
   - Pitch point: the sensor handover the brief describes happened during this hackathon season, and the pipeline handles it.
6. **Aggregate** to Parquet, at different detail levels so the deployed data stays small (target **< ~200 MB total**, every file < 100 MB for GitHub, well under Vercel's 500 MB function limit):
   - Global **monthly** counts per H3 **res 5** cell → calendar years view + anomalies anywhere.
   - Global **daily** counts per H3 **res 3** cell → calendar month view anywhere.
   - Demo regions: **daily** counts per H3 **res 7** + **raw hotspot points** → map dots, per-fire stats, hotspot CSV export.
   - Raw downloads (~10–20 GB) never leave the local machine.
   - Precompute per-cell monthly medians and multi-year means for anomaly views.
   - Sort/partition files by region and date so DuckDB can skip data.
7. **Validate**: calibrate on 2012–2016, predict 2017–2019 from MODIS, compare with actual VIIRS. Output metrics + a **raw vs harmonized** chart (the raw series jumps at 2012, the harmonized one doesn't). This chart goes on the methodology page and in the pitch.

**Known limitation (state it openly)**: the map can't invent VIIRS-detail points before 2012. Pre-2012 map points are original MODIS detections; the calendar and stats use harmonized counts.

## 6. Backend API

FastAPI + DuckDB over the Parquet files. Areas are passed as a bbox or a list of H3 cell IDs.

| Endpoint | Returns |
|---|---|
| `GET /calendar` | Harmonized counts per day or month for an area + date range, with medians/anomalies |
| `GET /hotspots` | Hotspot points for a bbox + date (or range) for the map |
| `GET /stats` | Summary stats for an area + range (counts, anomaly, FRP, etc.) |
| `GET /export.csv` | Hotspot CSV (streamed): date, lat, lon, sensor, confidence, FRP, H3 cell |
| `GET /export-summary.csv` | Monthly counts + anomalies for the area |
| `GET /risk` | Risk tiles for the current view |
| Static files | Simulation input rasters, preset regions, featured fires, town list |

Rules:
- Return JSON (or CSV for exports), enable CORS for the frontend origin, cache responses for presets and featured fires.
- **Compress responses**: `app.add_middleware(GZipMiddleware, minimum_size=1000)`.
- **Cap hotspot exports** (default 500,000 rows). Above the cap, return a clear error telling the user to narrow the area/date range or use the monthly summary.
- **Stream** CSV exports.

**Frontend API call rules** (protect Vercel's free-plan limits):
- Fetch once per area + date range; never call the API from the slider/playback animation loop.
- Calendar drag queries only on pointer release.
- Debounce map-move queries (~300 ms).

### Hosting the API on Vercel

- `api/` is its own Vercel project (Root Directory = `api`). Vercel auto-detects the FastAPI `app` in `main.py`. The web app reads the API URL from an env var (e.g. `PUBLIC_API_URL`).
- `vercel.json`:
  ```json
  {
    "regions": ["syd1"],
    "functions": {
      "main.py": { "includeFiles": "data/**", "maxDuration": 60 }
    }
  }
  ```
- **H3 in the API**: the API uses the `h3` Python package (cell conversion only); it does **not** need the DuckDB `h3` extension, so there is no build step and nothing is downloaded at runtime. The pipeline precomputes every H3 index the API needs (e.g. `global/cells_res5.parquet` has each cell's res 3 parent and centre lat/lng). The DuckDB `h3` extension is used only by the offline pipeline.
- **Read-only filesystem**: open DuckDB in memory, read Parquet files by path, and set `temp_directory` to `/tmp`.
- **Limits to respect**: function bundle ≤ 500 MB (up to 5 GB with the "large functions" beta), so the Parquet data must fit; responses ≤ 4.5 MB unless streamed, so **stream CSV exports** and keep `/hotspots` responses small (bbox + date, with a cap).
- **Static files** (`static/`): mount with FastAPI `StaticFiles` so Vercel serves them from its CDN.
- **Cold starts**: the first request after idle loads Python + DuckDB. Warm the site up before presenting.

### Fallback: Fly.io

Switch to Fly.io (`syd`, always-on, 1 GB machine, `auto_stop_machines = "off"`, `min_machines_running = 1`) only if the data exceeds Vercel's bundle limit or cold starts are too slow in testing. That path needs a small Dockerfile (python:3.12-slim, install requirements, run uvicorn on port 8080) and a credit card on the Fly account.

## 7. Dashboard (frontend)

One screen. Layout:

- **Map** in the centre (MapLibre, NASA GIBS basemap matching the slider date + a light label layer). Max zoom ~12, since hotspot data is 375 m–1 km.
  - Pick the GIBS true-colour layer **by date**: MODIS (Terra/Aqua) before 2012 → VIIRS S-NPP 2012 to 2 Nov 2026 → VIIRS NOAA-20 after 2 Nov 2026 (S-NPP imagery stopped updating then).
  - Recent ignition points for the simulation come from NOAA-20/21 hotspots.
- **Calendar widget** top right.
- **Area tools + start/end date inputs** in a top bar.
- **Time slider** along the bottom, above the **stats panel**.
- **Risk panel** and **featured fires** in a collapsible side panel.

### Shared state (Zustand)

One store holds: selected area (bbox or H3 cells), date range, current slider time, selected fire, calendar view level, simulation state, layer toggles. Every component reads from it; nothing keeps its own copy. Fast-changing values (slider time, playhead) are read with selectors so only dependent components re-render.

### Area selection

1. **Current map view** is the default area.
2. **Rectangle** tool.
3. **Paint brush**: paints H3 cells; eraser mode; brush size slider; map panning disabled while painting.
4. **Magic wand**: click a fire to select its whole cluster (hotspots grouped by DBSCAN in space and time).
5. **Lat/long + radius** input, and place search, if time allows.

### Burning calendar (corner widget)

- **Years view (default)**: years × months heatmap.
- **Month view**: click a month → day grid for that month.
- **Click a cell** → map, slider and stats jump to that date.
- **Click and drag** → selects a date range (wraps across years in reading order). Shift-click supports ranges across months. Query only on pointer release.
- Breadcrumb to zoom back out ("2019 › Dec").
- Toggle: **counts** (cividis/viridis, log scale) vs **anomaly** (% vs median, blue–orange diverging; never red–green).
- Tooltip: e.g. "20 Oct 2019: 148 hotspots, 3.2× the median".
- Expand button opens a large version with PNG/CSV export.
- Two-way sync with the slider. Recolours when the area changes.
- Presets: "Last 30 days", "This fire season", "Same month, all years".

### Date range

Start/end date inputs are the precise control. Calendar drag fills them in. The slider moves **within** the range (scrub + play), it doesn't choose it.

### Stats panel

Time-series charts across the timeline with a playhead line at the slider position; stat cards show values at the current time. Past = solid line, simulated future = dashed. Same metrics and units for past and simulation:

- Location: nearest town + distance, heading, region (coords on hover); time-to-reach in simulation
- Area burned (ha)
- Growth rate (ha/h)
- Front speed (km/h)
- Intensity (FRP for past; proxy for simulation)
- Wind, temperature, dryness

With multiple fires on screen, stats are per selected fire; with none selected, totals for the area.

### Downloads

One **Download menu** for the current area + date range, with each option doing exactly what its label says (never bundle everything behind a "CSV" button):

1. **Hotspots (CSV)**: raw harmonized hotspots from `/export.csv` (primary option, required by the brief).
2. **Monthly summary (CSV)**: counts, medians, anomalies per month.
3. **Everything (ZIP)**, built in the browser with JSZip:
   - `hotspots.csv`, `monthly_summary.csv`, `stats_timeseries.csv`
   - `calendar.png` and the stats chart PNGs
   - `README.txt`: area, date range, export date, harmonization method, data sources

Plus a small **per-chart download icon** (PNG + CSV of that chart's data) on the calendar and each stats chart. Chart PNG/CSV exports are generated client-side (Vega-Lite's built-in export; uPlot canvas → PNG). Only the hotspot CSV comes from the API.

Simulated data never goes in these files; it has its own download (section 8).

Priority: hotspot CSV + summary CSV → calendar PNG → Everything ZIP → per-chart icons.

### Featured fires

Preset events (e.g. Black Summer 2019–20, Amazon 2019, California 2020, Canada 2023). One click sets area, dates and map. Used as the demo shortcut.

## 8. Fire-spread simulation

### Flow

1. User clicks an ignition point (or a recent real fire).
2. Picks duration (24/48/72 h) and optional wind override.
3. Simulate → the worker runs the whole thing and caches hourly frames.
4. The slider extends past "now" (distinct dashed/orange styling). Play animates it; scrubbing is instant.
5. Show hourly perimeter lines, time-to-reach for nearby towns, and a stats panel.
6. Always labelled as an **estimate**, with inputs shown.

### Model

- Cellular automaton (~100 m cells); states: unburnt / burning / burnt.
- Each tick, burning cells try to ignite neighbours with probability from: fuel type × dryness × wind alignment × slope (upslope roughly doubles spread per 10°).
- Barriers never ignite: water, roads, bare ground, urban, **recently burnt cells (from our harmonized history)**.
- Optional spotting: small chance of ignition a few cells downwind in strong wind.
- Weights loosely based on established fire danger indices (FWI / McArthur FFDI).
- **Seeded RNG** so the same inputs always give the same result.
- Validation demo: start from the first hotspot of a real past fire and overlay what actually happened.

### Performance rules (must follow)

- Grid state and static layers in **typed arrays**, never in React state.
- Precompute static layers once per region.
- Iterate only over the active fire front.
- Render the grid as **one image** (pixel buffer → deck.gl `BitmapLayer`), never per-cell polygons.
- Run in a **Web Worker**.
- Precompute all frames, then scrub through cached snapshots.
- Optional: 10–20 runs with varied wind → uncertainty band on charts.

### Simulation download

One ZIP (built in the browser with JSZip):
- `perimeters_SIMULATED.geojson` (hourly perimeters)
- `stats_SIMULATED.csv` (hourly stats; min/median/max if uncertainty runs exist)
- `inputs.json` (ignition, start, duration, wind, seed, data sources)
- `README.txt` (model estimate, not observations)

**Never mix simulated data into the real hotspot CSV.**

### Simulation history

- "Past simulations" drawer: thumbnail, location, date, duration, wind, area burned.
- Reload, rename, delete, download, **compare two runs** (overlaid perimeters).
- Store only **inputs + seed + summary** in IndexedDB; reloading re-runs the simulation.
- Shareable URLs: `?sim=lat,lon,start,duration,wind,seed`.

## 9. Risk panel (global)

- Risk tiles on the map (toggleable) + a ranked "Highest risk areas" list for the current view, each with a "Simulate a fire here" button.
- Score = average of percentiles (relative to that place and month) of:
  - Fire Weather Index (GFWED, or computed from MERRA-2 with `xclim`; needs a spin-up of a few months of daily weather)
  - Dryness: NDVI and SMAP soil moisture anomalies
  - Historical activity for this month from the harmonized data
- 5 classes: Low, Moderate, High, Very high, Extreme. Tooltip explains the components.
- Global at coarse resolution; finer in demo regions.
- Label it a **"fire activity outlook"**, not an official fire danger rating. Point users to official ratings.

## 10. Pages

### Home (Astro, mostly static)

Sections top to bottom:
1. Top bar: name/logo, links to Dashboard and Methodology
2. Hero: mission line, subtitle, "Open the dashboard" + "How it works", spreading-fire visual (abstract dot grid now; later a looping muted video of a real simulation on the map)
3. The problem
4. The data story (MODIS since 2000, VIIRS since 2012)
5. **Raw vs harmonized chart** (must keep)
6. What you can do: calendar, compare, simulate
7. Featured fires
8. Who it's for
9. **Fire transition**: on scroll, soft red circles grow and merge into a full-screen red; then the same two buttons fade in
10. Footer: team, NASA data credits, "not an official fire danger rating", GitHub link

Accessibility: respect `prefers-reduced-motion` (simple fade instead), no rapid flashing.

#### Navigation: jump to sections

- Each home section has an `id` (e.g. `problem`, `data-story`, `approach`, `featured`, `who`), and the nav links to them with `href="#id"`. Dashboard and Methodology are normal page links.
- Smooth scrolling only when motion is allowed:
  `@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }`
- Sticky nav: add `scroll-margin-top` (≈ nav height) to `section[id]` so headings aren't hidden under it.
- Highlight the nav link of the section currently in view (IntersectionObserver).
- Links from other pages use `/#id` (e.g. `/#featured`).
- The fire transition is pinned with GSAP, which changes page height: if anchor jumps land off-target, handle nav clicks with GSAP's ScrollToPlugin instead of native anchors.

#### Hero: fixed layout that scales (like a poster)

The hero is designed once at a reference size (1440 px wide) and **scales proportionally** with the viewport. Text, buttons, spacing and the fire visual grow and shrink together; the **arrangement never changes** (text left, visual right, buttons under the text; nothing wraps or stacks).

How to build it:
- Set one scale value on the hero, e.g. `font-size: clamp(10px, calc(100vw / 1440 * 16), 20px)` on the hero container, and size **everything inside in `em`** (text, padding, gaps, button heights, the visual's width). Don't use `px` or `rem` inside the hero.
- Use CSS grid with fixed proportions (e.g. `grid-template-columns: 1.1fr 0.9fr`) and no `flex-wrap`.
- Don't use `transform: scale()` (blurry text, broken hit areas, ignores zoom).

Safeguards:
- **Phones** (below ~768 px wide): the fixed layout is dropped; the hero stacks (text, then visual) as a normal responsive section. Otherwise body text would shrink to an unreadable size.
- **Minimum text sizes**: body text never below 14 px, buttons never below 44 px tall (the `clamp` minimum handles this), so browser zoom still enlarges text.
- Only the hero behaves this way. The rest of the page is a normal responsive layout.

### Dashboard

As in section 7. Simulation is a mode within it, not a separate page.

### Methodology

How harmonization works, the raw vs harmonized chart, validation results, data sources, limitations, simulation and risk disclaimers.

## 11. Accessibility and honesty

- Colour-blind-safe ramps only (cividis/viridis; blue–orange diverging).
- Real buttons and labelled inputs; keyboard support for calendar ranges.
- Text contrast ≥ 4.5:1.
- Always distinguish **observed** vs **harmonized** vs **simulated** data in the UI and in downloads.

## 12. Demo reliability

- Preprocess everything offline; serve Parquet and static files. **No live NASA API calls during the demo.**
- Prepare 2–3 detailed demo regions (south-east Australia/Black Summer first, plus one or two on other continents).
- Pre-bake town lists for demo regions (no live reverse geocoding).
- Warm up the API (open the dashboard) a minute before presenting, to avoid a cold start on stage.
- Before the hackathon, deploy a hello-world FastAPI + DuckDB endpoint to Vercel and check bundle size and cold-start time.
- Test all submission links in a private browser window.

## 13. Open decisions

- Project name
- Team roles
- Exact demo regions
- Whether to add Terra MODIS for 2000–2002
- Vercel vs Fly.io for the API (decide after the hello-world test)
