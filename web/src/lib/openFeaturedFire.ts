import { useAppStore } from '../store/useAppStore';
import type { FeaturedFire } from './featuredFires';
import { stepOf, stepsFor } from './steps';

/** Shows a featured fire: its area, its season as the date range, the slider on
 *  its peak day, and `?fire=<id>` in the address so the view can be shared. */
export function openFeaturedFire(fire: FeaturedFire) {
  const store = useAppStore.getState();
  const range = { start: fire.start, end: fire.end };
  store.setDateRange(range);
  store.setArea({ bbox: fire.bbox, source: 'featured', label: `${fire.name} · ${fire.place}`, fireId: fire.id });
  store.setSliderPos(stepOf(stepsFor(range), fire.peak));
  const url = new URL(window.location.href);
  url.searchParams.set('fire', fire.id);
  window.history.replaceState(null, '', url);
}
