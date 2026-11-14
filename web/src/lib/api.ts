import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { Bbox, DateRange } from '../types';

const BASE = import.meta.env.PUBLIC_API_URL ?? '';

type Params = Record<string, string | number | undefined>;

async function getJson<T>(path: string, params: Params = {}): Promise<T> {
  const url = new URL(`${BASE}/api${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
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

export function useHotspots(bbox: Bbox | null, range: DateRange | null, enabled: boolean) {
  const b = bbox ? bboxParam(bbox) : '';
  return useQuery({
    queryKey: ['hotspots', b, range?.start, range?.end],
    queryFn: () => getJson<HotspotsResponse>('/hotspots', { bbox: b, limit: 50_000, ...range }),
    enabled: enabled && !!bbox && !!range,
    placeholderData: keepPreviousData,
    staleTime: 10 * 60_000,
  });
}
