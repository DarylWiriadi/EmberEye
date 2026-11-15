import { viridis } from './colors';
import type { CalendarPeriod } from './api';

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const EMPTY = '#1b2230';

/**
 * The burning calendar (years × months, harmonized fire cell-days) as a PNG,
 * coloured like the dashboard's calendar: viridis on a log scale from this area's
 * quiet months (5th percentile) to its busiest.
 */
export function calendarPng(periods: CalendarPeriod[], area: string): Promise<Blob | null> {
  const byMonth = new Map(periods.map((p) => [p.period.slice(0, 7), p.fire_days]));
  const years = [...new Set(periods.map((p) => Number(p.period.slice(0, 4))))].sort((a, b) => a - b);
  if (!years.length) return Promise.resolve(null);
  const vals = periods.map((p) => p.fire_days).filter((v) => v > 0).sort((a, b) => a - b);
  const lo = vals.length ? Math.max(vals[Math.floor(vals.length * 0.05)], 0.01) : 1;
  const max = vals.length ? vals[vals.length - 1] : 1;
  const colour = (v: number | undefined) => {
    if (v == null || v <= 0) return EMPTY;
    const t = max > lo ? Math.log(Math.max(v, lo) / lo) / Math.log(max / lo) : 1;
    const [r, g, b] = viridis(0.08 + 0.92 * t);
    return `rgb(${r}, ${g}, ${b})`;
  };

  const k = 2;
  const cellW = 30, cellH = 16, gap = 2, left = 48, top = 86, pad = 20;
  const width = left + 12 * (cellW + gap) + pad;
  const height = top + years.length * (cellH + gap) + 64;
  const out = document.createElement('canvas');
  out.width = width * k;
  out.height = height * k;
  const ctx = out.getContext('2d')!;
  ctx.scale(k, k);
  ctx.fillStyle = '#131820';
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#f4efe8';
  ctx.font = '600 14px Inter Variable, Inter, sans-serif';
  ctx.fillText('Burning calendar', pad, 14);
  ctx.fillStyle = '#b0b8c4';
  ctx.font = '11px Inter Variable, Inter, sans-serif';
  // Long area names are shortened to fit.
  let name = area;
  while (name.length > 1 && ctx.measureText(name).width > width - pad * 2) name = name.slice(0, -2) + '…';
  ctx.fillText(name, pad, 34);
  ctx.fillText('Harmonized fire cell-days per month', pad, 50);
  ctx.textAlign = 'center';
  MONTHS.forEach((m, i) => ctx.fillText(m, left + i * (cellW + gap) + cellW / 2, top - 16));
  ctx.textAlign = 'right';
  years.forEach((y, row) => {
    const yy = top + row * (cellH + gap);
    ctx.fillStyle = '#b0b8c4';
    ctx.fillText(String(y), left - 8, yy + 2);
    for (let m = 0; m < 12; m++) {
      const key = `${y}-${String(m + 1).padStart(2, '0')}`;
      ctx.fillStyle = byMonth.has(key) ? colour(byMonth.get(key)) : '#0b0e13';
      ctx.fillRect(left + m * (cellW + gap), yy, cellW, cellH);
    }
  });

  // Legend: quiet to busy.
  const ly = top + years.length * (cellH + gap) + 12;
  const lw = 12 * (cellW + gap) - gap;
  for (let i = 0; i < lw; i++) {
    const [r, g, b] = viridis(0.08 + 0.92 * (i / lw));
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(left + i, ly, 1, 8);
  }
  ctx.fillStyle = '#b0b8c4';
  ctx.textAlign = 'left';
  ctx.fillText('Quiet', left, ly + 12);
  ctx.textAlign = 'right';
  ctx.fillText('Busy (log scale)', left + lw, ly + 12);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#8e98a7';
  ctx.fillText('EmberEye · NASA FIRMS MODIS + VIIRS, harmonized to VIIRS S-NPP', pad, ly + 30);

  return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
}
