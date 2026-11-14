import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import { Download, LoaderCircle } from 'lucide-react';
import { saveBlob, toCsv } from '../../../lib/api';
import 'uplot/dist/uPlot.min.css';

export interface Series {
  label: string;
  color: string;
  dash?: number[];
}

interface Props {
  title: string;
  /** [x (unix seconds), ...one array per series]. */
  data: uPlot.AlignedData;
  series: Series[];
  /** The slider's window, [from, to) in unix seconds: shaded on the chart. */
  band: [number, number] | null;
  format: (v: number) => string;
  note?: string;
  /** The x-axis span, [from, to) in unix seconds; defaults to the data's. */
  xRange?: [number, number];
  /** Draw each value as a flat step until the next one (monthly data). */
  stepped?: boolean;
  /** Shown over the chart when every value is missing. */
  emptyText?: string;
  /** New data is on its way: the chart dims until it arrives. */
  updating?: boolean;
  /** Draw bars instead of lines. */
  bars?: boolean;
  /** y-axis span from the data's [min, max]; default starts at 0. */
  yRange?: (min: number, max: number) => [number, number];
  /** Allowed gaps between y-axis labels. */
  yIncrs?: number[];
  /** Downloaded files are named `<fileName>.csv` / `.png`. */
  fileName: string;
  /** The chart's data as a table, for the CSV download. */
  csv: () => { header: string[]; rows: (string | number | null)[][] };
  /** Data sources, printed under the downloaded image. */
  source: string;
  /** What one x step is, for the hover label: "27 Oct 2026" or "Oct 2026". */
  xUnit?: 'day' | 'month';
}

const AXIS = '#b0b8c4';
const GRID = '#2b3545';
const BAND = 'rgba(255, 122, 26, 0.16)';
const BAND_EDGE = 'rgba(255, 122, 26, 0.9)';
const HEIGHT = 190;

/** One measure over time (never two y-scales), with the slider's window shaded. */
export default function TimeSeriesChart({
  title,
  data,
  series,
  band,
  format,
  note,
  xRange,
  stepped,
  emptyText,
  updating,
  bars,
  yRange,
  yIncrs,
  fileName,
  csv,
  source,
  xUnit = 'day',
}: Props) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const bandRef = useRef(band);
  const formatRef = useRef(format);
  bandRef.current = band;
  formatRef.current = format;
  const seriesKey = JSON.stringify({ series, xRange, stepped, bars, yIncrs, xUnit });
  const yRangeRef = useRef(yRange);
  yRangeRef.current = yRange;
  const empty = data.slice(1).every((ys) => (ys as (number | null)[]).every((v) => v == null));

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fmt = (v: number | null) => (v == null ? '–' : formatRef.current(v));
    const u = new uPlot(
      {
        width: el.clientWidth,
        height: HEIGHT,
        scales: { x: { time: true, ...(xRange ? { range: () => xRange } : {}) }, y: {
            range: (_u, min, max) =>
              yRangeRef.current ? yRangeRef.current(min, max) : [0, max > 0 ? max * 1.1 : 1],
          },
        },
        axes: [
          { stroke: AXIS, grid: { stroke: GRID, width: 1 }, ticks: { show: false }, font: '11px Inter Variable, sans-serif' },
          {
            stroke: AXIS,
            grid: { stroke: GRID, width: 1 },
            ticks: { show: false },
            size: 52,
            font: '11px Inter Variable, sans-serif',
            values: (_u, vals) => vals.map((v) => fmt(v)),
            ...(yIncrs ? { incrs: yIncrs } : {}),
          },
        ],
        series: [
          {
            label: 'Date',
            value: (_u: uPlot, v: number | null) =>
              v == null
                ? '–'
                : new Date(v * 1000).toLocaleDateString('en-AU', {
                    ...(xUnit === 'day' ? { day: 'numeric' } : {}),
                    month: 'short',
                    year: 'numeric',
                    timeZone: 'UTC',
                  }),
          },
          ...series.map((s) => ({
            label: s.label,
            stroke: s.color,
            width: 2,
            dash: s.dash,
            points: { show: false },
            ...(stepped ? { paths: uPlot.paths.stepped!({ align: 1 }) } : {}),
            ...(bars ? { paths: uPlot.paths.bars!({ size: [0.7, 24] }), fill: s.color, width: 0 } : {}),
            value: (_u: uPlot, v: number | null) => fmt(v),
          })),
        ],
        cursor: { drag: { x: false, y: false }, points: { size: 8 } },
        legend: { live: true },
        hooks: {
          drawClear: [
            (p) => {
              const b = bandRef.current;
              if (!b) return;
              const ctx = p.ctx;
              const x0 = Math.max(p.bbox.left, p.valToPos(b[0], 'x', true));
              const x1 = Math.min(p.bbox.left + p.bbox.width, p.valToPos(b[1], 'x', true));
              if (x1 < p.bbox.left || x0 > p.bbox.left + p.bbox.width) return;
              ctx.save();
              ctx.fillStyle = BAND;
              ctx.fillRect(x0, p.bbox.top, Math.max(2, x1 - x0), p.bbox.height);
              ctx.fillStyle = BAND_EDGE;
              ctx.fillRect(Math.min(x1, p.bbox.left + p.bbox.width) - 2, p.bbox.top, 2, p.bbox.height);
              ctx.restore();
            },
          ],
        },
      },
      data,
      el,
    );
    plot.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: HEIGHT }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
    // Rebuilt only when the series change; data and the band are updated below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesKey]);

  useEffect(() => {
    plot.current?.setData(data);
  }, [data]);

  useEffect(() => {
    plot.current?.redraw(false);
  }, [band?.[0], band?.[1]]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menu]);

  const saveCsv = () => {
    const { header, rows } = csv();
    saveBlob(new Blob([toCsv(header, rows)], { type: 'text/csv' }), `${fileName}.csv`);
    setMenu(false);
  };

  // The chart as drawn, on the dashboard's background, with title, legend and sources.
  const savePng = () => {
    const u = plot.current;
    if (!u) return;
    const src = u.ctx.canvas;
    const k = src.width / u.width;
    const pad = 16 * k;
    const head = 30 * k;
    const foot = 44 * k;
    const out = document.createElement('canvas');
    out.width = src.width + pad * 2;
    out.height = src.height + head + foot + pad;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#131820';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.fillStyle = '#f4efe8';
    ctx.font = `600 ${14 * k}px Inter Variable, Inter, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(note ? `${title} · ${note}` : title, pad, pad);
    ctx.drawImage(src, pad, pad + head);
    let x = pad;
    const y = pad + head + src.height + 10 * k;
    ctx.font = `${11 * k}px Inter Variable, Inter, sans-serif`;
    for (const s of series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(x, y + 2 * k, 10 * k, 10 * k);
      ctx.fillStyle = '#b0b8c4';
      ctx.fillText(s.label, x + 14 * k, y);
      x += ctx.measureText(s.label).width + 30 * k;
    }
    ctx.fillStyle = '#8e98a7';
    ctx.fillText(`EmberEye · ${source}`, pad, y + 18 * k);
    out.toBlob((b) => b && saveBlob(b, `${fileName}.png`), 'image/png');
    setMenu(false);
  };

  return (
    <figure className="stats-chart" data-updating={updating || undefined} aria-busy={updating || undefined}>
      <figcaption className="stats-chart-title">
        {title}
        {note && <span className="stats-chart-note">{note}</span>}
        {updating && <LoaderCircle size={12} className="stat-spin" aria-label="Updating" />}
        <div className="chart-dl" ref={menuRef}>
          <button
            type="button"
            className="chart-dl-btn"
            onClick={() => setMenu((m) => !m)}
            aria-expanded={menu}
            aria-label={`Download ${title}`}
            title="Download this chart"
            disabled={empty}
          >
            <Download size={14} aria-hidden="true" />
          </button>
          {menu && (
            <div className="chart-dl-menu">
              <button type="button" onClick={saveCsv}>
                Data (CSV)
              </button>
              <button type="button" onClick={savePng}>
                Image (PNG)
              </button>
            </div>
          )}
        </div>
      </figcaption>
      <div className="stats-chart-body">
        <div ref={box} className="stats-chart-plot" />
        {empty && emptyText && !updating && <p className="stats-chart-empty">{emptyText}</p>}
      </div>
    </figure>
  );
}
