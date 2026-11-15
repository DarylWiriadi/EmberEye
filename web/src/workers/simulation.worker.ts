/// <reference lib="webworker" />
// Runs the fire-spread estimate off the main thread: loads the input tiles around
// the ignition, runs the whole simulation, and sends back the result in one go.
import { loadDomain } from './simulation/tiles';
import { simulate, type SimParams, type SimResult } from './simulation/model';

export type WorkerRequest = { id: number; params: SimParams };
export type WorkerResponse =
  | { id: number; ok: true; result: SimResult; ms: number }
  | { id: number; ok: false; error: string };

/** Grid size grows with duration so long, fast fires don't run off the edge. */
const sizeFor = (hours: number) => (hours <= 24 ? 512 : hours <= 48 ? 768 : 1024);

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, params } = e.data;
  const t0 = performance.now();
  try {
    const domain = await loadDomain(params.lat, params.lon, sizeFor(params.hours));
    const result = simulate(domain, params);
    const msg: WorkerResponse = { id, ok: true, result, ms: Math.round(performance.now() - t0) };
    (self as unknown as Worker).postMessage(msg, [result.ignited.buffer, result.burntOut.buffer]);
  } catch (err) {
    const msg: WorkerResponse = { id, ok: false, error: (err as Error).message };
    (self as unknown as Worker).postMessage(msg);
  }
};
