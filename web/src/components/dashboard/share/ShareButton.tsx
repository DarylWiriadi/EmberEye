import { useEffect, useRef, useState } from 'react';
import { Check, Link } from 'lucide-react';
import { buildShareUrl, copyText } from '../../../lib/shareUrl';

interface Props {
  label?: string;
  className?: string;
  size?: number;
}

/** Copies a link to exactly this view (map, dates, area, panel, simulation). */
export default function ShareButton({ label = 'Share', className = 'download-toggle', size = 18 }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const share = async () => {
    const url = buildShareUrl();
    // Phones: the system share sheet. Elsewhere: copy to the clipboard.
    if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: 'EmberEye', url });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    if (await copyText(url)) {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } else {
      window.prompt('Copy this link:', url);
    }
  };

  return (
    <button type="button" className={className} onClick={share} title="Copy a link to exactly this view">
      {copied ? <Check size={size} aria-hidden="true" /> : <Link size={size} aria-hidden="true" />}
      <span className="tool-label" aria-live="polite">{copied ? 'Link copied' : label}</span>
    </button>
  );
}
