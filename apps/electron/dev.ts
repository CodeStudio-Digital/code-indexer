/**
 * Dev launcher — spawns Electron pointing at the Vite dev server.
 * Main process runs via `tsx`, no build step. The dashboard's Vite
 * server should already be running on :7317 (npm run dev:dashboard).
 *
 * Preload pre-build: Electron's preload script runs in a sandbox-like
 * context BEFORE any Node loader registers, so `tsx`/ESM imports never
 * apply there. We hand Electron a real `.cjs` file that's CommonJS
 * (contextBridge + ipcRenderer don't survive ESM in preload reliably —
 * see electron/electron#36899). The `.cjs` extension is critical here:
 * the root package.json has `"type": "module"`, so a `.js` preload
 * gets resolved as ESM and silently fails to expose contextBridge.
 * `.cjs` overrides the type field and forces CommonJS.
 *
 * The buildSync below produces `preload.cjs` next to `preload.ts`,
 * which `main.ts` then references via `path.join(__dirname, 'preload.cjs')`.
 *
 * Production launch is handled by electron-builder; the build pipeline
 * runs the same esbuild step from scripts/build-electron.mjs so the
 * artifact lands in `dist/apps/electron/preload.cjs`.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { brandDevBinary } from './brand-dev-binary.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const nodeRequire = createRequire(import.meta.url);

// 1) Bundle preload.ts → preload.cjs. Synchronous so the spawn below
//    sees the file ready on disk.
//
//    The `.cjs` extension is intentional and critical: the root
//    package.json has `"type": "module"`, which makes Node treat
//    `preload.js` as ESM. Electron's preload (with sandbox:false)
//    delegates to Node's loader, so an ESM-resolved `preload.js`
//    fails to expose contextBridge silently — `window.electronAPI`
//    stays undefined in the renderer, install-fetch-base no-ops,
//    and every dashboard fetch falls back to TCP loopback (which
//    we deliberately killed). `.cjs` overrides "type":"module" and
//    forces CommonJS, which is the only shape contextBridge ships
//    reliably (see electron#36899).
buildSync({
  entryPoints: [path.join(__dirname, 'preload.ts')],
  outfile: path.join(__dirname, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22', // Electron 42 ships Node 24; node22 is the safe esbuild target.
  // Electron itself isn't a normal npm dep at runtime — it's the host.
  // Marking it external avoids bundling the entire @types stubs.
  external: ['electron'],
  sourcemap: 'inline',
  // Quiet output unless something breaks.
  logLevel: 'error',
});

// 2) `electron` ships a CLI at the path returned by `require('electron')`.
//    We spawn it directly so stdout/stderr stream through the parent.
const electronBin: string = nodeRequire('electron');

// 3) On Windows, stamp the prebuilt electron.exe so Task Manager shows
//    "CodeStudio" instead of "Electron" (idempotent + fail-open). Must run
//    before the spawn below, otherwise the launched process locks the binary.
await brandDevBinary(electronBin);

const child = spawn(electronBin, [path.join(__dirname, 'main.ts')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    MCP_ELECTRON_DEV_URL:
      process.env.MCP_ELECTRON_DEV_URL ??
      `http://localhost:${process.env.MCP_DASHBOARD_PORT ?? 7317}`,
    // IPC-first: Hono HTTP listener stays OFF unless the operator
    // explicitly opts in (MCP_DEV_HTTP=1) to debug with curl. The
    // dashboard talks to the backend via window.electronAPI.api.* —
    // everything else is a path that needs migrating, not a fallback.
    MCP_DEV_HTTP: process.env.MCP_DEV_HTTP ?? '0',
    // tsx loader so the .ts files in apps/electron resolve at runtime.
    // (preload doesn't use this — it's pre-built above as CJS.)
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import tsx/esm`.trim(),
  },
});

child.on('exit', (code) => process.exit(code ?? 0));
