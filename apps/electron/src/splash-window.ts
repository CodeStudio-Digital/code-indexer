/**
 * Splash / preload window — a tiny frameless window shown immediately while
 * the heavy in-process backend (`createApp()` in main.ts: SQLite, migrations,
 * stores, providers, indexer) boots. That boot blocks the MAIN process event
 * loop for several seconds; without a splash the user stares at Electron's
 * blank window.
 *
 * Why this works: every BrowserWindow has its OWN renderer process. The splash
 * page's CSS spinner therefore keeps animating even while the main process is
 * frozen inside `createApp()`. The page is a static local file (splash.html)
 * with no preload, no node integration, and a strict CSP — nothing to attack.
 *
 * Status text is updated from main via `executeJavaScript` (privileged, so no
 * preload/IPC bridge is needed on the splash side).
 */
import { BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// splash.html lives next to main.{ts,js} — i.e. one level up from this
// `src/` module: `apps/electron/splash.html` in dev (tsx), and
// `dist/apps/electron/splash.html` in the packaged build (copied by
// scripts/build-electron.mjs).
const SPLASH_HTML = path.join(__dirname, '..', 'splash.html');

let splash: BrowserWindow | null = null;

/** Create + show the splash window. Call right after `app.whenReady()`. */
export function createSplashWindow(): BrowserWindow {
  splash = new BrowserWindow({
    width: 460,
    height: 300,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    center: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Static trusted page — no bridge needed. contextIsolation on / node off
    // keeps it locked down regardless.
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splash.once('ready-to-show', () => splash?.show());
  void splash.loadFile(SPLASH_HTML);
  return splash;
}

/**
 * Resolve once the splash has painted its first frame, so the CSS animation is
 * already on screen before the main process freezes in `createApp()`. Never
 * blocks boot: also resolves on load failure or after a short timeout.
 */
export async function whenSplashPainted(): Promise<void> {
  const s = splash;
  if (!s) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    s.webContents.once('did-finish-load', finish);
    s.webContents.once('did-fail-load', finish);
    setTimeout(finish, 2000);
  });
}

/** Update the splash status line (best-effort; ignored if already closed). */
export function updateSplashStatus(message: string): void {
  if (!splash || splash.isDestroyed()) return;
  const literal = JSON.stringify(message);
  void splash.webContents
    .executeJavaScript(`(()=>{const e=document.getElementById('status');if(e)e.textContent=${literal};})()`)
    .catch(() => {});
}

/** Close + dispose the splash. Call when the main window is revealed. */
export function closeSplash(): void {
  if (!splash || splash.isDestroyed()) {
    splash = null;
    return;
  }
  const s = splash;
  splash = null;
  s.close();
}
