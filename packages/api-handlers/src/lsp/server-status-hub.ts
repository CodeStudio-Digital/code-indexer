/**
 * Per-project LSP server-status pub/sub — the push side that makes the
 * editor's language chip live. The manager fires a transition (starting →
 * ready → failed → …) via its `onStateChange` dep; `ensureLspManager`
 * translates serverId → languageId and publishes here; the renderer's
 * `serverStatusStream` consumes, filtered per languageId in the chip hook.
 *
 * COALESCED PER languageId — a slow consumer only ever sees the latest
 * state for each language, never a backlog. MODULE SINGLETON, same
 * two-instances Electron constraint as the document store / diagnostics hub.
 */
import type { LspServerStatusFrame } from '@mcp/api-bus';

type Subscriber = {
  /** Latest frame per languageId — insertion order preserved. */
  pending: Map<string, LspServerStatusFrame>;
  wake: (() => void) | null;
  closed: boolean;
};

const subscribers = new Map<number, Set<Subscriber>>();
/** Replay cache: subscribers must see ready even when it happened before connect. */
const latestByProject = new Map<number, Map<string, LspServerStatusFrame>>();

export function publishServerStatus(projectId: number, frame: LspServerStatusFrame): void {
  let latest = latestByProject.get(projectId);
  if (!latest) {
    latest = new Map();
    latestByProject.set(projectId, latest);
  }
  latest.set(frame.languageId, frame);
  const subs = subscribers.get(projectId);
  if (!subs || subs.size === 0) return;
  for (const sub of subs) {
    if (sub.closed) continue;
    sub.pending.set(frame.languageId, frame);
    if (sub.wake) { const w = sub.wake; sub.wake = null; w(); }
  }
}

/** True when at least one chip is listening (manager may skip emit work). */
export function hasServerStatusSubscribers(projectId: number): boolean {
  return (subscribers.get(projectId)?.size ?? 0) > 0;
}

/**
 * AsyncIterable of status frames for one project. Cancellation-correct:
 * for-await break/throw calls return() → unsubscribe (indefinite stream).
 */
export function subscribeServerStatus(projectId: number): AsyncIterable<LspServerStatusFrame> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<LspServerStatusFrame> {
      const sub: Subscriber = {
        pending: new Map(latestByProject.get(projectId) ?? []),
        wake: null,
        closed: false,
      };
      let set = subscribers.get(projectId);
      if (!set) { set = new Set(); subscribers.set(projectId, set); }
      set.add(sub);

      const cleanup = () => {
        if (sub.closed) return;
        sub.closed = true;
        set!.delete(sub);
        if (set!.size === 0) subscribers.delete(projectId);
        if (sub.wake) { const w = sub.wake; sub.wake = null; w(); }
      };

      return {
        async next(): Promise<IteratorResult<LspServerStatusFrame>> {
          while (!sub.closed) {
            const first = sub.pending.entries().next();
            if (!first.done) {
              sub.pending.delete(first.value[0]);
              return { value: first.value[1], done: false };
            }
            await new Promise<void>((resolve) => { sub.wake = resolve; });
          }
          return { value: undefined as never, done: true };
        },
        async return(): Promise<IteratorResult<LspServerStatusFrame>> {
          cleanup();
          return { value: undefined as never, done: true };
        },
        async throw(e?: unknown): Promise<IteratorResult<LspServerStatusFrame>> {
          cleanup();
          throw e;
        },
      };
    },
  };
}
