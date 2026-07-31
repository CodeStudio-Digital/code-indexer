/**
 * Wire the @mcp/api-handlers factory onto Electron's `ipcMain.handle`
 * + MessagePort streaming. Mirrors how Hono adapts the same handlers
 * to HTTP/SSE in apps/http-api/server.ts.
 *
 * Channel naming convention:
 *   `api:<namespace>[:<sub>]:<method>` for one-shot calls (Promise<T>)
 *   `stream:api:<namespace>[:<sub>]:<method>` for streams (MessagePort)
 *
 * The renderer's preload builds matching channel names from the proxy
 * access path, so adding a new method requires no preload changes —
 * only the new handler factory entry below.
 *
 * The transport-blind half — the tree walk, the channel-naming convention, the
 * cancellable-invoke envelope and the error wire shape — lives in
 * `@apps/http-api/server/handler-tree.js` so a second host can bind the same
 * handlers without duplicating (and drifting from) any of it. What stays here
 * is only what `ipcMain` / `MessageChannelMain` specifically require.
 */

import { ipcMain, MessageChannelMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { createHandlers, createContext } from '@mcp/api-handlers';
import type { ServerDeps } from '@apps/http-api/server/deps.js';
import type { Hono } from 'hono';
import {
  DISPATCH_TABLE,
  STREAMING_DISPATCH_PATHS,
  dispatchHono,
  dispatchStreaming,
} from '@apps/http-api/server/hono-dispatch.js';
import { timeCall } from '@apps/http-api/server/perf/slow-ipc.js';
import {
  type AnyFn,
  type AnyRecord,
  decodeInvoke,
  serializeError,
  walkHandlers,
} from '@apps/http-api/server/handler-tree.js';
import { raceWithAbort } from './invoke-lifecycle.js';

const activeInvokes = new Map<string, AbortController>();
const activeRequestsBySender = new Map<number, Set<AbortController>>();
const senderLifecycleMounted = new WeakSet<Electron.WebContents>();
let cancelInvokeMounted = false;

function invokeKey(senderId: number, requestId: string): string {
  return `${senderId}:${requestId}`;
}

function abortSenderRequests(senderId: number, reason: string): void {
  const controllers = activeRequestsBySender.get(senderId);
  if (!controllers) return;
  activeRequestsBySender.delete(senderId);
  for (const controller of controllers) {
    controller.abort(new Error(reason));
  }
  for (const [key, controller] of activeInvokes) {
    if (controllers.has(controller)) activeInvokes.delete(key);
  }
}

function ensureSenderLifecycle(sender: Electron.WebContents): void {
  if (senderLifecycleMounted.has(sender)) return;
  senderLifecycleMounted.add(sender);
  const senderId = sender.id;
  sender.on(
    'did-start-navigation',
    (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) {
        abortSenderRequests(senderId, 'renderer navigated');
      }
    },
  );
  sender.once('render-process-gone', () => {
    abortSenderRequests(senderId, 'renderer process exited');
  });
  sender.once('destroyed', () => {
    abortSenderRequests(senderId, 'renderer closed');
  });
}

function trackSenderRequest(
  sender: Electron.WebContents,
  controller: AbortController,
): () => void {
  ensureSenderLifecycle(sender);
  const senderId = sender.id;
  let requests = activeRequestsBySender.get(senderId);
  if (!requests) {
    requests = new Set();
    activeRequestsBySender.set(senderId, requests);
  }
  requests.add(controller);
  return () => {
    requests.delete(controller);
    if (requests.size === 0 && activeRequestsBySender.get(senderId) === requests) {
      activeRequestsBySender.delete(senderId);
    }
  };
}

async function runInvoke(
  event: IpcMainInvokeEvent,
  input: unknown,
  run: (payload: unknown, signal: AbortSignal) => Promise<unknown>,
): Promise<unknown> {
  const decoded = decodeInvoke(input);
  const controller = new AbortController();
  const senderId = event.sender.id;
  const key = decoded.requestId ? invokeKey(senderId, decoded.requestId) : null;
  const untrack = trackSenderRequest(event.sender, controller);
  if (key) {
    activeInvokes.get(key)?.abort(new Error('request superseded'));
    activeInvokes.set(key, controller);
  }
  try {
    return await raceWithAbort(
      controller.signal,
      () => run(decoded.payload, controller.signal),
    );
  } finally {
    untrack();
    if (key && activeInvokes.get(key) === controller) {
      activeInvokes.delete(key);
    }
  }
}

function ensureCancelInvokeMounted(): void {
  if (cancelInvokeMounted) return;
  cancelInvokeMounted = true;
  ipcMain.on('api:cancel-invoke', (event, requestId: unknown) => {
    if (typeof requestId !== 'string') return;
    activeInvokes.get(invokeKey(event.sender.id, requestId))?.abort(new Error('request cancelled'));
  });
}

function mountInvoke(channel: string, fn: AnyFn) {
  ipcMain.handle(channel, async (event, input: unknown) => {
    try {
      // Slow-call instrumentation: calls >50ms aggregate per channel in
      // the perf monitor (Admin → Performance → Chamadas lentas).
      const result = await timeCall(channel, () => runInvoke(event, input, (payload, signal) =>
        Promise.resolve(fn(payload as never, createContext({
          signal,
          clientInfo: { sourceType: 'electron', origin: channel },
        }))),
      ),
      );
      return { ok: true, value: result };
    } catch (err) {
      return { ok: false, error: serializeError(err) };
    }
  });
}

function mountStream(channel: string, fn: AnyFn) {
  ipcMain.on(`stream:${channel}`, (event: IpcMainEvent, msg: { requestId: string; payload: unknown }) => {
    const { requestId, payload } = msg;
    const { port1, port2 } = new MessageChannelMain();
    const controller = new AbortController();
    const untrack = trackSenderRequest(event.sender, controller);
    // Hand port1 to the renderer; renderer's preload is listening for
    // the same `stream-port:<requestId>` event name.
    event.sender.postMessage(`stream-port:${requestId}`, null, [port1]);
    void pumpStream(
      port2,
      fn,
      payload,
      channel,
      controller.signal,
    ).finally(untrack);
  });
}

async function pumpStream(
  port: Electron.MessagePortMain,
  fn: AnyFn,
  payload: unknown,
  channel: string,
  signal: AbortSignal,
) {
  let iterator: AsyncIterator<unknown> | undefined;
  try {
    const iterable = fn(
      payload as never,
      createContext({
        signal,
        clientInfo: { sourceType: 'electron', origin: channel },
      }),
    ) as AsyncIterable<unknown>;
    iterator = iterable[Symbol.asyncIterator]();
    port.start();
    while (true) {
      const step = await raceWithAbort(signal, () => iterator!.next());
      if (step.done) break;
      port.postMessage({ type: 'value', value: step.value });
    }
    port.postMessage({ type: 'done' });
  } catch (err) {
    if (!signal.aborted) {
      port.postMessage({ type: 'error', error: serializeError(err) });
    }
  } finally {
    if (signal.aborted && iterator?.return) {
      void Promise.resolve(iterator.return()).catch(() => undefined);
    }
    port.close();
  }
}

/**
 * Mount every pure handler over IPC and return the built handlers object,
 * so main.ts can reuse the SAME instances (e.g. the runner registry the
 * preview resolver borrows — a second `createHandlers` would have its own,
 * empty task list and never see the dashboard's running dev servers).
 */
export function mountIpcHandlers(deps: ServerDeps, honoApp?: Hono): ReturnType<typeof createHandlers> {
  ensureCancelInvokeMounted();
  const handlers = createHandlers(deps);
  // The walk is shared with the (future) utilityProcess host; only what a leaf
  // BINDS to is Electron-specific, so that is all this visitor decides.
  const boundChannels = walkHandlers(handlers as AnyRecord, ({ channel, fn, streaming }) => {
    if (streaming) mountStream(channel, fn);
    else mountInvoke(channel, fn);
  });

  // ─── Hono dispatch fallback ─────────────────────────────────
  //
  // Anything in the DISPATCH_TABLE that ISN'T already covered by a
  // pure handler gets a thin IPC wrapper that dispatches via
  // `app.fetch(Request)` — same Hono routes the dev HTTP listener
  // serves, but with zero socket. The wrapper marshals the IPC payload
  // into a synthetic Request and translates the Response back into
  // either an IPC reply (Promise<T>) or an SSE-→-MessagePort stream.
  //
  // As individual namespaces get extracted to pure handlers, their
  // rows can be deleted from DISPATCH_TABLE. End state: this whole
  // block deletes itself.
  if (honoApp) {
    for (const methodPath of Object.keys(DISPATCH_TABLE)) {
      const channel = `api:${methodPath.split('.').join(':')}`;
      if (boundChannels.has(channel)) continue;
      if (STREAMING_DISPATCH_PATHS.has(methodPath)) {
        mountHonoStream(channel, methodPath, honoApp);
      } else {
        mountHonoInvoke(channel, methodPath, honoApp);
      }
    }
  }
  return handlers;
}

function mountHonoInvoke(channel: string, methodPath: string, app: Hono) {
  ipcMain.handle(channel, async (event, input: unknown) => {
    try {
      const result = await timeCall(channel, () => runInvoke(
        event,
        input,
        (payload, signal) => dispatchHono(app, methodPath, payload, signal),
      ));
      return { ok: true, value: result };
    } catch (err) {
      return { ok: false, error: serializeError(err) };
    }
  });
}

function mountHonoStream(channel: string, methodPath: string, app: Hono) {
  ipcMain.on(`stream:${channel}`, (event: IpcMainEvent, msg: { requestId: string; payload: unknown }) => {
    const { requestId, payload } = msg;
    const { port1, port2 } = new MessageChannelMain();
    const controller = new AbortController();
    const untrack = trackSenderRequest(event.sender, controller);
    event.sender.postMessage(`stream-port:${requestId}`, null, [port1]);
    void pumpHonoStream(
      port2,
      methodPath,
      payload,
      app,
      controller.signal,
    ).finally(untrack);
  });
}

async function pumpHonoStream(
  port: Electron.MessagePortMain,
  methodPath: string,
  payload: unknown,
  app: Hono,
  signal: AbortSignal,
) {
  try {
    port.start();
    for await (const value of dispatchStreaming(
      app,
      methodPath,
      payload,
      signal,
    )) {
      port.postMessage({ type: 'value', value });
    }
    port.postMessage({ type: 'done' });
  } catch (err) {
    if (!signal.aborted) {
      port.postMessage({ type: 'error', error: serializeError(err) });
    }
  } finally {
    port.close();
  }
}
