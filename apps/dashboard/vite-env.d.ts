declare const __APP_VERSION__: string;

declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js' {
  export const StandaloneServices: {
    initialize(overrides?: Record<string, unknown>): unknown;
  };
}

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
    invoke: (methodPath: string, payload: unknown, requestId?: string) => Promise<unknown>;
    /** Abort a one-shot IPC call previously started with `requestId`. */
    cancelInvoke?: (requestId: string) => void;
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
    /** Absolute path for an OS-backed File; empty for synthetic/clipboard Files. */
    getPathForFile?: (file: File) => string;
    /** Native multi-file picker. Used by desktop-first JSONL session import. */
    openFiles?: () => Promise<string[]>;
    /** Open a URL in the user's default browser. */
    openExternal?: (url: string) => void;
    /** Reveal a local folder/file in the OS file manager. */
    openPath?: (path: string) => void;
    /** Reveal a file in its containing folder, with the file selected. */
    showItemInFolder?: (path: string) => void;
    /**
     * Start the ephemeral 127.0.0.1 OAuth loopback (RFC 8252) used to
     * capture the redirect when MCP OAuth opens in the external browser.
     * Resolves `{ ok, port }`, or `{ ok:false, error }` if the port is busy.
     */
    oauthLoopbackStart?: () => Promise<{ ok: boolean; port?: number; error?: string }>;
    /** Tear down the OAuth loopback listener (idempotent). */
    oauthLoopbackStop?: () => void;
    /**
     * Spawn a new Electron window pointing at `route` (e.g. `/projects/42`
     * or `/company/sessions/dddddddd-dddd-4ddd-8ddd-dddddddddddd/main/work/chat`).
     * The new window inherits
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
    showNotification?: (opts: {
      title: string;
      body: string;
      route?: string;
      tag?: string;
      kind?: string;
    }) => void;
    /** Whether Electron can show native desktop notifications on this OS. */
    isNotificationSupported?: () => Promise<boolean>;
    /** Navigate an existing renderer window after a native notification click. */
    onNavigate?: (cb: (route: string) => void) => () => void;
    /**
     * Window → project registry (title-bar switcher): report this window's
     * active project, and list/focus projects open in other windows.
     * Electron-only — undefined in a plain-browser dev session.
     */
    windowRegistry?: {
      setActiveProject: (projectId: number) => void;
      listOpenProjects: () => Promise<
        Array<{ windowId: number; projectId: number; focused: boolean }>
      >;
      focusProject: (projectId: number) => Promise<{ ok: boolean; windowId?: number }>;
      onOpenProjectsChanged: (
        cb: (list: Array<{ windowId: number; projectId: number; focused: boolean }>) => void,
      ) => () => void;
    };
    /** Auto-updater hooks (stubbed until Dia 17 of the macro plan lands). */
    onUpdateAvailable?: (cb: () => void) => () => void;
    restartAndUpdate?: () => void;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
