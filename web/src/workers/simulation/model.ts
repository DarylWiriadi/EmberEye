/**
 * Fire-spread estimate: a probabilistic cellular automaton (after Alexandridis et
 * al. 2008), on ~460 m cells. Every step (5 minutes), each burning cell tries to
 * ignite its 8 neighbours with probability
 *
 *   p = P_BASE x (1 + fuel) x dryness x wind x slope   (x road factor)
 *
 *   fuel     how readily the land cover carries fire (IGBP class, below)
 *   dryness  from the Fire Weather Index: ~0.24 when mild (FWI 15), ~2.4 when extreme (FWI 47)
 *   wind     exp(C1 V) [F + (1 - F) exp(C2 V (cos a - 1))]: fastest downwind; the floor F
 *            keeps the flanks and back spreading too (real fires grow as ovals) (V m/s)
 *   slope    exp(A theta): uphill faster (roughly doubles per 10 degrees)
 *
 * A cell keeps burning until it has had a fair chance to pass the fire on (PERSIST),
 * so in mild weather the fire creeps slowly instead of going out.
 * Water, cities, bare ground, ice and cells without data never burn; major roads
 * strongly slow it. A seeded random generator makes runs repeatable.
 * It is an estimate for exploring "what if", not a forecast. Tuned so a 24 h run gives
 * ~3-5k ha in mild forest weather, ~12k ha for grass on a moderate day, and ~130k ha
 * with a ~2.3 km/h head, flanks and backing on an extreme forest day (Black Summer scale).
 */
import { ROAD_FLAG, type Domain } from './tiles';

export const STEPS_PER_HOUR = 12;
/** Model constants (exported so they can be tuned in tests). */
export const TUNING = {
  P_BASE: 0.065,
  C1: 0.035,
  C2: 0.5,
  A_SLOPE: 0.069, // ~x2 per 10 degrees uphill
  ROAD_FACTOR: 0.15,
  DRY_MID: 35, // FWI where dryness = 1
  DRY_SCALE: 14,
  DIR_FLOOR: 0.06, // share of the spread chance every direction keeps, even upwind
  PERSIST: 2, // expected ignitions per neighbour before a cell burns out (min)
  MAX_BURN_HOURS: 12,
};

/** How readily each IGBP land cover class carries fire (0 = average). null = never burns. */
// Grass and open country spread fastest; forest slower (it burns longer and hotter,
// but the front moves slower).
const FUEL: (number | null)[] = [
  null, // 0 no data
  0, -0.05, 0, -0.05, 0, // 1-5 forests
  0.3, 0.25, // 6-7 shrublands
  0.35, 0.45, // 8-9 savannas
  0.6, // 10 grassland
  -0.6, // 11 wetland
  0, // 12 cropland
  null, // 13 city
  0.1, // 14 cropland / natural mosaic
  null, null, null, // 15 snow/ice, 16 bare, 17 water
];

/** Hours the flaming front stays in a cell (and can spread) before it's burnt out. */
const BURN_HOURS: number[] = [0, 1, 1, 1, 1, 1, 0.75, 0.75, 0.6, 0.5, 0.5, 0.5, 0.5, 0, 0.5, 0, 0, 0];

export interface SimParams {
  lat: number;
  lon: number;
  hours: number;
  /** Direction the wind blows from, degrees (0 = north). */
  windFromDeg: number;
  windKmh: number;
  fwi: number;
  seed: number;
}

export interface HourStats {
  hour: number;
  areaHa: number;
  growthHaPerHour: number;
  /** Furthest burnt cell from the ignition, km; its change per hour is the front speed. */
  reachKm: number;
  frontKmh: number;
  burning: number;
}

export interface SimResult {
  size: number;
  north: number;
  south: number;
  west: number;
  east: number;
  /** Step each cell caught fire (0xffff = never), and the step it burnt out. */
  ignited: Uint16Array;
  burntOut: Uint16Array;
  stats: HourStats[];
  /** The fire reached the edge of the simulated area (results there are cut off). */
  hitEdge: boolean;
  /** The ignition point can't burn (water, city, bare ground...). */
  unburnable: boolean;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const NEVER = 0xffff;

export function dryness(fwi: number) {
  return Math.min(3, Math.max(0.05, Math.exp((fwi - TUNING.DRY_MID) / TUNING.DRY_SCALE)));
}

export function simulate(domain: Domain, p: SimParams): SimResult {
  const { size, fuel, elev, dx, dy } = domain;
  const n = size * size;
  const ignited = new Uint16Array(n).fill(NEVER);
  const burntOut = new Uint16Array(n).fill(NEVER);
  const rand = mulberry32(p.seed);
  const steps = p.hours * STEPS_PER_HOUR;

  const dry = dryness(p.fwi);
  const v = p.windKmh / 3.6;
  // Unit vector of where the wind blows *to* (x east, y north).
  const toRad = ((p.windFromDeg + 180) * Math.PI) / 180;
  const wx = Math.sin(toRad);
  const wy = Math.cos(toRad);

  // 8 neighbours: row/col offsets, direction (unit vector, y north) and distance.
  const nbrs: { dr: number; dc: number; ux: number; uy: number; dist: number }[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const ex = dc * dx;
      const ey = -dr * dy;
      const dist = Math.hypot(ex, ey);
      nbrs.push({ dr, dc, ux: ex / dist, uy: ey / dist, dist });
    }
  }
  // Wind factor per neighbour direction, with diagonals adjusted for their longer distance.
  const windF = nbrs.map((nb) => {
    const cos = nb.ux * wx + nb.uy * wy;
    const dir = TUNING.DIR_FLOOR + (1 - TUNING.DIR_FLOOR) * Math.exp(TUNING.C2 * v * (cos - 1));
    return Math.exp(TUNING.C1 * v) * dir * (Math.min(dx, dy) / nb.dist);
  });

  // Steps each land cover class burns: its usual time, or longer when spread is slow.
  const meanWind = windF.reduce((a, b) => a + b, 0) / windF.length;
  const burnSteps = FUEL.map((f, cls) => {
    const own = Math.max(1, Math.round(BURN_HOURS[cls] * STEPS_PER_HOUR));
    if (f == null) return own;
    const pRef = Math.min(0.98, TUNING.P_BASE * (1 + f) * dry * meanWind);
    return Math.min(TUNING.MAX_BURN_HOURS * STEPS_PER_HOUR, Math.max(own, Math.round(TUNING.PERSIST / pRef)));
  });

  const r0 = size / 2;
  const c0 = size / 2;
  const start = r0 * size + c0;
  const classOf = (i: number) => fuel[i] & 0x7f;
  const unburnable = FUEL[classOf(start)] == null;
  const stats: HourStats[] = [{ hour: 0, areaHa: 0, growthHaPerHour: 0, reachKm: 0, frontKmh: 0, burning: 0 }];
  const box = { size, north: domain.north, south: domain.south, west: domain.west, east: domain.east };
  if (unburnable) return { ...box, ignited, burntOut, stats, hitEdge: false, unburnable };

  const cellHa = (dx * dy) / 10_000;
  ignited[start] = 0;
  burntOut[start] = burnSteps[classOf(start)];
  let front: number[] = [start];
  let burnt = 1;
  let reach2 = 0;
  let hitEdge = false;

  for (let step = 1; step <= steps; step++) {
    const next: number[] = [];
    for (const i of front) {
      if (burntOut[i] <= step - 1) continue; // burnt out
      const r = (i / size) | 0;
      const c = i - r * size;
      for (let k = 0; k < 8; k++) {
        const nb = nbrs[k];
        const rr = r + nb.dr;
        const cc = c + nb.dc;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) {
          hitEdge = true;
          continue;
        }
        const j = rr * size + cc;
        if (ignited[j] !== NEVER) continue;
        const f = FUEL[fuel[j] & 0x7f];
        if (f == null) continue;
        const rise = elev[j] - elev[i];
        const slope = Math.exp(TUNING.A_SLOPE * ((Math.atan(rise / nb.dist) * 180) / Math.PI));
        let prob = TUNING.P_BASE * (1 + f) * dry * windF[k] * slope;
        if (fuel[j] & ROAD_FLAG) prob *= TUNING.ROAD_FACTOR;
        if (rand() < Math.min(0.98, prob)) {
          ignited[j] = step;
          burntOut[j] = step + burnSteps[fuel[j] & 0x7f];
          next.push(j);
          burnt++;
          const d2 = ((rr - r0) * dy) ** 2 + ((cc - c0) * dx) ** 2;
          if (d2 > reach2) reach2 = d2;
        }
      }
      if (burntOut[i] > step) next.push(i); // still burning
    }
    front = next;
    if (step % STEPS_PER_HOUR === 0) {
      const hour = step / STEPS_PER_HOUR;
      const areaHa = burnt * cellHa;
      const prev = stats[stats.length - 1];
      const reachKm = Math.sqrt(reach2) / 1000;
      stats.push({
        hour,
        areaHa,
        growthHaPerHour: areaHa - prev.areaHa,
        reachKm,
        frontKmh: reachKm - prev.reachKm,
        burning: front.length,
      });
    }
    if (!front.length) {
      // Burnt out early: the rest of the hours keep the final numbers.
      for (let h = stats[stats.length - 1].hour + 1; h <= p.hours; h++) {
        const prev = stats[stats.length - 1];
        const areaHa = burnt * cellHa;
        const reachKm = Math.sqrt(reach2) / 1000;
        stats.push({ hour: h, areaHa, growthHaPerHour: areaHa - prev.areaHa, reachKm, frontKmh: reachKm - prev.reachKm, burning: 0 });
      }
      break;
    }
  }
  return { ...box, ignited, burntOut, stats, hitEdge, unburnable };
}
