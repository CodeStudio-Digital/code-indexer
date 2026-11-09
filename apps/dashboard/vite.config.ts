import { defineConfig, normalizePath, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

/**
 * Workspace packages use NodeNext-style `.js` specifiers in their TypeScript
 * sources so the emitted files run directly in Node. Vite resolves those
 * specifiers inside the dashboard root, but an aliased package lives outside
 * that root and otherwise becomes a literal `/@fs/.../*.js` request. In dev
 * those files only exist as `.ts`/`.tsx`, so lazy routes fail with a misleading
 * "Failed to fetch dynamically imported module" error.
 */
function workspaceTypeScriptSpecifiers(): Plugin {
  const workspacePrefix = `${normalizePath(repoRoot)}/`;

  return {
    name: 'workspace-typescript-specifiers',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;

      const importerPath = importer
        .replace(/^\/@fs\//, '')
        .split('?', 1)[0];
      const normalizedImporter = normalizePath(importerPath);
      if (!normalizedImporter.startsWith(workspacePrefix) || normalizedImporter.includes('/node_modules/')) return null;

      const emittedJsPath = resolve(dirname(importerPath), source);
      const sourceBase = emittedJsPath.slice(0, -'.js'.length);
      for (const extension of ['.ts', '.tsx']) {
        const candidate = `${sourceBase}${extension}`;
        if (existsSync(candidate)) return candidate;
      }
      return null;
    },
  };
}

export default defineConfig(({ command }) => ({
  // Electron loads the packaged dashboard from disk via file:// (main.ts
  // `win.loadFile(dist/dashboard/index.html)`). With Vite's default absolute
  // base ('/'), the built index.html references `/assets/*.js`, which under
  // file:// resolve to the filesystem root and 404 → black screen. A relative
  // base emits `./assets/*.js`, resolved next to index.html. Dev keeps '/'
  // (the Vite dev server serves from root; relative base breaks HMR).
  base: command === 'build' ? './' : '/',
  plugins: [workspaceTypeScriptSpecifiers(), tailwindcss(), react()],
  root: __dirname,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: [
      // The DOM entry uses document.createElement, unavailable in a Worker.
      // Use upstream's portable decoder in dev and production, without changing
      // conditional exports for unrelated packages or the entire renderer.
      { find: /^decode-named-character-reference$/, replacement: resolve(repoRoot, 'node_modules/decode-named-character-reference/index.js') },
      // React 19 replays layout effects and refs while revealing subtrees.
      // Radix 1.1.7 can dispatch forever in that phase; keep one renderer-wide
      // replacement until the upstream Presence fix ships.
      {
        find: /^@radix-ui\/react-presence$/,
        replacement: resolve(__dirname, "lib/radix-presence-react19.tsx"),
      },
      ...pkgAliases('@mcp/api-bus', 'api-bus'),
      ...pkgAliases('@mcp/shared', 'shared'),
      ...pkgAliases('@mcp/store', 'store'),
      ...pkgAliases('@mcp/services', 'services'),
      ...pkgAliases('@mcp/indexer', 'indexer'),
      // App Studio: o dashboard importa SÓ os módulos puros (spec/*,
      // blueprint/*) — verification/workspace-checks usa node:fs e quebraria o build.
      ...pkgAliases('@mcp/code-agent', 'code-agent'),
      // Renderer consumers use only pure session contracts (for example run
      // limits); persistence implementations remain in the host process.
      ...pkgAliases('@mcp/session-storage', 'session-storage'),
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
    // The bundle is ~700 chunks (every Shiki grammar and lazy route is one).
    // Gzipping each of them just to print a size column cost more than the
    // rest of the build, and nothing consumes the number: Electron loads the
    // assets from disk over file://, where no transfer encoding applies.
    reportCompressedSize: false,
    // Never inline the Material Icon Theme SVGs.
    //
    // `lib/material-icons/resolve.ts` eager-globs 1121 icons as `?url`, and each
    // one landed UNDER the default 4 KB inline threshold — so all of them were
    // url-encoded straight into the chunk. Measured: 1.29 MB of the 1.32 MB
    // file-icon chunk was inline SVG text, parsed and retained by V8 the first
    // time anything showed a file icon (explorer, chat file blocks, SFTP,
    // session state). As real files they are ~55 KB of URL strings plus small
    // on-disk reads for the handful of icons actually on screen, which Chromium
    // then caches. Everything else keeps Vite's default threshold.
    assetsInlineLimit: (filePath) => (
      /[\\/]material-icons[\\/]svg[\\/]/.test(filePath) ? false : undefined
    ),
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
}));
