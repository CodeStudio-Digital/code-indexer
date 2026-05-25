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
  'docs:sources:createUrlStream',
  'docs:sources:createPdfStream',
  'docs:sources:createFolderStream',
  'docs:sources:reindexStream',
  'docs:sources:retryEmbeddingsStream',
  'docs:research:stream',
  'company:stream',
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

contextBridge.exposeInMainWorld('electronAPI', {
  // Primitives — see the IPC primitives section above. The renderer
  // builds a Proxy on top of these (Proxies don't cross contextBridge).
  invoke: invokeApi,
  openStream: openApiStream,
  isStreamingPath,
  /** Open a bidirectional MessagePort stream. See openDuplex above. */
  openDuplexStream: (channel: string, payload: unknown) => openDuplex(`api:${channel}`, payload),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  openExternal: (url: string) => ipcRenderer.send('shell:openExternal', url),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  showNotification: (opts: { title: string; body: string }) => ipcRenderer.send('app:notify', opts),
  // Auto-updater hooks land in Dia 17; stubbed so the dashboard typechecks.
  onUpdateAvailable: (_cb: () => void) => () => undefined,
  restartAndUpdate: () => undefined,
});
