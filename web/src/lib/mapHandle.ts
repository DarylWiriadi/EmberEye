import type { Map as MapLibreMap } from 'maplibre-gl';

// The live map, for reading exactly what's on screen (share links).
let current: MapLibreMap | null = null;

export const setMapHandle = (map: MapLibreMap | null) => {
  current = map;
};
export const getMapHandle = () => current;
