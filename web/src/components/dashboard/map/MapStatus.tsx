import { VIRIDIS_CSS } from '../../../lib/colors';

interface Props {
  message: string;
  showLegend: boolean;
  frpMax: number;
  fetching: boolean;
  error: Error | null;
  notes: string[];
}

export default function MapStatus({ message, showLegend, frpMax, fetching, error, notes }: Props) {
  return (
    <div className="map-status" aria-live="polite">
      {showLegend && (
        <div className="map-legend">
          <span className="map-legend-bar" style={{ background: VIRIDIS_CSS }} />
          <span className="map-legend-labels">
            <span>Low</span>
            <span>Fire intensity (FRP, up to {Math.round(frpMax).toLocaleString()} MW)</span>
          </span>
        </div>
      )}
      <p>{message}</p>
      <p className="map-status-muted">Observed satellite detections</p>
      {fetching && <p className="map-status-muted">Updating…</p>}
      {error && <p className="map-status-error">{error.message}</p>}
      {notes.map((n) => (
        <p className="map-status-muted" key={n}>
          {n}
        </p>
      ))}
    </div>
  );
}
