/**
 * The simulation's input grid around an ignition point, assembled from the 1 x 1
 * degree tiles served by /api/sim-tile (built by pipeline/sim_inputs.py):
 * fuel = IGBP land cover class (+128 where a major road crosses), elevation in metres.
 */
export const RES = 240; // fuel cells per degree (~460 m)
const ELEV_RES = 120;
export const ROAD_FLAG = 128;

export interface Domain {
  size: number;
  /** Edges in degrees; row 0 is the north edge. */
  north: number;
  south: number;
  west: number;
  east: number;
  fuel: Uint8Array;
  /** Metres, one value per fuel cell (elevation is ~1 km, so shared by 2 x 2 cells). */
  elev: Float32Array;
  /** Cell size in metres (north-south, east-west at the domain's centre). */
  dy: number;
  dx: number;
}

interface Tile {
  fuel: Uint8Array;
  elev: Int16Array;
}

async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(buf);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buf; // already unpacked on the way
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

async function loadTile(south: number, west: number): Promise<Tile | null> {
  const res = await fetch(`${self.location.origin}/api/sim-tile/${south}/${west}`);
  if (res.status === 404) return null; // nothing burnable there
  if (!res.ok) throw new Error(`Simulation input tile failed to load (${res.status})`);
  const raw = await gunzip(await res.arrayBuffer());
  return {
    fuel: new Uint8Array(raw, 0, RES * RES),
    elev: new Int16Array(raw.slice(RES * RES)),
  };
}

/** A size x size grid centred on (lat, lon). */
export async function loadDomain(lat: number, lon: number, size: number): Promise<Domain> {
  const gr0 = Math.floor((90 - lat) * RES) - size / 2; // global row of the first cell
  const gc0 = Math.floor((lon + 180) * RES) - size / 2;
  const north = 90 - gr0 / RES;
  const west = -180 + gc0 / RES;
  const south = north - size / RES;
  const east = west + size / RES;

  const keys = new Set<string>();
  for (let s = Math.floor(south); s < north; s++) {
    for (let w = Math.floor(west); w < east; w++) keys.add(`${s}_${w}`);
  }
  const tiles = new Map<string, Tile | null>();
  await Promise.all(
    [...keys].map(async (k) => {
      const [s, w] = k.split('_').map(Number);
      tiles.set(k, await loadTile(s, ((w + 540) % 360) - 180));
    }),
  );

  const fuel = new Uint8Array(size * size);
  const elev = new Float32Array(size * size);
  for (let r = 0; r < size; r++) {
    const gr = gr0 + r;
    const latC = 90 - (gr + 0.5) / RES;
    const s = Math.floor(latC);
    const tr = Math.floor((s + 1 - latC) * RES);
    for (let c = 0; c < size; c++) {
      const gc = gc0 + c;
      const lonC = -180 + (gc + 0.5) / RES;
      const w = Math.floor(lonC);
      const tile = tiles.get(`${s}_${w}`);
      if (!tile) continue; // fuel 0 = nothing to burn
      const tc = Math.floor((lonC - w) * RES);
      const i = r * size + c;
      fuel[i] = tile.fuel[tr * RES + tc];
      const e = tile.elev[(tr >> 1) * ELEV_RES + (tc >> 1)];
      elev[i] = e === -32768 ? 0 : e;
    }
  }
  const dy = 111_320 / RES;
  const dx = dy * Math.cos((lat * Math.PI) / 180);
  return { size, north, south, west, east, fuel, elev, dy, dx };
}
