import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { version: string };

// Dev ports live in an uncommon 7xxx range so they don't collide with the
// usual 5173/3333 every other Vite/Node project grabs. Both stay overridable
// via env. The proxy target derives from the API port (MCP_INDEX_PORT, same
// var the backend reads in packages/shared config) so changing the API port
// keeps the dashboard wired — without this the proxy would silently miss.
const dashboardPort = Number(process.env.MCP_DASHBOARD_PORT ?? 7317);
const apiPort = Number(process.env.MCP_INDEX_PORT ?? 7333);
const apiTarget = `http://localhost:${apiPort}`;

// The CodeStudio Cloud Worker is a SEPARATE service from the in-process backend.
// Proxy /v1 → the Worker so the dev cloud bridge can issue same-origin (relative)
// requests and dodge CORS. Override with CODESTUDIO_CLOUD_URL (e.g.
// http://localhost:8787 for a local `wrangler dev`).
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
    alias: [
      ...pkgAliases('@mcp/api-bus', 'api-bus'),
      ...pkgAliases('@mcp/shared', 'shared'),
      ...pkgAliases('@mcp/store', 'store'),
      ...pkgAliases('@mcp/services', 'services'),
      ...pkgAliases('@mcp/indexer', 'indexer'),
      ...pkgAliases('@mcp/design-system', 'design-system'),
      // App Studio: o dashboard importa SÓ os módulos puros (spec/*,
      // blueprint/*) — verification/workspace-checks usa node:fs e quebraria o build.
      ...pkgAliases('@mcp/app-studio', 'app-studio'),
      ...pkgAliases('@mcp/code-agent', 'code-agent'),
      ...pkgAliases('@mcp/company', 'company'),
      ...pkgAliases('@mcp/company-contracts', 'company-contracts'),
      ...pkgAliases('@mcp/vault-crypto', 'vault-crypto'),
      ...pkgAliases('@mcp/secret-box', 'secret-box'),
      { find: /^@apps\/(.*)$/, replacement: resolve(repoRoot, 'apps/$1') },
    ],
  },
  build: {
    outDir: resolve(repoRoot, 'dist/dashboard'),
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: dashboardPort,
    // Electron loads this exact port. Moving to the next free port would leave
    // the launcher waiting on 7317 while Vite serves a different endpoint.
    strictPort: true,
    proxy: {
      // CodeStudio Cloud Worker (auth/billing/sharing/feedback) — dev bridge only.
      '/v1': {
        target: cloudTarget,
        changeOrigin: true,
        secure: true,
      },
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        // SSE (text/event-stream) responses must NOT be buffered — http-proxy
        // defaults swallow chunked responses until close. Explicitly clear
        // `accept-encoding` on the way out and surface `X-Accel-Buffering: no`
        // on the way back so the dashboard sees events the moment the server
        // flushes them, not at stream close.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const accept = (req.headers.accept ?? '') as string;
            if (accept.includes('text/event-stream')) {
              proxyReq.setHeader('accept-encoding', 'identity');
            }
          });
          proxy.on('proxyRes', (proxyRes) => {
            const ctype = (proxyRes.headers['content-type'] ?? '') as string;
            if (ctype.includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no';
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
      // Phase D — terminal WebSocket. Single endpoint, but the path
      // shape `/ws/terminal/:sessionId` means we proxy the whole `/ws/`
      // prefix so future WS routes land here too (the company-stream WS
      // lives under `/api/company/...` and goes through the `/api` proxy
      // above; it's the standalone `/ws/*` routes that need this).
      // `ws: true` is mandatory for upgrade handshakes.
      '/ws': {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
      },
      // Self-hosted draw.io editor webapp (browser dev only). In Electron the
      // iframe loads mcp://app/drawio/* directly; here it goes through the
      // backend via this proxy. See features/chat/right-panel/diagram.
      '/drawio': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
