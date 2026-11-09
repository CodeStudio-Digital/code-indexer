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

import type { SerializableAsyncIterator } from '@mcp/shared/utils/serializable-stream.js';

export interface ElectronAPI {
  /** Per-launch packaged CSP nonce used only for sandboxed plugin scripts. */
  rendererCspNonce?: string | null;

  /** Preload exposes RPC functions; it does not expose a nested API proxy. */
  invoke(methodPath: string, payload: unknown, requestId?: string): Promise<unknown>;
  cancelInvoke?(requestId: string): void;
  openStream<T = unknown>(methodPath: string, payload: unknown): SerializableAsyncIterator<T>;
  isStreamingPath(methodPath: string): boolean;
  openDuplexStream?(channel: string, payload: unknown): { port: MessagePort; ready: Promise<void> };
  openFiles?(): Promise<string[]>;
  saveFile?(defaultName?: string): Promise<string | null>;
  oauthLoopbackStart?(): Promise<{ ok: boolean; port?: number; error?: string }>;
  oauthLoopbackStop?(): void;
  oauthOpenExternal?(url: string): Promise<void>;
  openInNewWindow?(route: string, title?: string): Promise<{ ok: boolean; windowId?: number; error?: string }>;
  windowRegistry?: {
    setActiveProject(projectId: number): void;
    listOpenProjects(): Promise<Array<{ windowId: number; projectId: number; focused: boolean }>>;
    focusProject(projectId: number): Promise<{ ok: boolean; windowId?: number }>;
    onOpenProjectsChanged(callback: (list: Array<{ windowId: number; projectId: number; focused: boolean }>) => void): () => void;
  };

  /** Native folder picker — used in the Onboarding wizard + ProjectSwitcher. */
  openDirectory(): Promise<string | null>;

  /** Absolute path for an OS-backed File; empty for synthetic/clipboard Files. */
  getPathForFile(file: File): string;

  /** Open a URL in the default browser (Stripe checkout, doc links). */
  openExternal(url: string): void;

  /** Reveal a local folder/file in the OS file manager (Explorer/Finder/…). */
  openPath(path: string): void;

  /** Reveal a file in its containing folder, with the file selected. */
  showItemInFolder(path: string): void;

  /** App version from electron `app.getVersion()`. */
  getAppVersion(): Promise<string>;

  /** Native OS notification with optional deep-link route. */
  showNotification(opts: {
    title: string;
    body: string;
    route?: string;
    tag?: string;
    kind?: string;
  }): void;

  /** Whether Electron can show native desktop notifications on this OS. */
  isNotificationSupported?(): Promise<boolean>;

  /** Subscribe to main-process internal navigation requests. */
  onNavigate?(callback: (route: string) => void): () => void;

  /**
   * Auto-updater hooks. Wired in apps/electron/main.ts against
   * electron-updater (Dia 17). MVP: no-op stubs so the React side
   * compiles before the updater lands.
   */
  onUpdateAvailable(callback: () => void): () => void;
  restartAndUpdate(): void;

  /** OS platform — `'win32' | 'darwin' | 'linux'` (Node `process.platform`). */
  platform: NodeJS.Platform;

  /**
   * Custom title-bar controls for the frameless window. The dashboard's
   * top header renders its own min/max/close (win32/linux) and reads
   * maximize/focus state from the subscribe callbacks (which return an
   * unsubscribe fn). See apps/electron/src/window-controls-ipc.ts.
   */
  windowControls: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    quit(): void;
    isMaximized(): Promise<boolean>;
    onMaximizedChanged(cb: (v: boolean) => void): () => void;
    onFocusChanged(cb: (v: boolean) => void): () => void;
  };
}

declare global {
  interface Window {
    /** Present only inside the Electron renderer. `undefined` in browser dev. */
    electronAPI?: ElectronAPI;
  }
}
