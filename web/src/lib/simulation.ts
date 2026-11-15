import type { SimParams, SimResult } from '../workers/simulation/model';
import type { WorkerRequest, WorkerResponse } from '../workers/simulation.worker';
import { NEVER } from '../workers/simulation/model';

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (r: { result: SimResult; ms: number }) => void; reject: (e: Error) => void }>();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../workers/simulation.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.ok) w.resolve({ result: e.data.result, ms: e.data.ms });
      else w.reject(new Error(e.data.error));
    };
  }
  return worker;
}

/** Runs a fire-spread estimate in the background (Web Worker). */
export function runSimulation(params: SimParams) {
  return new Promise<{ result: SimResult; ms: number }>((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ id, params } satisfies WorkerRequest);
  });
}

/** The fire at an hour as an image: burning front yellow-orange, burnt area orange-red. */
export function frameImage(r: SimResult, hour: number, stepsPerHour: number): ImageData {
  const step = Math.round(hour * stepsPerHour);
  const img = new ImageData(r.size, r.size);
  const px = img.data;
  for (let i = 0; i < r.ignited.length; i++) {
    const t = r.ignited[i];
    if (t === NEVER || t > step) continue;
    const o = i * 4;
    if (r.burntOut[i] > step) {
      px[o] = 255;
      px[o + 1] = 210;
      px[o + 2] = 70;
      px[o + 3] = 255;
    } else {
      px[o] = 232;
      px[o + 1] = 72;
      px[o + 2] = 28;
      px[o + 3] = 200;
    }
  }
  return img;
}

export const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** [west, south, east, north] of everything burnt by the end, for fitting the map. */
export function burntBounds(r: SimResult): [number, number, number, number] | null {
  let r0 = r.size, r1 = -1, c0 = r.size, c1 = -1;
  for (let i = 0; i < r.ignited.length; i++) {
    if (r.ignited[i] === NEVER) continue;
    const row = (i / r.size) | 0;
    const col = i - row * r.size;
    if (row < r0) r0 = row;
    if (row > r1) r1 = row;
    if (col < c0) c0 = col;
    if (col > c1) c1 = col;
  }
  if (r1 < 0) return null;
  const cell = (r.north - r.south) / r.size;
  return [r.west + c0 * cell, r.north - (r1 + 1) * cell, r.west + (c1 + 1) * cell, r.north - r0 * cell];
}
