import type { DateRange } from '../types';

/**
 * The slider moves in steps. Short ranges step one day at a time; longer ones
 * use equal multi-day windows so there are never more than MAX_STEPS. Windows
 * are counted back from the range end, so the latest one is always full and only
 * the first may be shorter. Each window covers every day in it: nothing is skipped.
 */
export const MAX_STEPS = 31;
export const DAY_MS = 86_400_000;

export interface Steps {
  /** Days per step. */
  size: number;
  count: number;
  startTime: number;
  endTime: number;
}

const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (t: number) => new Date(t).toISOString().slice(0, 10);

export function stepsFor(range: DateRange): Steps {
  const startTime = toTime(range.start);
  const endTime = toTime(range.end);
  const days = Math.round((endTime - startTime) / DAY_MS) + 1;
  const size = Math.max(1, Math.ceil(days / MAX_STEPS));
  return { size, count: Math.ceil(days / size), startTime, endTime };
}

export function stepWindow(s: Steps, k: number): DateRange {
  const end = s.endTime - (s.count - 1 - k) * s.size * DAY_MS;
  const start = Math.max(s.startTime, end - (s.size - 1) * DAY_MS);
  return { start: toIso(start), end: toIso(end) };
}

/** The step a day (ISO date) falls in. */
export function stepOf(s: Steps, iso: string): number {
  const back = Math.round((s.endTime - toTime(iso)) / DAY_MS);
  return s.count - 1 - Math.floor(back / s.size);
}

export function windowDays(w: DateRange): number {
  return Math.round((toTime(w.end) - toTime(w.start)) / DAY_MS) + 1;
}

export function addDays(iso: string, days: number): string {
  return toIso(toTime(iso) + days * DAY_MS);
}

const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-AU', { ...opts, timeZone: 'UTC' });

/** "13 Nov 2026", "1–12 Mar 2026", "24 Feb – 7 Mar 2026", "26 Dec 2025 – 6 Jan 2026". */
export function formatWindow(w: DateRange): string {
  if (w.start === w.end) return fmt(w.end, { day: 'numeric', month: 'short', year: 'numeric' });
  const [ys, ms] = w.start.split('-');
  const [ye, me] = w.end.split('-');
  const end = fmt(w.end, { day: 'numeric', month: 'short', year: 'numeric' });
  if (ys !== ye) return `${fmt(w.start, { day: 'numeric', month: 'short', year: 'numeric' })} – ${end}`;
  if (ms !== me) return `${fmt(w.start, { day: 'numeric', month: 'short' })} – ${end}`;
  return `${Number(w.start.slice(8))}–${end}`;
}

/** "on 13 Nov 2026" or "in 1–12 Mar 2026". */
export const windowPhrase = (w: DateRange) => `${w.start === w.end ? 'on' : 'in'} ${formatWindow(w)}`;
