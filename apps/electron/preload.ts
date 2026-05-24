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

// ─── Proxy builder for the Api surface ────────────────────────
//
// We build a deeply-nested Proxy. Property accesses walk the namespace
// chain (`api.coder.sessions.list`) without instantiating intermediates
// until the call site invokes `(input)`. The leaf invocation maps to
// `ipcRenderer.invoke('api:coder:sessions:list', input)`.
//
// Streaming methods are detected by suffix convention — they all live
// under `coder.stream.*` and have known names. Anything else is a
// regular promise call. This avoids tagging methods at the bus level.

const STREAMING_METHOD_PATHS = new Set<string>([
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

function buildApiProxy(prefix: string[]): unknown {
  const target = function (..._args: unknown[]) {
    /* placeholder body for typeof check */
  };
  return new Proxy(target, {
    get(_t, prop: string) {
      if (typeof prop !== 'string') return undefined;
      return buildApiProxy([...prefix, prop]);
    },
    apply(_t, _thisArg, args) {
      const channel = `api:${prefix.join(':')}`;
      const isStream = STREAMING_METHOD_PATHS.has(prefix.join(':'));
      const input = args[0];
      if (isStream) {
        return openStream(channel, input);
      }
      return ipcRenderer.invoke(channel, input);
    },
  });
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
  api: buildApiProxy([]),
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
