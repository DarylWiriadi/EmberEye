import { useEffect } from 'react';
import { Pause, Play } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';

const DAY_MS = 86_400_000;
const DAYS_PER_SECOND = 2.5;

const label = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

export default function TimeSlider() {
  const range = useAppStore((s) => s.dateRange);
  const date = useAppStore((s) => s.sliderDate);
  const pos = useAppStore((s) => s.sliderPos);
  const setPos = useAppStore((s) => s.setSliderPos);
  const playing = useAppStore((s) => s.playing);
  const play = useAppStore((s) => s.play);
  const pause = useAppStore((s) => s.pause);
  const scrubTo = useAppStore((s) => s.scrubTo);

  const days = range ? Math.round((Date.parse(range.end) - Date.parse(range.start)) / DAY_MS) : 0;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = useAppStore.getState().sliderPos + ((now - last) / 1000) * DAYS_PER_SECOND;
      last = now;
      if (next >= days) {
        setPos(days);
        pause();
        return;
      }
      setPos(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, days, setPos, pause]);

  if (!range || !date) return null;

  const togglePlay = () => {
    if (playing) return pause();
    if (pos >= days) setPos(0);
    play();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
    if (e.key in steps) {
      e.preventDefault();
      scrubTo(Math.round(pos) + steps[e.key]);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      scrubTo(e.key === 'Home' ? 0 : days);
    }
  };

  return (
    <div className="time-slider">
      <button
        type="button"
        className="dash-icon-btn"
        onClick={togglePlay}
        aria-label={playing ? 'Pause' : 'Play through the date range'}
        disabled={days === 0}
      >
        {playing ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <input
        type="range"
        min={0}
        max={days}
        step="any"
        value={pos}
        onChange={(e) => scrubTo(Number(e.target.value))}
        onPointerUp={() => scrubTo(Math.round(useAppStore.getState().sliderPos))}
        onKeyDown={onKeyDown}
        aria-label="Map date"
        aria-valuetext={label(date)}
        disabled={days === 0}
      />
      <output className="time-slider-date">{label(date)}</output>
    </div>
  );
}
