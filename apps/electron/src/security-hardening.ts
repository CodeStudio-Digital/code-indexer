/**
 * Production security hardening for the desktop shell.
 *
 * The visible hardening is gated on `app.isPackaged` — in dev
 * (`electron:dev`) DevTools, the menu, and an open CSP stay available for
 * debugging. The preload nonce bridge is registered in both modes, but returns
 * no nonce in dev. In a packaged build we:
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
import { app, ipcMain, Menu, session, type BrowserWindow } from 'electron';
import { randomBytes } from 'node:crypto';
import { buildRendererCsp } from './security-csp.js';

const DEVTOOLS_DEBUG = process.env.CODESTUDIO_DEBUG_DEVTOOLS === '1';
const RENDERER_CSP_NONCE = randomBytes(18).toString('base64');
const CSP_NONCE_CHANNEL = 'security:getRendererCspNonce';
let nonceBridgeInstalled = false;

/** DevTools locks are on only in a shipped build (unless the debug hatch is set). */
function devtoolsLocked(): boolean {
  return app.isPackaged && !DEVTOOLS_DEBUG;
}

// Deliberately permissive-but-real: allows exactly what the renderer needs and
// nothing wider. MUST be re-validated against a packaged build (use the debug
// hatch to watch the DevTools console for violations, then tighten):
//   - 'wasm-unsafe-eval'      tree-sitter + onnxruntime wasm
//   - 'unsafe-inline' styles  React inline styles + Tailwind/shadcn layer
//   - blob: workers/img       Monaco editor web workers, generated images
//   - localhost/127.0.0.1      the builder's local dev-server previews (iframe + HMR ws)
//   - mcp://app                in-process backend (also bypassCSP; listed for clarity)
const CSP = buildRendererCsp(RENDERER_CSP_NONCE);

function installRendererNonceBridge(): void {
  if (nonceBridgeInstalled) return;
  nonceBridgeInstalled = true;
  ipcMain.on(CSP_NONCE_CHANNEL, (event) => {
    // Dev has no renderer CSP, so no nonce should be stamped into its plugin
    // documents. The packaged renderer receives only this launch's value.
    event.returnValue = app.isPackaged ? RENDERER_CSP_NONCE : null;
  });
}

/**
 * App-wide hardening — call once after `app.whenReady()` and before the first
 * window loads. Strips the menu and installs the CSP header on the default
 * session. In dev this only registers the nonce bridge, which returns null.
 */
export function installGlobalHardening(): void {
  installRendererNonceBridge();
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
