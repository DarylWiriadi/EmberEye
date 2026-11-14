import { addProtocol } from 'maplibre-gl';
import type { Bbox } from '../types';

/**
 * Basemap and label tiles go through a small in-memory store. NASA GIBS marks its
 * tiles as not cacheable, so the browser would download them again on every pan
 * back; and it lets the tiles for a place load before the map flies there.
 * Tile URLs use `gibs://…` instead of `https://…` to go through it.
 */
const MAX_TILES = 600;
const store = new Map<string, Promise<ArrayBuffer>>();

function load(url: string): Promise<ArrayBuffer> {
  const hit = store.get(url);
  if (hit) {
    store.delete(url); // most recently used goes to the end
    store.set(url, hit);
    return hit;
  }
  const p = fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Tile request failed (${r.status})`);
    return r.arrayBuffer();
  });
  p.catch(() => store.delete(url));
  store.set(url, p);
  if (store.size > MAX_TILES) store.delete(store.keys().next().value!);
  return p;
}

addProtocol('gibs', async (params) => ({ data: await load(params.url.replace(/^gibs:\/\//, 'https://')) }));

/** The same tile templates, loaded through the store. */
export const viaStore = (templates: string[]) => templates.map((t) => t.replace(/^https:\/\//, 'gibs://'));

/** Starts loading the tiles a raster source will need for a view (map zoom `zoom`,
 *  256 px tiles, so tile zoom = round(zoom + 1), capped at the source's max). */
export function prefetchTiles(template: string, maxZoom: number, [w, s, e, n]: Bbox, zoom: number) {
  const z = Math.max(0, Math.min(maxZoom, Math.round(zoom + 1)));
  const count = 2 ** z;
  const tx = (lng: number) => Math.min(count - 1, Math.max(0, Math.floor(((lng + 180) / 360) * count)));
  const ty = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * count;
    return Math.min(count - 1, Math.max(0, Math.floor(y)));
  };
  const [x0, x1] = w <= e ? [tx(w), tx(e)] : [0, count - 1];
  const [y0, y1] = [ty(n), ty(s)];
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 120) return; // a huge view: not worth it
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      load(template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
    }
  }
}
