import { useEffect } from 'react';
import { useSimStore } from '../../../store/useSimStore';

const HOURS_PER_SECOND = 6;

/**
 * Plays the simulated spread (advances the hour while playing). Used once, in the
 * dashboard shell, so playback continues whichever side panel tab is open, or with
 * the panel closed (the map's simulation bar has play/pause too).
 */
export function useSimPlayback() {
  const playing = useSimStore((s) => s.playing);
  const result = useSimStore((s) => s.result);
  useEffect(() => {
    if (!playing || !result) return;
    const last = result.stats.length - 1;
    let raf = 0;
    let prev = performance.now();
    const tick = (now: number) => {
      const st = useSimStore.getState();
      const next = st.hour + ((now - prev) / 1000) * HOURS_PER_SECOND;
      prev = now;
      if (next >= last) {
        st.setHour(last);
        st.setPlaying(false);
        return;
      }
      st.setHour(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, result]);
}
