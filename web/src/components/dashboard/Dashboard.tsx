import { useEffect, useRef } from 'react';
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
                <div className="side-tabs" role="tablist" aria-label="Side panel">
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

      <section className="dash-stats" aria-label="Statistics">
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
