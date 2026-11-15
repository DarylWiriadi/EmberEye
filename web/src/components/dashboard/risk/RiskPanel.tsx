import { useMemo } from 'react';
import { Flame, History, LoaderCircle, LocateFixed } from 'lucide-react';
import { useActiveBbox, useAppStore } from '../../../store/useAppStore';
import { useSimStore } from '../../../store/useSimStore';
import { useRisk } from '../../../lib/api';
import { RISK_COLORS, monthName, shortMonth, useRiskCells, type RiskCell } from '../../../lib/risk';
import type { Bbox } from '../../../types';

const TOP = 8;
const MIN = '2008-01';
const BLACK_SUMMER: Bbox = [145, -39, 152, -32];

const latLon = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;

function cellBbox(c: RiskCell): Bbox {
  const xs = c.polygon.map((p) => p[0]);
  const ys = c.polygon.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function inBox(c: RiskCell, [w, s, e, n]: Bbox) {
  const lon = c.lon < w ? c.lon + 360 : c.lon;
  return c.lat >= s && c.lat <= n && lon >= w && lon <= e;
}

export default function RiskPanel() {
  const riskOn = useAppStore((s) => s.riskOn);
  const setRiskOn = useAppStore((s) => s.setRiskOn);
  const month = useAppStore((s) => s.riskMonth);
  const setMonth = useAppStore((s) => s.setRiskMonth);
  const focusOn = useAppStore((s) => s.focusOn);
  const showSideTab = useAppStore((s) => s.showSideTab);
  const setPlacing = useSimStore((s) => s.setPlacing);
  const { bbox, picked } = useActiveBbox();

  const q = useRisk(month, true);
  const data = q.data;
  const cells = useRiskCells(data);
  const top = useMemo(
    () => (bbox ? cells.filter((c) => inBox(c, bbox)).sort((a, b) => b.score - a.score).slice(0, TOP) : []),
    [cells, bbox],
  );

  const simulateAt = (c: RiskCell) => {
    focusOn(cellBbox(c));
    showSideTab('simulate');
    setPlacing(true);
  };

  return (
    <div className="risk">
      <h2 className="sim-title">
        Fire activity outlook <span className="sim-badge">Not official</span>
      </h2>
      {data ? (
        <p className="sim-lede">
          Where fire is more likely than usual in <strong>{monthName(data.month)}</strong>, from recent fire weather, soil
          dryness and how much usually burns there.
        </p>
      ) : (
        <p className="sim-lede">Where fire is more likely than usual, from recent fire weather, soil dryness and fire history.</p>
      )}

      <div className="risk-controls">
        <label className="risk-month">
          <span>Month</span>
          <input
            type="month"
            min={MIN}
            max={data?.latest}
            value={data?.month ?? month ?? ''}
            onChange={(e) => e.target.value && setMonth(e.target.value === data?.latest ? null : e.target.value)}
          />
        </label>
        {month && (
          <button type="button" className="sim-btn" onClick={() => setMonth(null)}>
            Latest
          </button>
        )}
        <label className="risk-toggle">
          <input type="checkbox" checked={riskOn} onChange={(e) => setRiskOn(e.target.checked)} />
          Show on map
        </label>
      </div>

      <div className="risk-legend" aria-label="Outlook classes">
        {(data?.classes ?? ['Low', 'Moderate', 'High', 'Very high', 'Extreme']).map((name, i) => (
          <div key={name}>
            <span className="risk-swatch" style={{ background: `rgb(${RISK_COLORS[i].join(',')})` }} />
            {name}
          </div>
        ))}
      </div>

      {q.isPending && (
        <p className="sim-note">
          <LoaderCircle size={14} className="stat-spin" aria-hidden="true" /> Loading the outlook…
        </p>
      )}
      {q.error && <p className="sim-error">{(q.error as Error).message}</p>}

      {data && (
        <>
          <h3 className="risk-subhead">Highest in {picked ? 'the selected area' : 'view'}</h3>
          {top.length ? (
            <ol className="risk-list">
              {top.map((c) => (
                <li key={c.cell}>
                  <button type="button" className="risk-place" onClick={() => focusOn(cellBbox(c))} title="Show on the map">
                    <span className="risk-swatch" style={{ background: `rgb(${RISK_COLORS[c.cls].join(',')})` }} />
                    <span className="risk-name">
                      {data.classes[c.cls]} <span className="risk-score">{c.score}</span>
                    </span>
                    <span className="risk-where">
                      <LocateFixed size={12} aria-hidden="true" /> {latLon(c.lat, c.lon)}
                    </span>
                  </button>
                  <button type="button" className="risk-sim" onClick={() => simulateAt(c)} title="Go there and pick an ignition point">
                    <Flame size={14} aria-hidden="true" /> Simulate here
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="sim-note">No rated places here: little or no fire this time of year in the record.</p>
          )}

          <p className="sim-note">
            Score = average of three percentiles:{' '}
            {data.conditions.fwi && <>fire weather (GFWED Fire Weather Index, {shortMonth(data.conditions.fwi)}), </>}
            {data.conditions.soil && <>soil dryness (MERRA-2, {shortMonth(data.conditions.soil)}), </>}
            each against the same month in earlier years at that place; and how much usually burns there in{' '}
            {monthName(data.month).split(' ')[0]} (harmonized MODIS + VIIRS record) against everywhere else. Hexagons are about
            12,000 km².
          </p>
          <button
            type="button"
            className="sim-btn"
            onClick={() => {
              setMonth('2019-12');
              setRiskOn(true);
              focusOn(BLACK_SUMMER);
            }}
          >
            <History size={15} aria-hidden="true" /> Check it: Dec 2019, before Black Summer
          </button>
          <p className="sim-note risk-disclaimer">
            Not an official fire danger rating. For warnings and today’s rating, follow your local fire service.
          </p>
        </>
      )}
    </div>
  );
}
