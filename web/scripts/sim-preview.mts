/**
 * Bakes the home page's fire-spread preview (src/components/home/SimPreview.astro).
 *
 * Runs the dashboard's own model (src/workers/simulation) once, with fixed inputs
 * and seed, on the input tiles served by the live API, and saves:
 *   src/data/sim-preview.json            when each cell caught fire and burnt out,
 *                                         hourly area, labels, dashboard link
 *   src/assets/sim-preview-terrain.webp  background: relief, water, towns, major roads
 *   src/assets/sim-preview-final.webp    the fire after 24 h (shown without JavaScript)
 * Same inputs + seed = the same fire as the dashboard, so the panel can link to it.
 * Re-run after the model or its inputs change.
 *
 * Usage, from web/ (Node 22.18 or newer, which runs TypeScript directly; images
 * are written with sharp, which comes with Astro):
 *   node scripts/sim-preview.mts [--site https://embereye-chi.vercel.app] [--tiles <dir>]
 * --tiles reads <south>_<west>.bin files from a folder instead of the API.
 */
import { register } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// The dashboard's files import each other without extensions (fine for Vite);
// let Node resolve './tiles' to './tiles.ts' too.
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function resolve(spec, ctx, next) {
      try { return await next(spec, ctx); }
      catch (err) { if (/^\\.\\.?\\//.test(spec) && !/\\.[cm]?[jt]s$/.test(spec)) return next(spec + '.ts', ctx); throw err; }
    }`),
);

// ---------------------------------------------------------------- Scenario
// A severe day in the Blue Mountains: Jamison Valley, just south of Katoomba,
// strong north-westerly, extreme dryness (Black Summer conditions).
const SCENARIO = { lat: -33.76, lon: 150.28, hours: 24 as const, windFromDeg: 315, windKmh: 45, fwi: 55, seed: 2019 };
const PLACE = 'Blue Mountains, NSW';
const GRID = 512; // the dashboard's grid for a 24 h run (simulation.worker.ts)
// Space around the burnt area, share of the panel: more at the bottom, where
// the panel's readout sits over the map
const MARGIN = { x: 0.08, top: 0.12, bottom: 0.22 };
const TERRAIN_PX = 1152; // square background image, px
const TOWNS = [
  { name: 'Katoomba', lat: -33.714, lon: 150.311 },
  { name: 'Penrith', lat: -33.751, lon: 150.694 },
  { name: 'Camden', lat: -34.054, lon: 150.696 },
];

// ---------------------------------------------------------------- Options
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const SITE = arg('--site') ?? 'https://embereye-chi.vercel.app';
const TILES = arg('--tiles');
const WEB = new URL('../', import.meta.url);

// tiles.ts fetches from self.location.origin (it normally runs in a Worker)
(globalThis as any).self = { location: { origin: SITE } };
if (TILES) {
  const apiFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const m = String(input).match(/sim-tile\/(-?\d+)\/(-?\d+)/);
    if (!m) return apiFetch(input, init);
    const file = `${TILES}/${m[1]}_${m[2]}.bin`;
    return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 });
  }) as typeof fetch;
}

const { loadDomain } = await import('../src/workers/simulation/tiles.ts');
const { simulate, NEVER, STEPS_PER_HOUR } = await import('../src/workers/simulation/model.ts');

// ---------------------------------------------------------------- Run
const domain = await loadDomain(SCENARIO.lat, SCENARIO.lon, GRID);
const result = simulate(domain, SCENARIO);
const N = result.size;
if (result.unburnable || result.hitEdge) throw new Error('Pick another ignition: it cannot burn, or the fire reached the grid edge.');

// Square crop around the burnt area. Cells are taller than wide on screen
// (1 / cos(latitude), as on the dashboard's map), so the crop has more columns
// than rows and is shown stretched to a square.
const aspect = 1 / Math.cos((SCENARIO.lat * Math.PI) / 180);
let r0 = N, r1 = -1, c0 = N, c1 = -1;
for (let i = 0; i < N * N; i++) {
  if (result.ignited[i] === NEVER) continue;
  const r = (i / N) | 0, c = i % N;
  r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c);
}
const side = Math.max((c1 - c0 + 1) / (1 - 2 * MARGIN.x), ((r1 - r0 + 1) * aspect) / (1 - MARGIN.top - MARGIN.bottom)); // in columns
const cols = Math.round(side);
const rows = Math.round(side / aspect);
const top = r0 - Math.round(((rows - (r1 - r0 + 1)) * MARGIN.top) / (MARGIN.top + MARGIN.bottom));
const left = Math.round((c0 + c1) / 2 - cols / 2);
const deg = 1 / 240; // cell size in degrees (tiles.ts RES)
const north = result.north - top * deg, south = north - rows * deg;
const west = result.west + left * deg, east = west + cols * deg;
const pos = (lat: number, lon: number) => ({
  x: +(((lon - west) / (east - west)) * 100).toFixed(2),
  y: +(((north - lat) / (north - south)) * 100).toFixed(2),
});
const at = <T,>(arr: ArrayLike<T>, r: number, c: number) => arr[(top + r) * N + (left + c)];

// Burnt cells, in crop order: index deltas, ignition step, steps burning
const idx: number[] = [], ig: number[] = [], dur: number[] = [];
let prev = 0;
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const t = at(result.ignited, r, c);
    if (t === NEVER) continue;
    const i = r * cols + c;
    idx.push(i - prev); prev = i;
    ig.push(t);
    dur.push(at(result.burntOut, r, c) - t);
  }
}

// ---------------------------------------------------------------- Fire colours
// Same as SimPreview.astro: burning front bright, burnt area cooling from
// orange-red to deep red over COOL_HOURS.
const COOL_HOURS = 6;
function fireColour(step: number, t: number, out: number): [number, number, number, number] | null {
  if (t > step) return null;
  if (out > step) return [255, 206, 84, 255];
  const k = Math.min(1, (step - out) / (COOL_HOURS * STEPS_PER_HOUR));
  return [Math.round(226 - 116 * k), Math.round(72 - 46 * k), Math.round(30 - 14 * k), Math.round(235 - 25 * k)];
}

// ---------------------------------------------------------------- Terrain
// Per cell: hillshade (light from the north-west), and how much is forest, open
// land, town or water. Then sampled smoothly up to TERRAIN_PX.
const cls = (r: number, c: number) => at(domain.fuel, r, c) & 0x7f;
const elev = (r: number, c: number) => at(domain.elev, Math.max(0, Math.min(rows - 1, r)), Math.max(0, Math.min(cols - 1, c)));
const shade = new Float32Array(rows * cols);
const masks = { forest: new Float32Array(rows * cols), town: new Float32Array(rows * cols), water: new Float32Array(rows * cols) };
const az = (315 * Math.PI) / 180, alt = (40 * Math.PI) / 180;
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    const dzdx = (elev(r, c + 1) - elev(r, c - 1)) / (2 * domain.dx);
    const dzdy = (elev(r - 1, c) - elev(r + 1, c)) / (2 * domain.dy); // north is up
    const slope = Math.atan(3 * Math.hypot(dzdx, dzdy)); // relief exaggerated x3 so it reads at small sizes
    const aspectAng = Math.atan2(-dzdx, -dzdy);
    shade[i] = Math.cos(alt) * Math.sin(slope) * Math.cos(az - aspectAng) + Math.sin(alt) * Math.cos(slope);
    const k = cls(r, c);
    masks.forest[i] = k >= 1 && k <= 5 ? 1 : 0;
    masks.town[i] = k === 13 ? 1 : 0;
    masks.water[i] = k === 17 || k === 11 || k === 0 ? 1 : 0;
  }
}
const sample = (grid: Float32Array, fr: number, fc: number) => {
  const r = Math.max(0, Math.min(rows - 1.001, fr)), c = Math.max(0, Math.min(cols - 1.001, fc));
  const r0 = Math.floor(r), c0 = Math.floor(c), ar = r - r0, ac = c - c0;
  const g = (rr: number, cc: number) => grid[rr * cols + cc];
  return (g(r0, c0) * (1 - ac) + g(r0, c0 + 1) * ac) * (1 - ar) + (g(r0 + 1, c0) * (1 - ac) + g(r0 + 1, c0 + 1) * ac) * ar;
};
const smooth = (v: number) => { const t = Math.max(0, Math.min(1, (v - 0.35) / 0.3)); return t * t * (3 - 2 * t); };
const mix = (a: number[], b: number[], k: number) => a.map((x, j) => x + (b[j] - x) * k);

const S = TERRAIN_PX;
const terrain = new Uint8Array(S * S * 4);
const OPEN = [33, 37, 43], FOREST = [21, 31, 33], TOWN = [62, 68, 80], WATER = [9, 20, 36];
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const fr = ((y + 0.5) / S) * rows - 0.5, fc = ((x + 0.5) / S) * cols - 0.5;
    const light = 0.45 + 0.8 * sample(shade, fr, fc);
    let col = mix(OPEN, FOREST, sample(masks.forest, fr, fc)).map((v) => v * light);
    col = mix(col, TOWN, smooth(sample(masks.town, fr, fc)));
    col = mix(col, WATER, smooth(sample(masks.water, fr, fc)));
    const o = (y * S + x) * 4;
    terrain[o] = col[0]; terrain[o + 1] = col[1]; terrain[o + 2] = col[2]; terrain[o + 3] = 255;
  }
}
// Major roads: thin lines between neighbouring road cells (diagonals only where
// no straight neighbour already joins them, so junctions stay thin).
const isRoad = (r: number, c: number) => r >= 0 && c >= 0 && r < rows && c < cols && (at(domain.fuel, r, c) & 0x80) !== 0;
const sx = S / cols, sy = S / rows, HALF = 1.5;
const roadAlpha = new Float32Array(S * S);
function segment(x0: number, y0: number, x1: number, y1: number) {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - 3)), maxX = Math.min(S - 1, Math.ceil(Math.max(x0, x1) + 3));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - 3)), maxY = Math.min(S - 1, Math.ceil(Math.max(y0, y1) + 3));
  const vx = x1 - x0, vy = y1 - y0, len2 = vx * vx + vy * vy || 1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x + 0.5 - x0) * vx + (y + 0.5 - y0) * vy) / len2));
      const d = Math.hypot(x + 0.5 - (x0 + t * vx), y + 0.5 - (y0 + t * vy));
      const a = Math.max(0, Math.min(1, HALF + 0.5 - d));
      if (a > roadAlpha[y * S + x]) roadAlpha[y * S + x] = a;
    }
  }
}
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    if (!isRoad(r, c)) continue;
    const cx = (c + 0.5) * sx, cy = (r + 0.5) * sy;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      if (!isRoad(r + dr, c + dc)) continue;
      if (dr && dc && (isRoad(r + dr, c) || isRoad(r, c + dc))) continue;
      segment(cx, cy, (c + dc + 0.5) * sx, (r + dr + 0.5) * sy);
    }
  }
}
const ROAD = [128, 137, 152];
for (let i = 0; i < S * S; i++) {
  const a = roadAlpha[i] * 0.55;
  if (!a) continue;
  for (let j = 0; j < 3; j++) terrain[i * 4 + j] = Math.round(terrain[i * 4 + j] * (1 - a) + ROAD[j] * a);
}

// ---------------------------------------------------------------- Final frame (no JavaScript)
const lastStep = SCENARIO.hours * STEPS_PER_HOUR;
const final = new Uint8Array(rows * cols * 4);
{
  let i = 0;
  idx.forEach((d, k) => {
    i += d;
    const rgba = fireColour(lastStep, ig[k], ig[k] + dur[k]);
    if (rgba) final.set(rgba, i * 4);
  });
}

// ---------------------------------------------------------------- Labels + link
// Lake Burragorang: the largest body of water inside the crop (not touching its
// edge, which rules out the sea), labelled at its
// cell nearest its centre (the lake is long and bent, so the centre itself can
// fall on land)
const seen = new Uint8Array(rows * cols);
let lake: number[] = [];
for (let start = 0; start < rows * cols; start++) {
  if (seen[start] || cls((start / cols) | 0, start % cols) !== 17) continue;
  const part: number[] = [];
  const stack = [start];
  seen[start] = 1;
  let edge = false;
  while (stack.length) {
    const i = stack.pop()!;
    part.push(i);
    const r = (i / cols) | 0, c = i % cols;
    if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) edge = true;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr, cc = c + dc, j = rr * cols + cc;
      if (rr >= 0 && cc >= 0 && rr < rows && cc < cols && !seen[j] && cls(rr, cc) === 17) { seen[j] = 1; stack.push(j); }
    }
  }
  if (!edge && part.length > lake.length) lake = part;
}
const lakeLabel = (() => {
  if (!lake.length) return [];
  const mr = lake.reduce((a, i) => a + ((i / cols) | 0), 0) / lake.length;
  const mc = lake.reduce((a, i) => a + (i % cols), 0) / lake.length;
  const best = lake.reduce((b, i) => (Math.hypot(((i / cols) | 0) - mr, i % cols - mc) < Math.hypot(((b / cols) | 0) - mr, b % cols - mc) ? i : b));
  const x = ((best % cols) + 0.5) / cols * 100, y = (((best / cols) | 0) + 0.5) / rows * 100;
  return [{ name: 'Lake Burragorang', kind: 'water', x: +x.toFixed(2), y: +y.toFixed(2) }];
})();
const labels = [
  ...TOWNS.map((t) => ({ name: t.name, kind: 'town', ...pos(t.lat, t.lon) })).filter((l) => l.x > 4 && l.x < 96 && l.y > 4 && l.y < 96),
  ...lakeLabel,
];
// Dashboard view: centred on the panel's area, zoomed to fit a 940 x 770 map
const zoom = Math.log2((770 * 360) / ((east - west) * 512)) - 0.15;
const v = [((west + east) / 2).toFixed(4), ((north + south) / 2).toFixed(4), zoom.toFixed(2), 940, 770].join(',');
const sim = [SCENARIO.lat, SCENARIO.lon, SCENARIO.hours, SCENARIO.windFromDeg, SCENARIO.windKmh, SCENARIO.fwi, SCENARIO.seed, SCENARIO.hours].join(',');

const out = {
  note: 'Generated by web/scripts/sim-preview.mts. Do not edit by hand.',
  scenario: SCENARIO,
  place: PLACE,
  bounds: { north, south, west, east },
  cols,
  rows,
  stepsPerHour: STEPS_PER_HOUR,
  coolHours: COOL_HOURS,
  ignition: pos(SCENARIO.lat, SCENARIO.lon),
  areaHa: result.stats.map((s) => Math.round(s.areaHa)),
  labels,
  dashboardQuery: `v=${v}&p=simulate&sim=${sim}`,
  cells: { idx, ignited: ig, burning: dur },
};
mkdirSync(new URL('src/data/', WEB), { recursive: true });
writeFileSync(new URL('src/data/sim-preview.json', WEB), JSON.stringify(out));
const image = (data: Uint8Array, width: number, height: number) => sharp(Buffer.from(data.buffer), { raw: { width, height, channels: 4 } });
await image(terrain, S, S).webp({ quality: 90 }).toFile(fileURLToPath(new URL('src/assets/sim-preview-terrain.webp', WEB)));
await image(final, cols, rows).webp({ lossless: true }).toFile(fileURLToPath(new URL('src/assets/sim-preview-final.webp', WEB)));
const area = result.stats[result.stats.length - 1].areaHa;
console.log(`${PLACE}: ${Math.round(area).toLocaleString('en')} ha after ${SCENARIO.hours} h, ${idx.length} cells, crop ${cols} x ${rows}`);
console.log('labels:', labels.map((l) => `${l.name} (${l.x}%, ${l.y}%)`).join(', '));
