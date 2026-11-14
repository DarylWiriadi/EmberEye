import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useHealth } from '../../lib/api';
import { useAppStore } from '../../store/useAppStore';
import MapView from './map/MapView';
import DownloadMenu from './downloads/DownloadMenu';
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

function DashboardShell() {
  const [sideOpen, setSideOpen] = useState(false);
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
        <section className="dash-map" aria-label="Map">
          <MapView />
          <div className="dash-area-tools">
            <div className="dash-slot">Area tools</div>
            <DownloadMenu />
          </div>

          <aside id="dash-side" className="dash-side" data-open={sideOpen} aria-label="Risk and featured fires">
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
              <div className="dash-slot">Risk outlook</div>
              <div className="dash-slot">Featured fires</div>
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
        <div className="dash-slot">Stats</div>
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
