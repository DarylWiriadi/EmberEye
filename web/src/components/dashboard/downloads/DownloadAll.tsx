import { useRef, useState } from 'react';
import { FolderDown, LoaderCircle } from 'lucide-react';
import { useActiveBbox, useAppStore } from '../../../store/useAppStore';
import {
  bboxParam,
  fetchBlob,
  getJson,
  saveBlob,
  toCsv,
  useHealth,
  type CalendarResponse,
  type ExportEstimate,
} from '../../../lib/api';
import { calendarPng } from '../../../lib/calendarImage';
import type { ChartExport } from '../stats/TimeSeriesChart';

/** Bigger hotspot files are left out of the ZIP (built in memory) and pointed to. */
const MAX_HOTSPOT_BYTES = 50e6;
const MIN_BUSY_MS = 1_500;

const mb = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

interface Props {
  /** The stats charts' exports, by file name (e.g. "fire_activity"). */
  charts: Map<string, ChartExport>;
}

/** One ZIP with everything for the current area and dates. */
export default function DownloadAll({ charts }: Props) {
  const { bbox, picked } = useActiveBbox();
  const areaLabel = useAppStore((s) => s.area?.label);
  const range = useAppStore((s) => s.dateRange);
  const coverage = useHealth().data?.coverage;
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);

  const build = async () => {
    if (!bbox || !range || !coverage || locked.current) return;
    locked.current = true;
    setError(null);
    const clicked = Date.now();
    try {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      const params = { bbox: bboxParam(bbox), start: range.start, end: range.end };
      const where = picked && areaLabel ? areaLabel : 'Current map view';

      setStep('Checking hotspots…');
      const estimate = await getJson<ExportEstimate>('/export-estimate', params);
      let hotspotNote: string;
      if (estimate.bytes <= MAX_HOTSPOT_BYTES) {
        setStep('Gathering hotspots…');
        zip.file('hotspots.csv', await fetchBlob('/export.csv', params));
        hotspotNote = `hotspots.csv            Every observed detection (${estimate.hotspots.toLocaleString()}): date, time, location, sensor, confidence, FRP.`;
      } else {
        hotspotNote = `hotspots.csv            Not included: ${estimate.exact ? '' : 'about '}${estimate.hotspots.toLocaleString()} hotspots (~${mb(estimate.bytes)}) is too large for this ZIP. Use Download > Hotspots (CSV).`;
      }

      setStep('Gathering the monthly summary…');
      zip.file('monthly_summary.csv', await fetchBlob('/export-summary.csv', params));

      setStep('Drawing the calendar…');
      const cal = await getJson<CalendarResponse>('/calendar', {
        bbox: params.bbox,
        level: 'month',
        start: coverage.first,
        end: coverage.last,
      });
      zip.file(
        'calendar_all_years.csv',
        toCsv(
          ['month', 'fire_cell_days_harmonized', 'usual_median_fire_cell_days', 'times_usual'],
          cal.data.map((p) => [p.period, p.fire_days, p.median, p.ratio_to_median]),
        ),
      );
      const calImage = await calendarPng(cal.data, where);
      if (calImage) zip.file('calendar_all_years.png', calImage);

      setStep('Adding the charts…');
      const chartFolder = zip.folder('charts')!;
      for (const [name, chart] of charts) {
        chartFolder.file(`${name}.csv`, chart.csv());
        const png = await chart.png();
        if (png) chartFolder.file(`${name}.png`, png);
      }

      zip.file('README.txt', readme({ where, bbox, range, hotspotNote, charts: [...charts.keys()] }));

      setStep('Zipping…');
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      saveBlob(blob, `embereye_${range.start}_${range.end}.zip`);
    } catch (e) {
      setError((e as Error).message || 'Could not build the ZIP.');
    } finally {
      const left = MIN_BUSY_MS - (Date.now() - clicked);
      if (left > 0) await new Promise((r) => window.setTimeout(r, left));
      locked.current = false;
      setStep(null);
    }
  };

  const ready = !!bbox && !!range && !!coverage;
  return (
    <div className="download-all">
      <button type="button" className="download-toggle download-all-btn" onClick={build} disabled={!ready || step !== null} data-busy={step !== null || undefined}>
        {step ? <LoaderCircle size={18} className="download-spin" aria-hidden="true" /> : <FolderDown size={18} aria-hidden="true" />}
        <span aria-live="polite">{step ?? 'Download all (ZIP)'}</span>
      </button>
      <p className="download-all-note">
        Hotspots, monthly summary, burning calendar and every chart above (CSV + PNG), with a README, for{' '}
        {picked ? 'the selected area' : 'the current map view'} and these dates.
      </p>
      {error && (
        <p className="download-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function readme(o: {
  where: string;
  bbox: [number, number, number, number];
  range: { start: string; end: string };
  hotspotNote: string;
  charts: string[];
}) {
  const [w, s, e, n] = o.bbox.map((v) => v.toFixed(2));
  return `EmberEye export
===============

Area:      ${o.where}
           west ${w}, south ${s}, east ${e}, north ${n} (degrees)
Dates:     ${o.range.start} to ${o.range.end}
Exported:  ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC
Site:      ${window.location.origin}

Files
-----
${o.hotspotNote}
monthly_summary.csv     Harmonized fire cell-days for each month the dates touch, with the
                        historical median and the anomaly (times the median).
calendar_all_years.*    Burning calendar for this area: every month since July 2002 (harmonized).
charts/                 The stats panel charts for these dates, as data (CSV) and images (PNG):
                        ${o.charts.join(', ')}.

Observed, harmonized and simulated
----------------------------------
- Hotspots and intensity (fire radiative power, FRP) are OBSERVED satellite detections:
  MODIS Aqua before 2012, VIIRS 375 m (Suomi NPP, then NOAA-20 from 3 Nov 2026) after.
- Fire activity (fire cell-days) is HARMONIZED to the VIIRS Suomi NPP scale, so years are
  comparable across sensors. A fire cell-day is one small hexagon (H3 resolution 8) with at
  least one detection on a day.
- Weather, soil wetness and the Fire Weather Index are monthly averages.
- No simulated data is included.

Harmonization
-------------
MODIS is converted to the VIIRS scale with a ratio per region and calendar month, measured where
both sensors watched the same fires (2012-2019). Tested on years the method never saw: calibrated
on 2012-2016, it predicted 2017-2019 VIIRS from MODIS alone within 2.2% per month worldwide
(raw MODIS: 76.9% off) and 16.9% median error for single regions and months.

Data sources
------------
- NASA FIRMS active fires (MODIS Aqua Collection 6.1, VIIRS 375 m Suomi NPP and NOAA-20)
  https://firms.modaps.eosdis.nasa.gov/
- NASA GISS GFWED, Global Fire WEather Database (Fire Weather Index)
  https://data.giss.nasa.gov/impacts/gfwed/
- NASA GMAO MERRA-2 monthly weather and soil wetness
  https://gmao.gsfc.nasa.gov/reanalysis/MERRA-2/
- MODIS MCD12C1 land cover (NASA LP DAAC)
  https://doi.org/10.5067/MODIS/MCD12C1.061

We acknowledge the use of data and imagery from LANCE FIRMS operated by NASA's Earth Science Data
and Information System (ESDIS) with funding provided by NASA Headquarters.

EmberEye is a research tool, not an official fire danger rating or warning service.
Always follow advice from your local fire and emergency services.
`;
}
