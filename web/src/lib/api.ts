import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Bbox, DateRange } from '../types';

const BASE = import.meta.env.PUBLIC_API_URL ?? '';

type Params = Record<string, string | number | undefined>;

function apiUrl(path: string, params: Params) {
  const url = new URL(`${BASE}/api${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url;
}

async function failure(res: Response): Promise<Error> {
  const body = await res.json().catch(() => null);
  return new Error(body?.detail ?? `Request failed (${res.status})`);
}

async function getJson<T>(path: string, params: Params = {}, signal?: AbortSignal): Promise<T> {
  const res = await fetch(apiUrl(path, params), { signal });
  if (!res.ok) throw await failure(res);
  return res.json() as Promise<T>;
}

/**
 * Starts a browser download of a streamed, possibly very large file: it saves
 * straight to disk with the browser's own progress bar. Resolves once the server
 * has started sending it (it echoes `token` back in a cookie), or after a timeout.
 */
export function startDownload(path: string, params: Params, timeoutMs = 120_000): Promise<void> {
  const token = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  const a = document.createElement('a');
  a.href = apiUrl(path, { ...params, token }).toString();
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
  return new Promise((resolve) => {
    const t0 = Date.now();
    const id = window.setInterval(() => {
      if (document.cookie.includes(`embereye_download=${token}`) || Date.now() - t0 > timeoutMs) {
        window.clearInterval(id);
        document.cookie = 'embereye_download=; Path=/; Max-Age=0';
        resolve();
      }
    }, 250);
  });
}

/** Fetches a file from the API and saves it under the name the API gives it.
 *  Errors (e.g. too many hotspots) are thrown with the API's message instead of
 *  being saved as a file. */
export async function downloadFile(path: string, params: Params) {
  const res = await fetch(apiUrl(path, params));
  if (!res.ok) throw await failure(res);
  const blob = await res.blob();
  saveBlob(blob, /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'embereye.csv');
}

/** Saves a file made in the browser (chart images, chart data). */
export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** CSV text from a header and rows (quotes values that need it). */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

export const bboxParam = (b: Bbox) => b.map((v) => v.toFixed(2)).join(',');

const WORLD: Bbox = [-180, -85, 180, 85];

/** The cache key of the whole-world points for a date range (as useHotspots uses). */
export const worldHotspotsKey = (range: DateRange, limit = 50_000) =>
  ['hotspots', bboxParam(WORLD), range.start, range.end, limit] as const;

/**
 * The area to fetch for a map view: bigger than what's visible and snapped to a
 * zoom-dependent grid, so panning and zooming within it reuse the same request.
 * Zoomed out, that's the whole world.
 */
export function fetchBbox([w, s, e, n]: Bbox, zoom: number): Bbox {
  if (zoom < 3 || w > e) return WORLD;
  const step = Math.max(0.5, 180 / 2 ** Math.floor(zoom));
  const padX = (e - w) * 0.5;
  const padY = (n - s) * 0.5;
  const down = (v: number) => Math.floor(v / step) * step;
  const up = (v: number) => Math.ceil(v / step) * step;
  return [
    Math.max(-180, down(w - padX)),
    Math.max(-85, down(s - padY)),
    Math.min(180, up(e + padX)),
    Math.min(85, up(n + padY)),
  ];
}

export interface Health {
  coverage: { first: string; last: string };
}

export interface HotspotsResponse {
  start: string;
  end: string;
  source: 'r2' | 'demo-regions';
  complete: boolean;
  notes: string[];
  count: number;
  total: number;
  /** total is estimated from a sample (big areas or ranges). */
  total_estimated: boolean;
  truncated: boolean;
  data: {
    date: string[];
    time_utc: number[];
    lat: number[];
    lon: number[];
    frp_mw: number[];
    confidence: string[];
    sensor: string[];
    daynight: string[];
  };
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => getJson<Health>('/health'),
    staleTime: Infinity,
  });
}

const contains = (outer: string, inner: string) => {
  const [ow, os, oe, on] = outer.split(',').map(Number);
  const [iw, is, ie, inn] = inner.split(',').map(Number);
  return ow <= iw && os <= is && oe >= ie && on >= inn;
};

const sizeOf = (bbox: string) => {
  const [w, s, e, n] = bbox.split(',').map(Number);
  return (e - w) * (n - s);
};

/**
 * While a new view loads, show what's already there: the previous data if it
 * covers the new view (zooming in, small pans), else the whole-world data for
 * the same dates if it was loaded before. `keepAnyPrevious` also keeps the
 * previous data when panning, but never when zooming out (it would leave the
 * zoomed-in detail in one small patch).
 */
export function useHotspots(
  bbox: Bbox | null,
  range: DateRange | null,
  enabled: boolean,
  { limit = 50_000, keepAnyPrevious = true } = {},
) {
  const qc = useQueryClient();
  const b = bbox ? bboxParam(bbox) : '';
  return useQuery<HotspotsResponse>({
    queryKey: ['hotspots', b, range?.start, range?.end, limit],
    placeholderData: (prev, prevQuery) => {
      const prevBbox = prevQuery?.queryKey[1] as string | undefined;
      if (prev && prevBbox && b && contains(prevBbox, b)) return prev;
      const world = range ? qc.getQueryData<HotspotsResponse>(worldHotspotsKey(range, limit)) : undefined;
      const zoomingOut = !!prevBbox && !!b && sizeOf(b) > 1.5 * sizeOf(prevBbox);
      return world ?? (keepAnyPrevious && !zoomingOut ? prev : undefined);
    },
    // The signal cancels the request once it's no longer wanted (dates or view changed).
    queryFn: ({ signal }) => getJson<HotspotsResponse>('/hotspots', { bbox: b, limit, ...range }, signal),
    enabled: enabled && !!bbox && !!range,
    staleTime: 10 * 60_000,
  });
}

/** Starts loading the dots for a view the map is about to show (e.g. while it
 *  flies there), into the same cache useHotspots reads. */
export function prefetchHotspots(qc: QueryClient, bbox: Bbox, range: DateRange, limit = 50_000) {
  const b = bboxParam(bbox);
  return qc.prefetchQuery({
    queryKey: ['hotspots', b, range.start, range.end, limit],
    queryFn: ({ signal }) => getJson<HotspotsResponse>('/hotspots', { bbox: b, limit, ...range }, signal),
    staleTime: 10 * 60_000,
  });
}

export interface CalendarPeriod {
  /** YYYY-MM-DD (day level) or YYYY-MM (month level). */
  period: string;
  /** Harmonized fire cell-days (VIIRS S-NPP equivalent). */
  fire_days: number;
  detections: number;
  frp_mw: number;
  median: number | null;
  mean: number | null;
  ratio_to_median: number | null;
  anomaly_pct: number | null;
}

export interface CalendarResponse {
  level: 'day' | 'month';
  start: string;
  end: string;
  notes?: string[];
  data: CalendarPeriod[];
}

export function useCalendar(bbox: Bbox | null, range: DateRange | null, level: 'day' | 'month') {
  const b = bbox ? bboxParam(bbox) : '';
  return useQuery({
    queryKey: ['calendar', b, range?.start, range?.end, level],
    queryFn: ({ signal }) => getJson<CalendarResponse>('/calendar', { bbox: b, level, ...range }, signal),
    enabled: !!bbox && !!range,
    placeholderData: keepPreviousData,
    staleTime: 10 * 60_000,
  });
}

export interface WeatherMonth {
  month: string;
  t2m: number | null;
  rh: number | null;
  wind_ms: number | null;
  wind_from_deg: number | null;
  soil: number | null;
  fwi: number | null;
}

export interface StatsResponse {
  start: string;
  end: string;
  area: { cells_res5: number; centre: [number, number] | null };
  weather: WeatherMonth[];
  landcover: { shares: Record<string, number | null>; basis: string } | null;
  /** The latest month with MERRA-2 weather, and with FWI (up to a year before the range end). */
  latest: { weather: WeatherMonth | null; fwi: WeatherMonth | null };
}

export function useAreaStats(bbox: Bbox | null, range: DateRange | null) {
  const b = bbox ? bboxParam(bbox) : '';
  return useQuery({
    queryKey: ['stats', b, range?.start, range?.end],
    queryFn: ({ signal }) => getJson<StatsResponse>('/stats', { bbox: b, ...range }, signal),
    enabled: !!bbox && !!range,
    placeholderData: keepPreviousData,
    staleTime: 10 * 60_000,
  });
}

export interface ExportEstimate {
  hotspots: number;
  /** false: estimated from a sample (big searches). */
  exact: boolean;
  bytes: number;
}

export function useExportEstimate(bbox: Bbox | null, range: DateRange | null, enabled: boolean) {
  const b = bbox ? bboxParam(bbox) : '';
  return useQuery({
    queryKey: ['export-estimate', b, range?.start, range?.end],
    queryFn: ({ signal }) => getJson<ExportEstimate>('/export-estimate', { bbox: b, ...range }, signal),
    enabled: enabled && !!bbox && !!range,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

export interface BurnedResponse {
  start: string;
  end: string;
  res: 7;
  complete: boolean;
  count: number;
  cells: string[];
  /** Days after `start` that each cell first had a detection. */
  first_day: number[];
}

export function useBurned(bbox: Bbox | null, range: DateRange | null, enabled: boolean) {
  const b = bbox ? bboxParam(bbox) : '';
  return useQuery({
    queryKey: ['burned', b, range?.start, range?.end],
    queryFn: ({ signal }) => getJson<BurnedResponse>('/burned', { bbox: b, ...range }, signal),
    enabled: enabled && !!bbox && !!range,
    placeholderData: keepPreviousData,
    staleTime: 10 * 60_000,
    retry: false,
  });
}
