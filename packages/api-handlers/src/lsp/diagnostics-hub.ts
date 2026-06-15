/**
 * Per-project diagnostics pub/sub — the push side that replaced the
 * renderer's 1s polling loop.
 *
 * Producers: the TS backend (debounced after didChange), external LSP
 * servers (publishDiagnostics, Onda 3) and the index fallback. Consumers:
 * one queue per `diagnosticsStream` subscriber, COALESCED PER (file,source)
 * — a slow consumer only ever sees the latest frame for each file instead
 * of an unbounded backlog.
 *
 * MODULE SINGLETON — same two-instances Electron constraint as the
 * document store.
 */
import type { DiagnosticsFrame } from '@mcp/api-bus';

type Subscriber = {
  /** Latest frame per `${file}|${source}` — insertion order preserved. */
  pending: Map<string, DiagnosticsFrame>;
  wake: (() => void) | null;
  closed: boolean;
};

const subscribers = new Map<number, Set<Subscriber>>();

export function publishDiagnostics(projectId: number, frame: DiagnosticsFrame): void {
  const subs = subscribers.get(projectId);
  if (!subs || subs.size === 0) return;
  const k = `${frame.file}|${frame.source}`;
  for (const sub of subs) {
    if (sub.closed) continue;
    sub.pending.set(k, frame);
    if (sub.wake) { const w = sub.wake; sub.wake = null; w(); }
  }
}

/** True when at least one stream is attached (producers may skip work). */
export function hasDiagnosticsSubscribers(projectId: number): boolean {
  return (subscribers.get(projectId)?.size ?? 0) > 0;
}

/**
 * AsyncIterable of frames for one project. Cancellation-correct: for-await
 * `break`/`throw` calls `return()`, which unsubscribes — mandatory for an
 * indefinite stream (the callback→queue bridge used by finite streams has
 * no return() and would leak the subscription).
 */
export function subscribeDiagnostics(projectId: number): AsyncIterable<DiagnosticsFrame> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<DiagnosticsFrame> {
      const sub: Subscriber = { pending: new Map(), wake: null, closed: false };
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
        async next(): Promise<IteratorResult<DiagnosticsFrame>> {
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
        async return(): Promise<IteratorResult<DiagnosticsFrame>> {
          cleanup();
          return { value: undefined as never, done: true };
        },
        async throw(e?: unknown): Promise<IteratorResult<DiagnosticsFrame>> {
          cleanup();
          throw e;
        },
      };
    },
  };
}
