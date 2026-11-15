import { useEffect, useRef, useState } from 'react';
import { Globe, LocateFixed, SquareDashed, X } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import type { Bbox } from '../../../types';

const MAX_RADIUS_KM = 2000;

const fmt = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? pos : neg}`;

/** "-35.50, 148.00" style label for a bbox. */
export function describeBbox([w, s, e, n]: Bbox) {
  return `${fmt(s, 'N', 'S')} to ${fmt(n, 'N', 'S')}, ${fmt(w, 'E', 'W')} to ${fmt(e, 'E', 'W')}`;
}

/** A box around a point: `km` north, south, east and west of it. */
function boxAround(lat: number, lon: number, km: number): Bbox {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  const clampLat = (v: number) => Math.max(-85, Math.min(85, v));
  const clampLon = (v: number) => Math.max(-180, Math.min(180, v));
  return [clampLon(lon - dLon), clampLat(lat - dLat), clampLon(lon + dLon), clampLat(lat + dLat)];
}

function CoordinatesForm({ onDone }: { onDone: () => void }) {
  const setArea = useAppStore((s) => s.setArea);
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [km, setKm] = useState('50');
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => first.current?.focus(), []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const la = Number(lat);
    const lo = Number(lon);
    const r = Number(km);
    if (!lat.trim() || !Number.isFinite(la) || la < -85 || la > 85) return setError('Latitude must be between -85 and 85.');
    if (!lon.trim() || !Number.isFinite(lo) || lo < -180 || lo > 180) return setError('Longitude must be between -180 and 180.');
    if (!Number.isFinite(r) || r <= 0 || r > MAX_RADIUS_KM) return setError(`Radius must be between 1 and ${MAX_RADIUS_KM} km.`);
    setArea({
      bbox: boxAround(la, lo, r),
      source: 'coordinates',
      label: `Within ${r.toLocaleString()} km of ${la.toFixed(2)}, ${lo.toFixed(2)}`,
    });
    onDone();
  };

  return (
    <form className="area-form" onSubmit={submit} noValidate>
      <label>
        <span>Latitude</span>
        <input ref={first} inputMode="decimal" placeholder="-35.50" value={lat} onChange={(e) => setLat(e.target.value)} />
      </label>
      <label>
        <span>Longitude</span>
        <input inputMode="decimal" placeholder="148.00" value={lon} onChange={(e) => setLon(e.target.value)} />
      </label>
      <label>
        <span>Radius (km)</span>
        <input inputMode="numeric" value={km} onChange={(e) => setKm(e.target.value)} />
      </label>
      {error && (
        <p className="area-form-error" role="alert">
          {error}
        </p>
      )}
      <div className="area-form-actions">
        <button type="button" className="area-btn" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="area-btn area-btn-primary">
          Select area
        </button>
      </div>
    </form>
  );
}

export default function AreaToolbar() {
  const area = useAppStore((s) => s.area);
  const tool = useAppStore((s) => s.areaTool);
  const setArea = useAppStore((s) => s.setArea);
  const setTool = useAppStore((s) => s.setAreaTool);
  const [coordsOpen, setCoordsOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setTool('none');
      setCoordsOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setTool]);

  useEffect(() => {
    if (!coordsOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setCoordsOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [coordsOpen]);

  const mode = tool === 'rectangle' ? 'rectangle' : coordsOpen ? 'coordinates' : area ? area.source : 'view';

  return (
    <div className="area-tools" ref={root}>
      <div className="area-group" role="group" aria-label="Area to analyse">
        <button
          type="button"
          className="area-btn"
          aria-pressed={mode === 'view'}
          onClick={() => {
            setArea(null);
            setCoordsOpen(false);
          }}
          title="Use whatever is on the map"
        >
          <Globe size={16} aria-hidden="true" />
          <span className="tool-label">Map view</span>
        </button>
        <button
          type="button"
          className="area-btn"
          aria-pressed={mode === 'rectangle'}
          onClick={() => {
            setCoordsOpen(false);
            setTool(tool === 'rectangle' ? 'none' : 'rectangle');
          }}
          title="Drag a rectangle on the map"
        >
          <SquareDashed size={16} aria-hidden="true" />
          <span className="tool-label">Draw area</span>
        </button>
        <button
          type="button"
          className="area-btn"
          aria-pressed={mode === 'coordinates'}
          aria-expanded={coordsOpen}
          onClick={() => {
            setTool('none');
            setCoordsOpen((o) => !o);
          }}
          title="Enter a latitude, longitude and radius"
        >
          <LocateFixed size={16} aria-hidden="true" />
          <span className="tool-label">Coordinates</span>
        </button>
      </div>

      {tool === 'rectangle' && <p className="area-hint">Drag on the map to draw an area · Esc to cancel</p>}

      {area && tool !== 'rectangle' && !coordsOpen && (
        <p className="area-chip">
          <span className="area-chip-text" title={describeBbox(area.bbox)}>
            {area.label}
          </span>
          <button type="button" className="area-chip-clear" onClick={() => setArea(null)} aria-label="Clear the selected area">
            <X size={14} aria-hidden="true" />
          </button>
        </p>
      )}

      {coordsOpen && (
        <div className="area-panel">
          <CoordinatesForm onDone={() => setCoordsOpen(false)} />
        </div>
      )}
    </div>
  );
}
