// Land mask for the home page map: a 1-degree grid of cell centres, 77.5N to
// 57.5S (136 rows x 360 columns), from Natural Earth land via world-atlas.
// Writes land-1deg.txt next to this file: one line per row, '1' = land.
// The output is committed, so this only needs running if the grid changes.
//
//   npm install && npm run land
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const topo = JSON.parse(readFileSync(require.resolve('world-atlas/land-50m.json'), 'utf8'));
const geom = feature(topo, topo.objects.land).features[0].geometry;

// Flat lon/lat point-in-polygon (accurate enough at 1 degree), with a bbox pre-filter.
const polys = (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates).map((original) => {
  // Shapes that cross the 180 degree line (e.g. far-eastern Russia, Fiji): unwrap
  // their far-western longitudes (west of 150W) by +360 so the edges stay short.
  const crosses = original.some((ring) => ring.some(([x], i) => i > 0 && Math.abs(x - ring[i - 1][0]) > 180));
  const rings = crosses ? original.map((ring) => ring.map(([x, y]) => [x < -150 ? x + 360 : x, y])) : original;
  let x0 = 360, x1 = -180, y0 = 90, y1 = -90;
  for (const [x, y] of rings[0]) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { rings, x0, x1, y0, y1 };
});

const inRing = (x, y, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inPoly = (x, y, p) =>
  x >= p.x0 && x <= p.x1 && y >= p.y0 && y <= p.y1 &&
  inRing(x, y, p.rings[0]) && !p.rings.slice(1).some((hole) => inRing(x, y, hole));

// Test each point at its longitude and +360, to catch the unwrapped shapes
const isLand = (x, y) => polys.some((p) => inPoly(x, y, p) || inPoly(x + 360, y, p));

const rows = [];
for (let lat = 77.5; lat >= -57.5; lat -= 1) {
  let row = '';
  for (let lon = -179.5; lon <= 179.5; lon += 1) row += isLand(lon, lat) ? '1' : '0';
  rows.push(row);
}
writeFileSync(new URL('./land-1deg.txt', import.meta.url), rows.join('\n'));
console.log(`${rows.length} rows x ${rows[0].length} cols, ${rows.join('').split('1').length - 1} land cells`);
