import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [tailwindcss(), react()],
  root: __dirname,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: '../../../dist/dashboard',
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3333',
        changeOrigin: true,
      },
      // Builder sandbox preview proxy. Without this, `/preview/:id/*`
      // would hit Vite's SPA fallback and serve the dashboard's own
      // `index.html` — exactly what you saw when the iframe kept
      // rendering the Projetos page on top of itself.
      //
      // `ws: true` is critical: the Vite dev-server inside the sandbox
      // container upgrades to WebSocket for HMR at
      // `/preview/:id/@vite/hmr`. Without WS proxying you'd see the
      // page load once but never hot-reload on code changes.
      '/preview': {
        target: 'http://localhost:3333',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
