/**
 * Electron main process. Owns the backend (imported in-process — no
 * child_process, no HTTP loopback) and the BrowserWindow that hosts
 * the React dashboard.
 *
 * Flow on startup:
 *   1. `createBackend()` returns a `BackendHandle` (src/backend/handle.ts).
 *      Today the only implementation boots the full deps graph (SQLite,
 *      providers, stores) in THIS process — same `createDeps` the Hono server
 *      uses, minus `serve()`. Selected by `MCP_BACKEND_PROCESS`.
 *   2. `backend.attachRenderer()` wires every handler in @mcp/api-handlers to
 *      `ipcMain.handle('api:<namespace>:<method>', …)`. Streaming methods
 *      register on a separate channel that returns a MessagePort.
 *   3. The window loads either the Vite dev URL (npm run electron:dev)
 *      or the built dashboard files (production via electron-builder).
 *
 * The renderer reaches the backend via `window.electronAPI.api.*`
 * (defined in preload.ts via contextBridge). There is no port open on
 * loopback — every call is in-process IPC.
 *
 * Why the indirection: the backend is what freezes this process (260 sync
 * migrations at boot, then every synchronous handler), and this process also
 * owns the window, the menus, IPC dispatch for all renderers and the PTYs.
 * `BackendHandle` is the seam a `utilityProcess` implementation slots into.
 * Anything main still reaches through `backend.local` is coupling that has to
 * become an RPC first — the property is nullable so the compiler lists it.
 */

import { app, BrowserWindow, ipcMain, dialog, shell, Notification, protocol, session } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { seedBundledPlugins } from '@apps/http-api/server/bundled-plugins.js';
import { installLlmDispatcher } from '@apps/http-api/install-llm-dispatcher.js';
import { createBackend } from './src/backend/create.js';
import { runBackendSpike } from './src/backend/spike/run-spike.js';
import { createElectronProfiler } from './src/perf-trace.js';
import { setElectronProfiler } from '@apps/http-api/server/perf/electron-profiler.js';
import {
  setMainSecretDecryptor,
  setMainSecretEncryptor,
} from '@apps/http-api/server/secret-decrypt-port.js';
import { setGlobalPreviewDevtools } from '@mcp/code-agent/tools/preview/index.js';
import { PreviewWindowService } from './src/preview-window/service.js';
import { DiagramRenderService } from './src/diagram-render/service.js';
import { setDiagramRenderer } from '@mcp/code-agent/tools/diagram/render-port.js';
import { buildRunnerBridge } from './src/preview-window/build-runner-bridge.js';
import { type BackendDispatch, OAUTH_LOOPBACK_PORT, startOAuthLoopback, stopOAuthLoopback } from './src/oauth-loopback.js';
import { mountTerminalIpc } from './src/terminal-ipc.js';
import {
  decryptSecretBlob,
  encryptSecretBlob,
  mountSecretsIpc,
} from './src/secrets-ipc.js';
import { registerWindowControlsIpc } from './src/window-controls-ipc.js';
import { registerWindowRegistryIpc } from './src/window-registry-ipc.js';
import { mountPreviewInspectIpc } from './src/preview-inspect-ipc.js';
import { mountPreviewCaptureIpc } from './src/preview-capture-ipc.js';
import { mountCloudIpc } from './src/cloud/cloud-ipc.js';
import { installGlobalHardening, applyProductionHardening } from './src/security-hardening.js';
import { APP_IDENTITY, resolveAppIconPath } from './src/app-icon.js';
import { createSplashWindow, whenSplashPainted, updateSplashStatus, closeSplash } from './src/splash-window.js';
import { enrichElectronProcessMetrics } from './src/process-metrics.js';
import {
  registerTaskManagerShortcut,
  TASK_MANAGER_ROUTE,
  TASK_MANAGER_WINDOW,
} from './src/task-manager-shortcut.js';
import { childRegistry } from './src/child-process-registry.js';
import { sharedPtyManager } from '@mcp/api-handlers';
import { forceDisposeAppProcessResources } from '@apps/http-api/server/runtime-shutdown.js';
import { applyDesktopRuntimeEnvDefaults } from './src/desktop-runtime-env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Installed builds do not inherit the repository `.env`. Apply the desktop's
// durable-data defaults before any backend/store is constructed so dev and
// packaged launches route already-split projects to the same SQLite files.
applyDesktopRuntimeEnvDefaults();

// Streaming-resilient global undici dispatcher for the main-process realm
// (provider-refresh, model-pricing, quality-watchdog fetch here). Workers set
// their own — see apps/http-api/install-llm-dispatcher.ts.
installLlmDispatcher();

// ─── Main-process safety net ─────────────────────────────────────
// A stray throw/rejection from a BACKGROUND feature (preview/devtools CDP,
// an MCP pool, a fire-and-forget task) must never take down the whole IDE.
// Log loudly (so the real error is visible) but keep the editor alive. This
// is the desktop-app posture: the user's session is worth far more than
// crashing on a non-critical async failure. (The coder worker has its own
// classifier — see coder-worker.ts — this only covers the main process.)
process.on('uncaughtException', (err) => {
  console.error('[electron-main] uncaughtException (kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[electron-main] unhandledRejection (kept alive):', reason);
});

// ─── Crash / signal teardown of OS children ──────────────────────
// The orderly cleanup lives in `will-quit` (graceful flush → force sweep).
// But Ctrl-C in `electron:dev` (SIGINT), an external SIGTERM, or a hard
// `process.exit` bypass `will-quit` entirely — without these, terminal
// shells and their `npm run dev` grandchildren orphan. `killAllSync` is the
// synchronous last resort (it's the only thing allowed on the 'exit' tick).
let signalQuitStarted = false;
const teardownOnSignal = (signal: NodeJS.Signals): void => {
  if (signalQuitStarted) {
    console.error(`[electron-main] received ${signal} again — forcing exit`);
    childRegistry.killAllSync();
    app.exit(signal === 'SIGINT' ? 130 : 0);
    return;
  }
  signalQuitStarted = true;
  console.error(`[electron-main] received ${signal} — starting graceful shutdown`);
  // The first signal follows will-quit so active worker turns and DB writes are
  // flushed before process trees are reaped. A second signal is the hard stop.
  app.quit();
};
process.on('SIGINT', () => teardownOnSignal('SIGINT'));
process.on('SIGTERM', () => teardownOnSignal('SIGTERM'));
process.on('exit', () => {
  try {
    forceDisposeAppProcessResources();
    childRegistry.killAllSync();
  } catch {
    /* best-effort */
  }
});

const DEV_URL = process.env.MCP_ELECTRON_DEV_URL;
// `.cjs` (not `.js`) because root package.json has "type": "module";
// Electron's preload loader respects that and would otherwise try to
// parse the file as ESM, silently failing to expose contextBridge.
// See dev.ts buildSync block for the full explanation.
const PRELOAD_PATH = path.join(__dirname, 'preload.cjs');

/** Max time the graceful quit phase may take before we force-kill + exit. */
const QUIT_GRACE_MS = 20_000;

// ─── Renderer/main V8 heap ceiling ───────────────────────────────
//
// The dashboard renderer is heavy (many Monaco models, chat history,
// terminal scrollback) and was observed running at ~94% of V8's default
// old-space limit (1371 / 1457 MB in the perf panel). At that fill level
// V8 runs frequent major GC, and those pauses surface as the recurring
// main-thread longtasks that jank the whole UI long after a project opens.
// Raising the ceiling gives the working set headroom so V8 stops thrashing.
//
// `--js-flags` set on the browser-process command line is forwarded by
// Chromium to renderer + utility processes too, so this lifts the limit
// where the 1.4 GB heap actually lives. MUST be set before `app.whenReady()`
// (and before any renderer spawns) — module load is the right place.
// Tunable via MCP_RENDERER_HEAP_MB (unset/invalid → 4096).
const heapMbEnv = Number(process.env.MCP_RENDERER_HEAP_MB);
const maxOldSpaceMb = Number.isFinite(heapMbEnv) && heapMbEnv > 0 ? Math.floor(heapMbEnv) : 4096;
app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${maxOldSpaceMb}`);

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
  // Electron must be ready before any BrowserWindow can open. Do this FIRST
  // so the splash can be shown to cover the heavy in-process backend boot.
  app.setName(APP_IDENTITY.displayName);
  await app.whenReady();

  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_IDENTITY.userModelId);
  }

  // Allow microphone capture for the composer voice-dictation button. Electron
  // denies `media`/`audioCapture` by default, so getUserMedia would reject
  // silently without this grant. Two layers of scoping:
  //   1. audio-only — camera/geolocation/etc. stay denied.
  //   2. origin-gated — only the trusted app origins (packaged file://, the
  //      in-process mcp:// backend, or the dev server) may capture the mic.
  //      Preview/loopback windows share this default session but load arbitrary
  //      localhost content, so a stray/over-permissive page there must NOT be
  //      able to open the mic without a prompt.
  // OS-level mic permission (Windows privacy / macOS prompt) still applies on top.
  const allowMic = (permission: string) => permission === 'media' || permission === 'audioCapture';
  const micOriginAllowed = (url: string | undefined | null): boolean => {
    if (!url) return false;
    return url.startsWith('mcp://') || url.startsWith('file://') || (!!DEV_URL && url.startsWith(DEV_URL));
  };
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const url = wc?.getURL() || details?.requestingUrl || '';
    cb(allowMic(permission) && micOriginAllowed(url));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    const url = requestingOrigin || wc?.getURL() || '';
    return allowMic(permission) && micOriginAllowed(url);
  });

  // Pin the local-embedding model cache to a stable per-user dir so the
  // transformers.js model downloads once and survives app updates — never
  // into the read-only asar bundle. Read by LocalEmbeddingService. Set
  // before createApp() so the embedding service picks it up at construction.
  if (!process.env.MCP_MODEL_CACHE_DIR) {
    process.env.MCP_MODEL_CACHE_DIR = path.join(app.getPath('userData'), 'models');
  }

  // Point outbound-MCP OAuth redirects at the ephemeral 127.0.0.1 loopback
  // the desktop app spins up during consent (see oauth-loopback.ts). The
  // dashboard's own origin is socket-free (mcp:// in-process), so a provider
  // can't redirect a browser back to it. Read by `redirectUriFor` in
  // mcp-servers-oauth.routes.ts; must be set before createApp() so DCR
  // registers the loopback redirect_uri. Web deployments leave it unset.
  process.env.MCP_OAUTH_REDIRECT_BASE = `http://127.0.0.1:${OAUTH_LOOPBACK_PORT}`;

  // Show the splash immediately and wait for its first paint, so the CSS
  // spinner is on screen BEFORE createApp() freezes the main process. The
  // splash renders in its own renderer process, so it keeps animating
  // throughout the synchronous backend boot. (~20s "white screen" cover.)
  createSplashWindow();
  await whenSplashPainted();
  updateSplashStatus('Iniciando o servidor…');

  // The HTTP entrypoint seeds bundled plugins before createApp(), but the
  // desktop imports createApp() directly and never crosses that entrypoint.
  // Keep the ordering identical here so first-party debugger/provider
  // contributions are installed and visible to handlers on the same boot.
  updateSplashStatus('Carregando plugins integrados…');
  try {
    await seedBundledPlugins();
  } catch (error) {
    console.warn(`[bundled-plugins] desktop seed failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // THROWAWAY (Onda 0 gate): MCP_BACKEND_SPIKE=1 probes what a utilityProcess
  // can actually do here before any of the backend moves into one. No-op
  // otherwise, and it does not block the normal boot below.
  runBackendSpike();

  // Boot the backend in-process. The Hono app is built but not served
  // unless MCP_DEV_HTTP=1 — that flag exists so an operator can curl
  // the same backend from outside the Electron window for debugging.
  const backend = createBackend();
  await backend.ready();
  // `local` is non-null only while the backend shares this process. Everything
  // read through it is coupling that becomes a control-bridge RPC when the
  // backend moves into a utilityProcess — see backend/handle.ts.
  const { deps, honoApp } = backend.local!;

  // Perf monitor: hand the backend the Electron process tree
  // (GPU/renderer/utility working sets — what Task Manager shows).
  // Read lazily per sampler tick, so assigning after createApp is fine.
  backend.setProcessMetricsProvider(() => enrichElectronProcessMetrics(
    app.getAppMetrics(),
    BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
      .map((window) => ({
        pid: window.webContents.getOSProcessId(),
        url: window.webContents.getURL(),
        appWindow: (window as unknown as { __mcpAppWindow?: boolean }).__mcpAppWindow === true,
      })),
  ));

  // Task manager: the desktop-only child registry (terminal PTYs, the shared
  // runner PTY manager, dev-http) as labelled inventory entries. Same
  // late-binding contract as the metrics provider — read lazily per request.
  backend.setProcessInventoryProvider(() => childRegistry.list().flatMap((child) => (
    typeof child.pid === 'number' && child.pid > 0
      ? [{
        pid: child.pid,
        kind: child.kind === 'pty' ? ('terminal' as const) : ('helper' as const),
        label: child.label,
      }]
      : []
  )));

  // Wire the admin "Restart backend" button to Electron's relaunch
  // primitives — without this, `process.exit(75)` would kill the main
  // process directly and the user would see the window vanish without
  // it ever coming back (no supervisor in the Electron deployment).
  // `app.relaunch()` schedules a fresh launch with the same argv; the
  // graceful `app.quit()` tears down the current instance before relaunch.
  const { setSettingsRestartHook } = await import('../http-api/admin/app-settings.routes.js');
  setSettingsRestartHook(() => {
    app.relaunch();
    // quit() enters the same bounded graceful-shutdown path as a normal window
    // close; exit() bypasses before-quit/will-quit and can orphan subprocesses.
    app.quit();
  });

  updateSplashStatus('Carregando a interface…');

  // Production lockdown: strip the application menu + install the renderer
  // CSP. No-op in dev (gated on app.isPackaged inside). Runs before the
  // main window loads so the CSP header applies to the document.
  installGlobalHardening();

  // Pass the Hono app so handlers-mount can register a fallback for
  // every IPC channel not yet covered by a pure handler in
  // @mcp/api-handlers. The fallback dispatches via `app.fetch(Request)`
  // in-process — same routes, zero port. See hono-dispatch.ts.
  backend.attachRenderer();
  const handlers = backend.local!.handlers;
  mountTerminalIpc(deps);
  mountSecretsIpc();
  // Server-side decrypt port: lets http-api code (and workers via the
  // secretsDecrypt bridge handler) resolve `enc:` blobs with safeStorage
  // without importing electron. See server/secret-decrypt-port.ts.
  setMainSecretDecryptor(decryptSecretBlob);
  setMainSecretEncryptor(encryptSecretBlob);
  registerNativeIpc();
  registerWindowIpc();
  registerWindowControlsIpc();
  registerWindowRegistryIpc();
  // Both speak Request/Response, so both go through the SAME dispatch — which
  // is what lets a forwarder replace it wholesale later.
  const dispatch = (req: Request): Promise<Response> => backend.fetch(req);
  registerOAuthLoopbackIpc(dispatch);
  registerMcpProtocol(dispatch);

  // Full-app trace (contentTracing) + renderer CPU profile (CDP) — the two
  // capabilities the in-process http-api can't reach. Drives /api/admin/perf/
  // {full-trace,renderer-profile}. See perf-trace.ts.
  setElectronProfiler(createElectronProfiler());

  // Agent preview/devtools: wire the main-process service so the `preview_*`
  // tools (coder + company) can open a dedicated window + read CDP. Reaches
  // the runner workers via the bridge handler in the worker pools.
  // Inject the runner bridge so `preview_open` (no url) can reuse the
  // project's running dev server — or start a tracked one we own and stop
  // at session end — instead of the agent spawning a server in the shell.
  const previewService = new PreviewWindowService(
    handlers.runner ? buildRunnerBridge(handlers.runner, deps) : null,
  );
  setGlobalPreviewDevtools(previewService);
  const diagramRenderer = new DiagramRenderService();
  setDiagramRenderer(diagramRenderer);
  // Dashboard "Inspect": reuse the SAME service so universal element-selection
  // windows are managed alongside the agent's preview windows.
  mountPreviewInspectIpc(previewService);
  // Region screenshot of the inline preview iframe (captures the dashboard
  // window's painted pixels clipped to the marquee box).
  mountPreviewCaptureIpc();
  // Cloud account/login transport (separate HTTPS surface to the deployed Worker).
  mountCloudIpc();
  app.on('before-quit', () => stopOAuthLoopback());

  // The shared PTY manager backs the api `terminal` + `runner` namespaces —
  // i.e. the project's `npm run dev` dev servers. Register it as ONE tracked
  // child: its kill snapshots the live pids, signals each PTY, then tree-kills
  // so the dev servers (and their vite/esbuild grandchildren) can't orphan.
  // The per-window host shells in terminal-ipc.ts register themselves.
  childRegistry.register({
    kind: 'pty',
    label: 'runner-ptys',
    kill: () => sharedPtyManager.killAll(),
  });

  // Windows GUI quit emits NO SIGINT/SIGTERM, so the http-api signal handlers
  // never fire in the desktop app — `will-quit` is the one place we can flush
  // and reap everything. Two phases, order critical:
  //   1. GRACEFUL — flush in-flight per-session writers, stop
  //      LSP/ONNX/DB pools, shut external MCP subprocesses + company dev
  //      servers, close the optional dev-http listener. Force-killing here
  //      would lose the user's last turn (the very reason pools go first).
  //   2. FORCE — tree-kill every remaining OS child (terminal PTYs, runner
  //      dev servers + grandchildren) the graceful pass didn't already remove.
  // A watchdog bounds phase 1 so a stuck dispose can't hang the quit; we then
  // `app.exit(0)` (not `quit()`) to avoid re-entering this handler.
  let quitCleanupDone = false;
  app.on('will-quit', (e) => {
    if (quitCleanupDone) return;
    e.preventDefault();

    const graceful = (async (): Promise<void> => {
      setGlobalPreviewDevtools(null);
      setDiagramRenderer(null); diagramRenderer.close();
      await previewService.closeAll();
      stopOAuthLoopback();
      await backend.dispose('electron-quit');
      setElectronProfiler(null);
      setMainSecretDecryptor(null);
      setMainSecretEncryptor(null);
    })();

    void (async () => {
      try {
        await Promise.race([
          graceful.catch((err) => console.error('[electron] graceful quit cleanup failed:', err)),
          new Promise((r) => setTimeout(r, QUIT_GRACE_MS).unref?.()),
        ]);
      } finally {
        // Phase 2 — reap every remaining OS child (PTYs + dev-server trees).
        try {
          await childRegistry.killAll({ graceMs: 1500 });
        } catch (err) {
          console.error('[electron] force-kill sweep failed:', err);
        }
        quitCleanupDone = true;
        app.exit(0);
      }
    })();
  });

  // First paint of the main window → reveal it and dismiss the splash.
  await createAppWindow(undefined, () => closeSplash());

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

  // Push window-state changes to the renderer so the custom title bar can
  // (a) swap the maximize⇄restore icon and (b) dim the bar when the window
  // loses focus — both native behaviors the frameless chrome must replicate.
  const send = (channel: string, value: boolean): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, value);
  };
  win.on('maximize', () => send('window:maximized-changed', true));
  win.on('unmaximize', () => send('window:maximized-changed', false));
  win.on('focus', () => send('window:focus-changed', true));
  win.on('blur', () => send('window:focus-changed', false));
}

/**
 * Create the main BrowserWindow (also reused for "open in new window"
 * spawned via the `window:open` IPC handler). `routeSuffix` is appended
 * to the dashboard base URL — e.g. `/projects/42` or
 * `/company/sessions/<uuid>/main/work/chat`. `onReveal` runs once the window
 * has painted its first frame (used to dismiss the splash).
 */
async function createAppWindow(
  routeSuffix?: string,
  onReveal?: () => void,
  // Utility popouts (the task manager) are small companion windows; the
  // 1024x720 minimum below is sized for the full IDE chrome and would force
  // them far larger than they need to be.
  geometry?: { width: number; height: number },
): Promise<BrowserWindow> {
  const appIconPath = resolveAppIconPath();
  const win = new BrowserWindow({
    width: geometry?.width ?? 1400,
    height: geometry?.height ?? 900,
    minWidth: geometry ? 520 : 1024,
    minHeight: geometry ? 320 : 720,
    title: 'CodeStudio',
    ...(appIconPath ? { icon: appIconPath } : {}),
    autoHideMenuBar: true,
    // Frameless title bar: the dashboard's top `<header>` IS the title bar
    // (drag region + custom min/max/close), so the redundant native caption
    // bar is removed. `titleBarStyle: 'hidden'` (NOT `frame: false`) keeps the
    // OS resize borders and native double-click-to-maximize on the drag
    // region. On macOS we keep the native traffic-lights (convention) and
    // nudge them down to vertically center in the 36px header.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 11 } }
      : {}),
    // Stay hidden until the renderer paints its first frame, then reveal —
    // this is what kills the blank/white window flash. The dark background
    // also avoids a white flicker for the brief pre-paint moment.
    show: false,
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // Tag as a real app/UI window so the renderer CPU profiler (perf-trace.ts)
  // targets THIS, never a preview/inspect or splash window.
  (win as unknown as { __mcpAppWindow?: boolean }).__mcpAppWindow = true;

  // Reveal on first paint. `did-finish-load` is a belt-and-suspenders
  // fallback so a delayed/absent `ready-to-show` can never leave the window
  // (and the splash) stuck hidden. Attached BEFORE load to avoid a race.
  let revealed = false;
  const reveal = (): void => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    win.show();
    onReveal?.();
  };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);

  attachWindowHandlers(win);
  registerTaskManagerShortcut(win, openTaskManagerWindow);
  applyProductionHardening(win);

  if (DEV_URL) {
    // The renderer is hash-routed (createHashRouter — see apps/dashboard/App.tsx),
    // so a deep link goes in the fragment, not the pathname. Same shape as the
    // packaged branch below, which keeps dev and production on one code path.
    const target = routeSuffix ? `${DEV_URL.replace(/\/$/, '')}/#${routeSuffix}` : DEV_URL;
    await win.loadURL(target);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Production: dashboard build is bundled into the asar at dist/dashboard.
    // The renderer is hash-routed, so `{ hash: routeSuffix }` IS the route the
    // router boots from — nothing has to re-navigate after mount.
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
    const route = normalizeInternalRoute(payload?.route);
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

function normalizeInternalRoute(route: unknown): string | undefined {
  if (typeof route !== 'string') return undefined;
  const trimmed = route.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return undefined;
  return trimmed;
}

/**
 * The task manager is a singleton window: pressing Shift+Esc again focuses the
 * existing one instead of stacking copies, which is what Chrome does and what
 * anyone who mashes the shortcut expects.
 */
let taskManagerWindow: BrowserWindow | null = null;

async function openTaskManagerWindow(): Promise<void> {
  if (taskManagerWindow && !taskManagerWindow.isDestroyed()) {
    if (taskManagerWindow.isMinimized()) taskManagerWindow.restore();
    taskManagerWindow.show();
    taskManagerWindow.focus();
    return;
  }
  const win = await createAppWindow(TASK_MANAGER_ROUTE, undefined, TASK_MANAGER_WINDOW);
  win.setTitle('CodeStudio — Task Manager');
  taskManagerWindow = win;
  win.once('closed', () => {
    taskManagerWindow = null;
  });
}

async function focusOrOpenRoute(route?: string): Promise<void> {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  const existing = BrowserWindow.getFocusedWindow()
    ?? windows.find((win) => win.isVisible())
    ?? windows[0];

  if (!existing) {
    await createAppWindow(route);
    return;
  }

  if (existing.isMinimized()) existing.restore();
  existing.show();
  existing.focus();
  if (!route) return;

  const sendNavigate = (): void => {
    if (!existing.isDestroyed()) existing.webContents.send('app:navigate', route);
  };
  if (existing.webContents.isLoading()) {
    existing.webContents.once('did-finish-load', sendNavigate);
  } else {
    sendNavigate();
  }
}

/**
 * IPC for the ephemeral OAuth loopback (see oauth-loopback.ts). The
 * dashboard calls start() right before opening the provider login in the
 * external browser, then stop() once consent completes or is cancelled.
 */
function registerOAuthLoopbackIpc(dispatch: BackendDispatch) {
  ipcMain.handle('oauth:loopback:start', () => startOAuthLoopback(dispatch));
  ipcMain.on('oauth:loopback:stop', () => stopOAuthLoopback());
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

  // SFTP upload source — pick one or more local files to push to the remote.
  ipcMain.handle('dialog:openFiles', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : result.filePaths;
  });

  // SFTP download target — pick where to save a remote file locally.
  ipcMain.handle('dialog:saveFile', async (_e, defaultName?: string) => {
    const result = await dialog.showSaveDialog(defaultName ? { defaultPath: defaultName } : {});
    return result.canceled || !result.filePath ? null : result.filePath;
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

  // Reveal a file in its containing folder WITH the file selected (Explorer/
  // Finder "Reveal"). Used by the file-tree context menu for files; folders
  // use shell:openPath (which opens the folder itself).
  ipcMain.on('shell:showItemInFolder', (_event, targetPath: string) => {
    if (typeof targetPath === 'string' && targetPath.length > 0) {
      shell.showItemInFolder(targetPath);
    }
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.handle('app:notificationSupported', () => Notification.isSupported());

  ipcMain.on('app:notify', (_event, opts: { title: string; body: string; route?: string; tag?: string; kind?: string }) => {
    if (!Notification.isSupported()) return;
    if (typeof opts?.title !== 'string' || typeof opts?.body !== 'string') return;
    const route = normalizeInternalRoute(opts.route);
    const icon = resolveAppIconPath();
    const notification = new Notification({
      title: opts.title,
      body: opts.body,
      ...(icon ? { icon } : {}),
    });
    if (route) {
      notification.on('click', () => {
        void focusOrOpenRoute(route).catch((err) => {
          console.error('[electron] notification route click failed:', err);
        });
      });
    }
    notification.show();
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
function registerMcpProtocol(dispatch: BackendDispatch) {
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
        // Preserve renderer cancellation/navigation. Without this bridge the
        // custom protocol detached Hono work from the originating fetch, so a
        // reload could leave expensive snapshot/session reads running in main.
        signal: req.signal,
        // duplex: 'half' is required when streaming a Request body in
        // Node 18+'s undici impl. Hono routes consume the body eagerly
        // (await c.req.json()), so this is harmless but technically
        // required by the spec when body is a ReadableStream.
        duplex: hasBody ? 'half' : undefined,
      } as RequestInit & { duplex?: 'half' });
      // B0 instrumentation: the `useApi` (HTTP-style) reads — sessions:list,
      // groups:list, projects.get, files.* — flow through this protocol
      // handler, NOT the `invoke` path that handlers-mount already wraps with
      // timeCall. Without this they were invisible in the admin "slow IPC"
      // panel even though they're the slow ones in the perf trace. The
      // slow-call keying and the IN_PROCESS_ENV trust marker now live in the
      // backend handle, so this path and the OAuth loopback are measured and
      // trusted identically — and a forwarding implementation inherits both.
      return await dispatch(honoReq);
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
