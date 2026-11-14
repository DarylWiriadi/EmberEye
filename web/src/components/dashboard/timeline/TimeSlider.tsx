import { useEffect } from 'react';
import { Pause, Play } from 'lucide-react';
import { useAppStore, useSliderWindow, useSteps } from '../../../store/useAppStore';
import { formatWindow } from '../../../lib/steps';

const STEPS_PER_SECOND = 2.5;

export default function TimeSlider() {
  const steps = useSteps();
  const win = useSliderWindow();
  const pos = useAppStore((s) => s.sliderPos);
  const setPos = useAppStore((s) => s.setSliderPos);
  const playing = useAppStore((s) => s.playing);
  const play = useAppStore((s) => s.play);
  const pause = useAppStore((s) => s.pause);
  const scrubTo = useAppStore((s) => s.scrubTo);

  const last = steps ? steps.count - 1 : 0;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let prev = performance.now();
    const tick = (now: number) => {
      const next = useAppStore.getState().sliderPos + ((now - prev) / 1000) * STEPS_PER_SECOND;
      prev = now;
      if (next >= last) {
        setPos(last);
        pause();
        return;
      }
      setPos(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, last, setPos, pause]);

  if (!steps || !win) return null;

  const togglePlay = () => {
    if (playing) return pause();
    if (pos >= last) setPos(0);
    play();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const keys: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
    if (e.key in keys) {
      e.preventDefault();
      scrubTo(Math.round(pos) + keys[e.key]);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      scrubTo(e.key === 'Home' ? 0 : last);
    }
  };

  const label = formatWindow(win);
  return (
    <div className="time-slider">
      <button
        type="button"
        className="dash-icon-btn"
        onClick={togglePlay}
        aria-label={playing ? 'Pause' : 'Play through the date range'}
        disabled={last === 0}
      >
        {playing ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <input
        type="range"
        min={0}
        max={last}
        step="any"
        value={pos}
        onChange={(e) => scrubTo(Number(e.target.value))}
        onPointerUp={() => scrubTo(Math.round(useAppStore.getState().sliderPos))}
        onKeyDown={onKeyDown}
        aria-label={steps.size > 1 ? `Map dates, ${steps.size}-day steps` : 'Map date'}
        aria-valuetext={label}
        disabled={last === 0}
      />
      <output className="time-slider-date">
        {label}
        {steps.size > 1 && <span className="time-slider-step">{steps.size}-day steps</span>}
      </output>
    </div>
  );
}
