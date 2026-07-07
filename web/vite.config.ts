/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Mastra dev server (mastra dev) serves the workflow API and our additive
// /prepare-interview route on http://localhost:4111. Proxying both prefixes keeps
// the browser same-origin with the Vite dev server, so no CORS config is needed on
// the Mastra side. Override the target with MASTRA_SERVER_URL when the API runs
// elsewhere.
const MASTRA_SERVER_URL = process.env.MASTRA_SERVER_URL ?? 'http://localhost:4111';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: MASTRA_SERVER_URL, changeOrigin: true },
      '/prepare-interview': { target: MASTRA_SERVER_URL, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
