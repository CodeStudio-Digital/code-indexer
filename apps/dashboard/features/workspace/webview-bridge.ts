/**
 * Host side of the plugin webview bridge. Sandboxed plugin iframes (null
 * origin) postMessage `{ __mcpPlugin:'invoke', id, method, payload }`; we
 * forward whitelisted api-bus methods to `apiCall` and post the result back.
 *
 * Two method classes:
 *  - READ_ONLY: forwarded with the iframe's payload as-is (project context).
 *  - NS_BOUND: the bridge OVERWRITES `namespace` (and fills `projectId`) from
 *    the frame's registered identity — a null-origin iframe can't be trusted to
 *    declare which plugin it is, so it can only ever touch its OWN tools /
 *    storage / permissions. Unregistered frames are rejected.
 *
 * Anything off both lists is rejected.
 */
import { apiCall, apiStream } from '../../lib/api-client.js';

const READ_ONLY = new Set<string>([
  'plugins.list',
  'plugins.get',
  'projects.list',
  'projects.get',
  'files.read',
]);

const NS_BOUND = new Set<string>([
  'plugins.invokeTool',
  'plugins.getPermissions',
  'plugins.storageGet',
  'plugins.storageSet',
  'plugins.storageList',
]);

/** Namespace-bound STREAMING methods (iframe `openStream`). */
const NS_BOUND_STREAM = new Set<string>(['plugins.execStream']);

/** AbortControllers for live iframe streams, per source frame then stream id. */
const liveStreams = new WeakMap<MessageEventSource, Map<number, AbortController>>();

export interface PluginFrameInfo {
  namespace: string;
  projectId?: number;
}

/** Identity per live plugin iframe, keyed by its `contentWindow`. */
const frames = new Map<MessageEventSource, PluginFrameInfo>();

export function registerPluginFrame(win: MessageEventSource, info: PluginFrameInfo): void {
  frames.set(win, info);
}

export function unregisterPluginFrame(win: MessageEventSource): void {
  frames.delete(win);
}

interface InvokeMessage {
  __mcpPlugin: 'invoke';
  id: number;
  method: string;
  payload?: unknown;
}

function isInvoke(d: unknown): d is InvokeMessage {
  return (
    typeof d === 'object' &&
    d !== null &&
    (d as { __mcpPlugin?: unknown }).__mcpPlugin === 'invoke' &&
    typeof (d as { method?: unknown }).method === 'string'
  );
}

type StreamKind = 'openStream' | 'closeStream';
interface StreamMessage {
  __mcpPlugin: StreamKind;
  id: number;
  method?: string;
  payload?: unknown;
}

function streamKind(d: unknown): StreamKind | null {
  const k = (d as { __mcpPlugin?: unknown })?.__mcpPlugin;
  return k === 'openStream' || k === 'closeStream' ? k : null;
}

function closeStream(source: MessageEventSource, id: number): void {
  const m = liveStreams.get(source);
  m?.get(id)?.abort();
  m?.delete(id);
}

/** Pump a namespace-bound api-bus stream to the iframe; abortable via closeStream. */
async function runStream(source: WindowProxy, msg: StreamMessage): Promise<void> {
  const post = (body: Record<string, unknown>): void =>
    source.postMessage({ __mcpPlugin: 'stream', id: msg.id, ...body }, '*');
  const method = msg.method ?? '';
  if (!NS_BOUND_STREAM.has(method)) {
    post({ event: 'error', error: `stream method not allowed: ${method}` });
    return;
  }
  const frame = frames.get(source);
  if (!frame) {
    post({ event: 'error', error: 'frame not registered' });
    return;
  }
  const merged: Record<string, unknown> = {
    ...(typeof msg.payload === 'object' && msg.payload ? msg.payload : {}),
    namespace: frame.namespace,
  };
  if (merged.projectId == null && frame.projectId != null) merged.projectId = frame.projectId;

  const ac = new AbortController();
  let perSource = liveStreams.get(source);
  if (!perSource) {
    perSource = new Map();
    liveStreams.set(source, perSource);
  }
  perSource.set(msg.id, ac);
  try {
    for await (const value of apiStream(method, merged)) {
      if (ac.signal.aborted) break;
      post({ event: 'data', value });
    }
    if (!ac.signal.aborted) post({ event: 'end' });
  } catch (err) {
    post({ event: 'error', error: err instanceof Error ? err.message : String(err) });
  } finally {
    perSource.delete(msg.id);
  }
}

/** Install the global listener. Returns a disposer. Mounted once on app load. */
export function installWebviewBridge(): () => void {
  const onMessage = async (e: MessageEvent): Promise<void> => {
    const sk = streamKind(e.data);
    if (sk) {
      const source = e.source as WindowProxy | null;
      if (!source) return;
      const msg = e.data as StreamMessage;
      if (sk === 'openStream') void runStream(source, msg);
      else closeStream(source, msg.id);
      return;
    }
    if (!isInvoke(e.data)) return;
    const { id, method, payload } = e.data;
    const source = e.source as WindowProxy | null;
    if (!source) return;
    const reply = (body: Record<string, unknown>): void =>
      source.postMessage({ __mcpPlugin: 'result', id, ...body }, '*');

    try {
      let result: unknown;
      if (NS_BOUND.has(method)) {
        const frame = frames.get(source);
        if (!frame) {
          reply({ ok: false, error: 'frame not registered' });
          return;
        }
        // Force the bound namespace; fill projectId when the frame knows it.
        const merged: Record<string, unknown> = {
          ...(typeof payload === 'object' && payload ? payload : {}),
          namespace: frame.namespace,
        };
        if (merged.projectId == null && frame.projectId != null) merged.projectId = frame.projectId;
        result = await apiCall(method, merged);
      } else if (READ_ONLY.has(method)) {
        result = await apiCall(method, payload);
      } else {
        reply({ ok: false, error: `method not allowed: ${method}` });
        return;
      }
      reply({ ok: true, result });
    } catch (err) {
      reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
