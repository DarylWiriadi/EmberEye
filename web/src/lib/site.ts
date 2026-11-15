// Site-wide names and links, kept in one place so they're easy to change.

export const site = {
  name: 'EmberEye',
  tagline: 'Two decades of fire, one consistent record',
  description:
    'A harmonized MODIS and VIIRS fire hotspot record with a burning activity calendar, ' +
    'history comparisons and a fire-spread simulation. NASA Space Apps Challenge 2026.',
  github: 'https://github.com/DarylWiriadi/EmberEye',
  firms: 'https://www.earthdata.nasa.gov/data/tools/firms',
  team: ['Daryl Allen Wiriadi', 'Nicholas Aidan Halim'],
};

export const pages = {
  home: '/',
  dashboard: '/dashboard',
};

// Home page sections, in page order. Used for section ids and nav links.
export const homeSections = [
  { id: 'problem', label: 'The problem' },
  { id: 'data-story', label: 'Data story' },
  { id: 'how-it-works', label: 'How it works' },
  { id: 'approach', label: 'What you can do' },
  { id: 'featured', label: 'Featured fires' },
  { id: 'who', label: 'Who it’s for' },
] as const;

export type HomeSectionId = (typeof homeSections)[number]['id'];
