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
    /**
     * One-shot IPC call. `methodPath` is dotted (`coder.sessions.list`);
     * the bridge translates to the colon channel internally. Returns the
     * `{ok, value, error}` envelope produced by handlers-mount.ts.
     */
    invoke: (methodPath: string, payload: unknown) => Promise<unknown>;
    /**
     * AsyncIterable-backed stream call. Same path format as `invoke`.
     * Returns immediately; iteration waits on a MessagePort transferred
     * from main.
     */
    openStream: <T = unknown>(methodPath: string, payload: unknown) => AsyncIterable<T>;
    /** Quick check: is the given dotted path registered as a stream endpoint? */
    isStreamingPath: (methodPath: string) => boolean;
    /** Open a duplex MessagePort against an IPC stream channel. Used by terminal. */
    openDuplexStream?: (channel: string, payload: unknown) => {
      port: MessagePort;
      ready: Promise<void>;
    };
    /** Native folder picker. Returns the chosen path, or null if canceled. */
    openDirectory?: () => Promise<string | null>;
    /** Open a URL in the user's default browser. */
    openExternal?: (url: string) => void;
    /** Reveal a local folder/file in the OS file manager. */
    openPath?: (path: string) => void;
    /**
     * Spawn a new Electron window pointing at `route` (e.g. `/projects/42`
     * or `/company/sessions/7/main/work/chat`). The new window inherits
     * the same preload + protocol setup, so it talks to the same
     * in-process backend without extra wiring.
     */
    openInNewWindow?: (
      route: string,
      title?: string,
    ) => Promise<{ ok: boolean; windowId?: number; error?: string }>;
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
