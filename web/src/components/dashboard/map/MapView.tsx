import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map, { AttributionControl, NavigationControl, useControl, type MapEvent } from 'react-map-gl/maplibre';
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox';
import { ScatterplotLayer } from '@deck.gl/layers';
import { DataFilterExtension } from '@deck.gl/extensions';
import type { PickingInfo } from '@deck.gl/core';
import { setWorkerUrl, type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';

import { useAppStore } from '../../../store/useAppStore';
import { fetchBbox, useHotspots, type HotspotsResponse } from '../../../lib/api';
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

const MAX_POINT_DAYS = 366;
const INITIAL_ZOOM = 1.6;
const DAY_MS = 86_400_000;
const SWAP_FADE_MS = 450;
const DAY_FILTER = new DataFilterExtension({ filterSize: 1 });

// MapLibre finds its worker relative to its own file, which breaks once bundled.
setWorkerUrl(maplibreWorkerUrl);

const BASE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: 'raster',
      tiles: BASEMAP_TILES,
      tileSize: 256,
      maxzoom: BASEMAP_MAX_ZOOM,
      attribution: BASEMAP_ATTRIBUTION,
    },
    labels: {
      type: 'raster',
      tiles: LABEL_TILES,
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
  const clampLat = (v: number) => Math.max(-85, Math.min(85, v));
  let w = b.getWest();
  let e = b.getEast();
  if (e - w >= 360) {
    w = -180;
    e = 180;
  } else {
    const wrap = (v: number) => ((((v + 180) % 360) + 360) % 360) - 180;
    w = wrap(w);
    e = wrap(e);
  }
  return [w, clampLat(b.getSouth()), e, clampLat(b.getNorth())];
}

const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000 + 1;

const formatDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

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

  const day = useAppStore((s) => s.sliderDate);
  const playing = useAppStore((s) => s.playing);

  const rangeDays = range ? daysBetween(range.start, range.end) : 0;
  const rangeOk = rangeDays <= MAX_POINT_DAYS;
  const area = useMemo(() => (view ? fetchBbox(view.bbox, view.zoom) : null), [view]);
  const rangeQuery = useHotspots(area, range, rangeOk);

  // The range is fetched once. If it came back sampled (zoomed out), the slider's
  // day is fetched on its own once the slider settles: never during playback, and
  // not after pausing either (pause freezes the picture). Picking a day by
  // dragging or with the keyboard loads it.
  const [settledDay, setSettledDay] = useState<string | null>(null);
  useEffect(() => {
    if (playing || !day) return;
    const id = window.setTimeout(() => setSettledDay(day), 400);
    return () => window.clearTimeout(id);
  }, [day, playing]);
  const frozen = useAppStore((s) => s.frozen);
  // Zoomed out the range is almost always sampled, so ask for the day in parallel
  // instead of waiting for the range to say so.
  const likelySampled = rangeQuery.data ? rangeQuery.data.truncated : (view?.zoom ?? 0) < 5;
  const useDayQuery = likelySampled && !playing && !frozen && settledDay === day;
  const dayQuery = useHotspots(area, settledDay ? { start: settledDay, end: settledDay } : null, useDayQuery);
  const fromDayQuery = useDayQuery && dayQuery.data?.start === day;

  // All loaded points go to the GPU once; the slider only moves a filter window.
  const rangePoints = useMemo(() => toPoints(rangeQuery.data), [rangeQuery.data]);
  const dayPoints = useMemo(() => toPoints(dayQuery.data), [dayQuery.data]);
  const dayCount = useMemo(
    () => rangePoints.reduce((n, p) => n + (p.date === day ? 1 : 0), 0),
    [rangePoints, day],
  );
  const frpMax = useMemo(
    () => Math.max(2, ...[rangePoints, dayPoints].map((ps) => ps.reduce((m, p) => Math.max(m, p.frp), 0))),
    [rangePoints, dayPoints],
  );

  // Cross-fade between the playback sample and the full day instead of swapping.
  const mixTarget = fromDayQuery ? 1 : 0;
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
      const k = Math.min(1, (now - t0) / SWAP_FADE_MS);
      mixRef.current = from + (mixTarget - from) * k;
      setMix(mixRef.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [mixTarget]);

  const startMs = range ? Date.parse(`${range.start}T00:00:00Z`) : 0;
  const dayIndex = useCallback((iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - startMs) / DAY_MS), [startMs]);

  // The slider position (fractional while gliding) drives the fade between days.
  const t = useAppStore((s) => s.sliderPos);

  // Live zoom (not debounced) so dots grow smoothly while zooming.
  const [zoomNow, setZoomNow] = useState(INITIAL_ZOOM);
  const dotRadius = Math.min(10, 2 + Math.max(0, zoomNow - 3) * 0.9);

  const status = useMemo(() => {
    const label = day ? formatDay(day) : '';
    const r = rangeQuery.data;
    if (!rangeOk) return 'Choose a date range of a year or less to see hotspots on the map';
    if (fromDayQuery && dayQuery.data) {
      const d = dayQuery.data;
      return d.truncated
        ? `${d.total.toLocaleString()} hotspots on ${label} · showing a sample of ${d.count.toLocaleString()}, zoom in for all`
        : `${d.total.toLocaleString()} hotspots on ${label}`;
    }
    if (!r) return 'Loading hotspots…';
    if (r.truncated) {
      if (playing) return `Hotspots on ${label} · a sample while playing`;
      if (frozen) return `Hotspots on ${label} · a sample (paused) · drag the slider or zoom in for every hotspot`;
      return `Hotspots on ${label} · loading the full day…`;
    }
    return `${dayCount.toLocaleString()} hotspots on ${label} · ${r.total.toLocaleString()} in the date range`;
  }, [day, rangeOk, rangeQuery.data, fromDayQuery, dayQuery.data, playing, frozen, dayCount]);
  const activeQuery = fromDayQuery ? dayQuery : rangeQuery;

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
      getFillColor: (p) => viridis(0.35 + 0.65 * logScale(p.frp + 1, frpMax + 1)),
      pickable: true,
      extensions: [DAY_FILTER],
      getFilterValue: (p) => dayIndex(p.date),
      filterRange: [t - 1, t + 1],
      filterSoftRange: [t - 0.5, t + 0.5],
      updateTriggers: { getFillColor: [frpMax], getFilterValue: [startMs] },
    });
  const layers = [hotspotLayer('hotspots-range', rangePoints, 1 - mix), hotspotLayer('hotspots-day', dayPoints, mix)];

  const getTooltip = useCallback(({ object }: PickingInfo) => {
    if (!object) return null;
    const p = object as Point;
    const t = String(p.time).padStart(4, '0');
    return `${p.date} ${t.slice(0, 2)}:${t.slice(2)} UTC\nFRP ${p.frp} MW\n${p.sensor.replace('_', ' ')}, confidence ${p.confidence}\nObserved detection`;
  }, []);

  return (
    <div className="map-wrap">
      <Map
        initialViewState={{ longitude: 20, latitude: 10, zoom: INITIAL_ZOOM }}
        mapStyle={BASE_STYLE}
        minZoom={1}
        maxZoom={12}
        renderWorldCopies={false}
        attributionControl={false}
        onLoad={publishView}
        onMoveEnd={publishView}
        onMove={(e) => setZoomNow((z) => (Math.abs(z - e.viewState.zoom) >= 0.1 ? e.viewState.zoom : z))}
      >
        <DeckOverlay layers={layers} getTooltip={getTooltip} pickingRadius={5} />
        <NavigationControl position="bottom-right" showCompass={false} />
        <AttributionControl position="bottom-right" compact />
      </Map>
      <MapStatus
        message={status}
        showLegend={dayCount > 0 || fromDayQuery}
        frpMax={frpMax}
        fetching={rangeQuery.isFetching || (useDayQuery && dayQuery.isFetching)}
        error={activeQuery.error as Error | null}
        notes={activeQuery.data?.notes.slice(1) ?? []}
      />
    </div>
  );
}
