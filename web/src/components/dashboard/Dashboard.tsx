import { useState } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import './Dashboard.css';

/**
 * Dashboard layout shell (CLAUDE.md section 7). Each region is an empty slot
 * for now; the real components (MapView, CalendarWidget, TimeSlider, ...) go in.
 *
 *   ┌──────────────────────────────┬────────┐
 *   │ top bar: area tools + dates  │        │
 *   ├──────────────────────────────┤  side  │
 *   │ map              [calendar]  │ panel  │
 *   ├──────────────────────────────┤ (risk, │
 *   │ time slider                  │ fires) │
 *   ├──────────────────────────────┤        │
 *   │ stats panel                  │        │
 *   └──────────────────────────────┴────────┘
 */
export default function Dashboard() {
  const [sideOpen, setSideOpen] = useState(true);

  return (
    <div className="dash" data-side-open={sideOpen}>
      <div className="dash-top" role="toolbar" aria-label="Area and date range">
        <div className="dash-slot">Area tools</div>
        <div className="dash-slot">Date range</div>
        <button
          type="button"
          className="dash-icon-btn"
          onClick={() => setSideOpen((o) => !o)}
          aria-expanded={sideOpen}
          aria-controls="dash-side"
          aria-label={sideOpen ? 'Hide side panel' : 'Show side panel'}
        >
          {sideOpen ? <PanelRightClose size={20} /> : <PanelRightOpen size={20} />}
        </button>
      </div>

      <section className="dash-map" aria-label="Map">
        <div className="dash-calendar dash-slot" aria-label="Burning calendar">
          Calendar
        </div>
      </section>

      <div className="dash-slider dash-slot" aria-label="Time slider">
        Time slider
      </div>

      <section className="dash-stats dash-slot" aria-label="Statistics">
        Stats
      </section>

      <aside id="dash-side" className="dash-side" aria-label="Risk and featured fires" hidden={!sideOpen}>
        <div className="dash-slot">Risk outlook</div>
        <div className="dash-slot">Featured fires</div>
      </aside>
    </div>
  );
}
