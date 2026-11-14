/** [west, south, east, north] in degrees */
export type Bbox = [number, number, number, number];

/** ISO dates, YYYY-MM-DD */
export interface DateRange {
  start: string;
  end: string;
}

export interface MapViewState {
  bbox: Bbox;
  zoom: number;
}

/** An area picked by the user; stats and downloads use it instead of the map view. */
export interface SelectedArea {
  bbox: Bbox;
  /** How it was picked, and a short description of it. */
  source: 'rectangle' | 'coordinates' | 'featured';
  label: string;
  /** Featured fire id, when picked from the featured list. */
  fireId?: string;
}
