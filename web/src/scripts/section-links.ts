/*
 * Links to sections on the same page (#problem, #data-story, ...) scroll to the
 * section without adding "#section" to the address bar.
 *
 * - Works for every same-page link (nav, hero buttons, skip link), so no link
 *   needs special markup.
 * - Smooth scroll unless the visitor prefers reduced motion.
 * - Moves keyboard focus to the section, like a normal link jump does, so
 *   keyboard and screen-reader users continue reading from there.
 * - Arriving from another page with a hash (e.g. /#featured from the dashboard):
 *   the browser jumps there as usual, then the hash is removed from the address.
 * - Ctrl/Cmd/Shift/middle clicks keep their normal behaviour (new tab etc.).
 */
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function jumpTo(id: string): boolean {
  const target = document.getElementById(id);
  if (!target) return false;
  document.dispatchEvent(new CustomEvent('section-jump', { detail: id }));
  target.scrollIntoView({ behavior: reduceMotion.matches ? 'instant' : 'smooth', block: 'start' });
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  return true;
}

document.addEventListener('click', (event) => {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href*="#"]');
  if (!link || link.target === '_blank') return;

  const url = new URL(link.href, location.href);
  const samePage = url.origin === location.origin && url.pathname === location.pathname;
  if (!samePage || url.hash.length < 2) return;

  if (jumpTo(decodeURIComponent(url.hash.slice(1)))) event.preventDefault();
});

if (location.hash) {
  history.replaceState(history.state, '', location.pathname + location.search);
}
