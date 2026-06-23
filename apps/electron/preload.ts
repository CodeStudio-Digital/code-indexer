/**
 * Electron preload script — runs in the renderer's context but with
 * `contextIsolation: true`, so the only thing we can touch is the safe
 * `contextBridge`. We expose `window.electronAPI` here, which the
 * dashboard imports via `@mcp/api-bus` types.
 *
 * Streaming methods (e.g. `coder.stream.sendMessage`) return an
 * AsyncIterable backed by a MessagePort transferred from the main
 * process. See `src/stream-port.ts` in main for the producer side.
 *
 * Why a dynamic dispatch instead of hand-rolled methods: the `Api`
 * surface has dozens of namespaces and hundreds of methods. Writing
 * each one twice (here + main) drifts. The IPC channel name encodes
 * `api:<namespace>:<method>` deterministically; main registers handlers
 * the same way. New endpoints land by adding the namespace to the bus
 * + a handler entry in `mountIpcHandlers` — preload requires no change.
 */

import { contextBridge, ipcRenderer } from 'electron';

// ─── Streaming pump ────────────────────────────────────────────
//
// For methods returning AsyncIterable<T>, main creates a MessageChannel,
// transfers `port1` via `webContents.postMessage('stream-port:<requestId>', null, [port1])`,
// and keeps `port2` to push frames. We register a one-shot listener for
// the matching `stream-port:<requestId>` event, then wrap the received
// port as an AsyncIterable.

interface StreamFrame<T> {
  type: 'value' | 'error' | 'done';
  value?: T;
  error?: { message: string; code?: string; status?: number };
}

interface DesktopNotificationOptions {
  title: string;
  body: string;
  route?: string;
  tag?: string;
  kind?: string;
}

let streamRequestSeq = 0;

function nextRequestId(): string {
  streamRequestSeq += 1;
  return `${Date.now().toString(36)}-${streamRequestSeq}`;
}

function openStream<T>(channel: string, payload: unknown): AsyncIterable<T> {
  const requestId = nextRequestId();
  const portPromise = new Promise<MessagePort>((resolve) => {
    const handler = (event: Electron.IpcRendererEvent) => {
      const port = event.ports?.[0];
      if (!port) return;
      ipcRenderer.removeListener(`stream-port:${requestId}`, handler);
      resolve(port);
    };
    ipcRenderer.on(`stream-port:${requestId}`, handler);
  });
  // Kick off the stream — main listens on `stream:<channel>` and
  // immediately replies with the MessagePort, then writes frames.
  ipcRenderer.send(`stream:${channel}`, { requestId, payload });

  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const queue: StreamFrame<T>[] = [];
      const waiters: Array<(r: IteratorResult<T>) => void> = [];
      let ended = false;
      let errorObj: unknown = null;

      void portPromise.then((port) => {
        port.onmessage = (msg) => {
          const frame = msg.data as StreamFrame<T>;
          if (frame.type === 'value') {
            const v = frame.value!;
            if (waiters.length > 0) {
              waiters.shift()!({ value: v, done: false });
            } else {
              queue.push(frame);
            }
          } else if (frame.type === 'error') {
            errorObj = new Error(frame.error?.message ?? 'stream error');
            ended = true;
            // Wake any waiter so they observe the error on next().
            while (waiters.length > 0) {
              waiters.shift()!({ value: undefined as never, done: true });
            }
            port.close();
          } else if (frame.type === 'done') {
            ended = true;
            while (waiters.length > 0) {
              waiters.shift()!({ value: undefined as never, done: true });
            }
            port.close();
          }
        };
        port.start?.();
      });

      return {
        async next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            const frame = queue.shift()!;
            if (frame.type === 'value') return { value: frame.value!, done: false };
          }
          if (errorObj) throw errorObj;
          if (ended) return { value: undefined as never, done: true };
          return new Promise<IteratorResult<T>>((resolve) => {
            waiters.push(resolve);
          }).then((r) => {
            if (errorObj) throw errorObj;
            return r;
          });
        },
        async return(): Promise<IteratorResult<T>> {
          ended = true;
          return { value: undefined as never, done: true };
        },
      };
    },
  };
}

// ─── IPC primitives exposed via contextBridge ─────────────────
//
// Earlier iterations of this file exposed a deeply-nested Proxy as
// `electronAPI.api` so the renderer could write
// `await window.electronAPI.api.coder.sessions.list(input)`. That
// looked elegant but didn't survive contextBridge: Electron's bridge
// serialises the exposed value at expose time, and Proxies have no
// own enumerable properties to walk — so the renderer received
// either an empty object (Electron 26+) or a stripped function
// (older versions). Effect: every IPC call that didn't have an
// HTTP fallback in `dottedToHttp` silently broke (e.g. `terminal.spawn`
// → "no HTTP fallback mapped" thrown by the dashboard).
//
// Fix: expose two PRIMITIVES — `invoke(channel, payload)` and
// `openStream(channel, payload)`. The renderer builds the
// `api.coder.sessions.list` Proxy LOCALLY using these, where Proxy
// semantics work natively. The channel-name → method-path mapping
// is now the renderer's job (it composes `api:<path-joined-by-colons>`
// from the dotted call).
//
// STREAMING_METHOD_PATHS still lives here because the choice of
// invoke-vs-stream has to be made by the caller (and the IPC
// channel name encodes both flavours via the `stream:` prefix).

const STREAMING_METHOD_PATHS: ReadonlySet<string> = new Set([
  'coder:stream:sendMessage',
  'coder:stream:continueSession',
  'coder:stream:attach',
  'projects:indexStream',
  'projects:retryEmbeddingsStream',
  // Terminal PTY — `terminal.open` returns a duplex MessagePort stream
  // (data/exit/error frames out, data/resize/close frames in via the
  // same port). Implemented by apps/electron/src/terminal-ipc.ts.
  'terminal:open',
  'terminal:output',
  'ssh:sftpDownloadStream',
  'ssh:sftpUploadStream',
  'runner:events',
  'runtime:download',
  // Universal "Inspect" — stream of element selections from the CDP preview
  // window. Implemented by apps/electron/src/preview-inspect-ipc.ts.
  'previewInspect:events',
  'docs:sources:createUrlStream',
  'docs:sources:createPdfStream',
  'docs:sources:createFolderStream',
  'docs:sources:reindexStream',
  'docs:sources:retryEmbeddingsStream',
  'docs:research:stream',
  'company:stream',
  'system:podmanMachineSetupStream',
]);

/**
 * Invoke a one-shot IPC method. `methodPath` is the dotted form
 * the renderer composes (e.g. `coder.sessions.list`). We translate
 * to the colon-channel here so the renderer doesn't need to know
 * the wire format.
 */
function invokeApi(methodPath: string, payload: unknown): Promise<unknown> {
  const channel = `api:${methodPath.split('.').join(':')}`;
  return ipcRenderer.invoke(channel, payload);
}

/**
 * Open an AsyncIterable-backed stream. Returns immediately; the iterable
 * waits on the MessagePort transferred from main. Same channel-name
 * conversion as invokeApi.
 */
function openApiStream<T>(methodPath: string, payload: unknown): AsyncIterable<T> {
  const colonPath = methodPath.split('.').join(':');
  return openStream<T>(`api:${colonPath}`, payload);
}

/**
 * Check whether a given dotted method path is a streaming endpoint.
 * The renderer uses this to decide between invokeApi and openApiStream
 * without having to import the catalogue.
 */
function isStreamingPath(methodPath: string): boolean {
  return STREAMING_METHOD_PATHS.has(methodPath.split('.').join(':'));
}

/**
 * Open a bidirectional message channel against a streaming IPC endpoint.
 *
 * Unlike `openStream` (which exposes only the async-iterable read side),
 * `openDuplex` returns a `{ port, ready }` pair where the caller owns the
 * MessagePort directly. Send via `port.postMessage(value)`, receive via
 * `port.onmessage = ev => …`. Used by the terminal panel — the PTY
 * needs both directions over the same channel (keystrokes in, bytes out).
 *
 * The `ready` promise resolves when the MessagePort has been transferred
 * from the main process. Until then, `port.postMessage()` enqueues
 * (Electron buffers until the other side is reachable).
 */
function openDuplex(channel: string, payload: unknown): { port: MessagePort; ready: Promise<void> } {
  const requestId = nextRequestId();
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => { resolveReady = r; });
  const intermediate = new MessageChannel();
  // The renderer-facing port is intermediate.port1; we pump frames from
  // the transferred Electron port onto it once it arrives. This lets the
  // caller start posting messages immediately (they queue on port1).
  const handler = (event: Electron.IpcRendererEvent) => {
    const transferred = event.ports?.[0];
    if (!transferred) return;
    ipcRenderer.removeListener(`stream-port:${requestId}`, handler);
    transferred.onmessage = (ev) => {
      const frame = ev.data as { type?: string; value?: unknown };
      if (frame?.type === 'value') intermediate.port1.postMessage(frame.value);
      else if (frame?.type === 'done' || frame?.type === 'error') {
        try { intermediate.port1.close(); } catch { /* */ }
        try { transferred.close(); } catch { /* */ }
      }
    };
    transferred.start?.();
    intermediate.port2.onmessage = (ev) => {
      try { transferred.postMessage(ev.data); } catch { /* port closed */ }
    };
    intermediate.port2.start();
    resolveReady();
  };
  ipcRenderer.on(`stream-port:${requestId}`, handler);
  ipcRenderer.send(`stream:${channel}`, { requestId, payload });
  intermediate.port1.start();
  return { port: intermediate.port1, ready };
}

/**
 * Subscribe to a main→renderer push channel. Returns an unsubscribe fn so
 * React effects can clean up. Used by the custom title bar to track
 * maximize/restore + window focus state.
 */
function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * OS platform, surfaced so the renderer can pick window-control chrome:
   * custom min/max/close on win32/linux, native traffic-lights on darwin.
   */
  platform: process.platform,
  /**
   * Drive the frameless window's title bar. Handlers live in
   * apps/electron/src/window-controls-ipc.ts and act on the *sending*
   * window (so "open in new window" stays isolated).
   */
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    close: () => ipcRenderer.send('window:close'),
    quit: () => ipcRenderer.send('app:quit'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
    onMaximizedChanged: (cb: (v: boolean) => void) => subscribe('window:maximized-changed', cb),
    onFocusChanged: (cb: (v: boolean) => void) => subscribe('window:focus-changed', cb),
  },
  /**
   * Cloud account/login — a SEPARATE HTTPS surface (the deployed Worker), not the
   * in-process api bus. The refresh token stays in main; the renderer only ever
   * sends an opaque op + receives `{ ok, status, body }` (tokens stripped).
   */
  cloud: {
    fetch: (op: string, input: unknown) =>
      ipcRenderer.invoke('cloud:fetch', op, input) as Promise<{ ok: boolean; status: number; body: unknown }>,
    getAuthState: () => ipcRenderer.invoke('cloud:auth-state') as Promise<{ state: string; account: unknown }>,
    logout: () => ipcRenderer.invoke('cloud:logout') as Promise<{ ok: true }>,
    // Browser OAuth: opens the system browser, returns once the loopback handoff
    // is redeemed (tokens handled in main). Renderer only learns ok/error.
    startBrowserLogin: (provider: string) =>
      ipcRenderer.invoke('cloud:startBrowserLogin', provider) as Promise<{ ok: boolean; error?: string }>,
    onAuthChanged: (cb: (state: { state: string; account: unknown }) => void) => subscribe('cloud:auth-changed', cb),
  },
  /**
   * SSH credential shim — encrypt/decrypt saved-host secrets with the OS
   * keychain (`safeStorage`). The renderer encrypts before persisting a host
   * and decrypts just before connecting; SQLite only ever holds ciphertext.
   */
  ssh: {
    encryptSecret: (plain: string) => ipcRenderer.invoke('ssh:encryptSecret', plain) as Promise<string>,
    decryptSecret: (blob: string) => ipcRenderer.invoke('ssh:decryptSecret', blob) as Promise<string>,
  },
  /**
   * Generalized device-bound secret shim (OS keychain via `safeStorage`).
   * Shared by the SSH client, the database client, and any future sensitive
   * store. `@mcp/secret-box` reads this bridge (falling back to `ssh` for
   * back-compat). SQLite only ever holds the tagged ciphertext.
   */
  secrets: {
    encrypt: (plain: string) => ipcRenderer.invoke('secrets:encrypt', plain) as Promise<string>,
    decrypt: (blob: string) => ipcRenderer.invoke('secrets:decrypt', blob) as Promise<string>,
  },
  // Primitives — see the IPC primitives section above. The renderer
  // builds a Proxy on top of these (Proxies don't cross contextBridge).
  invoke: invokeApi,
  openStream: openApiStream,
  isStreamingPath,
  /** Open a bidirectional MessagePort stream. See openDuplex above. */
  openDuplexStream: (channel: string, payload: unknown) => openDuplex(`api:${channel}`, payload),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  /** SFTP upload source — native open-file dialog, returns absolute paths (or []). */
  openFiles: () => ipcRenderer.invoke('dialog:openFiles') as Promise<string[]>,
  /** SFTP download target — native save dialog, returns absolute path (or null). */
  saveFile: (defaultName?: string) => ipcRenderer.invoke('dialog:saveFile', defaultName) as Promise<string | null>,
  openExternal: (url: string) => ipcRenderer.send('shell:openExternal', url),
  openPath: (path: string) => ipcRenderer.send('shell:openPath', path),
  /**
   * Start/stop the ephemeral OAuth loopback listener (RFC 8252). The MCP
   * OAuth dialog starts it just before opening the provider login in the
   * external browser, then stops it once consent completes or is cancelled.
   */
  oauthLoopbackStart: () =>
    ipcRenderer.invoke('oauth:loopback:start') as Promise<{
      ok: boolean;
      port?: number;
      error?: string;
    }>,
  oauthLoopbackStop: () => ipcRenderer.send('oauth:loopback:stop'),
  /**
   * Spawn a new Electron window pointing at `route` (e.g. `/projects/42`).
   * Returns `{ ok, windowId? , error? }`. The new window inherits the
   * same preload + protocol setup, so it talks to the same in-process
   * backend with no extra wiring.
   */
  openInNewWindow: (route: string, title?: string) =>
    ipcRenderer.invoke('window:open', { route, title }) as Promise<{
      ok: boolean;
      windowId?: number;
      error?: string;
    }>,
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  showNotification: (opts: DesktopNotificationOptions) => ipcRenderer.send('app:notify', opts),
  isNotificationSupported: () => ipcRenderer.invoke('app:notificationSupported') as Promise<boolean>,
  onNavigate: (cb: (route: string) => void) => subscribe('app:navigate', cb),
  // Auto-updater hooks land in Dia 17; stubbed so the dashboard typechecks.
  onUpdateAvailable: (_cb: () => void) => () => undefined,
  restartAndUpdate: () => undefined,
});
