import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, Flame, Gauge } from 'lucide-react';
import { useHealth } from '../../lib/api';
import { useAppStore } from '../../store/useAppStore';
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

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type SideTab = 'calendar' | 'risk' | 'featured';
const SIDE_TABS = [
  { id: 'calendar', label: 'Calendar', Icon: CalendarDays },
  { id: 'risk', label: 'Risk', Icon: Gauge },
  { id: 'featured', label: 'Featured', Icon: Flame },
] as const;

function DashboardShell() {
  // Open by default on wide screens (the calendar lives there); closed on phones.
  const [sideOpen, setSideOpen] = useState(() => window.matchMedia('(min-width: 48rem)').matches);
  const [sideTab, setSideTab] = useState<SideTab>('calendar');
  const health = useHealth();
  const range = useAppStore((s) => s.dateRange);
  const setRange = useAppStore((s) => s.setDateRange);
  const coverage = health.data?.coverage;

  useEffect(() => {
    if (coverage && !range) setRange({ start: addDays(coverage.last, -29), end: coverage.last });
  }, [coverage, range, setRange]);

  return (
    <div className="dash">
      <div className="dash-screen">
        <section className="dash-map" aria-label="Map" data-side-open={sideOpen || undefined}>
          <MapView />
          <div className="dash-area-tools">
            <AreaToolbar />
            <DownloadMenu />
          </div>

          <aside id="dash-side" className="dash-side" data-open={sideOpen} aria-label="Calendar, risk and featured fires">
            <button
              type="button"
              className="dash-side-tab"
              onClick={() => setSideOpen((o) => !o)}
              aria-expanded={sideOpen}
              aria-controls="dash-side-panel"
              aria-label={sideOpen ? 'Close side panel' : 'Open side panel'}
            >
              {sideOpen ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
            </button>
            <div id="dash-side-panel" className="dash-side-panel" inert={!sideOpen}>
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
              <div
                className="side-pane"
                role="tabpanel"
                id={`side-pane-${sideTab}`}
                aria-labelledby={`side-tab-${sideTab}`}
              >
                {sideTab === 'calendar' && <CalendarWidget />}
                {sideTab === 'risk' && <div className="dash-slot">Risk outlook (coming soon)</div>}
                {sideTab === 'featured' && <div className="dash-slot">Featured fires (coming soon)</div>}
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
