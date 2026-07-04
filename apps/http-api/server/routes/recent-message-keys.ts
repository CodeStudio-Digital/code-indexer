import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { CoderRunBus } from '../../coder-bus.js';

/**
 * In-memory idempotency store for streaming POST endpoints (coder /messages,
 * /continue; company /start, /resume).
 *
 * The problem: `ReconnectingSSEClient` re-sends the FULL request — body
 * included — on every backoff retry after a mid-stream disconnect. For a POST
 * that already ran its server-side side effects (appended a user message,
 * pushed it onto the runner, spawned a run) a retry would duplicate them.
 *
 * The fix: the client stamps a stable `client_msg_id` on the body (the same
 * object is reused across retries, so the key is stable). The route records
 * `(sessionId, key) -> bus` inside the per-session lock, BEFORE releasing it.
 * A retry that lands while the original bus is still reachable is answered by
 * REPLAYING that bus instead of re-running the side effects — semantically
 * identical to a GET /attach with Last-Event-ID.
 *
 * `sinceHint` is the `since` the ORIGINAL response used (attach: its tailFrom;
 * fresh/start: -1). The dedupe replay answers with `max(Last-Event-ID, sinceHint)`
 * so a retry that dropped before the first byte (Last-Event-ID absent → -1)
 * still tails from the same point the original did, instead of replaying the
 * whole buffer (prior turns → duplicate notifications / spurious refetches).
 *
 * The bus is held via `WeakRef`: once the run's bus is evicted and GC'd, a
 * late retry deref's to `undefined` ("key known, bus gone") and the route
 * answers with a synthetic `done` (see `syntheticDoneSSE`) — no side effects,
 * and the dashboard refetches the persisted history on `done`.
 *
 * Bounded by a per-session key cap (LRU) + a lazy TTL sweep + a global session
 * cap, so it never grows without limit even under abusive external API use.
 */

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_PER_SESSION = 32;
const MAX_SESSIONS = 256;

interface Entry<Bus extends object> {
  ref: WeakRef<Bus>;
  sinceHint: number;
  at: number;
}

export class RecentMessageKeys<Bus extends object = CoderRunBus> {
  private readonly ttlMs: number;
  private readonly maxPerSession: number;
  private readonly now: () => number;
  // Outer map insertion order = session LRU; inner map insertion order = key LRU.
  private readonly bySession = new Map<number, Map<string, Entry<Bus>>>();

  constructor(opts: { ttlMs?: number; maxPerSession?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxPerSession = opts.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
    this.now = opts.now ?? (() => Date.now());
  }

  record(sessionId: number, key: string, bus: Bus, sinceHint: number): void {
    let inner = this.bySession.get(sessionId);
    if (!inner) {
      inner = new Map();
      this.bySession.set(sessionId, inner);
    }
    this.sweep(inner);
    // Re-insert to move this key to the MRU (tail) position for eviction.
    inner.delete(key);
    inner.set(key, { ref: new WeakRef(bus), sinceHint, at: this.now() });
    while (inner.size > this.maxPerSession) {
      const oldest = inner.keys().next().value;
      if (oldest === undefined) break;
      inner.delete(oldest);
    }
    // Move session to MRU position + enforce the global cap.
    this.bySession.delete(sessionId);
    this.bySession.set(sessionId, inner);
    while (this.bySession.size > MAX_SESSIONS) {
      const oldest = this.bySession.keys().next().value;
      if (oldest === undefined) break;
      this.bySession.delete(oldest);
    }
  }

  lookup(sessionId: number, key: string): { bus: Bus | undefined; sinceHint: number } | undefined {
    const inner = this.bySession.get(sessionId);
    if (!inner) return undefined;
    this.sweep(inner);
    if (inner.size === 0) {
      this.bySession.delete(sessionId);
      return undefined;
    }
    const entry = inner.get(key);
    if (!entry) return undefined;
    return { bus: entry.ref.deref(), sinceHint: entry.sinceHint };
  }

  /** Drop entries older than the TTL. Cheap — the inner map is tiny (≤ cap). */
  private sweep(inner: Map<string, Entry<Bus>>): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, e] of inner) {
      if (e.at < cutoff) inner.delete(k);
    }
  }
}

/**
 * Coerce a raw `client_msg_id` body field into a usable dedupe key. Rejects
 * anything that isn't a non-empty string of sane length, so a malformed or
 * abusive value from an external API caller degrades to "no key" (current
 * behaviour) rather than poisoning the store.
 */
export function normalizeDedupeKey(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 128 ? raw : undefined;
}

/**
 * Emit a one-shot SSE `done` and close — the dedupe response when a retry's
 * original bus is gone (GC'd after eviction). Carries no `id:` so it never
 * advances the client's Last-Event-ID cursor, and no `bus_info` (there is no
 * bus). The dashboard's `done` handler refetches the persisted history, so the
 * user still sees the finished run's output.
 */
export function syntheticDoneSSE(c: Context, data: Record<string, unknown>) {
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'done', data: JSON.stringify(data) });
    await stream.close();
  });
}
