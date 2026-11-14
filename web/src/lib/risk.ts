import { useMemo } from 'react';
import { cellToBoundary, cellToLatLng } from 'h3-js';
import type { RiskResponse } from './api';

/** Low to Extreme: one light-to-dark orange-red ramp (no green), more opaque as it rises. */
export const RISK_COLORS: [number, number, number][] = [
  [254, 240, 217],
  [253, 204, 138],
  [252, 141, 89],
  [227, 74, 51],
  [179, 0, 0],
];
export const RISK_ALPHA = [30, 60, 95, 130, 165];

export interface RiskCell {
  cell: string;
  score: number;
  cls: number;
  fwi: number | null;
  dryness: number | null;
  activity: number;
  lat: number;
  lon: number;
  polygon: number[][];
}

/** Hexagon outlines (kept on one side of the antimeridian) and centres. */
export function useRiskCells(data: RiskResponse | undefined): RiskCell[] {
  return useMemo(() => {
    if (!data) return [];
    return data.cells.map(([cell, score, cls, fwi, dryness, activity]) => {
      const polygon = cellToBoundary(cell, true);
      if (Math.max(...polygon.map((p) => p[0])) - Math.min(...polygon.map((p) => p[0])) > 180) {
        for (const p of polygon) if (p[0] < 0) p[0] += 360;
      }
      const [lat, lon] = cellToLatLng(cell);
      return { cell, score, cls, fwi, dryness, activity, lat, lon, polygon };
    });
  }, [data]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
export const shortMonth = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1].slice(0, 3)} ${ym.slice(0, 4)}`;

const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${s}`;
};

/** Tooltip lines explaining a cell's score. */
export function describeRisk(c: RiskCell, classes: string[], month: string) {
  const m = MONTHS[Number(month.slice(5, 7)) - 1];
  const lines = [`${classes[c.cls]} · outlook score ${c.score}/100`];
  if (c.fwi != null) lines.push(`Fire weather: ${ordinal(c.fwi)} percentile for this place and time of year`);
  if (c.dryness != null) lines.push(`Soil dryness: ${ordinal(c.dryness)} percentile for this place and time of year`);
  lines.push(`Usually burns in ${m}: more than ${c.activity}% of places`);
  return lines;
}
