// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import icon from 'astro-icon';

// https://astro.build/config
export default defineConfig({
  integrations: [react(), icon()],
  server: {
    // Lets the dev and preview servers load through GitHub Codespaces' forwarded URLs
    allowedHosts: ['.app.github.dev'],
  },
  vite: {
    server: {
      // In development, forward /api to the local FastAPI server
      // (cd api && .venv/Scripts/python -m uvicorn index:app --port 8000).
      // In production, Vercel routes /api to the Python function (vercel.json).
      proxy: { '/api': 'http://127.0.0.1:8000' },
    },
  },
});
