declare const __APP_VERSION__: string;

/**
 * Surface exposed by the Electron preload's `contextBridge.exposeInMainWorld('electronAPI', …)`.
 *
 * Kept as a loose `unknown`-typed namespace on the bridged `api` field so the
 * existing `apiCall`/`apiStream` helpers can dereference deep paths without
 * dragging the full @mcp/api-bus into every dashboard module. Callers that
 * want strong types import the Api type from @mcp/api-bus directly.
 */
declare global {
  interface ElectronAPI {
    api: Record<string, unknown>;
    /** Open a duplex MessagePort against an IPC stream channel. Used by terminal. */
    openDuplexStream?: (channel: string, payload: unknown) => {
      port: MessagePort;
      ready: Promise<void>;
    };
    /** Native folder picker. Returns the chosen path, or null if canceled. */
    openDirectory?: () => Promise<string | null>;
    /** Open a URL in the user's default browser. */
    openExternal?: (url: string) => void;
    /** App version reported by Electron's main process. */
    getAppVersion?: () => Promise<string>;
    /** Show a native desktop notification. */
    showNotification?: (opts: { title: string; body: string }) => void;
    /** Auto-updater hooks (stubbed until Dia 17 of the macro plan lands). */
    onUpdateAvailable?: (cb: () => void) => () => void;
    restartAndUpdate?: () => void;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
