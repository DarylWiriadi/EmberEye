// Wakes the API (a serverless function that sleeps when idle) while someone reads
// the home page, so the dashboard's first map data loads without the start-up wait.
const warm = () => {
  fetch('/api/health', { cache: 'no-store' }).catch(() => {});
};
if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 3000 });
else setTimeout(warm, 1500);
