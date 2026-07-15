/**
 * Per-project diagnostics pub/sub — the push side that replaced the
 * renderer's 1s polling loop.
 *
 * Producers: the TS backend (debounced after didChange), external LSP
 * servers (via the diagnostics batcher) and the index fallback. Consumers:
 * one queue per `diagnosticsStream` subscriber, COALESCED PER (file,source)
 * — a slow consumer only ever sees the latest frame for each file instead
 * of an unbounded backlog.
 *
 * The wire unit is a BATCH ({ frames: [...] }): a subscriber drains up to
 * MAX_BATCH pending entries per message, so a whole-solution diagnostics
 * burst costs ~ceil(n/MAX_BATCH) IPC messages instead of n.
 *
 * MODULE SINGLETON — same two-instances Electron constraint as the
 * document store.
 */
import type { DiagnosticsBatch, DiagnosticsFrame } from '@mcp/api-bus';

type Subscriber = {
  /** Latest frame per `${file}|${source}` — insertion order preserved. */
  pending: Map<string, DiagnosticsFrame>;
  wake: (() => void) | null;
  closed: boolean;
};

/** Max pending (file,source) entries drained into one wire message —
 *  bounds the structured-clone size of a post-solution-load flood. */
const MAX_BATCH = 200;

const subscribers = new Map<number, Set<Subscriber>>();
const latest = new Map<number, Map<string, DiagnosticsFrame>>();

export function publishDiagnostics(projectId: number, frame: DiagnosticsFrame): void {
  publishDiagnosticsBatch(projectId, [frame]);
}

/** Publish many per-file frames at once — subscribers are woken ONCE. */
export function publishDiagnosticsBatch(projectId: number, frames: DiagnosticsFrame[]): void {
  if (frames.length === 0) return;
  let projectLatest = latest.get(projectId);
  if (!projectLatest) {
    projectLatest = new Map();
    latest.set(projectId, projectLatest);
  }
  for (const frame of frames) {
    projectLatest.set(`${frame.file}|${frame.source}`, frame);
  }

  const subs = subscribers.get(projectId);
  if (!subs || subs.size === 0) return;
  for (const sub of subs) {
    if (sub.closed) continue;
    for (const frame of frames) {
      sub.pending.set(`${frame.file}|${frame.source}`, frame);
    }
    if (sub.wake) { const w = sub.wake; sub.wake = null; w(); }
  }
}

/** True when at least one stream is attached (producers may skip work). */
export function hasDiagnosticsSubscribers(projectId: number): boolean {
  return (subscribers.get(projectId)?.size ?? 0) > 0;
}

/**
 * AsyncIterable of frame BATCHES for one project. Cancellation-correct:
 * for-await `break`/`throw` calls `return()`, which unsubscribes — mandatory
 * for an indefinite stream (the callback→queue bridge used by finite streams
 * has no return() and would leak the subscription).
 */
export function subscribeDiagnostics(projectId: number): AsyncIterable<DiagnosticsBatch> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<DiagnosticsBatch> {
      const sub: Subscriber = { pending: new Map(), wake: null, closed: false };
      let set = subscribers.get(projectId);
      if (!set) { set = new Set(); subscribers.set(projectId, set); }
      set.add(sub);
      for (const [key, frame] of latest.get(projectId) ?? []) {
        sub.pending.set(key, frame);
      }

      const cleanup = () => {
        if (sub.closed) return;
        sub.closed = true;
        set!.delete(sub);
        if (set!.size === 0) subscribers.delete(projectId);
        if (sub.wake) { const w = sub.wake; sub.wake = null; w(); }
      };

      return {
        async next(): Promise<IteratorResult<DiagnosticsBatch>> {
          while (!sub.closed) {
            if (sub.pending.size > 0) {
              const frames: DiagnosticsFrame[] = [];
              for (const [key, frame] of sub.pending) {
                sub.pending.delete(key);
                frames.push(frame);
                if (frames.length >= MAX_BATCH) break;
              }
              return { value: { frames }, done: false };
            }
            await new Promise<void>((resolve) => { sub.wake = resolve; });
          }
          return { value: undefined as never, done: true };
        },
        async return(): Promise<IteratorResult<DiagnosticsBatch>> {
          cleanup();
          return { value: undefined as never, done: true };
        },
        async throw(e?: unknown): Promise<IteratorResult<DiagnosticsBatch>> {
          cleanup();
          throw e;
        },
      };
    },
  };
}
