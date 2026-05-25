/**
 * Electron main process. Owns the backend (imported in-process — no
 * child_process, no HTTP loopback) and the BrowserWindow that hosts
 * the React dashboard.
 *
 * Flow on startup:
 *   1. `createApp()` instantiates the full deps graph (SQLite, providers,
 *      stores). Same `createDeps` the Hono server uses — we just skip
 *      `serve()`. The Hono `app` is unused unless MCP_DEV_HTTP=1 (debug).
 *   2. `mountIpcHandlers()` wires every handler in @mcp/api-handlers to
 *      `ipcMain.handle('api:<namespace>:<method>', …)`. Streaming methods
 *      register on a separate channel that returns a MessagePort.
 *   3. The window loads either the Vite dev URL (npm run electron:dev)
 *      or the built dashboard files (production via electron-builder).
 *
 * The renderer reaches the backend via `window.electronAPI.api.*`
 * (defined in preload.ts via contextBridge). There is no port open on
 * loopback — every call is in-process IPC.
 */

import { app, BrowserWindow, ipcMain, dialog, shell, Notification, protocol } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from '@apps/http-api/server.js';
import { mountIpcHandlers } from './src/handlers-mount.js';
import { startOptionalDevHttp } from './src/dev-http.js';
import { mountTerminalIpc } from './src/terminal-ipc.js';
import type { Hono } from 'hono';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEV_URL = process.env.MCP_ELECTRON_DEV_URL;
// `.cjs` (not `.js`) because root package.json has "type": "module";
// Electron's preload loader respects that and would otherwise try to
// parse the file as ESM, silently failing to expose contextBridge.
// See dev.ts buildSync block for the full explanation.
const PRELOAD_PATH = path.join(__dirname, 'preload.cjs');

// ─── Custom protocol for in-process backend ──────────────────────
//
// `mcp://app/api/...` is intercepted in the main process and dispatched
// directly to `honoApp.fetch(Request)`. The renderer keeps using a
// plain `fetch()` call — there is NO socket, NO loopback, NO Hono dev
// listener required for the dashboard to talk to its backend.
//
// `installFetchBase` (dashboard side) rewrites the relative `/api/*`
// URLs to `mcp://app/api/*` before the call lands here.
//
// Privileges:
//   - standard:           parsed as `scheme://host/path` (we need this so URL.pathname works)
//   - secure:             treated as HTTPS-equivalent (no mixed-content warnings)
//   - supportFetchAPI:    renderer can call `fetch(mcp://…)`
//   - stream:             keeps response.body as a ReadableStream (SSE!)
//   - bypassCSP:          renderer's CSP doesn't have to whitelist the scheme
//   - corsEnabled:        relaxed CORS so the dashboard isn't blocked
//
// MUST be registered BEFORE `app.whenReady()` — Electron decides scheme
// behaviour at module load.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mcp',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
]);

async function bootstrap() {
  // Boot the backend in-process. The Hono app is built but not served
  // unless MCP_DEV_HTTP=1 — that flag exists so an operator can curl
  // the same backend from outside the Electron window for debugging.
  const { app: honoApp, deps } = createApp();
  await startOptionalDevHttp(honoApp);

  // Wire the admin "Restart backend" button to Electron's relaunch
  // primitives — without this, `process.exit(75)` would kill the main
  // process directly and the user would see the window vanish without
  // it ever coming back (no supervisor in the Electron deployment).
  // `app.relaunch()` schedules a fresh launch with the same argv; the
  // immediate `app.exit(0)` cleanly tears down the current instance.
  const { setSettingsRestartHook } = await import('../http-api/admin/app-settings.routes.js');
  setSettingsRestartHook(() => {
    app.relaunch();
    app.exit(0);
  });

  await app.whenReady();

  // Pass the Hono app so handlers-mount can register a fallback for
  // every IPC channel not yet covered by a pure handler in
  // @mcp/api-handlers. The fallback dispatches via `app.fetch(Request)`
  // in-process — same routes, zero port. See hono-dispatch.ts.
  mountIpcHandlers(deps, honoApp);
  mountTerminalIpc(deps);
  registerNativeIpc();
  registerMcpProtocol(honoApp);

  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: 'MCP IDE',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (DEV_URL) {
    await window.loadURL(DEV_URL);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Production: dashboard build is bundled into the asar at dist/dashboard.
    await window.loadFile(path.join(__dirname, '../../dashboard/index.html'));
  }

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/**
 * IPC handlers backed by Electron's native APIs (dialog, shell,
 * Notification). Counterparts to api-handlers but for things that only
 * make sense inside the desktop shell.
 */
function registerNativeIpc() {
  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.on('shell:openExternal', (_event, url: string) => {
    // Safety: only http/https. The api-bus billing flow only ever passes
    // Stripe URLs but the renderer is the source of strings here — guard
    // against `javascript:` / `file:` payloads regardless of intent.
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.on('app:notify', (_event, opts: { title: string; body: string }) => {
    if (Notification.isSupported()) {
      new Notification({ title: opts.title, body: opts.body }).show();
    }
  });
}

/**
 * Install the `mcp://` URL handler. Every renderer-side `fetch('mcp://app/api/...')`
 * lands here, gets translated into an `http://internal/api/...` Request,
 * and is dispatched through the in-process Hono app. The Response
 * (including streaming body for SSE) is returned verbatim to the
 * renderer, so caller code that expects `await fetch(...)` + ReadableStream
 * behaves identically to talking to a real HTTP server — except there
 * is no socket, no port, no loopback.
 */
function registerMcpProtocol(honoApp: Hono) {
  protocol.handle('mcp', async (req) => {
    try {
      const url = new URL(req.url);
      // Reconstruct the Hono-side URL. Pathname carries `/api/...`,
      // search carries the query string. Authority is irrelevant —
      // Hono routes match on pathname only.
      const honoUrl = `http://internal${url.pathname}${url.search}`;
      // GET/HEAD have no body in the spec; passing one (even null) makes
      // the WHATWG Request constructor throw.
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const honoReq = new Request(honoUrl, {
        method: req.method,
        headers: req.headers,
        body: hasBody ? req.body : undefined,
        // duplex: 'half' is required when streaming a Request body in
        // Node 18+'s undici impl. Hono routes consume the body eagerly
        // (await c.req.json()), so this is harmless but technically
        // required by the spec when body is a ReadableStream.
        duplex: hasBody ? 'half' : undefined,
      } as RequestInit & { duplex?: 'half' });
      return await honoApp.fetch(honoReq);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  });
}

void bootstrap().catch((err) => {
  console.error('[electron] bootstrap failed:', err);
  process.exitCode = 1;
});
