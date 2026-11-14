import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import { useActiveBbox, useAppStore } from '../../../store/useAppStore';
import { bboxParam, downloadFile, startDownload, useExportEstimate, type ExportEstimate } from '../../../lib/api';
import { formatWindow } from '../../../lib/steps';

const OPTIONS = [
  {
    id: 'hotspots',
    path: '/export.csv',
    label: 'Hotspots (CSV)',
    hint: 'Every observed detection: date, time, location, sensor, confidence, FRP',
    // Can be very large: streamed straight to disk by the browser.
    streamed: true,
  },
  {
    id: 'summary',
    path: '/export-summary.csv',
    label: 'Monthly summary (CSV)',
    hint: 'Harmonized counts for each month your dates touch, with the historical median and anomaly',
    streamed: false,
  },
] as const;

type OptionId = (typeof OPTIONS)[number]['id'];

/** The loading state shows for at least this long. */
const MIN_BUSY_MS = 1_500;
/** No new download within this long of the previous one starting. */
const MIN_GAP_MS = 1_500;

function formatSize(bytes: number) {
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  if (bytes < 1e7) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** Whole months the range touches: the monthly summary has one row each. */
function monthsTouched(start: string, end: string) {
  const [ys, ms] = start.split('-').map(Number);
  const [ye, me] = end.split('-').map(Number);
  return (ye - ys) * 12 + (me - ms) + 1;
}

function formatCount(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} million`;
  return n.toLocaleString();
}

/** "9,907 hotspots · ~0.8 MB" or "About 1.3 million hotspots · ~110 MB". */
function describe(e: ExportEstimate) {
  const n = e.exact ? e.hotspots.toLocaleString() : `About ${formatCount(e.hotspots)}`;
  return `${n} hotspot${e.hotspots === 1 ? '' : 's'} · ~${formatSize(e.bytes)}`;
}

export default function DownloadMenu() {
  const { bbox, picked } = useActiveBbox();
  const range = useAppStore((s) => s.dateRange);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<OptionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => setError(null), [bbox, range]);

  const ready = !!bbox && !!range;
  const estimate = useExportEstimate(bbox, range, open);
  const months = range ? monthsTouched(range.start, range.end) : 0;
  // ~88 bytes per month row plus the header line (measured).
  const summarySize = `${months.toLocaleString()} month${months === 1 ? '' : 's'} · ~${formatSize(120 + 88 * months)}`;

  // Set synchronously, so a second click is ignored even before React re-renders.
  const locked = useRef(false);
  const lastStart = useRef(0);

  const save = async (option: (typeof OPTIONS)[number]) => {
    if (!bbox || !range || locked.current) return;
    if (Date.now() - lastStart.current < MIN_GAP_MS) return;
    locked.current = true;
    lastStart.current = Date.now();
    setBusy(option.id);
    setError(null);
    const clicked = Date.now();
    try {
      const params = { bbox: bboxParam(bbox), start: range.start, end: range.end };
      await (option.streamed ? startDownload(option.path, params) : downloadFile(option.path, params));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      const left = MIN_BUSY_MS - (Date.now() - clicked);
      if (left > 0) await new Promise((r) => window.setTimeout(r, left));
      locked.current = false;
      setBusy(null);
    }
  };

  return (
    <div className="download-menu" ref={root}>
      <button
        type="button"
        className="download-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="download-panel"
        disabled={!ready}
      >
        <Download size={18} aria-hidden="true" />
        Download
      </button>
      {open && ready && (
        <div id="download-panel" className="download-panel">
          <p className="download-scope">
            {picked ? 'Selected area' : 'Current map view'} · {formatWindow(range)}
          </p>
          {OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              className="download-option"
              onClick={() => save(o)}
              disabled={busy !== null}
              data-busy={busy === o.id || undefined}
            >
              <span className="download-option-label">
                {o.label}
                {busy === o.id && (
                  <span className="download-busy">
                    <LoaderCircle size={14} className="download-spin" aria-hidden="true" />
                    Starting…
                  </span>
                )}
              </span>
              <span className="download-option-hint">{o.hint}</span>
              <span className="download-option-size">
                {o.id === 'hotspots'
                  ? estimate.data
                    ? describe(estimate.data)
                    : estimate.isFetching
                      ? 'Checking size…'
                      : ''
                  : summarySize}
              </span>
            </button>
          ))}
          {error && (
            <p className="download-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
