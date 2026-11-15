/*
 * Ambient effects on the home page. Off entirely with reduced motion.
 *
 *   data-parallax="0.2"        moves the element as its section scrolls by, by this
 *                              many screen heights (negative = moves up). Default
 *                              range: from when the section enters the screen until
 *                              it leaves; data-parallax-start="top top" starts it
 *                              from the top of the page instead (the hero).
 *   .card                      on mouse/trackpad screens, a soft spotlight follows the
 *                              pointer and the card tilts slightly towards it
 *                              (styles in global.css).
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const mm = gsap.matchMedia();

// Parallax: only transforms, scrubbed with scroll (smooth on iPad)
mm.add('(prefers-reduced-motion: no-preference)', () => {
  for (const el of document.querySelectorAll<HTMLElement>('[data-parallax]')) {
    const amount = Number(el.dataset.parallax) || 0;
    const scope = el.closest('section, .story') ?? el.parentElement ?? el;
    gsap.fromTo(
      el,
      { y: 0 },
      {
        y: () => amount * window.innerHeight,
        ease: 'none',
        scrollTrigger: {
          trigger: scope,
          start: el.dataset.parallaxStart ?? 'top bottom',
          end: 'bottom top',
          scrub: true,
          invalidateOnRefresh: true,
        },
      },
    );
  }
});

// Card spotlight and tilt: only where there's a real pointer (not touch)
mm.add('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)', () => {
  const MAX_TILT = 3; // degrees
  const cleanups: (() => void)[] = [];

  for (const card of document.querySelectorAll<HTMLElement>('.card')) {
    let frame = 0;
    const move = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = card.getBoundingClientRect();
        const x = (event.clientX - box.left) / box.width;
        const y = (event.clientY - box.top) / box.height;
        card.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
        card.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
        card.style.setProperty('--ry', `${((x - 0.5) * 2 * MAX_TILT).toFixed(2)}deg`);
        card.style.setProperty('--rx', `${((0.5 - y) * 2 * MAX_TILT).toFixed(2)}deg`);
      });
    };
    const leave = () => {
      cancelAnimationFrame(frame);
      for (const prop of ['--mx', '--my', '--rx', '--ry']) card.style.removeProperty(prop);
    };
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerleave', leave);
    cleanups.push(() => {
      card.removeEventListener('pointermove', move);
      card.removeEventListener('pointerleave', leave);
      leave();
    });
  }

  return () => cleanups.forEach((fn) => fn());
});
