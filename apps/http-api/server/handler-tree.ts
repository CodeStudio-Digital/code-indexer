/**
 * Host-agnostic pieces of the api-handlers → transport binding.
 *
 * These used to live in apps/electron/src/handlers-mount.ts, which made them
 * reachable only from the Electron main process. Nothing here touches
 * `electron`: it is the tree walk, the channel-naming convention, the
 * cancellable-invoke envelope and the error wire shape — all of which a second
 * host (a `utilityProcess` binding the same handlers to a MessagePort) needs
 * verbatim. Keeping one copy is the point; two would drift.
 *
 * Channel naming convention (unchanged, and the renderer's preload builds the
 * same strings from its proxy access path):
 *   `api:<namespace>[:<sub>]:<method>`         one-shot calls (Promise<T>)
 *   `stream:api:<namespace>[:<sub>]:<method>`  streams (AsyncIterable<T>)
 */

import type { ApiError } from '@mcp/api-bus';

export type AnyFn = (...args: unknown[]) => unknown;
export type AnyRecord = Record<string, unknown>;

/**
 * Slow-call key for the Request/Response path (the `mcp://` protocol handler
 * and the OAuth loopback), the counterpart to the `api:…` channel names below.
 *
 * Numeric project/catalog IDs and UUID operational IDs collapse to `:id` so
 * per-id routes share one row. Without this the bounded channel table fills
 * with one entry per project/session id and stops recording anything new.
 */
export function normalizeRouteKey(pathname: string): string {
  return pathname.replace(
    /\/(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\/|$)/gi,
    '/:id',
  );
}

/**
 * Wire form of a call that the caller may cancel. Older clients send the bare
 * payload, so `decodeInvoke` accepts both.
 */
interface CancellableInvokeEnvelope {
  __mcpInvokeV1: true;
  requestId: string;
  payload: unknown;
}

interface SerializedError {
  message: string;
  code?: string;
  status?: number;
  details?: Record<string, unknown>;
}

export function decodeInvoke(input: unknown): { payload: unknown; requestId?: string } {
  const value = input as Partial<CancellableInvokeEnvelope> | null;
  if (value?.__mcpInvokeV1 === true && typeof value.requestId === 'string') {
    return { payload: value.payload, requestId: value.requestId };
  }
  return { payload: input };
}

function isApiError(err: unknown): err is ApiError {
  return !!err && typeof err === 'object' && 'code' in err && 'status' in err && err instanceof Error;
}

export function serializeError(err: unknown): SerializedError {
  if (isApiError(err)) {
    // `details` carries structured, actionable metadata (e.g. the SSH host-key
    // fingerprint on `ssh_host_key_unknown`) the renderer needs to react —
    // forwarded only when present so ordinary errors stay lean.
    return { message: err.message, code: err.code, status: err.status, details: err.details };
  }
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

/**
 * Streaming methods (return AsyncIterable) are detected by name suffix
 * /Stream$/, by living in the `stream` sub-namespace of `coder`, or by an
 * explicit exception below. `path` is the namespace path WITHOUT the leaf.
 */
export function isStreamingLeaf(path: string[], fnName: string): boolean {
  if (/Stream$/.test(fnName)) return true;
  if (path[0] === 'coder' && path[1] === 'stream') return true;
  if (path[0] === 'terminal' && fnName === 'output') return true;
  if (path[0] === 'runner' && fnName === 'events') return true;
  if (path[0] === 'debug' && fnName === 'events') return true;
  if (path[0] === 'runtime' && (fnName === 'install' || fnName === 'installPeclExtension')) return true;
  if (path[0] === 'company' && fnName === 'stream') return true;
  return false;
}

export interface HandlerLeaf {
  /** Full channel name, e.g. `api:coder:sessions:list`. */
  channel: string;
  /** Access path including the leaf, e.g. `['coder','sessions','list']`. */
  path: string[];
  fn: AnyFn;
  streaming: boolean;
}

/**
 * Walk a `Partial<Api>` object and hand every leaf function to `visit`.
 *
 * The walk is deliberately transport-blind — the caller decides what binding a
 * leaf means (`ipcMain.handle`, a MessagePort dispatcher, a test double). It
 * returns the set of channels it produced so a host can skip them when
 * mounting fallbacks for namespaces the factory does not implement.
 */
export function walkHandlers(
  handlers: AnyRecord,
  visit: (leaf: HandlerLeaf) => void,
  basePath: string[] = [],
  boundChannels: Set<string> = new Set(),
): Set<string> {
  for (const [key, value] of Object.entries(handlers)) {
    const path = [...basePath, key];
    if (typeof value === 'function') {
      const channel = `api:${path.join(':')}`;
      visit({ channel, path, fn: value as AnyFn, streaming: isStreamingLeaf(basePath, key) });
      boundChannels.add(channel);
    } else if (value && typeof value === 'object') {
      walkHandlers(value as AnyRecord, visit, path, boundChannels);
    }
  }
  return boundChannels;
}
