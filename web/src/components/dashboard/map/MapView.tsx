import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map, {
  AttributionControl,
  NavigationControl,
  useControl,
  type MapEvent,
  type MapLayerMouseEvent,
  type MapLayerTouchEvent,
  type MapRef,
} from 'react-map-gl/maplibre';
import { describeBbox } from '../area/AreaToolbar';
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox';
import { PolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { cellsToMultiPolygon, latLngToCell } from 'h3-js';
import { DataFilterExtension } from '@deck.gl/extensions';
import type { PickingInfo } from '@deck.gl/core';
import { LngLat, setWorkerUrl, type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';

import { useAppStore, useSliderWindow, useSteps } from '../../../store/useAppStore';
import { addDays, DAY_MS, stepOf, stepsFor, stepWindow, windowPhrase } from '../../../lib/steps';
import { useQueryClient } from '@tanstack/react-query';
import { fetchBbox, prefetchHotspots, useBurned, useHotspots, worldHotspotsKey, type HotspotsResponse } from '../../../lib/api';
import {
  BASEMAP_ATTRIBUTION,
  BASEMAP_MAX_ZOOM,
  BASEMAP_TILES,
  LABEL_ATTRIBUTION,
  LABEL_MAX_ZOOM,
  LABEL_TILES,
} from '../../../lib/gibs';
import { logScale, viridis } from '../../../lib/colors';
import type { Bbox } from '../../../types';
import MapStatus from './MapStatus';
import { prefetchTiles, viaStore } from '../../../lib/tileCache';

const INITIAL_ZOOM = 1.6;
// Outlines: merged H3 res 7 cells (~5 km2) with a detection in the last 30 days.
const OUTLINE_MIN_ZOOM = 7.5;
// Below this zoom (about country level) the map only shows the reduced sample.
const DETAIL_MIN_ZOOM = 5;
const OUTLINE_WINDOW_DAYS = 30;
// Most dots drawn for one slider step; more than this just piles up.
const STEP_DOT_CAP = 5_000;
const SWAP_FADE_MS = 450;
const DAY_FILTER = new DataFilterExtension({ filterSize: 1 });

// MapLibre finds its worker relative to its own file, which breaks once bundled.
setWorkerUrl(maplibreWorkerUrl);

const BASE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: 'raster',
      tiles: viaStore(BASEMAP_TILES),
      tileSize: 256,
      maxzoom: BASEMAP_MAX_ZOOM,
      attribution: BASEMAP_ATTRIBUTION,
    },
    labels: {
      type: 'raster',
      tiles: viaStore(LABEL_TILES),
      tileSize: 256,
      maxzoom: LABEL_MAX_ZOOM,
      attribution: LABEL_ATTRIBUTION,
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0b0e13' } },
    { id: 'basemap', type: 'raster', source: 'basemap', paint: { 'raster-brightness-max': 0.85 } },
    { id: 'labels', type: 'raster', source: 'labels' },
  ],
};

interface Point {
  lat: number;
  lon: number;
  frp: number;
  date: string;
  time: number;
  sensor: string;
  confidence: string;
}

function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

function boundsOf(map: MapLibreMap): Bbox {
  const b = map.getBounds();
  return tidyBounds(b.getWest(), b.getSouth(), b.getEast(), b.getNorth());
}

/** Wraps longitudes into -180..180 (whole world if wider) and clamps latitudes. */
function tidyBounds(west: number, south: number, east: number, north: number): Bbox {
  const clampLat = (v: number) => Math.max(-85, Math.min(85, v));
  let w = west;
  let e = east;
  if (e - w >= 360) {
    w = -180;
    e = 180;
  } else {
    const wrap = (v: number) => ((((v + 180) % 360) + 360) % 360) - 180;
    w = wrap(w);
    e = wrap(e);
  }
  return [w, clampLat(south), e, clampLat(north)];
}

/** What the map will show at a centre and zoom (Web Mercator, no rotation or tilt),
 *  so its data can load before the map gets there. */
function boundsAt(map: MapLibreMap, lng: number, lat: number, zoom: number): Bbox {
  const { clientWidth: width, clientHeight: height } = map.getContainer();
  const size = 512 * 2 ** zoom;
  const x = ((lng + 180) / 360) * size;
  const y = ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * size;
  const lngAt = (px: number) => (px / size) * 360 - 180;
  const latAt = (py: number) => (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * py) / size)) * 180) / Math.PI;
  return tidyBounds(lngAt(x - width / 2), latAt(y + height / 2), lngAt(x + width / 2), latAt(y - height / 2));
}

/** A fixed pseudo-random number in [0, 1) per detection, for even thinning. */
function spread(p: Point): number {
  const x = Math.sin(p.lat * 12.9898 + p.lon * 78.233 + p.time * 0.1234) * 43758.5453;
  return x - Math.floor(x);
}

function toPoints(res: HotspotsResponse | undefined): Point[] {
  const d = res?.data;
  if (!d?.lat) return [];
  return d.lat.map((lat, i) => ({
    lat,
    lon: d.lon[i],
    frp: d.frp_mw[i],
    date: d.date[i],
    time: d.time_utc[i],
    sensor: d.sensor[i],
    confidence: d.confidence[i],
  }));
}

export default function MapView() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const range = useAppStore((s) => s.dateRange);
  const timer = useRef<number | undefined>(undefined);

  const publishView = useCallback(
    (e: MapEvent) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(
        () => setView({ bbox: boundsOf(e.target), zoom: e.target.getZoom() }),
        300,
      );
    },
    [setView],
  );

  const playing = useAppStore((s) => s.playing);

  // Live zoom (not debounced): dots grow smoothly while zooming, and zooming out
  // drops zoomed-in detail at once. Data requests still wait for the map to stop.
  const [zoomNow, setZoomNow] = useState(INITIAL_ZOOM);
  const zoom = Math.min(view?.zoom ?? 0, zoomNow);
  const zoomedOutLive = zoomNow < (view?.zoom ?? 0) - 1;
  const steps = useSteps();
  const win = useSliderWindow();
  const k = useAppStore((s) => s.sliderStep);
  const winKey = win ? `${win.start}/${win.end}` : '';

  const area = useMemo(() => (view ? fetchBbox(view.bbox, view.zoom) : null), [view]);
  // While flying to a picked area, the old view's dots aren't fetched (the
  // destination's are, see the fly-to effect below).
  const flying = useAppStore((s) => s.flying);
  const setFlying = useAppStore((s) => s.setFlying);
  const rangeQuery = useHotspots(area, range, !flying);

  // The range is fetched once. If it came back sampled (zoomed out), the slider's
  // window is fetched on its own once the slider settles: never during playback,
  // and not after pausing either (pause freezes the picture). Picking a window by
  // dragging or with the keyboard loads it.
  const [settled, setSettled] = useState<{ key: string; start: string; end: string } | null>(null);
  useEffect(() => {
    if (playing || !win) return;
    const id = window.setTimeout(() => setSettled({ key: winKey, ...win }), 400);
    return () => window.clearTimeout(id);
  }, [winKey, playing]); // eslint-disable-line react-hooks/exhaustive-deps
  const isSettled = !!settled && settled.key === winKey;
  const frozen = useAppStore((s) => s.frozen);
  const unfreeze = useAppStore((s) => s.unfreeze);
  const areaKey = area?.join(',');
  useEffect(() => {
    unfreeze();
  }, [areaKey, unfreeze]);
  // The slider's window is asked for straight away, alongside the range, so it
  // shows first. Data still on screen from the previous view doesn't count.
  const rangeFresh = !!rangeQuery.data && !rangeQuery.isPlaceholderData;
  const likelySampled = rangeFresh ? rangeQuery.data!.truncated : true;
  const detailed = zoom >= DETAIL_MIN_ZOOM;
  const useWinQuery = detailed && likelySampled && !playing && !frozen && isSettled && !flying;
  const winQuery = useHotspots(area, settled ? { start: settled.start, end: settled.end } : null, useWinQuery, {
    limit: STEP_DOT_CAP,
    keepAnyPrevious: false,
  });
  const fromWinQuery = useWinQuery && winQuery.data?.start === win?.start && winQuery.data?.end === win?.end;

  // All loaded points go to the GPU once; the slider only moves a filter window.
  // Zoomed out well past the loaded area: show the whole-world sample (if loaded)
  // right away instead of the zoomed-in patch, until the new view has loaded.
  const qc = useQueryClient();
  const rangeData =
    zoomedOutLive && range ? qc.getQueryData<HotspotsResponse>(worldHotspotsKey(range)) : rangeQuery.data;
  const rangePoints = useMemo(() => toPoints(rangeData), [rangeData]);
  const winPoints = useMemo(() => toPoints(winQuery.data), [winQuery.data]);
  const stepIndex = useCallback((iso: string) => (steps ? stepOf(steps, iso) : 0), [steps]);
  // 0 for the newest day in its step, up to 1 for the oldest.
  const dayAge = useCallback(
    (iso: string) => {
      if (!steps || steps.size === 1) return 0;
      const back = Math.round((steps.endTime - Date.parse(`${iso}T00:00:00Z`)) / DAY_MS);
      return (back % steps.size) / (steps.size - 1);
    },
    [steps],
  );
  // Steps holding more than STEP_DOT_CAP dots keep an even, fixed share of them.
  const { shownPoints, perStep } = useMemo(() => {
    const perStep: Record<number, number> = {};
    for (const p of rangePoints) perStep[stepIndex(p.date)] = (perStep[stepIndex(p.date)] ?? 0) + 1;
    const shownPoints = rangePoints.filter((p) => {
      const n = perStep[stepIndex(p.date)];
      return n <= STEP_DOT_CAP || spread(p) < STEP_DOT_CAP / n;
    });
    return { shownPoints, perStep };
  }, [rangePoints, stepIndex]);
  const stepCount = perStep[k] ?? 0;
  const stepShown = Math.min(stepCount, STEP_DOT_CAP);
  const frpMax = useMemo(
    () => Math.max(2, ...[rangePoints, winPoints].map((ps) => ps.reduce((m, p) => Math.max(m, p.frp), 0))),
    [rangePoints, winPoints],
  );

  // Cross-fade between the playback sample and the full window instead of swapping.
  const mixTarget = fromWinQuery ? 1 : 0;
  const [mix, setMix] = useState(0);
  const mixRef = useRef(0);
  useEffect(() => {
    const from = mixRef.current;
    if (from === mixTarget) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      mixRef.current = mixTarget;
      setMix(mixTarget);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const f = Math.min(1, (now - t0) / SWAP_FADE_MS);
      mixRef.current = from + (mixTarget - from) * f;
      setMix(mixRef.current);
      if (f < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [mixTarget]);

  // The slider position (fractional while gliding) drives the fade between steps.
  const t = useAppStore((s) => s.sliderPos);

  const dotRadius = Math.min(10, 1.2 + Math.max(0, zoomNow - 1.5) * 0.75);

  const status = useMemo(() => {
    const when = win ? windowPhrase(win) : '';
    const r = rangeQuery.data;
    const winFresh = fromWinQuery && !winQuery.isPlaceholderData;
    if (rangeQuery.isPlaceholderData && !winFresh) return 'Loading hotspots for this view…';
    if (fromWinQuery && winQuery.data) {
      const d = winQuery.data;
      const total = `${d.total_estimated ? 'About ' : ''}${d.total.toLocaleString()}`;
      return d.truncated
        ? `${total} hotspots ${when} · showing ${d.count.toLocaleString()}`
        : `${total} hotspots ${when}`;
    }
    if (!r) return 'Loading hotspots…';
    if (r.truncated) {
      if (playing) return `Hotspots ${when} · a sample while playing`;
      if (frozen || !detailed) return `Hotspots ${when} · a sample · zoom in for every hotspot`;
      return `Hotspots ${when} · loading all of them…`;
    }
    const shown = stepShown < stepCount ? ` · showing about ${stepShown.toLocaleString()}` : '';
    return `${stepCount.toLocaleString()} hotspots ${when}${shown} · ${r.total.toLocaleString()} in the date range`;
  }, [win, rangeQuery.data, rangeQuery.isPlaceholderData, fromWinQuery, winQuery.data, winQuery.isPlaceholderData, playing, frozen, detailed, stepCount, stepShown]);
  const activeQuery = fromWinQuery ? winQuery : rangeQuery;

  const hotspotLayer = (id: string, data: Point[], opacity: number) =>
    new ScatterplotLayer<Point>({
      id,
      data,
      opacity,
      visible: opacity > 0,
      getPosition: (p) => [p.lon, p.lat],
      getRadius: (p) => (p.sensor === 'MODIS_AQUA' ? 1.3 : 1),
      radiusUnits: 'pixels',
      radiusScale: dotRadius,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 230],
      // Within a multi-day step, older days fade so the newest fires stand out.
      getFillColor: (p) => viridis(0.35 + 0.65 * logScale(p.frp + 1, frpMax + 1), 255 - Math.round(150 * dayAge(p.date))),
      pickable: true,
      extensions: [DAY_FILTER],
      getFilterValue: (p) => stepIndex(p.date),
      filterRange: [t - 1, t + 1],
      filterSoftRange: [t - 0.5, t + 0.5],
      updateTriggers: { getFillColor: [frpMax, dayAge], getFilterValue: [stepIndex] },
    });

  // Approximate recently burned area: cells with a detection in the
  // OUTLINE_WINDOW_DAYS up to the end of the slider's window. Built from the
  // loaded dots when they're all there (works while playing); otherwise asked for
  // just those days once the slider settles, without waiting for the dots.
  const outlinesWanted = zoom >= OUTLINE_MIN_ZOOM;
  const dotsComplete = rangeFresh && !rangeQuery.data!.truncated;
  const outlineSpan = useMemo(() => {
    if (!win || !range) return null;
    const start = addDays(win.end, -(OUTLINE_WINDOW_DAYS - 1));
    return { start: start < range.start ? range.start : start, end: win.end };
  }, [win, range]);
  const burnedQuery = useBurned(
    area,
    isSettled ? outlineSpan : null,
    outlinesWanted && !dotsComplete && !playing && isSettled,
  );
  const startMs = range ? Date.parse(`${range.start}T00:00:00Z`) : 0;
  const dayIndex = useCallback((iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - startMs) / DAY_MS), [startMs]);
  const pointCells = useMemo(
    () =>
      outlinesWanted && dotsComplete
        ? rangePoints.map((p) => ({ cell: latLngToCell(p.lat, p.lon, 7), d: dayIndex(p.date) }))
        : [],
    [outlinesWanted, dotsComplete, rangePoints, dayIndex],
  );
  const outlines = useMemo(() => {
    if (!outlinesWanted || !outlineSpan) return [];
    let cells: string[] = [];
    if (dotsComplete) {
      const from = dayIndex(outlineSpan.start);
      const to = dayIndex(outlineSpan.end);
      cells = [...new Set(pointCells.filter((c) => c.d >= from && c.d <= to).map((c) => c.cell))];
    } else {
      const b = burnedQuery.data;
      if (!b || b.start !== outlineSpan.start || b.end !== outlineSpan.end) return [];
      cells = b.cells;
    }
    return cells.length ? cellsToMultiPolygon(cells, true).map((polygon) => ({ polygon })) : [];
  }, [outlinesWanted, outlineSpan, dotsComplete, pointCells, dayIndex, burnedQuery.data]);

  const outlineLayer = new PolygonLayer<{ polygon: number[][][] }>({
    id: 'fire-outlines',
    data: outlines,
    getPolygon: (o) => o.polygon,
    filled: true,
    getFillColor: [255, 122, 26, 35],
    stroked: true,
    getLineColor: [255, 154, 77, 230],
    lineWidthUnits: 'pixels',
    getLineWidth: 1.5,
  });

  // Area selection: drag a rectangle while the tool is on; the picked area is outlined.
  const mapRef = useRef<MapRef>(null);

  // Browser zoom (Ctrl/Cmd +/-) changes the device pixel ratio; zoom the map the
  // other way so it keeps showing the same part of the world.
  useEffect(() => {
    let dpr = window.devicePixelRatio;
    let query: MediaQueryList;
    const onChange = () => {
      const next = window.devicePixelRatio;
      const map = mapRef.current;
      if (map && next !== dpr) map.setZoom(map.getZoom() - Math.log2(next / dpr));
      dpr = next;
      watch();
    };
    const watch = () => {
      query?.removeEventListener('change', onChange);
      query = window.matchMedia(`(resolution: ${dpr}dppx)`);
      query.addEventListener('change', onChange);
    };
    watch();
    return () => query.removeEventListener('change', onChange);
  }, []);
  const selectedArea = useAppStore((s) => s.area);
  const areaTool = useAppStore((s) => s.areaTool);
  const setArea = useAppStore((s) => s.setArea);
  const drawStart = useRef<{ lng: number; lat: number; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Bbox | null>(null);
  const drawing = areaTool === 'rectangle';
  useEffect(() => {
    if (!drawing) {
      drawStart.current = null;
      setDraft(null);
    }
  }, [drawing]);
  const boxFrom = (a: { lng: number; lat: number }, b: { lng: number; lat: number }): Bbox => [
    Math.max(-180, Math.min(a.lng, b.lng)),
    Math.max(-85, Math.min(a.lat, b.lat)),
    Math.min(180, Math.max(a.lng, b.lng)),
    Math.min(85, Math.max(a.lat, b.lat)),
  ];
  const onDrawStart = (e: MapLayerMouseEvent | MapLayerTouchEvent) => {
    if (!drawing) return;
    drawStart.current = { lng: e.lngLat.lng, lat: e.lngLat.lat, x: e.point.x, y: e.point.y };
  };
  const onDrawMove = (e: MapLayerMouseEvent | MapLayerTouchEvent) => {
    if (drawing && drawStart.current) setDraft(boxFrom(drawStart.current, e.lngLat));
  };
  const onDrawEnd = (e: MapLayerMouseEvent | MapLayerTouchEvent) => {
    const start = drawStart.current;
    if (!drawing || !start) return;
    drawStart.current = null;
    setDraft(null);
    // A click, not a drag: keep the tool on.
    if (Math.hypot(e.point.x - start.x, e.point.y - start.y) < 8) return;
    const bbox = boxFrom(start, e.lngLat);
    setArea({ bbox, source: 'rectangle', label: describeBbox(bbox) });
  };

  // Typed-in coordinates and featured fires: bring the area into view. The dots for
  // where the map will land start loading first, so they're there on arrival.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!selectedArea || selectedArea.source === 'rectangle') return;
    if (!map) {
      setFlying(false);
      return;
    }
    const [w, s, e, n] = selectedArea.bbox;
    const fit = { padding: 80 };
    const camera = map.cameraForBounds([[w, s], [e, n]], fit);
    const { dateRange, sliderStep } = useAppStore.getState();
    if (camera?.center && camera.zoom != null && dateRange) {
      const c = LngLat.convert(camera.center);
      const area = fetchBbox(boundsAt(map, c.lng, c.lat, camera.zoom), camera.zoom);
      // The map imagery and labels where it will land, and the dots.
      const view = boundsAt(map, c.lng, c.lat, camera.zoom);
      prefetchTiles(BASEMAP_TILES[0], BASEMAP_MAX_ZOOM, view, camera.zoom);
      prefetchTiles(LABEL_TILES[0], LABEL_MAX_ZOOM, view, camera.zoom);
      prefetchHotspots(qc, area, dateRange);
      if (camera.zoom >= DETAIL_MIN_ZOOM) {
        prefetchHotspots(qc, area, stepWindow(stepsFor(dateRange), sliderStep), STEP_DOT_CAP);
      }
    }
    const instant = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // On landing, report the new view at once (not after the usual pause), so the
    // old view's data is never asked for.
    const landed = () => {
      setView({ bbox: boundsOf(map), zoom: map.getZoom() });
      setFlying(false);
    };
    map.once('moveend', landed);
    const safety = window.setTimeout(landed, 3000);
    map.fitBounds([[w, s], [e, n]], { ...fit, duration: instant ? 0 : 900 });
    return () => window.clearTimeout(safety);
  }, [selectedArea]); // eslint-disable-line react-hooks/exhaustive-deps

  const shownArea = draft ?? selectedArea?.bbox ?? null;
  const areaLayer = new PolygonLayer<{ polygon: number[][] }>({
    id: 'selected-area',
    data: shownArea
      ? [{ polygon: [[shownArea[0], shownArea[1]], [shownArea[2], shownArea[1]], [shownArea[2], shownArea[3]], [shownArea[0], shownArea[3]]] }]
      : [],
    getPolygon: (o) => o.polygon,
    filled: true,
    getFillColor: [255, 255, 255, draft ? 30 : 12],
    stroked: true,
    getLineColor: [255, 255, 255, 230],
    lineWidthUnits: 'pixels',
    getLineWidth: 2,
    updateTriggers: { getFillColor: [!!draft] },
  });

  const layers = [
    outlineLayer,
    areaLayer,
    hotspotLayer('hotspots-range', shownPoints, 1 - mix),
    hotspotLayer('hotspots-window', winPoints, mix),
  ];

  const getTooltip = useCallback(({ object }: PickingInfo) => {
    if (!object) return null;
    const p = object as Point;
    const time = String(p.time).padStart(4, '0');
    return `${p.date} ${time.slice(0, 2)}:${time.slice(2)} UTC\nFRP ${p.frp} MW\n${p.sensor.replace('_', ' ')}, confidence ${p.confidence}\nObserved detection`;
  }, []);

  const outlineNote = (() => {
    if (!outlinesWanted) return 'Zoom in to see fire outlines';
    if (burnedQuery.error) return 'Zoom in further to see fire outlines';
    if (outlines.length > 0 && outlineSpan)
      return `Outlined: area with fire detected ${windowPhrase(outlineSpan)} (approx., ~5 km² cells)`;
    if (!dotsComplete && playing) return 'Fire outlines update when paused';
    if (burnedQuery.isFetching || (!dotsComplete && !isSettled)) return 'Loading fire outlines…';
    return null;
  })();

  return (
    <div className="map-wrap">
      <Map
        ref={mapRef}
        dragRotate={false}
        pitchWithRotate={false}
        touchPitch={false}
        maxPitch={0}
        dragPan={!drawing}
        cursor={drawing ? 'crosshair' : undefined}
        onMouseDown={onDrawStart}
        onMouseMove={onDrawMove}
        onMouseUp={onDrawEnd}
        onTouchStart={onDrawStart}
        onTouchMove={onDrawMove}
        onTouchEnd={onDrawEnd}
        initialViewState={{ longitude: 20, latitude: 10, zoom: INITIAL_ZOOM }}
        mapStyle={BASE_STYLE}
        minZoom={1}
        maxZoom={12}
        renderWorldCopies={false}
        attributionControl={false}
        onLoad={(e) => {
          // Two-finger twist on touchscreens would rotate the map; north stays up.
          e.target.touchZoomRotate.disableRotation();
          e.target.keyboard.disableRotation();
          publishView(e);
        }}
        onMoveEnd={publishView}
        onMove={(e) => setZoomNow((z) => (Math.abs(z - e.viewState.zoom) >= 0.1 ? e.viewState.zoom : z))}
      >
        <DeckOverlay layers={layers} getTooltip={getTooltip} pickingRadius={5} />
        <NavigationControl position="bottom-right" showCompass={false} />
        <AttributionControl position="bottom-right" compact />
      </Map>
      <MapStatus
        message={status}
        showLegend={stepCount > 0 || fromWinQuery}
        frpMax={frpMax}
        fetching={rangeQuery.isFetching || (useWinQuery && winQuery.isFetching)}
        error={activeQuery.error as Error | null}
        notes={activeQuery.data?.notes.slice(1) ?? []}
        outlineNote={outlineNote}
      />
    </div>
  );
}
