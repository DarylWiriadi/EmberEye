import { ArrowRight } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import { FEATURED_FIRES } from '../../../lib/featuredFires';
import { openFeaturedFire } from '../../../lib/openFeaturedFire';

/** Well-known fires: one click sets the area, dates and map, on the fire's peak day. */
export default function FeaturedList() {
  const current = useAppStore((s) => s.area?.fireId);

  return (
    <div className="featured">
      <h2 className="featured-title">Featured fires</h2>
      <p className="featured-lede">Jump to a well-known event. Opens on its busiest day; press play to watch the season.</p>
      <ul className="featured-list" role="list">
        {FEATURED_FIRES.map((fire) => (
          <li key={fire.id}>
            <button
              type="button"
              className="featured-item"
              aria-current={current === fire.id || undefined}
              onClick={() => openFeaturedFire(fire)}
            >
              <span className="featured-name">
                {fire.name} <span className="featured-year">{fire.years}</span>
              </span>
              <span className="featured-place">{fire.place}</span>
              <ArrowRight size={16} className="featured-arrow" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
