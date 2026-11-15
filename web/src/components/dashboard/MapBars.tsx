import { Pause, Play } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useSimStore } from '../../store/useSimStore';
import { useRisk } from '../../lib/api';
import { RISK_COLORS, shortMonth } from '../../lib/risk';
import { fmtHa } from '../../lib/simulation';

/**
 * Bars on the map for what it shows while the side panel is closed (mostly on
 * phones, where the panel covers the screen):
 *   - the risk outlook's hexagons, with Exit to hide them
 *   - a simulated fire, always labelled as an estimate, with play/pause
 */
export default function MapBars() {
  const sideOpen = useAppStore((s) => s.sideOpen);
  const sideTab = useAppStore((s) => s.sideTab);
  const riskOn = useAppStore((s) => s.riskOn);
  const riskOverlay = useAppStore((s) => s.riskOverlay);
  const showRisk = !sideOpen && riskOverlay && riskOn && sideTab === 'risk';
  const sim = useSimStore((s) => s.result);
  const showSim = !sideOpen && !!sim && !sim.unburnable;
  if (!showRisk && !showSim) return null;
  return (
    <div className="map-bars">
      {showRisk && <RiskBar />}
      {showSim && <SimBar />}
    </div>
  );
}

function RiskBar() {
  const month = useAppStore((s) => s.riskMonth);
  const setRiskOverlay = useAppStore((s) => s.setRiskOverlay);
  const data = useRisk(month, true).data; // the Risk tab's query (already cached)
  const classes = data?.classes ?? ['Low', 'Moderate', 'High', 'Very high', 'Extreme'];
  return (
    <div className="map-bar" role="group" aria-label="Fire activity outlook on the map">
      <div className="map-bar-text">
        <p>
          <strong>Fire activity outlook</strong> <span className="sim-badge">Not official</span>
        </p>
        <p className="map-bar-scale" aria-label={`From ${classes[0]} to ${classes[classes.length - 1]}`}>
          {data && <span className="map-bar-month">{shortMonth(data.month)} ·</span>}
          <span>{classes[0]}</span>
          {RISK_COLORS.map((c, i) => (
            <span key={i} className="risk-swatch" style={{ background: `rgb(${c.join(',')})` }} aria-hidden="true" />
          ))}
          <span>{classes[classes.length - 1]}</span>
        </p>
      </div>
      {/* The panel's edge tab reopens the Risk tab; this bar keeps to one action */}
      <button type="button" className="map-bar-btn map-bar-exit" onClick={() => setRiskOverlay(false)}>
        Exit
      </button>
    </div>
  );
}

function SimBar() {
  const r = useSimStore((s) => s.result)!;
  const ran = useSimStore((s) => s.ran);
  const hour = useSimStore((s) => s.hour);
  const playing = useSimStore((s) => s.playing);
  const setPlaying = useSimStore((s) => s.setPlaying);
  const setHour = useSimStore((s) => s.setHour);
  const showSideTab = useAppStore((s) => s.showSideTab);
  const last = r.stats.length - 1;
  const h = Math.min(Math.round(hour), last);
  return (
    <div className="map-bar" role="group" aria-label="Simulated fire on the map">
      <div className="map-bar-text">
        <p>
          <span className="sim-badge">Estimate</span> <strong>Simulated fire</strong>
        </p>
        <p className="map-bar-meta">
          Hour {h} of {ran?.hours ?? last} · {fmtHa(r.stats[h].areaHa)}
        </p>
      </div>
      <button
        type="button"
        className="dash-icon-btn"
        onClick={() => {
          if (!playing && hour >= last) setHour(0);
          setPlaying(!playing);
        }}
        aria-label={playing ? 'Pause' : 'Play the simulated spread'}
      >
        {playing ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <button type="button" className="map-bar-btn" onClick={() => showSideTab('simulate')}>
        Details
      </button>
    </div>
  );
}
