import { useEffect, useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import type { DateRange } from '../../../types';

// The map loads only once a date is settled, not on every change while picking one.
const SETTLE_MS = 700;

interface Props {
  min: string;
  max: string;
}

export default function DateRangeInputs({ min, max }: Props) {
  const range = useAppStore((s) => s.dateRange);
  const setRange = useAppStore((s) => s.setDateRange);
  const [draft, setDraft] = useState<DateRange | null>(range);

  useEffect(() => setDraft(range), [range]);

  const commit = (d: DateRange | null) => {
    if (d && range && (d.start !== range.start || d.end !== range.end)) setRange(d);
  };

  useEffect(() => {
    const id = window.setTimeout(() => commit(draft), SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!draft) return null;

  const update = (key: 'start' | 'end', value: string) => {
    if (!value || value < min || value > max) return;
    const next = { ...draft, [key]: value };
    if (next.start > next.end) {
      if (key === 'start') next.end = value;
      else next.start = value;
    }
    setDraft(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit(draft);
  };

  return (
    <fieldset className="date-range">
      <legend className="visually-hidden">Date range</legend>
      <label>
        <span>From</span>
        <input
          type="date"
          value={draft.start}
          min={min}
          max={max}
          onChange={(e) => update('start', e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={onKeyDown}
        />
      </label>
      <label>
        <span>To</span>
        <input
          type="date"
          value={draft.end}
          min={min}
          max={max}
          onChange={(e) => update('end', e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={onKeyDown}
        />
      </label>
    </fieldset>
  );
}
