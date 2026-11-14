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
