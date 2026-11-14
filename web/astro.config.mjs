// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import icon from 'astro-icon';

// https://astro.build/config
export default defineConfig({
  integrations: [react(), icon()],
  server: {
    // Lets the dev and preview servers load through GitHub Codespaces' forwarded URLs
    allowedHosts: ['.app.github.dev']
  }
});
