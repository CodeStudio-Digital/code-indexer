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
import { setGlobalPreviewDevtools } from '@mcp/code-agent/tools/preview/index.js';
import { PreviewWindowService } from './src/preview-window/service.js';
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
  // Pin the local-embedding model cache to a stable per-user dir so the
  // transformers.js model downloads once and survives app updates — never
  // into the read-only asar bundle. Read by LocalEmbeddingService. Set
  // before createApp() so the embedding service picks it up at construction.
  if (!process.env.MCP_MODEL_CACHE_DIR) {
    process.env.MCP_MODEL_CACHE_DIR = path.join(app.getPath('userData'), 'models');
  }

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
  registerWindowIpc();
  registerMcpProtocol(honoApp);

  // Agent preview/devtools: wire the main-process service so the `preview_*`
  // tools (coder + company) can open a dedicated window + read CDP. Reaches
  // the runner workers via the bridge handler in the worker pools.
  const previewService = new PreviewWindowService();
  setGlobalPreviewDevtools(previewService);
  app.on('before-quit', () => previewService.closeAll());

  await createAppWindow();

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/**
 * Decide whether a URL belongs to the in-app surface or should be
 * treated as "external" (and therefore opened in the user's default
 * browser instead of an Electron window).
 *
 * Internal protocols:
 *   - `mcp://`        — our in-process backend (prod renderer hits this).
 *   - `file://`       — bundled dashboard assets in production.
 *   - `about:blank`   — Chromium internal, harmless.
 *
 * Plus the Vite dev server URL when running `npm run electron:dev`, so
 * that internal SPA navigation in development isn't mistaken for an
 * external link.
 */
function isInternalUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  if (rawUrl === 'about:blank') return true;
  if (rawUrl.startsWith('mcp://')) return true;
  if (rawUrl.startsWith('file://')) return true;
  if (DEV_URL && rawUrl.startsWith(DEV_URL)) return true;
  // Local dev-server previews (the project preview pane's "open in new
  // window"). Restricted to loopback hosts so only local dev servers can
  // open inside our shell — never an arbitrary remote URL.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(rawUrl)) return true;
  return false;
}

/**
 * Attach the window-open + navigation handlers that route external
 * URLs to the OS default browser. Without this, `<a target="_blank">`
 * and `window.open(...)` would spawn a chromeless popup INSIDE Electron
 * — bad UX (no address bar, no history, no extensions) and a security
 * footgun (the popup inherits our preload bridge).
 *
 * The preview pane of the builder is the one place we intentionally
 * WANT an in-Electron window — callers pass `features: 'newWindow'`
 * (or any feature string at all, since regular SPA navigation never
 * sets features) to opt into that path. Anything else with an
 * external URL goes to the OS browser.
 */
function attachWindowHandlers(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url, features }) => {
    // Internal URL + caller asked for a real window → let Electron
    // open it (e.g. preview pane's "open in new tab" inside our shell).
    if (isInternalUrl(url)) {
      if (features && features.length > 0) {
        return { action: 'allow' };
      }
      // Stray popup attempt without features — block; SPA nav should
      // use router instead of window.open.
      return { action: 'deny' };
    }
    // External URL → user's default browser.
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Catches `<a href="https://...">` clicks (top-level nav) that bypass
  // setWindowOpenHandler. Without this, clicking such a link replaces
  // the dashboard with the external page inside our window.
  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
}

/**
 * Create the main BrowserWindow (also reused for "open in new window"
 * spawned via the `window:open` IPC handler). `routeSuffix` is appended
 * to the dashboard base URL — e.g. `/projects/42` or
 * `/company/sessions/7/main/work/chat`.
 */
async function createAppWindow(routeSuffix?: string): Promise<BrowserWindow> {
  const win = new BrowserWindow({
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

  attachWindowHandlers(win);

  if (DEV_URL) {
    const target = routeSuffix ? `${DEV_URL.replace(/\/$/, '')}${routeSuffix}` : DEV_URL;
    await win.loadURL(target);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Production: dashboard build is bundled into the asar at dist/dashboard.
    // React Router uses BrowserRouter, so a deep-link route lives in the
    // pathname — we use hash-prefixed style here (`#/path`) only if the
    // app is hash-routed. Today it's BrowserRouter, so we load the
    // base index.html and rely on the renderer reading the hash/query
    // we append. Simpler: pass the route via a `?initial=...` query the
    // App entry reads on mount, falling back to current location.
    const baseFile = path.join(__dirname, '../../dashboard/index.html');
    if (routeSuffix) {
      await win.loadFile(baseFile, { hash: routeSuffix });
    } else {
      await win.loadFile(baseFile);
    }
  }

  return win;
}

/**
 * IPC handler for "open in new window" — the renderer's context menu
 * calls `window.electronAPI.openInNewWindow(route)` and we spawn a
 * fresh BrowserWindow pointing at that route. The window inherits the
 * same preload + protocol setup, so it talks to the same in-process
 * backend.
 */
function registerWindowIpc() {
  ipcMain.handle('window:open', async (_event, payload: { route?: string; title?: string }) => {
    const route = typeof payload?.route === 'string' ? payload.route : undefined;
    const title = typeof payload?.title === 'string' ? payload.title : undefined;
    try {
      const win = await createAppWindow(route);
      if (title) win.setTitle(title);
      return { ok: true, windowId: win.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[electron] window:open failed:', message);
      return { ok: false, error: message };
    }
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

  // Reveal a local folder/file in the OS file manager (Explorer/Finder/…).
  // Used by the projects list context menu ("Open in file explorer").
  ipcMain.on('shell:openPath', (_event, targetPath: string) => {
    if (typeof targetPath === 'string' && targetPath.length > 0) {
      void shell.openPath(targetPath);
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
