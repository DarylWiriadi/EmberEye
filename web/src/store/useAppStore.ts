import { create } from 'zustand';
import type { DateRange, MapViewState } from '../types';

const DAY_MS = 86_400_000;
const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (t: number) => new Date(t).toISOString().slice(0, 10);
const spanDays = (r: DateRange) => Math.round((toTime(r.end) - toTime(r.start)) / DAY_MS);

interface AppState {
  view: MapViewState | null;
  dateRange: DateRange | null;
  /** Slider position in days from dateRange.start; fractional while gliding. */
  sliderPos: number;
  /** The day at the slider position (rounded); changes only when crossing days. */
  sliderDate: string | null;
  playing: boolean;
  /** Paused after playback: the map keeps the picture it had (no extra loading). */
  frozen: boolean;
  setView: (view: MapViewState) => void;
  setDateRange: (range: DateRange) => void;
  setSliderPos: (pos: number) => void;
  /** The user picks a position (drag, keyboard): unfreezes the map. */
  scrubTo: (pos: number) => void;
  play: () => void;
  /** Stops playback on the nearest whole day, so exactly one day is shown. */
  pause: () => void;
}

export const useAppStore = create<AppState>()((set, get) => ({
  view: null,
  dateRange: null,
  sliderPos: 0,
  sliderDate: null,
  playing: false,
  frozen: false,
  setView: (view) => set({ view }),
  setDateRange: (dateRange) => {
    const s = get().sliderDate;
    const date = s && s >= dateRange.start && s <= dateRange.end ? s : dateRange.end;
    set({ dateRange, sliderDate: date, sliderPos: (toTime(date) - toTime(dateRange.start)) / DAY_MS });
  },
  setSliderPos: (pos) => {
    const range = get().dateRange;
    if (!range) return;
    const p = Math.min(Math.max(pos, 0), spanDays(range));
    const date = toIso(toTime(range.start) + Math.round(p) * DAY_MS);
    set(date === get().sliderDate ? { sliderPos: p } : { sliderPos: p, sliderDate: date });
  },
  scrubTo: (pos) => {
    set({ playing: false, frozen: false });
    get().setSliderPos(pos);
  },
  play: () => set({ playing: true, frozen: false }),
  pause: () => {
    set({ playing: false, frozen: true });
    get().setSliderPos(Math.round(get().sliderPos));
  },
}));
