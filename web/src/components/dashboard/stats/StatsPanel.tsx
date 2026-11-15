import { useMemo, useRef } from 'react';
import { ArrowUp, LoaderCircle } from 'lucide-react';
import type uPlot from 'uplot';
import { useActiveBbox, useAppStore, useSliderWindow, useSteps } from '../../../store/useAppStore';
import { useAreaStats, useCalendar, type CalendarPeriod, type WeatherMonth } from '../../../lib/api';
import { formatWindow, windowPhrase } from '../../../lib/steps';
import TimeSeriesChart, { type ChartExport } from './TimeSeriesChart';
import DownloadAll from '../downloads/DownloadAll';

const DAY_LEVEL_MAX_DAYS = 366;
const WEATHER_EMPTY = 'No available data for these months yet';
const EMBER = '#ff7a1a';
const QUIETER = '#3d8bfd';
const SRC_FIRE = 'NASA FIRMS MODIS + VIIRS, harmonized to VIIRS S-NPP';

/** A log2 ratio as "3.2×", "1×" or "0.25×". */
const timesUsual = (lr: number) => {
  const r = 2 ** lr;
  return `${r >= 10 ? Math.round(r).toLocaleString() : r >= 1 ? r.toFixed(1).replace(/\.0$/, '') : r.toFixed(2)}×`;
};
const USUAL = '#8e98a7';
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const LAND_LABELS: Record<string, string> = {
  forest: 'Forest',
  shrubland: 'Shrubland',
  savanna: 'Savanna',
  grassland: 'Grassland',
  cropland: 'Cropland',
  other: 'Other',
};

const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;
const monthStart = (period: string) => (period.length === 7 ? `${period}-01` : period);
const monthEnd = (period: string) => {
  const d = new Date(`${period}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
};

const whole = (v: number) => Math.round(v).toLocaleString();
const compact = (v: number) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : Math.round(v).toLocaleString();

function latLon([lat, lon]: [number, number]) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
}

function vsUsual(value: number, usual: number | null) {
  if (usual == null || usual <= 0) return null;
  const r = value / usual;
  if (r >= 1.15) return `${r.toFixed(1)}× the usual for this time of year`;
  if (r <= 0.85) return `${Math.round((1 - r) * 100)}% below the usual for this time of year`;
  return 'About usual for this time of year';
}

type Status = 'loading' | 'updating' | 'ready';

const statusOf = (q: { data?: unknown; isFetching: boolean; isPlaceholderData: boolean }): Status =>
  !q.data ? 'loading' : q.isFetching || q.isPlaceholderData ? 'updating' : 'ready';

function Card({
  label,
  value,
  detail,
  status = 'ready',
  children,
}: {
  label: string;
  value: string;
  detail?: string | null;
  status?: Status;
  children?: React.ReactNode;
}) {
  return (
    <div className="stat-card" data-status={status} aria-busy={status !== 'ready'}>
      <p className="stat-card-label">
        {label}
        {status === 'updating' && <LoaderCircle size={12} className="stat-spin" aria-label="Updating" />}
      </p>
      {status === 'loading' ? (
        <>
          <span className="stat-skeleton stat-skeleton-value" />
          <span className="stat-skeleton stat-skeleton-detail" />
        </>
      ) : (
        <>
          <p className="stat-card-value">
            {value}
            {children}
          </p>
          {detail && <p className="stat-card-detail">{detail}</p>}
        </>
      )}
    </div>
  );
}

export default function StatsPanel() {
  const { bbox, picked } = useActiveBbox();
  const areaLabel = useAppStore((s) => s.area?.label);
  const range = useAppStore((s) => s.dateRange);
  const steps = useSteps();
  const win = useSliderWindow();

  const days = steps ? Math.round((steps.endTime - steps.startTime) / 86_400_000) + 1 : 0;
  const level = days <= DAY_LEVEL_MAX_DAYS ? 'day' : 'month';
  const cal = useCalendar(bbox, range, level);
  const stats = useAreaStats(bbox, range);
  const periods = cal.data?.data ?? [];
  const calStatus = statusOf(cal);
  const statsStatus = statusOf(stats);

  // Periods inside the slider's window (months that overlap it at month level).
  const inWindow = (p: CalendarPeriod) => {
    if (!win) return false;
    if (p.period.length === 10) return p.period >= win.start && p.period <= win.end;
    return monthStart(p.period) <= win.end && monthEnd(p.period) >= win.start;
  };
  const now = useMemo(() => {
    const ps = periods.filter(inWindow);
    const sum = (f: (p: CalendarPeriod) => number | null) => ps.reduce((n, p) => n + (f(p) ?? 0), 0);
    return {
      fireDays: sum((p) => p.fire_days),
      detections: sum((p) => p.detections),
      frp: sum((p) => p.frp_mw),
      usual: ps.some((p) => p.median != null) ? sum((p) => p.median) : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods, win?.start, win?.end]);

  // The slider's month, or the latest month that has data if that's newer than
  // the weather record (MERRA-2 and GFWED end a little before the fire data).
  const { weatherNow, fwiNow } = useMemo(() => {
    const month = win?.end.slice(0, 7);
    const inRange = stats.data?.weather.find((w) => w.month === month);
    const latest = stats.data?.latest;
    const pick = (has: (w: WeatherMonth) => boolean, fallback: WeatherMonth | null | undefined) =>
      inRange && has(inRange) ? { row: inRange, fallback: false } : fallback && month && fallback.month < month ? { row: fallback, fallback: true } : null;
    return {
      weatherNow: pick((w) => w.t2m != null, latest?.weather),
      fwiNow: pick((w) => w.fwi != null, latest?.fwi),
    };
  }, [stats.data, win]);

  const charts = useMemo(() => {
    const x = periods.map((p) => toTime(monthStart(p.period)));
    const weather = stats.data?.weather ?? [];
    // Monthly values drawn as steps across their month: one extra point closes the last step.
    const wx = weather.map((w) => toTime(`${w.month}-01`));
    if (weather.length) wx.push(toTime(monthEnd(weather[weather.length - 1].month)) + 86_400);
    const steps = (f: (w: WeatherMonth) => number | null) => {
      const v = weather.map(f);
      return v.length ? [...v, v[v.length - 1]] : v;
    };
    return {
      activity: [x, periods.map((p) => p.fire_days), periods.map((p) => p.median)] as uPlot.AlignedData,
      // log2 of (activity / usual): 2x and half the usual are the same height.
      // Above-usual and below-usual are separate series so they get their own colour.
      anomaly: (() => {
        const lr = periods.map((p) =>
          p.median != null && p.median > 0 ? Math.max(-5, Math.min(12, Math.log2(Math.max(p.fire_days, 0) / p.median || 2 ** -5))) : null,
        );
        return [x, lr.map((v) => (v != null && v >= 0 ? v : null)), lr.map((v) => (v != null && v < 0 ? v : null))];
      })() as uPlot.AlignedData,
      frp: [x, periods.map((p) => p.frp_mw)] as uPlot.AlignedData,
      fwi: [wx, steps((w) => w.fwi)] as uPlot.AlignedData,
      t2m: [wx, steps((w) => w.t2m)] as uPlot.AlignedData,
      soil: [wx, steps((w) => w.soil)] as uPlot.AlignedData,
    };
  }, [periods, stats.data]);
  const dateCol = level === 'day' ? 'date' : 'month';
  const weatherRows = stats.data?.weather ?? [];
  const fileName = (what: string) => `embereye_${what}_${range?.start ?? ''}_${range?.end ?? ''}`;
  // Each chart hands its CSV and PNG to "Download all".
  const exports = useRef(new Map<string, ChartExport>());
  const registers = useRef(new Map<string, (e: ChartExport | null) => void>());
  const register = (what: string) => {
    if (!registers.current.has(what)) {
      registers.current.set(what, (e) => (e ? exports.current.set(what, e) : exports.current.delete(what)));
    }
    return registers.current.get(what)!;
  };
  const xRange: [number, number] | undefined = range
    ? [toTime(range.start), toTime(range.end) + 86_400]
    : undefined;

  const band: [number, number] | null = win ? [toTime(win.start), toTime(win.end) + 86_400] : null;
  const monthBand: [number, number] | null = win
    ? [toTime(`${win.start.slice(0, 7)}-01`), toTime(monthEnd(win.end.slice(0, 7))) + 86_400]
    : null;

  if (!range || !win) return <p className="stats-empty">Loading…</p>;

  const centre = stats.data?.area.centre;
  const lc = stats.data?.landcover;
  const land = lc
    ? Object.entries(lc.shares)
        .filter(([, v]) => (v ?? 0) >= 1)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .slice(0, 3)
    : [];
  const w = weatherNow?.row;
  const fwi = fwiNow?.row;
  const windLabel =
    w?.wind_ms != null && w.wind_from_deg != null
      ? `from the ${COMPASS[Math.round(w.wind_from_deg / 22.5) % 16]}`
      : null;
  const noWeather = 'No weather data for this month yet';
  const monthName = (m: string) =>
    new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const when = (p: { row: WeatherMonth; fallback: boolean } | null) =>
    p ? (p.fallback ? `latest available, ${monthName(p.row.month)}` : monthName(p.row.month)) : '';

  return (
    <div className="stats">
      <header className="stats-head">
        <h2 className="stats-title">
          {picked ? 'Selected area' : 'Current map view'} {windowPhrase(win)}
        </h2>
        {picked && areaLabel && <p className="stats-area">{areaLabel}</p>}
        <p className="stats-sub">
          Fire activity is harmonized across MODIS and VIIRS; hotspots and intensity are observed detections;
          weather is the monthly average.
        </p>
      </header>

      <div className="stat-cards">
        <Card status={calStatus}
          label="Fire activity (cell-days)"
          value={cal.data ? whole(now.fireDays) : '…'}
          detail={cal.data ? vsUsual(now.fireDays, now.usual) : null}
        />
        <Card status={calStatus}
          label="Intensity"
          value={cal.data ? `${compact(now.frp)} MW` : '…'}
          detail={now.detections > 0 ? `${(now.frp / now.detections).toFixed(1)} MW per hotspot (FRP)` : 'Fire radiative power'}
        />
        <Card status={statsStatus}
          label="Fire Weather Index"
          value={fwi?.fwi != null ? fwi.fwi.toFixed(0) : '–'}
          detail={fwi ? `Monthly average, ${when(fwiNow)}` : noWeather}
        />
        <Card status={statsStatus}
          label="Weather"
          value={w?.t2m != null ? `${w.t2m.toFixed(0)}°C` : '–'}
          detail={
            w ? `${w.rh ?? '–'}% humidity · wind ${w.wind_ms?.toFixed(1) ?? '–'} m/s ${windLabel ?? ''} · ${when(weatherNow)}` : noWeather
          }
        >
          {w?.wind_from_deg != null && (
            <ArrowUp
              size={16}
              className="stat-wind"
              style={{ transform: `rotate(${w.wind_from_deg + 180}deg)` }}
              aria-label={windLabel ? `Wind ${windLabel}` : undefined}
            />
          )}
        </Card>
        <Card status={statsStatus}
          label="Dryness"
          value={w?.soil != null ? `${w.soil.toFixed(0)}%` : '–'}
          detail={w ? `Topsoil wetness (0% = bone dry) · ${when(weatherNow)}` : noWeather}
        />
        <Card status={statsStatus}
          label="What's burning"
          value={land.length ? `${LAND_LABELS[land[0][0]]} ${Math.round(land[0][1] ?? 0)}%` : '–'}
          detail={
            land.length > 1
              ? land
                  .slice(1)
                  .map(([k, v]) => `${LAND_LABELS[k]} ${Math.round(v ?? 0)}%`)
                  .join(' · ') + (lc?.basis === 'whole record' ? ' (whole record)' : '')
              : lc?.basis === 'whole record'
                ? 'Whole record'
                : null
          }
        />
        <Card status={statsStatus} label="Location" value={centre ? latLon(centre) : '–'} detail="Centre of the burnable area in view" />
      </div>

      <div className="stats-charts">
        <TimeSeriesChart
          updating={calStatus !== 'ready'}
          title="Fire activity (fire cell-days, harmonized)"
          fileName={fileName('fire_activity')}
          register={register('fire_activity')}
          source={SRC_FIRE}
          xUnit={level}
          csv={() => ({ header: [dateCol, 'fire_cell_days_harmonized', 'usual_median_fire_cell_days'], rows: periods.map((p) => [p.period, p.fire_days, p.median]) })}
          data={charts.activity}
          series={[
            { label: 'This period', color: EMBER },
            { label: 'Usual (median 2003–2025)', color: USUAL, dash: [5, 4] },
          ]}
          band={band}
          xRange={xRange}
          format={compact}
        />
        <TimeSeriesChart
          updating={calStatus !== 'ready'}
          title="Compared with usual"
          fileName={fileName('compared_with_usual')}
          register={register('compared_with_usual')}
          source={SRC_FIRE}
          xUnit={level}
          csv={() => ({ header: [dateCol, 'fire_cell_days_harmonized', 'usual_median_fire_cell_days', 'times_usual'], rows: periods.map((p) => [p.period, p.fire_days, p.median, p.ratio_to_median]) })}
          note="× the median for this time of year"
          data={charts.anomaly}
          series={[
            { label: 'Busier than usual', color: EMBER },
            { label: 'Quieter than usual', color: QUIETER },
          ]}
          band={band}
          xRange={xRange}
          bars
          yRange={(min, max) => [Math.min(-1, Math.floor(min)), Math.max(1, Math.ceil(max))]}
          yIncrs={[1, 2, 3, 4]}
          format={timesUsual}
        />
        <TimeSeriesChart
          updating={calStatus !== 'ready'}
          title="Intensity (fire radiative power, MW)"
          fileName={fileName('intensity_frp')}
          register={register('intensity_frp')}
          source={SRC_FIRE}
          xUnit={level}
          csv={() => ({ header: [dateCol, 'frp_mw_observed'], rows: periods.map((p) => [p.period, p.frp_mw]) })}
          data={charts.frp}
          series={[{ label: 'FRP', color: EMBER }]}
          band={band}
          xRange={xRange}
          format={compact}
        />
        <TimeSeriesChart
          updating={statsStatus !== 'ready'}
          title="Fire Weather Index"
          fileName={fileName('fire_weather_index')}
          register={register('fire_weather_index')}
          source='NASA GISS GFWED (MERRA-2; GEOS-5 rescaled after Apr 2026)'
          csv={() => ({ header: ['month', 'fire_weather_index'], rows: weatherRows.map((w) => [w.month, w.fwi]) })}
          note="GFWED, monthly"
          data={charts.fwi}
          series={[{ label: 'FWI', color: EMBER }]}
          band={monthBand}
          xRange={xRange}
          stepped
          xUnit="month"
          emptyText={WEATHER_EMPTY}
          format={(v) => v.toFixed(0)}
        />
        <TimeSeriesChart
          updating={statsStatus !== 'ready'}
          title="Temperature (°C)"
          fileName={fileName('temperature')}
          register={register('temperature')}
          source='NASA GMAO MERRA-2 monthly'
          csv={() => ({ header: ['month', 'air_temperature_c'], rows: weatherRows.map((w) => [w.month, w.t2m]) })}
          note="MERRA-2, monthly"
          data={charts.t2m}
          series={[{ label: 'Air temperature', color: EMBER }]}
          band={monthBand}
          xRange={xRange}
          stepped
          xUnit="month"
          emptyText={WEATHER_EMPTY}
          format={(v) => v.toFixed(0)}
        />
        <TimeSeriesChart
          updating={statsStatus !== 'ready'}
          title="Topsoil wetness (%)"
          fileName={fileName('topsoil_wetness')}
          register={register('topsoil_wetness')}
          source='NASA GMAO MERRA-2 monthly'
          csv={() => ({ header: ['month', 'topsoil_wetness_pct'], rows: weatherRows.map((w) => [w.month, w.soil]) })}
          note="MERRA-2, monthly · lower is drier"
          data={charts.soil}
          series={[{ label: 'Topsoil wetness', color: EMBER }]}
          band={monthBand}
          xRange={xRange}
          stepped
          xUnit="month"
          emptyText={WEATHER_EMPTY}
          format={(v) => v.toFixed(0)}
        />
      </div>
      {cal.error && <p className="stats-error">{(cal.error as Error).message}</p>}
      <DownloadAll charts={exports.current} />
    </div>
  );
}
