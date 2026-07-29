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

const activeInvokes = new Map<string, AbortController>();
let cancelInvokeMounted = false;

function invokeKey(senderId: number, requestId: string): string {
  return `${senderId}:${requestId}`;
}

async function runInvoke(
  event: IpcMainInvokeEvent,
  input: unknown,
  run: (payload: unknown, signal: AbortSignal) => Promise<unknown>,
): Promise<unknown> {
  const decoded = decodeInvoke(input);
  const controller = new AbortController();
  const key = decoded.requestId ? invokeKey(event.sender.id, decoded.requestId) : null;
  const onDestroyed = () => controller.abort(new Error('renderer closed'));
  if (key) activeInvokes.set(key, controller);
  event.sender.once('destroyed', onDestroyed);
  try {
    return await run(decoded.payload, controller.signal);
  } finally {
    event.sender.removeListener('destroyed', onDestroyed);
    if (key) activeInvokes.delete(key);
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
    // Hand port1 to the renderer; renderer's preload is listening for
    // the same `stream-port:<requestId>` event name.
    event.sender.postMessage(`stream-port:${requestId}`, null, [port1]);
    void pumpStream(port2, fn, payload, channel);
  });
}

async function pumpStream(port: Electron.MessagePortMain, fn: AnyFn, payload: unknown, channel: string) {
  try {
    const iterable = fn(
      payload as never,
      createContext({ clientInfo: { sourceType: 'electron', origin: channel } }),
    ) as AsyncIterable<unknown>;
    port.start();
    for await (const value of iterable) {
      port.postMessage({ type: 'value', value });
    }
    port.postMessage({ type: 'done' });
  } catch (err) {
    port.postMessage({ type: 'error', error: serializeError(err) });
  } finally {
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
    event.sender.postMessage(`stream-port:${requestId}`, null, [port1]);
    void pumpHonoStream(port2, methodPath, payload, app);
  });
}

async function pumpHonoStream(
  port: Electron.MessagePortMain,
  methodPath: string,
  payload: unknown,
  app: Hono,
) {
  try {
    port.start();
    for await (const value of dispatchStreaming(app, methodPath, payload)) {
      port.postMessage({ type: 'value', value });
    }
    port.postMessage({ type: 'done' });
  } catch (err) {
    port.postMessage({ type: 'error', error: serializeError(err) });
  } finally {
    port.close();
  }
}
