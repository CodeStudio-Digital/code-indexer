/**
 * Production security hardening for the desktop shell.
 *
 * Everything here is gated on `app.isPackaged` — in dev (`electron:dev`) none
 * of it applies, so DevTools, the menu, and an open CSP stay available for
 * debugging. In a packaged build we:
 *   - never let DevTools open (programmatically or via keyboard shortcut),
 *   - strip the application menu (kills the View→Toggle DevTools / reload roles),
 *   - swallow the right-click "Inspect Element" context menu,
 *   - install a Content-Security-Policy on the renderer's file:// origin.
 *
 * Escape hatch: CODESTUDIO_DEBUG_DEVTOOLS=1 re-enables DevTools in a packaged
 * build so a CSP violation can be diagnosed (DevTools console shows the
 * blocked resource). It only unlocks DevTools — the CSP itself stays applied.
 *
 * The `mcp://` scheme is registered bypassCSP (see main.ts), so the in-process
 * backend is unaffected; the CSP only governs what the file:// document loads.
 */
import { app, Menu, session, type BrowserWindow } from 'electron';

const DEVTOOLS_DEBUG = process.env.CODESTUDIO_DEBUG_DEVTOOLS === '1';

/** DevTools locks are on only in a shipped build (unless the debug hatch is set). */
function devtoolsLocked(): boolean {
  return app.isPackaged && !DEVTOOLS_DEBUG;
}

// Deliberately permissive-but-real: allows exactly what the renderer needs and
// nothing wider. MUST be re-validated against a packaged build (use the debug
// hatch to watch the DevTools console for violations, then tighten):
//   - 'wasm-unsafe-eval'      tree-sitter + onnxruntime wasm
//   - 'unsafe-inline' styles  React inline styles + Tailwind/shadcn layer
//   - fonts.googleapis/gstatic the <link> in index.html
//   - blob: workers/img       Monaco editor web workers, generated images
//   - localhost/127.0.0.1      the builder's local dev-server previews (iframe + HMR ws)
//   - mcp://app                in-process backend (also bypassCSP; listed for clarity)
const CSP = [
  "default-src 'self' mcp://app",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: mcp://app",
  "connect-src 'self' mcp://app http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
  "worker-src 'self' blob:",
  "frame-src 'self' mcp://app http://localhost:* http://127.0.0.1:*",
].join('; ');

/**
 * App-wide hardening — call once after `app.whenReady()` and before the first
 * window loads. Strips the menu and installs the CSP header on the default
 * session. No-op in dev.
 */
export function installGlobalHardening(): void {
  if (!app.isPackaged) return; // menu + CSP always off in dev
  Menu.setApplicationMenu(null);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });
}

/**
 * Per-window DevTools lockdown — call for every user-facing window right after
 * it's created. No-op in dev (or with CODESTUDIO_DEBUG_DEVTOOLS=1).
 */
export function applyProductionHardening(win: BrowserWindow): void {
  if (!devtoolsLocked()) return;
  const wc = win.webContents;
  // Belt-and-suspenders: if anything manages to open DevTools, close it.
  wc.on('devtools-opened', () => wc.closeDevTools());
  // Swallow DevTools accelerators before the page (or Chromium) acts on them.
  wc.on('before-input-event', (event, input) => {
    if (isDevtoolsChord(input)) event.preventDefault();
  });
  // Kill the right-click "Inspect Element" entry.
  wc.on('context-menu', (event) => event.preventDefault());
}

function isDevtoolsChord(input: Electron.Input): boolean {
  if (input.type !== 'keyDown') return false;
  const key = (input.key ?? '').toLowerCase();
  if (key === 'f12') return true; // bare F12
  // Ctrl+Shift+{I,J,C} (Win/Linux) and Cmd+Opt+{I,J,C} (macOS).
  const primary = input.control || input.meta;
  const secondary = input.shift || input.alt;
  return primary && secondary && (key === 'i' || key === 'j' || key === 'c');
}
