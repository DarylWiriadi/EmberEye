import { useAppStore, type SharedView, type SideTab } from '../store/useAppStore';
import { useSimStore } from '../store/useSimStore';
import { featuredFire } from './featuredFires';
import { getMapHandle } from './mapHandle';
import type { Bbox, SelectedArea } from '../types';

// A share link holds the whole view in its query string, so nothing is stored on
// a server. The simulation is stored as its inputs and seed: re-running them gives
// exactly the same fire.
//
//   v    map centre lng,lat, zoom, and the sender's map width,height (px)
//   d    date range start,end      t   slider step
//   a    area w,s,e,n   as  r|c|f (rectangle, coordinates, featured)   al  label   af  featured fire id
//   p    side panel tab, or "closed"
//   l    map layers shown: h (hotspots), t (fire trail), "-" for none
//   cm   calendar "a" = vs usual   cmo  calendar month open (YYYY-MM)
//   rm   risk month (YYYY-MM)      ro  "0" = risk hidden on the map
//   sim  lat,lon,hours,wind from,wind km/h,FWI,seed[,hour shown]; without the hour,
//        only the ignition point and inputs are restored (not run)

const TABS: SideTab[] = ['calendar', 'simulate', 'featured', 'risk'];
const SOURCES = { r: 'rectangle', c: 'coordinates', f: 'featured' } as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

const fix = (x: number, digits: number) => String(Number(x.toFixed(digits)));

export function buildShareUrl(): string {
  const a = useAppStore.getState();
  const s = useSimStore.getState();
  const p: [string, string][] = [];
  const map = getMapHandle();
  if (map) {
    const c = map.getCenter().wrap();
    const el = map.getContainer();
    p.push(['v', [fix(c.lng, 4), fix(c.lat, 4), fix(map.getZoom(), 2), el.clientWidth, el.clientHeight].join(',')]);
  }
  if (a.dateRange) {
    p.push(['d', `${a.dateRange.start},${a.dateRange.end}`], ['t', String(a.sliderStep)]);
  }
  if (a.area) {
    p.push(['a', a.area.bbox.map((x) => fix(x, 4)).join(',')], ['as', a.area.source[0]], ['al', a.area.label]);
    if (a.area.fireId) p.push(['af', a.area.fireId]);
  }
  p.push(['p', a.sideOpen ? a.sideTab : 'closed']);
  if (!a.showHotspots || !a.showTrail) p.push(['l', `${a.showHotspots ? 'h' : ''}${a.showTrail ? 't' : ''}` || '-']);
  if (a.calMode === 'anomaly') p.push(['cm', 'a']);
  if (a.calMonth) p.push(['cmo', a.calMonth]);
  if (a.riskMonth) p.push(['rm', a.riskMonth]);
  if (!a.riskOn) p.push(['ro', '0']);
  const shown = s.status === 'done' && s.result && s.ran;
  const sim = shown ? s.ran : s.ignition ? { ...s.inputs, ...s.ignition } : null;
  if (sim) {
    const parts = [fix(sim.lat, 4), fix(sim.lon, 4), sim.hours, sim.windFromDeg, sim.windKmh, sim.fwi, sim.seed];
    if (shown) parts.push(fix(Math.round(s.hour * 4) / 4, 2));
    p.push(['sim', parts.join(',')]);
  }
  const query = p.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2C/g, ',')}`).join('&');
  return `${window.location.origin}${window.location.pathname}?${query}`;
}

function numbers(value: string | null, count: number): number[] | null {
  if (!value) return null;
  const parts = value.split(',').map(Number);
  return parts.length >= count && parts.slice(0, count).every(Number.isFinite) ? parts : null;
}

/**
 * Restores a shared link's view into the stores. Returns null for a normal visit,
 * else the simulation hour to open at (if a simulation should be re-run).
 */
export function applySharedLink(search: string): { simHour: number | null } | null {
  const q = new URLSearchParams(search);
  if (!q.has('v')) return null;
  const app = useAppStore.getState();

  const v = numbers(q.get('v'), 5);
  if (v && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 85 && v[3] > 0 && v[4] > 0) {
    const view: SharedView = { lng: v[0], lat: v[1], zoom: v[2], width: v[3], height: v[4] };
    app.setPendingView(view);
  }

  const d = q.get('d')?.split(',');
  if (d && d.length === 2 && DATE.test(d[0]) && DATE.test(d[1]) && d[0] <= d[1]) {
    app.setDateRange({ start: d[0], end: d[1] });
    const t = Number(q.get('t'));
    if (q.has('t') && Number.isInteger(t)) app.setSliderPos(t);
  }

  const box = numbers(q.get('a'), 4);
  const source = SOURCES[q.get('as') as keyof typeof SOURCES];
  if (box && source) {
    const fire = featuredFire(q.get('af'));
    const area: SelectedArea = {
      bbox: box.slice(0, 4) as Bbox,
      source,
      label: (q.get('al') ?? '').slice(0, 160) || 'Shared area',
      ...(fire ? { fireId: fire.id } : {}),
    };
    // Not flown to: the shared map view below is what the sender was looking at.
    useAppStore.setState({ area, areaTool: 'none', flying: false });
  }

  const tab = q.get('p');
  if (tab === 'closed') app.setSideOpen(false);
  else if (TABS.includes(tab as SideTab)) app.showSideTab(tab as SideTab);

  const layers = q.get('l');
  if (layers != null) {
    app.setShowHotspots(layers.includes('h'));
    app.setShowTrail(layers.includes('t'));
  }
  if (q.get('cm') === 'a') app.setCalMode('anomaly');
  const calMonth = q.get('cmo');
  if (calMonth && MONTH.test(calMonth)) app.setCalMonth(calMonth);
  const riskMonth = q.get('rm');
  if (riskMonth && MONTH.test(riskMonth)) app.setRiskMonth(riskMonth);
  if (q.get('ro') === '0') app.setRiskOn(false);

  let simHour: number | null = null;
  const sim = numbers(q.get('sim'), 7);
  if (sim && Math.abs(sim[0]) <= 85 && Math.abs(sim[1]) <= 180 && [24, 48, 72].includes(sim[2])) {
    const [lat, lon, hours, windFromDeg, windKmh, fwi, seed] = sim;
    useSimStore.setState({
      ignition: { lat, lon },
      inputs: {
        hours: hours as 24 | 48 | 72,
        windFromDeg: ((Math.round(windFromDeg / 45) * 45) % 360 + 360) % 360,
        windKmh: Math.min(Math.max(windKmh, 0), 80),
        fwi: Math.min(Math.max(fwi, 0), 80),
        seed: Math.round(seed),
      },
      restored: true,
    });
    if (sim.length >= 8 && Number.isFinite(sim[7])) simHour = sim[7];
  }
  return { simHour };
}

/** Copies text; false if the browser won't allow it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.append(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    return ok;
  }
}
