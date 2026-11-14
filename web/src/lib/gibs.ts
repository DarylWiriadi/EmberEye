// Basemap from NASA GIBS: a static, cloud-free Blue Marble composite plus place
// names and borders (derived from OpenStreetMap). No API key needed.
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

export const BASEMAP_TILES = [
  `${GIBS}/BlueMarble_NextGeneration/default/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`,
];
export const BASEMAP_MAX_ZOOM = 8;
export const BASEMAP_ATTRIBUTION = 'Imagery: NASA Blue Marble (GIBS)';

export const LABEL_TILES = [
  `${GIBS}/Reference_Labels/default/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png`,
];
export const LABEL_MAX_ZOOM = 9;
export const LABEL_ATTRIBUTION = 'Labels: NASA GIBS, © OpenStreetMap contributors';
