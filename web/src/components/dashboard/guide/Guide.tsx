import { useEffect, useRef } from 'react';
import { CalendarDays, CalendarRange, Download, Flame, Gauge, Map, ScanSearch, SquareDashed, X } from 'lucide-react';
import { featuredFire } from '../../../lib/featuredFires';
import { openFeaturedFire } from '../../../lib/openFeaturedFire';

const SEEN_KEY = 'embereye-guide-seen';

/** First visit: show the guide (unless the page opened a shared or featured view). */
export function guideWanted(): boolean {
  try {
    return !window.localStorage.getItem(SEEN_KEY);
  } catch {
    return true;
  }
}

function markSeen() {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Private mode: the guide may show again next time, which is fine.
  }
}

const TIPS = [
  { Icon: Map, title: 'Map', text: 'Each dot is a fire detected by satellite (a “hotspot”), coloured by how intense it was. Zoom in to see every one, and outlines of recently burned ground.' },
  { Icon: Download, title: 'Download and share', text: 'Get the data as CSV or everything as a ZIP. Click Share to copy a link to your current view; anyone who opens it sees the same place, dates and simulation.' },
  { Icon: SquareDashed, title: 'Keep one area fixed', text: 'Use Draw area or Coordinates in the top bar. Then moving the map no longer changes the numbers.' },
  { Icon: Flame, title: 'Simulate and risk', text: 'Start a fire anywhere and watch an estimated spread, or see where fire is more likely than usual.' },
  { Icon: CalendarDays, title: 'Burning calendar', text: 'A grid of every month since 2002, showing how busy fire activity was in your map area (right panel). Switch to “vs usual” to see which months were busier or quieter than normal there.' },
  { Icon: CalendarRange, title: 'Dates and stats', text: 'Pick a start and end date at the bottom. The slider moves through that period a day (or, for long periods, a few days) at a time: drag it, or press play to watch the fires unfold. Scroll down below the map for charts of fire activity, intensity and weather over those dates.' },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

/** A short welcome guide to the dashboard (native dialog: focus stays inside, Esc closes). */
export default function Guide({ open, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Start at the top (the key note), even though focus goes to the button below.
      primary.current?.focus({ preventScroll: true });
      d.scrollTop = 0;
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  const close = () => {
    markSeen();
    onClose();
  };

  const showBlackSummer = () => {
    const fire = featuredFire('black-summer');
    if (fire) openFeaturedFire(fire);
    close();
  };

  return (
    <dialog
      ref={dialog}
      className="guide"
      aria-labelledby="guide-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        // A click on the backdrop (outside the card) closes it.
        if (e.target === dialog.current) close();
      }}
    >
      <div className="guide-card">
        <button type="button" className="guide-x" onClick={close} aria-label="Close the guide">
          <X size={18} aria-hidden="true" />
        </button>
        <h2 id="guide-title" className="guide-title">
          Welcome to the EmberEye dashboard
        </h2>
        <p className="guide-lede">
          EmberEye shows where and when fires have burned anywhere on Earth since 2002, using NASA satellite data.
          Older and newer satellites count fires differently, so we adjusted them to one consistent scale. That way you
          can fairly compare this year with the past, and spot unusually busy fire seasons.
        </p>
        <div className="guide-key">
          <ScanSearch size={20} aria-hidden="true" />
          <div>
            <p>
              <strong>What you see on the map is what gets counted.</strong> The charts below the map, the burning
              calendar and the downloads only include fires inside your current map view.
            </p>
            <ul role="list">
              <li>
                Zoomed in on Australia: the fire counts in the charts and calendar, and the hotspots you download, are
                for fires in Australia only.
              </li>
              <li>Move or zoom the map, and a moment later the charts, calendar and downloads update to match the new view.</li>
            </ul>
          </div>
        </div>
        <ul className="guide-tips" role="list">
          {TIPS.map(({ Icon, title, text }) => (
            <li key={title}>
              <span className="guide-icon">
                <Icon size={18} aria-hidden="true" />
              </span>
              <span>
                <strong>{title}</strong>
                {text}
              </span>
            </li>
          ))}
        </ul>
        <p className="guide-note">
          <Gauge size={14} aria-hidden="true" /> Simulations and the risk outlook are estimates, not official fire warnings.
        </p>
        <div className="guide-actions">
          <button type="button" ref={primary} className="guide-primary" onClick={showBlackSummer}>
            Show Black Summer (2019–20)
          </button>
          <button type="button" className="guide-secondary" onClick={close}>
            Explore on my own
          </button>
        </div>
        <p className="guide-hint">Reopen this any time with the ? button in the top bar.</p>
      </div>
    </dialog>
  );
}
