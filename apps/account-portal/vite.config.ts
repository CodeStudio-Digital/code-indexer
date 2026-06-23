import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// CodeStudio account portal — a STANDALONE browser SPA (Cloudflare Pages,
// account.codestudio.dev) for managing the cloud account: sign-in (OAuth +
// email/password), devices, billing, projects, API docs, teams. It talks
// DIRECTLY to the cloud Worker over HTTPS with a Bearer token in localStorage
// (NOT the Electron bridge), so it is fully self-contained.
const repoRoot = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { version: string };

const portalPort = Number(process.env.MCP_ACCOUNT_PORTAL_PORT ?? 7318);
// Same Worker the dashboard proxies. Override with CODESTUDIO_CLOUD_URL (e.g.
// http://localhost:8787 for a local `wrangler dev`). In PROD the bundle hits the
// Worker cross-origin via VITE_CLOUD_API_URL (see lib/api.ts) — CORS allowlisted.
const cloudTarget = process.env.CODESTUDIO_CLOUD_URL ?? 'https://codestudio-cloud-api.maiconspo6792.workers.dev';

function pkgAliases(name: string, dir: string) {
  const base = resolve(repoRoot, 'packages', dir, 'src');
  return [
    { find: new RegExp(`^${name}$`), replacement: resolve(base, 'index.ts') },
    { find: new RegExp(`^${name}/(.*)$`), replacement: resolve(base, '$1') },
  ];
}

export default defineConfig({
  plugins: [tailwindcss(), react()],
  root: __dirname,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    // Only the pure wire-type package is needed for type safety.
    alias: [...pkgAliases('@mcp/api-bus', 'api-bus')],
  },
  build: {
    outDir: resolve(repoRoot, 'dist/account-portal'),
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: portalPort,
    strictPort: false,
    // Dev: relative /v1 requests are proxied to the Worker (dodges CORS); the
    // prod bundle uses VITE_CLOUD_API_URL instead.
    proxy: {
      '/v1': { target: cloudTarget, changeOrigin: true, secure: true },
      '/d': { target: cloudTarget, changeOrigin: true, secure: true },
    },
  },
});
