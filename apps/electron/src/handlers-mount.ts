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
 */

import { ipcMain, MessageChannelMain, type IpcMainEvent } from 'electron';
import { createHandlers, createContext } from '@mcp/api-handlers';
import type { ApiError } from '@mcp/api-bus';
import type { ServerDeps } from '@apps/http-api/server/deps.js';

type AnyFn = (...args: unknown[]) => unknown;
type AnyRecord = Record<string, unknown>;

function isApiError(err: unknown): err is ApiError {
  return !!err && typeof err === 'object' && 'code' in err && 'status' in err && err instanceof Error;
}

function serializeError(err: unknown) {
  if (isApiError(err)) {
    return { message: err.message, code: err.code, status: err.status };
  }
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

/**
 * Walk a `Partial<Api>` object and bind every leaf function to
 * `ipcMain.handle`. The channel key encodes the access path with colons:
 *
 *   handlers.coder.sessions.list  →  api:coder:sessions:list
 *
 * Streaming methods (return AsyncIterable) are detected by name suffix
 * /Stream$/, by being inside the `stream` sub-namespace of `coder`, or
 * by being `terminal.output` / `company.stream`. They register on
 * `stream:<channel>` and pump frames over a MessagePort transferred
 * to the renderer.
 */
function isStreamingLeaf(path: string[], fnName: string): boolean {
  if (/Stream$/.test(fnName)) return true;
  if (path[0] === 'coder' && path[1] === 'stream') return true;
  if (path[0] === 'terminal' && fnName === 'output') return true;
  if (path[0] === 'company' && fnName === 'stream') return true;
  return false;
}

function bind(handlers: AnyRecord, basePath: string[]) {
  for (const [key, value] of Object.entries(handlers)) {
    const path = [...basePath, key];
    if (typeof value === 'function') {
      const fn = value as AnyFn;
      const channel = `api:${path.join(':')}`;
      if (isStreamingLeaf(basePath, key)) {
        mountStream(channel, fn);
      } else {
        mountInvoke(channel, fn);
      }
    } else if (value && typeof value === 'object') {
      bind(value as AnyRecord, path);
    }
  }
}

function mountInvoke(channel: string, fn: AnyFn) {
  ipcMain.handle(channel, async (_event, input: unknown) => {
    try {
      const result = await fn(input as never, createContext());
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
    void pumpStream(port2, fn, payload);
  });
}

async function pumpStream(port: Electron.MessagePortMain, fn: AnyFn, payload: unknown) {
  try {
    const iterable = fn(payload as never, createContext()) as AsyncIterable<unknown>;
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

export function mountIpcHandlers(deps: ServerDeps): void {
  const handlers = createHandlers(deps) as AnyRecord;
  bind(handlers, []);
}
