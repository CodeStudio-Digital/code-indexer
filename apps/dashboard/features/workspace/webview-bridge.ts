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
import { confirm as hostConfirm, prompt as hostPrompt, toast } from '../../components/ui/prompt-dialog.js';
import i18n from '../../i18n/index.js';

const READ_ONLY = new Set<string>([
  'plugins.list',
  'plugins.get',
  'projects.list',
  'projects.get',
  'files.read',
  // Global, non-namespaced reads usable by any plugin webview.
  'plugins.listModels',
  'plugins.assistantConfirm',
]);

const NS_BOUND = new Set<string>([
  'plugins.invokeTool',
  'plugins.getPermissions',
  'plugins.storageGet',
  'plugins.storageSet',
  'plugins.storageList',
]);

/** Namespace-bound STREAMING methods (iframe `openStream`). */
const NS_BOUND_STREAM = new Set<string>(['plugins.execStream', 'plugins.assistantStream']);

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
    post({ event: 'error', error: i18n.t('plugins:bridge.streamMethodNotAllowed', { method }) });
    return;
  }
  const frame = frames.get(source);
  if (!frame) {
    post({ event: 'error', error: i18n.t('plugins:bridge.frameNotRegistered') });
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

/**
 * Host-rendered dialogs/toasts for plugin webviews. A sandboxed iframe
 * (`allow-scripts`, no `allow-modals`) can't use window.confirm/alert/prompt —
 * they silently no-op — so plugins call `window.mcp.ui.*`, which routes here to
 * the app's GLOBAL dialog host (the same confirm/prompt/toast the rest of the
 * IDE uses). Pure UI: no privilege, no backend, no namespace binding. Options
 * are coerced to strings so a plugin can't smuggle non-text into the dialog.
 */
async function handlePluginUi(method: string, payload: unknown): Promise<unknown> {
  const p = (typeof payload === 'object' && payload ? payload : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  // Plugin-facing field names (message/confirmText/danger) → the host dialog's
  // internal names (description/confirmLabel/tone), so plugin authors don't
  // depend on our internals.
  switch (method) {
    case 'plugins.ui.confirm':
      return hostConfirm({
        title: str(p.title) ?? i18n.t('plugins:ui.confirmTitle'),
        description: str(p.message),
        confirmLabel: str(p.confirmText),
        cancelLabel: str(p.cancelText),
        tone: p.danger ? 'destructive' : 'default',
      });
    case 'plugins.ui.prompt':
      return hostPrompt({
        title: str(p.title) ?? i18n.t('plugins:ui.inputTitle'),
        description: str(p.message),
        defaultValue: str(p.defaultValue),
        placeholder: str(p.placeholder),
        confirmLabel: str(p.confirmText),
        cancelLabel: str(p.cancelText),
      });
    case 'plugins.ui.alert':
      // No dedicated alert host — a single-acknowledge confirm reads as a notice.
      await hostConfirm({
        title: str(p.title) ?? i18n.t('plugins:ui.noticeTitle'),
        description: str(p.message),
        confirmLabel: str(p.confirmText) ?? i18n.t('plugins:ui.ok'),
        cancelLabel: i18n.t('plugins:ui.close'),
      });
      return null;
    case 'plugins.ui.toast': {
      const kind = p.kind === 'success' || p.kind === 'error' || p.kind === 'warning' ? p.kind : 'info';
      toast[kind](str(p.message) ?? '', { duration: typeof p.durationMs === 'number' ? p.durationMs : undefined });
      return null;
    }
    default:
      throw new Error(`unknown ui method: ${method}`);
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
      if (method.startsWith('plugins.ui.')) {
        result = await handlePluginUi(method, payload);
      } else if (NS_BOUND.has(method)) {
        const frame = frames.get(source);
        if (!frame) {
          reply({ ok: false, error: i18n.t('plugins:bridge.frameNotRegistered') });
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
        reply({ ok: false, error: i18n.t('plugins:bridge.methodNotAllowed', { method }) });
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
