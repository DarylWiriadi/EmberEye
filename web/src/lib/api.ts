import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Bbox, DateRange } from '../types';

const BASE = import.meta.env.PUBLIC_API_URL ?? '';

type Params = Record<string, string | number | undefined>;

async function getJson<T>(path: string, params: Params = {}, signal?: AbortSignal): Promise<T> {
  const url = new URL(`${BASE}/api${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const bboxParam = (b: Bbox) => b.map((v) => v.toFixed(2)).join(',');

const WORLD: Bbox = [-180, -85, 180, 85];

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

/**
 * While a new view loads, show what's already there: the previous data if it
 * covers the new view (zooming in, small pans), else the whole-world data for
 * the same dates if it was loaded before (zooming out). `keepAnyPrevious` falls
 * back to the previous data even if it covers less.
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
      const world = qc.getQueryData<HotspotsResponse>(['hotspots', bboxParam(WORLD), range?.start, range?.end, limit]);
      return world ?? (keepAnyPrevious ? prev : undefined);
    },
    // The signal cancels the request once it's no longer wanted (dates or view changed).
    queryFn: ({ signal }) => getJson<HotspotsResponse>('/hotspots', { bbox: b, limit, ...range }, signal),
    enabled: enabled && !!bbox && !!range,
    staleTime: 10 * 60_000,
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
