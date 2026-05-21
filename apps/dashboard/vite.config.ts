import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { version: string };

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
      ...pkgAliases('@mcp/shared', 'shared'),
      ...pkgAliases('@mcp/store', 'store'),
      ...pkgAliases('@mcp/services', 'services'),
      ...pkgAliases('@mcp/indexer', 'indexer'),
      ...pkgAliases('@mcp/design-system', 'design-system'),
      ...pkgAliases('@mcp/code-agent', 'code-agent'),
      ...pkgAliases('@mcp/company', 'company'),
      ...pkgAliases('@mcp/company-contracts', 'company-contracts'),
      { find: /^@apps\/(.*)$/, replacement: resolve(repoRoot, 'apps/$1') },
    ],
  },
  build: {
    outDir: resolve(repoRoot, 'dist/dashboard'),
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
        target: 'http://localhost:3333',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
