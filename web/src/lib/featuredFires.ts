import type { Bbox } from '../types';

/** Well-known fire events, used on the home page and as dashboard presets
 *  (`/dashboard?fire=<id>` selects the area and dates). */
export interface FeaturedFire {
  id: string;
  name: string;
  years: string;
  place: string;
  /** [west, south, east, north] */
  bbox: Bbox;
  start: string;
  end: string;
  /** The slider opens here: the busiest day in our harmonized data. */
  peak: string;
}

export const FEATURED_FIRES: FeaturedFire[] = [
  {
    id: 'black-summer',
    name: 'Black Summer',
    years: '2019–20',
    place: 'New South Wales & Victoria, Australia',
    bbox: [145.5, -38.8, 153.7, -28.0],
    start: '2019-09-01',
    end: '2020-02-29',
    peak: '2020-01-04',
  },
  {
    id: 'amazon-2019',
    name: 'Amazon fires',
    years: '2019',
    place: 'Amazon, Brazil',
    bbox: [-67.0, -14.0, -46.0, -2.0],
    start: '2019-07-01',
    end: '2019-10-31',
    peak: '2019-08-14',
  },
  {
    id: 'california-2020',
    name: 'California fire season',
    years: '2020',
    place: 'California, USA',
    bbox: [-124.5, 34.5, -118.5, 42.0],
    start: '2020-08-01',
    end: '2020-11-30',
    peak: '2020-09-09',
  },
  {
    id: 'canada-2023',
    name: 'Canada fire season',
    years: '2023',
    place: 'Canada',
    bbox: [-128.0, 48.5, -60.0, 62.0],
    start: '2023-05-01',
    end: '2023-10-31',
    // Our busiest day is 23 Sep 2023 (231x usual), not yet checked; 13 Jul matches the known peak season.
    peak: '2023-07-13',
  },
];

export const featuredFire = (id: string | null) => FEATURED_FIRES.find((f) => f.id === id) ?? null;

