/*
 * Scroll reveal for the home page.
 *
 *   data-reveal-group      its children slide in one after another
 *   data-reveal            the element slides in on its own
 *   ...="load"             plays on page load (the hero) instead of on scroll
 *
 * Each plays once. Reduced motion: a short fade, no movement.
 * Hiding before the animation runs is done in CSS (see "Scroll reveal" in
 * global.css), only while <html> has the js-reveal class.
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);
// Don't recalculate when the iPad/iPhone toolbar shows or hides while scrolling
ScrollTrigger.config({ ignoreMobileResize: true });

const mm = gsap.matchMedia();

mm.add(
  { full: '(prefers-reduced-motion: no-preference)', reduced: '(prefers-reduced-motion: reduce)' },
  (context) => {
    const reduced = Boolean(context.conditions?.reduced);
    // Opacity only (never visibility), so content stays focusable while hidden
    const from = reduced ? { opacity: 0 } : { opacity: 0, y: 40 };
    const to = (extra: gsap.TweenVars): gsap.TweenVars => ({
      opacity: 1,
      y: 0,
      duration: reduced ? 0.4 : 0.9,
      ease: 'power3.out',
      clearProps: 'transform', // leave hover effects free to use transform afterwards
      ...extra,
    });
    const stagger = reduced ? 0.04 : 0.12;

    // Hero: plays as soon as the page loads
    const onLoad = [
      ...document.querySelectorAll('[data-reveal-group="load"] > *'),
      ...document.querySelectorAll('[data-reveal="load"]'),
    ];
    if (onLoad.length) gsap.fromTo(onLoad, from, to({ stagger, delay: 0.1 }));

    // Everything else: plays once when it scrolls into view
    const onScroll = (trigger: Element) => ({ trigger, start: 'top 88%', once: true });

    for (const group of document.querySelectorAll('[data-reveal-group]:not([data-reveal-group="load"])')) {
      gsap.fromTo(group.children, from, to({ stagger, scrollTrigger: onScroll(group) }));
    }
    for (const el of document.querySelectorAll('[data-reveal]:not([data-reveal="load"])')) {
      gsap.fromTo(el, from, to({ scrollTrigger: onScroll(el) }));
    }
  },
);

document.documentElement.classList.add('reveal-ready');
