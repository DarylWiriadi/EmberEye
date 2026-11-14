import { create } from 'zustand';
import type { SimResult } from '../workers/simulation/model';

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
  setPlacing: (placing: boolean) => void;
  setIgnition: (lat: number, lon: number) => void;
  setInputs: (inputs: Partial<SimInputs>) => void;
  start: () => void;
  finish: (result: SimResult, ms: number) => void;
  fail: (error: string) => void;
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
  setPlacing: (placing) => set({ placing }),
  setIgnition: (lat, lon) => set({ ignition: { lat, lon }, placing: false }),
  setInputs: (inputs) => set({ inputs: { ...get().inputs, ...inputs } }),
  start: () => {
    const { ignition, inputs } = get();
    if (!ignition) return;
    set({ status: 'running', error: null, playing: false, ran: { ...inputs, ...ignition } });
  },
  finish: (result, ms) => set({ status: 'done', result, ms, hour: result.stats.length - 1 }),
  fail: (error) => set({ status: 'error', error }),
  setHour: (hour) => set({ hour }),
  setPlaying: (playing) => set({ playing }),
  clear: () => set({ ignition: null, status: 'idle', result: null, ran: null, error: null, hour: 0, playing: false, placing: false }),
}));
