/**
 * Shape of `window.electronAPI` exposed by `apps/electron/preload.ts` via
 * `contextBridge.exposeInMainWorld`. Imported by the dashboard's IPC
 * adapter so React components get full type coverage on every call.
 *
 * Streaming methods return `AsyncIterable<T>` constructed from a
 * MessagePort hop (see apps/electron/src/stream-port.ts). Non-streaming
 * methods return `Promise<T>` from `ipcRenderer.invoke`.
 *
 * Outside Electron `window.electronAPI` is undefined; the dashboard's
 * `apiClient` falls back to `fetch` against the Hono routes.
 */

import type { Api } from './index.js';

export interface ElectronAPI {
  /** Full backend RPC surface — same shape Hono mounts at /api/*. */
  api: Api;

  /** Native folder picker — used in the Onboarding wizard + ProjectSwitcher. */
  openDirectory(): Promise<string | null>;

  /** Open a URL in the default browser (Stripe checkout, doc links). */
  openExternal(url: string): void;

  /** Reveal a local folder/file in the OS file manager (Explorer/Finder/…). */
  openPath(path: string): void;

  /** App version from electron `app.getVersion()`. */
  getAppVersion(): Promise<string>;

  /** Native OS notification (used after agent run finishes in background). */
  showNotification(opts: { title: string; body: string }): void;

  /**
   * Auto-updater hooks. Wired in apps/electron/main.ts against
   * electron-updater (Dia 17). MVP: no-op stubs so the React side
   * compiles before the updater lands.
   */
  onUpdateAvailable(callback: () => void): () => void;
  restartAndUpdate(): void;
}

declare global {
  interface Window {
    /** Present only inside the Electron renderer. `undefined` in browser dev. */
    electronAPI?: ElectronAPI;
  }
}
