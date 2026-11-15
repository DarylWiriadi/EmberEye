import { useState } from 'react';
import { ChevronDown, ChevronUp, Layers } from 'lucide-react';
import { VIRIDIS_CSS } from '../../../lib/colors';
import { useAppStore } from '../../../store/useAppStore';

interface Props {
  message: string;
  showLegend: boolean;
  frpMax: number;
  fetching: boolean;
  error: Error | null;
  notes: string[];
  outlineNote: string | null;
}

// Phones and short (sideways) screens: the legend starts folded into its button
const FOLDED_QUERY = '(max-width: 36rem), (max-height: 30rem)';

export default function MapStatus({ message, showLegend, frpMax, fetching, error, notes, outlineNote }: Props) {
  const showHotspots = useAppStore((s) => s.showHotspots);
  const showTrail = useAppStore((s) => s.showTrail);
  const setShowHotspots = useAppStore((s) => s.setShowHotspots);
  const setShowTrail = useAppStore((s) => s.setShowTrail);
  // On narrow maps the legend folds into a "Legend" button (always open on wide
  // screens, where the button is hidden), and its notes fold behind "More"
  const [open, setOpen] = useState(() => !window.matchMedia(FOLDED_QUERY).matches);
  const [more, setMore] = useState(false);
  return (
    <div className="map-status" data-open={open || undefined} data-more={more || undefined}>
      <button
        type="button"
        className="map-legend-toggle"
        aria-expanded={open}
        aria-controls="map-status-body"
        onClick={() => setOpen((o) => !o)}
      >
        <Layers size={15} aria-hidden="true" />
        Legend
        {open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronUp size={15} aria-hidden="true" />}
      </button>
      <div className="map-status-body" id="map-status-body">
        <fieldset className="map-layers">
          <legend className="sr-only">Show on the map</legend>
          <label>
            <input type="checkbox" checked={showHotspots} onChange={(e) => setShowHotspots(e.target.checked)} />
            Hotspots
          </label>
          <label>
            <input type="checkbox" checked={showTrail} onChange={(e) => setShowTrail(e.target.checked)} />
            <span className="map-outline-swatch" aria-hidden="true" />
            Fire trail
          </label>
        </fieldset>
        <div aria-live="polite">
          {showLegend && (
            <div className="map-legend">
              <span className="map-legend-bar" style={{ background: VIRIDIS_CSS }} />
              <span className="map-legend-labels">
                <span>Low</span>
                <span>Fire intensity (FRP, up to {Math.round(frpMax).toLocaleString()} MW)</span>
              </span>
            </div>
          )}
          <p className="map-status-msg">{message}</p>
          {fetching && <p className="map-status-muted">Updating…</p>}
          {error && <p className="map-status-error">{error.message}</p>}
          <div className="map-status-more" id="map-status-more">
            <p className="map-status-muted">Observed satellite detections</p>
            {outlineNote && (
              <p className="map-status-muted map-status-outline">
                <span className="map-outline-swatch" aria-hidden="true" />
                {outlineNote}
              </p>
            )}
            {notes.map((n) => (
              <p className="map-status-muted" key={n}>
                {n}
              </p>
            ))}
          </div>
        </div>
        <button
          type="button"
          className="map-status-toggle"
          aria-expanded={more}
          aria-controls="map-status-more"
          onClick={() => setMore((m) => !m)}
        >
          {more ? 'Less' : 'More'}
        </button>
      </div>
    </div>
  );
}
