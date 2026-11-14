export type RGBA = [number, number, number, number];

// Viridis (colour-blind safe, perceptually uniform)
const VIRIDIS: [number, number, number][] = [
  [68, 1, 84],
  [72, 40, 120],
  [62, 74, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [109, 205, 89],
  [180, 222, 44],
  [253, 231, 37],
];

export function viridis(t: number, alpha = 255): RGBA {
  const x = Math.min(1, Math.max(0, t)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [VIRIDIS[i], VIRIDIS[i + 1]];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
    alpha,
  ];
}

/** 0..1 on a log scale between 1 and max. */
export function logScale(value: number, max: number): number {
  if (value <= 1 || max <= 1) return 0;
  return Math.log(value) / Math.log(max);
}

export const VIRIDIS_CSS = `linear-gradient(to right, ${VIRIDIS.map((c) => `rgb(${c.join(',')})`).join(', ')})`;

// Blue-orange diverging (never red-green): quieter than usual <- grey -> busier.
const QUIET: [number, number, number] = [61, 139, 253];
const NEUTRAL: [number, number, number] = [74, 82, 96];
const BUSY: [number, number, number] = [255, 122, 26];

/** t in -1..1: -1 = much quieter, 0 = usual, 1 = much busier. */
export function diverging(t: number): [number, number, number] {
  const x = Math.max(-1, Math.min(1, t));
  const [a, b] = x < 0 ? [NEUTRAL, QUIET] : [NEUTRAL, BUSY];
  const f = Math.abs(x);
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * f)) as [number, number, number];
}

export const DIVERGING_CSS = `linear-gradient(to right, rgb(${QUIET.join(',')}), rgb(${NEUTRAL.join(',')}), rgb(${BUSY.join(',')}))`;
