/**
 * Registry of live plugin iframes, keyed by their `contentWindow`. The webview
 * bridge binds every privileged call to the frame's registered identity (a
 * null-origin iframe can't be trusted to declare which plugin it is).
 *
 * `resolveFrame` tolerates a brief registration lag: a plugin can postMessage
 * around the moment its `WebviewWindow` registers it, so on a miss we retry once
 * after a short delay before treating the frame as truly unregistered. The
 * `ready` handshake (WebviewWindow ↔ the iframe shim) makes this path rare —
 * this is defense-in-depth so a transient never surfaces as a hard error.
 */
interface PluginFrameInfo {
  namespace: string;
  projectId?: number;
}

const frames = new Map<MessageEventSource, PluginFrameInfo>();

/** Grace before a missed frame lookup is retried, in ms. */
const RESOLVE_GRACE_MS = 60;

export function registerPluginFrame(win: MessageEventSource, info: PluginFrameInfo): void {
  frames.set(win, info);
}

export function unregisterPluginFrame(win: MessageEventSource): void {
  frames.delete(win);
}

/** The frame's identity, or null after one delayed retry. */
export function resolveFrame(source: MessageEventSource): Promise<PluginFrameInfo | null> {
  const hit = frames.get(source);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    setTimeout(() => resolve(frames.get(source) ?? null), RESOLVE_GRACE_MS);
  });
}
