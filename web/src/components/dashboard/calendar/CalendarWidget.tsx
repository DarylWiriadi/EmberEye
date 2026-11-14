import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useActiveBbox, useAppStore, useSliderWindow } from '../../../store/useAppStore';
import { useCalendar, useHealth, type CalendarPeriod } from '../../../lib/api';
import { DIVERGING_CSS, VIRIDIS_CSS, diverging, viridis } from '../../../lib/colors';

type Mode = 'counts' | 'anomaly';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const EMPTY = '#1b2230';
/** log2 of (activity / usual) at which the anomaly colour is fully saturated (4x / quarter). */
const ANOMALY_SPAN = 2;

const monthEnd = (ym: string) => {
  const d = new Date(`${ym}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
};
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const dayLabel = (iso: string) => `${Number(iso.slice(8))} ${monthLabel(iso.slice(0, 7))}`;
const rgb = (c: ArrayLike<number>) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

function describe(p: CalendarPeriod | undefined, label: string) {
  if (!p) return `${label}: no data`;
  const v = `${Math.round(p.fire_days).toLocaleString()} fire cell-days`;
  const r = p.ratio_to_median;
  const vs = r == null ? '' : r >= 1.15 || r <= 0.85 ? ` · ${r >= 10 ? Math.round(r) : r.toFixed(1)}× usual` : ' · about usual';
  return `${label} · ${v}${vs}`;
}

export default function CalendarWidget() {
  const coverage = useHealth().data?.coverage;
  const { bbox } = useActiveBbox();
  const range = useAppStore((s) => s.dateRange);
  const setRange = useAppStore((s) => s.setDateRange);
  const jumpToDate = useAppStore((s) => s.jumpToDate);
  const win = useSliderWindow();

  const [mode, setMode] = useState<Mode>('counts');
  const [month, setMonth] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: string; to: string } | null>(null);
  const anchor = useRef<string | null>(null);

  const all = coverage ? { start: coverage.first, end: coverage.last } : null;
  const years = useCalendar(bbox, all, 'month');
  const monthRange = month && coverage
    ? { start: `${month}-01`, end: monthEnd(month) < coverage.last ? monthEnd(month) : coverage.last }
    : null;
  const days = useCalendar(bbox, monthRange, 'day');

  const level = month ? 'day' : 'month';
  const data = (month ? days.data : years.data)?.data ?? [];
  const byKey = useMemo(() => new Map(data.map((p) => [p.period, p])), [data]);
  // Colours stretch between this area's own quiet and busy periods (log scale):
  // from the 5th percentile of non-zero values up to the maximum.
  const [lo, max] = useMemo(() => {
    const vals = data.map((p) => p.fire_days).filter((v) => v > 0).sort((a, b) => a - b);
    if (!vals.length) return [1, 1];
    return [Math.max(vals[Math.floor(vals.length * 0.05)], 0.01), vals[vals.length - 1]];
  }, [data]);
  const loading = month ? days.isFetching : years.isFetching;

  const colour = (p: CalendarPeriod | undefined) => {
    if (!p) return EMPTY;
    if (mode === 'anomaly') {
      if (p.median == null || p.median <= 0) return p.fire_days > 0 ? rgb(diverging(1)) : EMPTY;
      const lr = Math.log2(Math.max(p.fire_days, p.median / 2 ** ANOMALY_SPAN) / p.median);
      return rgb(diverging(lr / ANOMALY_SPAN));
    }
    if (p.fire_days <= 0) return EMPTY;
    const t = max > lo ? Math.log(Math.max(p.fire_days, lo) / lo) / Math.log(max / lo) : 1;
    return rgb(viridis(0.08 + 0.92 * t));
  };

  // Selection: a cell's key is YYYY-MM (years view) or YYYY-MM-DD (month view).
  const span = (a: string, b: string) => (a <= b ? [a, b] : [b, a]);
  const toRange = (a: string, b: string) => {
    const [lo, hi] = span(a, b);
    let start = lo.length === 7 ? `${lo}-01` : lo;
    let end = hi.length === 7 ? monthEnd(hi) : hi;
    if (coverage) {
      if (start < coverage.first) start = coverage.first;
      if (end > coverage.last) end = coverage.last;
    }
    return { start, end };
  };
  const activate = (key: string) => {
    if (key.length === 7) {
      setMonth(key);
      setHover(null);
    } else {
      jumpToDate(key, all ?? undefined);
    }
  };
  const keyAt = (x: number, y: number) =>
    (document.elementFromPoint(x, y)?.closest('[data-key]') as HTMLElement | null)?.dataset.key ?? null;

  const onPointerDown = (e: React.PointerEvent) => {
    const key = keyAt(e.clientX, e.clientY);
    if (!key || e.button !== 0) return;
    e.preventDefault();
    if (e.shiftKey && anchor.current && anchor.current.length === key.length) {
      setRange(toRange(anchor.current, key));
      return;
    }
    setDrag({ from: key, to: key });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const key = keyAt(e.clientX, e.clientY);
    if (key) setHover(key);
    if (drag && key && key.length === drag.from.length && key !== drag.to) setDrag({ ...drag, to: key });
  };
  useEffect(() => {
    if (!drag) return;
    const up = () => {
      if (drag.from === drag.to) {
        anchor.current = drag.from;
        activate(drag.from);
      } else {
        setRange(toRange(drag.from, drag.to));
      }
      setDrag(null);
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  });

  const inRange = (key: string) => {
    if (!range) return false;
    return key.length === 7 ? `${key}-01` <= range.end && monthEnd(key) >= range.start : key >= range.start && key <= range.end;
  };
  const atSlider = (key: string) => {
    if (!win) return false;
    return key.length === 7 ? `${key}-01` <= win.end && monthEnd(key) >= win.start : key >= win.start && key <= win.end;
  };
  const pending = (key: string) => {
    if (!drag || drag.from === drag.to || key.length !== drag.from.length) return false;
    const [lo, hi] = span(drag.from, drag.to);
    return key >= lo && key <= hi;
  };

  const cell = (key: string, label: string, available: boolean) => {
    if (!available) return <span key={key} className="cal-cell cal-cell-off" />;
    const p = byKey.get(key);
    return (
      <button
        key={key}
        type="button"
        data-key={key}
        className="cal-cell"
        style={{ background: colour(p) }}
        data-range={inRange(key) || undefined}
        data-slider={atSlider(key) || undefined}
        data-pending={pending(key) || undefined}
        aria-label={`${describe(p, label)}. ${key.length === 7 ? 'Open month' : 'Show this day'}`}
        onFocus={() => setHover(key)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate(key);
          }
        }}
      />
    );
  };

  const yearsGrid = () => {
    if (!coverage) return null;
    const first = Number(coverage.first.slice(0, 4));
    const last = Number(coverage.last.slice(0, 4));
    const rows = [];
    for (let y = first; y <= last; y++) {
      rows.push(
        <div key={y} className="cal-row">
          <span className="cal-year">{y}</span>
          {MONTHS.map((_, i) => {
            const key = `${y}-${String(i + 1).padStart(2, '0')}`;
            const ok = monthEnd(key) >= coverage.first && `${key}-01` <= coverage.last;
            return cell(key, monthLabel(key), ok);
          })}
        </div>,
      );
    }
    return (
      <div className="cal-years">
        <div className="cal-row cal-head">
          <span className="cal-year" />
          {MONTHS.map((m) => (
            <span key={m} className="cal-colhead">
              {m[0]}
            </span>
          ))}
        </div>
        {rows}
      </div>
    );
  };

  const monthGrid = () => {
    if (!month || !coverage) return null;
    const first = new Date(`${month}-01T00:00:00Z`);
    const lead = (first.getUTCDay() + 6) % 7; // Monday first
    const n = Number(monthEnd(month).slice(8));
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(<span key={`pad${i}`} className="cal-cell cal-cell-off cal-pad" />);
    for (let d = 1; d <= n; d++) {
      const key = `${month}-${String(d).padStart(2, '0')}`;
      cells.push(cell(key, dayLabel(key), key >= coverage.first && key <= coverage.last));
    }
    return (
      <div className="cal-month">
        {WEEKDAYS.map((w, i) => (
          <span key={i} className="cal-colhead">
            {w}
          </span>
        ))}
        {cells}
      </div>
    );
  };

  const status = hover
    ? describe(byKey.get(hover), hover.length === 7 ? monthLabel(hover) : dayLabel(hover))
    : month
      ? 'Click a day to show it · drag to choose dates'
      : 'Click a month to open it · drag to choose dates';

  return (
    <section className="cal" aria-label="Burning calendar">
      <header className="cal-top">
        {month ? (
          <button type="button" className="cal-back" onClick={() => setMonth(null)} aria-label="Back to all years">
            <ChevronLeft size={14} aria-hidden="true" />
            <span>All years</span>
            <span className="cal-crumb">› {monthLabel(month)}</span>
          </button>
        ) : (
          <h2 className="cal-title">Burning calendar</h2>
        )}
        <div className="cal-modes" role="group" aria-label="Colour by">
          <button type="button" aria-pressed={mode === 'counts'} onClick={() => setMode('counts')}>
            Counts
          </button>
          <button type="button" aria-pressed={mode === 'anomaly'} onClick={() => setMode('anomaly')}>
            vs usual
          </button>
        </div>
      </header>

      <div
        className="cal-grid"
        data-level={level}
        data-loading={loading || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
      >
        {month ? monthGrid() : yearsGrid()}
      </div>
      <div className="cal-foot">
        <span className="cal-legend" style={{ background: mode === 'counts' ? VIRIDIS_CSS : DIVERGING_CSS }} />
        <span className="cal-legend-labels">
          {mode === 'counts' ? (
            <>
              <span>Quiet</span>
              <span>Busy (log scale)</span>
            </>
          ) : (
            <>
              <span>¼× usual</span>
              <span>usual</span>
              <span>4×</span>
            </>
          )}
        </span>
        <p className="cal-status" aria-live="polite">
          {status}
        </p>
      </div>
    </section>
  );
}
