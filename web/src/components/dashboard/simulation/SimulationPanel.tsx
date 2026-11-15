import { useEffect, useMemo } from 'react';
import { Crosshair, LoaderCircle, Pause, Play, RotateCcw, X } from 'lucide-react';
import { useSimStore } from '../../../store/useSimStore';
import { useAppStore, useSliderWindow } from '../../../store/useAppStore';
import { useAreaStats } from '../../../lib/api';
import { COMPASS, fmtHa } from '../../../lib/simulation';
import ShareButton from '../share/ShareButton';
import type { Bbox } from '../../../types';

const latLon = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
const fwiWord = (fwi: number) => (fwi < 10 ? 'low' : fwi < 25 ? 'moderate' : fwi < 40 ? 'high' : fwi < 55 ? 'very high' : 'extreme');

export default function SimulationPanel() {
  const s = useSimStore();
  const win = useSliderWindow();

  // That month's weather around the ignition, to prefill wind and dryness.
  const box: Bbox | null = s.ignition
    ? [s.ignition.lon - 0.25, s.ignition.lat - 0.25, s.ignition.lon + 0.25, s.ignition.lat + 0.25]
    : null;
  const month = win ? win.end.slice(0, 7) : null;
  const weather = useAreaStats(box, month ? { start: `${month}-01`, end: win!.end } : null);
  const local = useMemo(() => {
    const d = weather.data;
    if (!d) return null;
    const w = d.weather.find((x) => x.t2m != null && x.month === month) ?? d.latest.weather;
    const f = d.weather.find((x) => x.fwi != null && x.month === month) ?? d.latest.fwi;
    return { month: w?.month ?? f?.month ?? null, windFrom: w?.wind_from_deg ?? null, fwi: f?.fwi ?? null };
  }, [weather.data, month]);

  // Escape cancels picking.
  const placing = s.placing;
  const setPlacing = s.setPlacing;
  useEffect(() => {
    if (!placing) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPlacing(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [placing, setPlacing]);

  // Prefill once per ignition point.
  useEffect(() => {
    if (!local || useSimStore.getState().restored) return;
    const patch: Parameters<typeof s.setInputs>[0] = {};
    if (local.windFrom != null) patch.windFromDeg = Math.round(local.windFrom / 45) * 45 % 360;
    if (local.fwi != null) patch.fwi = Math.round(local.fwi);
    s.setInputs(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local?.month, s.ignition?.lat, s.ignition?.lon]);

  // On phones, once the fire is simulated the full-screen panel closes so it's
  // seen spreading on the map (a bar on the map keeps the controls).
  const run = async () => {
    await s.run();
    const done = useSimStore.getState();
    if (done.status === 'done' && done.result && !done.result.unburnable) useAppStore.getState().revealMap();
  };

  // Playback runs in useSimPlayback (Dashboard.tsx), so it carries on with this tab closed.

  const r = s.result;
  const h = Math.round(s.hour);
  const st = r?.stats[Math.min(h, r.stats.length - 1)];

  return (
    <div className="sim">
      <h2 className="sim-title">
        Fire-spread simulation <span className="sim-badge">Estimate</span>
      </h2>
      <p className="sim-lede">Start a fire anywhere and see how it might spread with the fuel, terrain, wind and dryness there.</p>

      <div className="sim-row">
        <button
          type="button"
          className="sim-btn"
          aria-pressed={s.placing}
          onClick={() => s.setPlacing(!s.placing)}
        >
          <Crosshair size={15} aria-hidden="true" />
          {s.placing ? 'Click the map…' : s.ignition ? 'Move ignition point' : 'Pick ignition point'}
        </button>
        {s.ignition && <span className="sim-coords">{latLon(s.ignition.lat, s.ignition.lon)}</span>}
      </div>

      {s.ignition && (
        <form
          className="sim-form"
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <label>
            <span>Duration</span>
            <select value={s.inputs.hours} onChange={(e) => s.setInputs({ hours: Number(e.target.value) as 24 | 48 | 72 })}>
              <option value={24}>24 hours</option>
              <option value={48}>48 hours</option>
              <option value={72}>72 hours</option>
            </select>
          </label>
          <label>
            <span>Wind from</span>
            <select value={s.inputs.windFromDeg} onChange={(e) => s.setInputs({ windFromDeg: Number(e.target.value) })}>
              {COMPASS.map((c, i) => (
                <option key={c} value={i * 45}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="sim-wide">
            <span>
              Wind speed <output>{s.inputs.windKmh} km/h</output>
            </span>
            <input type="range" min={0} max={80} step={5} value={s.inputs.windKmh} onChange={(e) => s.setInputs({ windKmh: Number(e.target.value) })} />
          </label>
          <label className="sim-wide">
            <span>
              Dryness (Fire Weather Index) <output>{s.inputs.fwi} · {fwiWord(s.inputs.fwi)}</output>
            </span>
            <input type="range" min={0} max={80} step={1} value={s.inputs.fwi} onChange={(e) => s.setInputs({ fwi: Number(e.target.value) })} />
          </label>
          <p className="sim-note sim-wide">
            {s.restored
              ? 'Inputs from a shared link; adjust freely.'
              : local?.month
              ? `Prefilled from ${local.month} weather here (monthly averages); adjust freely.`
              : weather.isFetching
                ? 'Looking up this month’s weather here…'
                : 'No weather data here; using defaults.'}
          </p>
          <button type="submit" className="sim-run sim-wide" disabled={s.status === 'running'}>
            {s.status === 'running' ? (
              <>
                <LoaderCircle size={15} className="stat-spin" aria-hidden="true" /> Simulating…
              </>
            ) : r ? (
              <>
                <RotateCcw size={15} aria-hidden="true" /> Run again
              </>
            ) : (
              'Run simulation'
            )}
          </button>
        </form>
      )}

      {s.status === 'error' && <p className="sim-error">{s.error}</p>}

      {r && st && s.ran && (
        <div className="sim-result">
          {r.unburnable ? (
            <p className="sim-error">This spot can’t burn (water, city, bare ground or ice). Pick a point on vegetation.</p>
          ) : (
            <>
              <div className="sim-play">
                <button
                  type="button"
                  className="dash-icon-btn"
                  onClick={() => {
                    if (!s.playing && s.hour >= r.stats.length - 1) s.setHour(0);
                    s.setPlaying(!s.playing);
                  }}
                  aria-label={s.playing ? 'Pause' : 'Play the simulated spread'}
                >
                  {s.playing ? <Pause size={18} /> : <Play size={18} />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={r.stats.length - 1}
                  step="any"
                  value={s.hour}
                  onChange={(e) => {
                    s.setPlaying(false);
                    s.setHour(Number(e.target.value));
                  }}
                  aria-label="Hours after ignition"
                  aria-valuetext={`${h} hours after ignition`}
                />
                <output className="sim-hour">+{h} h</output>
              </div>
              <dl className="sim-stats">
                <div>
                  <dt>Area burned</dt>
                  <dd>{fmtHa(st.areaHa)}</dd>
                </div>
                <div>
                  <dt>Growth</dt>
                  <dd>{fmtHa(st.growthHaPerHour)}/h</dd>
                </div>
                <div>
                  <dt>Front speed</dt>
                  <dd>{st.frontKmh.toFixed(1)} km/h</dd>
                </div>
                <div>
                  <dt>Reach</dt>
                  <dd>{st.reachKm.toFixed(1)} km</dd>
                </div>
              </dl>
              {r.hitEdge && <p className="sim-note">The fire reached the edge of the simulated area; spread beyond it isn’t shown.</p>}
            </>
          )}
          <p className="sim-note">
            Simulated estimate, not a forecast or warning. Inputs: land cover (NASA MODIS MCD12Q1, 2024), elevation (NASA
            SRTM), major roads (Natural Earth); wind {COMPASS[Math.round(s.ran.windFromDeg / 45) % 8]} {s.ran.windKmh} km/h,
            FWI {s.ran.fwi}, {s.ran.hours} h, seed {s.ran.seed}
            {s.ms != null ? ` · computed in ${(s.ms / 1000).toFixed(1)} s` : ''}.
          </p>
          <div className="sim-row">
            {!r.unburnable && <ShareButton label="Share this simulation" className="sim-btn" size={15} />}
            <button type="button" className="sim-btn" onClick={s.clear}>
              <X size={15} aria-hidden="true" /> Clear simulation
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

