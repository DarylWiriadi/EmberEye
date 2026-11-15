import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, Flame, Gauge, Star, X } from 'lucide-react';
import { useHealth } from '../../lib/api';
import { featuredFire } from '../../lib/featuredFires';
import { openFeaturedFire } from '../../lib/openFeaturedFire';
import { applySharedLink } from '../../lib/shareUrl';
import ShareButton from './share/ShareButton';
import FeaturedList from './featured/FeaturedList';
import RiskPanel from './risk/RiskPanel';
import SimulationPanel from './simulation/SimulationPanel';
import { useSimPlayback } from './simulation/useSimPlayback';
import MapBars from './MapBars';
import { useAppStore } from '../../store/useAppStore';
import { useSimStore } from '../../store/useSimStore';
import MapView from './map/MapView';
import DownloadMenu from './downloads/DownloadMenu';
import AreaToolbar from './area/AreaToolbar';
import CalendarWidget from './calendar/CalendarWidget';
import StatsPanel from './stats/StatsPanel';
import DateRangeInputs from './timeline/DateRangeInputs';
import TimeSlider from './timeline/TimeSlider';
import './Dashboard.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

// A shared link (?v=...) restores the sender's view before anything renders.
const shared = applySharedLink(window.location.search);

// /dashboard?tab=calendar (or simulate, featured, risk) opens that side panel tab,
// e.g. from the home page's feature cards. The address is tidied back afterwards.
{
  const url = new URL(window.location.href);
  const tab = url.searchParams.get('tab');
  if (!shared && tab && ['calendar', 'simulate', 'featured', 'risk'].includes(tab)) {
    useAppStore.getState().showSideTab(tab as 'calendar' | 'simulate' | 'featured' | 'risk');
  }
  if (tab) {
    url.searchParams.delete('tab');
    window.history.replaceState(null, '', url);
  }
}

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const SIDE_TABS = [
  { id: 'calendar', label: 'Calendar', Icon: CalendarDays },
  { id: 'simulate', label: 'Simulate', Icon: Flame },
  { id: 'featured', label: 'Featured', Icon: Star },
  { id: 'risk', label: 'Risk', Icon: Gauge },
] as const;

function DashboardShell() {
  const sideOpen = useAppStore((s) => s.sideOpen);
  const setSideOpen = useAppStore((s) => s.setSideOpen);
  const sideTab = useAppStore((s) => s.sideTab);
  const setSideTab = useAppStore((s) => s.showSideTab);
  const health = useHealth();
  const range = useAppStore((s) => s.dateRange);
  const setRange = useAppStore((s) => s.setDateRange);
  const coverage = health.data?.coverage;
  const placing = useSimStore((s) => s.placing);
  const revealMap = useAppStore((s) => s.revealMap);
  const sideHandle = useRef<HTMLButtonElement>(null);

  // Tab underline, animated like the home page nav: it shrinks while sliding,
  // arrives as a dot at the near edge of the new tab, then grows across it.
  const tabRow = useRef<HTMLDivElement>(null);
  const tabLine = useRef<HTMLSpanElement>(null);
  const shownTab = useRef<string | null>(null);
  const placeLine = useCallback((animate: boolean) => {
    const row = tabRow.current;
    const line = tabLine.current;
    const tab = row?.querySelector('.side-tab[aria-selected="true"]');
    if (!row || !line || !tab) return;
    const box = row.getBoundingClientRect();
    const at = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - box.left, w: r.width };
    };
    const frame = (x: number, w: number) => ({ transform: `translateX(${x}px)`, width: `${w}px` });
    const from = at(line);
    const to = at(tab);
    line.getAnimations().forEach((a) => a.cancel());
    Object.assign(line.style, frame(to.x, to.w), { opacity: '1' });
    if (!animate || from.w === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const DOT = 6;
    const dotTo = to.x > from.x ? to.x : to.x + to.w - DOT;
    line.animate(
      [
        { ...frame(from.x, from.w), easing: 'ease-in-out' },
        { ...frame(dotTo, DOT), offset: 0.6, easing: 'ease-out' },
        frame(to.x, to.w),
      ],
      { duration: 420 },
    );
  }, []);
  useLayoutEffect(() => {
    placeLine(shownTab.current !== null && shownTab.current !== sideTab);
    shownTab.current = sideTab;
  }, [sideTab, placeLine]);
  useEffect(() => {
    const row = tabRow.current;
    if (!row) return;
    const ro = new ResizeObserver(() => placeLine(false));
    ro.observe(row);
    return () => ro.disconnect();
  }, [placeLine]);
  useSimPlayback();

  // A shared simulation is re-run (same inputs and seed, so the same fire).
  useEffect(() => {
    if (shared?.simHour != null) useSimStore.getState().run(shared.simHour);
  }, []);

  // Picking an ignition point only makes sense with the Simulate tab open.
  useEffect(() => {
    if (sideTab !== 'simulate' || !sideOpen) useSimStore.getState().setPlacing(false);
  }, [sideTab, sideOpen]);

  useEffect(() => {
    if (!coverage || range) return;
    // /dashboard?fire=<id> opens a featured fire: its area and dates.
    const fire = featuredFire(new URLSearchParams(window.location.search).get('fire'));
    if (fire) {
      openFeaturedFire(fire);
    } else {
      setRange({ start: addDays(coverage.last, -29), end: coverage.last });
    }
  }, [coverage, range, setRange]);

  return (
    <div className="dash">
      <div className="dash-screen">
        <section
          className="dash-map"
          aria-label="Map"
          data-side-open={sideOpen || undefined}
          data-placing={placing || undefined}
        >
          <MapView />
          <div className="dash-area-tools">
            <AreaToolbar />
            <DownloadMenu />
            <ShareButton />
          </div>

          {/* Phones: the full-screen side panel steps aside while an ignition point is
              picked (it would cover the map), and this bar says what to do. */}
          <MapBars />

          {placing && (
            <div className="sim-place-hint" role="status">
              <span>Tap the map where the fire starts</span>
              <button type="button" className="sim-place-cancel" onClick={() => useSimStore.getState().setPlacing(false)}>
                Cancel
              </button>
            </div>
          )}

          <aside id="dash-side" className="dash-side" data-open={sideOpen} aria-label="Calendar, risk and featured fires">
            <button
              ref={sideHandle}
              type="button"
              className="dash-side-tab"
              onClick={() => setSideOpen(!sideOpen)}
              aria-expanded={sideOpen}
              aria-controls="dash-side-panel"
              aria-label={sideOpen ? 'Close side panel' : 'Open side panel'}
            >
              {sideOpen ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
            </button>
            <div id="dash-side-panel" className="dash-side-panel" inert={!sideOpen}>
              <div className="side-head">
                <div className="side-tabs" role="tablist" aria-label="Side panel" ref={tabRow}>
                  <span className="side-tab-line" ref={tabLine} aria-hidden="true" />
                  {SIDE_TABS.map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      id={`side-tab-${id}`}
                      aria-selected={sideTab === id}
                      aria-controls={`side-pane-${id}`}
                      className="side-tab"
                      onClick={() => setSideTab(id)}
                    >
                      <Icon size={15} aria-hidden="true" />
                      {label}
                    </button>
                  ))}
                </div>
                {/* Phones: the panel covers the screen and its edge tab is off-screen */}
                <button
                  type="button"
                  className="dash-side-close"
                  aria-label="Close side panel"
                  onClick={() => {
                    revealMap(); // on the Risk tab, the hexagons stay on the map
                    // Back to the edge tab once it's shown again (after this render)
                    requestAnimationFrame(() => sideHandle.current?.focus({ preventScroll: true }));
                  }}
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
              <div
                className="side-pane"
                role="tabpanel"
                id={`side-pane-${sideTab}`}
                aria-labelledby={`side-tab-${sideTab}`}
              >
                {sideTab === 'calendar' && <CalendarWidget />}
                {sideTab === 'risk' && <RiskPanel />}
                {sideTab === 'featured' && <FeaturedList />}
                {sideTab === 'simulate' && <SimulationPanel />}
              </div>
            </div>
          </aside>
        </section>

        <div className="dash-timebar" role="group" aria-label="Date range and time slider">
          {coverage ? (
            <DateRangeInputs min={coverage.first} max={coverage.last} />
          ) : (
            <p className="dash-timebar-msg">{health.error ? 'Data service unavailable' : 'Loading…'}</p>
          )}
          <TimeSlider />
        </div>
      </div>

      <section id="stats" className="dash-stats" aria-label="Statistics">
        <StatsPanel />
      </section>
    </div>
  );
}

export default function Dashboard() {
  return (
    <QueryClientProvider client={queryClient}>
      <DashboardShell />
    </QueryClientProvider>
  );
}
