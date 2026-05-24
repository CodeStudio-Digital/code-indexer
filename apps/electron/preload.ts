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

contextBridge.exposeInMainWorld('electronAPI', {
  api: buildApiProxy([]),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  openExternal: (url: string) => ipcRenderer.send('shell:openExternal', url),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  showNotification: (opts: { title: string; body: string }) => ipcRenderer.send('app:notify', opts),
  // Auto-updater hooks land in Dia 17; stubbed so the dashboard typechecks.
  onUpdateAvailable: (_cb: () => void) => () => undefined,
  restartAndUpdate: () => undefined,
});
