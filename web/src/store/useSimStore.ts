import { create } from 'zustand';
import type { SimResult } from '../workers/simulation/model';
import { runSimulation } from '../lib/simulation';

export interface SimInputs {
  hours: 24 | 48 | 72;
  /** Direction the wind blows from, degrees (0 = north). */
  windFromDeg: number;
  windKmh: number;
  fwi: number;
  seed: number;
}

interface SimState {
  /** Waiting for a click on the map to set the ignition point. */
  placing: boolean;
  ignition: { lat: number; lon: number } | null;
  inputs: SimInputs;
  status: 'idle' | 'running' | 'done' | 'error';
  result: SimResult | null;
  /** Inputs the shown result was run with. */
  ran: (SimInputs & { lat: number; lon: number }) | null;
  error: string | null;
  ms: number | null;
  /** Playback position in hours (fractional while playing). */
  hour: number;
  playing: boolean;
  /** Fit the map to the result when it arrives (not for a shared link's view). */
  fit: boolean;
  /** Inputs came from a shared link: don't overwrite them with local weather. */
  restored: boolean;
  setPlacing: (placing: boolean) => void;
  setIgnition: (lat: number, lon: number) => void;
  setInputs: (inputs: Partial<SimInputs>) => void;
  /** Runs it; plays from ignition, or opens paused at `openAt` hours (shared links). */
  run: (openAt?: number) => Promise<void>;
  setHour: (hour: number) => void;
  setPlaying: (playing: boolean) => void;
  clear: () => void;
}

const DEFAULT_INPUTS: SimInputs = { hours: 24, windFromDeg: 315, windKmh: 25, fwi: 30, seed: 1 };

export const useSimStore = create<SimState>()((set, get) => ({
  placing: false,
  ignition: null,
  inputs: DEFAULT_INPUTS,
  status: 'idle',
  result: null,
  ran: null,
  error: null,
  ms: null,
  hour: 0,
  playing: false,
  fit: true,
  restored: false,
  setPlacing: (placing) => set({ placing }),
  setIgnition: (lat, lon) => set({ ignition: { lat, lon }, placing: false, restored: false }),
  setInputs: (inputs) => set({ inputs: { ...get().inputs, ...inputs } }),
  run: async (openAt) => {
    const { ignition, inputs } = get();
    if (!ignition) return;
    set({ status: 'running', error: null, playing: false, ran: { ...inputs, ...ignition } });
    try {
      const { result, ms } = await runSimulation({ ...ignition, ...inputs });
      const last = result.stats.length - 1;
      if (openAt != null) {
        set({ status: 'done', result, ms, hour: Math.min(Math.max(openAt, 0), last), playing: false, fit: false });
        return;
      }
      // Plays from ignition (the frames are already computed, so no requests).
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const play = !still && !result.unburnable;
      set({ status: 'done', result, ms, hour: play ? 0 : last, playing: play, fit: true });
    } catch (e) {
      set({ status: 'error', error: (e as Error).message });
    }
  },
  setHour: (hour) => set({ hour }),
  setPlaying: (playing) => set({ playing }),
  clear: () => set({ ignition: null, status: 'idle', result: null, ran: null, error: null, hour: 0, playing: false, placing: false }),
}));
