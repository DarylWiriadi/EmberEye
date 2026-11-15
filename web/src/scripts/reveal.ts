/*
 * Scroll reveal for the home page.
 *
 *   data-reveal-group      its children slide in one after another
 *   data-reveal            the element slides in on its own
 *   ...="load"             plays on page load (the hero) instead of on scroll
 *   data-reveal-words      (a heading inside a group) its words rise in one by one
 *                          (markup from SplitWords.astro)
 *   data-draw              a line that draws itself (scaleX/scaleY via --draw)
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
    const stagger = reduced ? 0.04 : 0.12;
    // Opacity only (never visibility), so content stays focusable while hidden
    const from = reduced ? { opacity: 0 } : { opacity: 0, y: 40 };
    const to: gsap.TweenVars = { opacity: 1, y: 0, clearProps: 'transform' }; // leave hover effects free to use transform

    // Plays a list of items one after another. Headings with data-reveal-words
    // show at once and their words rise in instead of the whole heading sliding.
    const play = (items: Element[], vars: gsap.TimelineVars) => {
      const tl = gsap.timeline({ ...vars, defaults: { duration: reduced ? 0.4 : 0.9, ease: 'power3.out' } });
      items.forEach((item, i) => {
        const at = i * stagger;
        const words = reduced ? [] : [...item.querySelectorAll('.word-inner')];
        if (item.matches('[data-reveal-words]') && words.length) {
          tl.set(item, { opacity: 1 }, at);
          tl.fromTo(words, { yPercent: 110 }, { yPercent: 0, duration: 0.8, stagger: 0.06, clearProps: 'transform' }, at);
        } else {
          tl.fromTo(item, from, to, at);
        }
      });
      return tl;
    };

    // Hero: plays as soon as the page loads
    const onLoad = [
      ...document.querySelectorAll('[data-reveal-group="load"] > *'),
      ...document.querySelectorAll('[data-reveal="load"]'),
    ];
    if (onLoad.length) play(onLoad, { delay: 0.1 });

    // Everything else: plays once when it scrolls into view
    const onScroll = (trigger: Element): ScrollTrigger.Vars => ({ trigger, start: 'top 88%', once: true });

    for (const group of document.querySelectorAll('[data-reveal-group]:not([data-reveal-group="load"])')) {
      play([...group.children], { scrollTrigger: onScroll(group) });
    }
    for (const el of document.querySelectorAll('[data-reveal]:not([data-reveal="load"])')) {
      play([el], { scrollTrigger: onScroll(el) });
    }

    // Lines that draw themselves
    for (const line of document.querySelectorAll<HTMLElement>('[data-draw]')) {
      if (reduced) {
        gsap.set(line, { '--draw': 1 });
      } else {
        gsap.fromTo(
          line,
          { '--draw': 0 },
          {
            '--draw': 1,
            duration: 1.6,
            ease: 'power2.inOut',
            scrollTrigger: onScroll(line.parentElement ?? line),
          },
        );
      }
    }
  },
);

document.documentElement.classList.add('reveal-ready');
