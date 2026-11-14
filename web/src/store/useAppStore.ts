import { useMemo } from 'react';
import { create } from 'zustand';
import type { Bbox, DateRange, MapViewState, SelectedArea } from '../types';
import { stepOf, stepsFor, stepWindow } from '../lib/steps';

interface AppState {
  view: MapViewState | null;
  dateRange: DateRange | null;
  /** Slider position in steps (see lib/steps); fractional while gliding. */
  sliderPos: number;
  /** The step at the slider position (rounded); changes only when crossing steps. */
  sliderStep: number;
  playing: boolean;
  /** The slider has been used: the map keeps its current data (no extra loading)
   *  until the area or date range changes. */
  frozen: boolean;
  setView: (view: MapViewState) => void;
  setDateRange: (range: DateRange) => void;
  setSliderPos: (pos: number) => void;
  /** The user picks a position (drag, keyboard). */
  scrubTo: (pos: number) => void;
  play: () => void;
  /** Stops playback on the nearest whole step, so exactly one window is shown. */
  pause: () => void;
  /** New area or date range: the full window may load again. */
  unfreeze: () => void;
  /** The picked area, or null to use the current map view. */
  area: SelectedArea | null;
  /** 'rectangle' while the user is drawing one on the map. */
  areaTool: 'none' | 'rectangle';
  setArea: (area: SelectedArea | null) => void;
  setAreaTool: (tool: 'none' | 'rectangle') => void;
  /** Moves the slider to a day; outside the date range, the range becomes that day's month. */
  jumpToDate: (iso: string, bounds?: DateRange) => void;
}

export const useAppStore = create<AppState>()((set, get) => ({
  view: null,
  dateRange: null,
  sliderPos: 0,
  sliderStep: 0,
  playing: false,
  frozen: false,
  setView: (view) => set({ view }),
  setDateRange: (dateRange) => {
    const { dateRange: old, sliderStep } = get();
    const steps = stepsFor(dateRange);
    // Stay on the same date if it's still in the range, else go to the end.
    const keep = old ? stepWindow(stepsFor(old), sliderStep).end : null;
    const k = keep && keep >= dateRange.start && keep <= dateRange.end ? stepOf(steps, keep) : steps.count - 1;
    set({ dateRange, frozen: false, sliderStep: k, sliderPos: k });
  },
  setSliderPos: (pos) => {
    const range = get().dateRange;
    if (!range) return;
    const p = Math.min(Math.max(pos, 0), stepsFor(range).count - 1);
    const k = Math.round(p);
    set(k === get().sliderStep ? { sliderPos: p } : { sliderPos: p, sliderStep: k });
  },
  scrubTo: (pos) => {
    set({ playing: false, frozen: true });
    get().setSliderPos(pos);
  },
  play: () => set({ playing: true, frozen: true }),
  pause: () => {
    set({ playing: false, frozen: true });
    get().setSliderPos(Math.round(get().sliderPos));
  },
  unfreeze: () => set({ frozen: false }),
  area: null,
  areaTool: 'none',
  setArea: (area) => set({ area, areaTool: 'none' }),
  setAreaTool: (areaTool) => set({ areaTool }),
  jumpToDate: (iso, bounds) => {
    let range = get().dateRange;
    if (!range || iso < range.start || iso > range.end) {
      const start = `${iso.slice(0, 7)}-01`;
      const last = new Date(`${start}T00:00:00Z`);
      last.setUTCMonth(last.getUTCMonth() + 1, 0);
      let end = last.toISOString().slice(0, 10);
      if (bounds && end > bounds.end) end = bounds.end;
      range = { start: bounds && start < bounds.start ? bounds.start : start, end };
      get().setDateRange(range);
    }
    get().scrubTo(stepOf(stepsFor(range), iso));
  },
}));

/** The area stats and downloads use: the picked area, else the map view. */
export function useActiveBbox(): { bbox: Bbox | null; picked: boolean } {
  const area = useAppStore((s) => s.area);
  const view = useAppStore((s) => s.view);
  return area ? { bbox: area.bbox, picked: true } : { bbox: view?.bbox ?? null, picked: false };
}

export function useSteps() {
  const range = useAppStore((s) => s.dateRange);
  return useMemo(() => (range ? stepsFor(range) : null), [range]);
}

/** The dates covered by the slider's current step. */
export function useSliderWindow() {
  const steps = useSteps();
  const k = useAppStore((s) => s.sliderStep);
  return useMemo(() => (steps ? stepWindow(steps, k) : null), [steps, k]);
}
