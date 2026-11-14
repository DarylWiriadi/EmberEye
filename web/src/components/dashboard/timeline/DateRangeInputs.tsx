import { useAppStore } from '../../../store/useAppStore';

interface Props {
  min: string;
  max: string;
}

export default function DateRangeInputs({ min, max }: Props) {
  const range = useAppStore((s) => s.dateRange);
  const setRange = useAppStore((s) => s.setDateRange);
  if (!range) return null;

  const update = (key: 'start' | 'end', value: string) => {
    if (!value || value < min || value > max) return;
    const next = { ...range, [key]: value };
    if (next.start > next.end) {
      if (key === 'start') next.end = value;
      else next.start = value;
    }
    setRange(next);
  };

  return (
    <fieldset className="date-range">
      <legend className="visually-hidden">Date range</legend>
      <label>
        <span>From</span>
        <input type="date" value={range.start} min={min} max={max} onChange={(e) => update('start', e.target.value)} />
      </label>
      <label>
        <span>To</span>
        <input type="date" value={range.end} min={min} max={max} onChange={(e) => update('end', e.target.value)} />
      </label>
    </fieldset>
  );
}
