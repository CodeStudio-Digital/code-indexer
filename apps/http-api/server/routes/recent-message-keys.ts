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
 * `sinceHint` records where the ORIGINAL response attached (attach: tailFrom;
 * fresh/start: -1) for settlement diagnostics. A reconnect always honors its
 * own Last-Event-ID; the hint must never advance a client past buffered events
 * it has not acknowledged.
 *
 * The bus is held via `WeakRef`. A live exact bus is retained past the lazy
 * TTL (the count/session caps remain authoritative); an ended/collected bus
 * is only a replay cache miss. Durable command state, not this cache, decides
 * whether a late retry is terminal, interrupted, or a payload conflict.
 *
 * Bounded by a per-session key cap (LRU) + a lazy TTL sweep + a global session
 * cap, so it never grows without limit even under abusive external API use.
 */

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_PENDING_WAIT_MS = 5_000;
const DEFAULT_MAX_PER_SESSION = 32;
const MAX_SESSIONS = 256;

export interface RecentMessageLookup<Bus extends object> {
  bus: Bus | undefined;
  sinceHint: number;
  /**
   * This waiter reached its local wait ceiling while the original owner still
   * holds the claim. It is not a command terminal and must never mutate the
   * owner entry or durable ledger.
   */
  retryLater?: {
    reason: 'idempotency-owner-pending';
    retryAfterMs: number;
  };
  terminal?: {
    event: 'done' | 'error';
    data: Record<string, unknown>;
  };
}

interface ReadyEntry<Bus extends object> {
  kind: 'ready';
  ref: WeakRef<Bus>;
  token: symbol;
  fingerprintHash: string;
  sinceHint: number;
  at: number;
  terminal?: RecentMessageLookup<Bus>['terminal'];
}

interface PendingEntry<Bus extends object> {
  kind: 'pending';
  token: symbol;
  fingerprintHash: string;
  at: number;
  /** Per-request waiters; timed-out waiters remove themselves from this set. */
  waiters: Set<(value: RecentMessageLookup<Bus>) => void>;
}

type Entry<Bus extends object> = ReadyEntry<Bus> | PendingEntry<Bus>;
type RecentSessionKey = string;

type RecentMessageClaim<Bus extends object> =
  | { kind: 'owner'; token: symbol }
  | { kind: 'payload_conflict' }
  | { kind: 'capacity_exhausted'; retryAfterMs: number }
  | { kind: 'existing'; settled: Promise<RecentMessageLookup<Bus>> };

export class RecentMessageKeys<Bus extends object = CoderRunBus> {
  private readonly ttlMs: number;
  private readonly pendingWaitMs: number;
  private readonly maxPerSession: number;
  private readonly maxSessions: number;
  private readonly now: () => number;
  // Outer map insertion order = session LRU; inner map insertion order = key LRU.
  private readonly bySession = new Map<
    RecentSessionKey,
    Map<string, Entry<Bus>>
  >();

  constructor(opts: {
    ttlMs?: number;
    pendingWaitMs?: number;
    maxPerSession?: number;
    maxSessions?: number;
    now?: () => number;
  } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.pendingWaitMs = opts.pendingWaitMs ?? DEFAULT_PENDING_WAIT_MS;
    this.maxPerSession = opts.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
    this.maxSessions = opts.maxSessions ?? MAX_SESSIONS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Reserve a key before any request side effect. A concurrent retry receives
   * a bounded waiter over the owner's settlement. The waiter may return
   * `retryLater`, but TTL/LRU pressure never removes or terminalizes the owner
   * claim. This closes the old append→record window without allowing cache
   * policy to become negative command authority.
   */
  claim(
    sessionId: RecentSessionKey,
    key: string,
    fingerprintHash = '',
  ): RecentMessageClaim<Bus> {
    let inner = this.bySession.get(sessionId);
    let createdSession = false;
    if (!inner) {
      if (!this.ensureGlobalSessionSlot()) {
        return { kind: 'capacity_exhausted', retryAfterMs: this.pendingWaitMs };
      }
      inner = new Map();
      this.bySession.set(sessionId, inner);
      createdSession = true;
    }
    this.sweep(inner);
    const existing = inner.get(key);
    if (existing) {
      if (existing.fingerprintHash !== fingerprintHash) {
        this.touchSession(sessionId, inner);
        return { kind: 'payload_conflict' };
      }
      if (existing.kind === 'pending') {
        existing.at = this.now();
        this.touchEntry(inner, key, existing);
        this.touchSession(sessionId, inner);
        return { kind: 'existing', settled: this.waitForPending(existing) };
      }
      const snapshot = this.snapshot(existing);
      if (snapshot.bus || snapshot.terminal) {
        existing.at = this.now();
        this.touchEntry(inner, key, existing);
        this.touchSession(sessionId, inner);
        return { kind: 'existing', settled: Promise.resolve(snapshot) };
      }
      // WeakRef collection is a cache miss, not a terminal answer. Remove the
      // dead ready entry and create a new owner token so the route must consult
      // the durable command ledger before deciding replay/interruption.
      inner.delete(key);
    }

    if (!this.ensureKeySlot(inner)) {
      if (createdSession && inner.size === 0) this.bySession.delete(sessionId);
      else this.touchSession(sessionId, inner);
      return { kind: 'capacity_exhausted', retryAfterMs: this.pendingWaitMs };
    }

    const token = Symbol(key);
    inner.set(key, {
      kind: 'pending',
      token,
      fingerprintHash,
      at: this.now(),
      waiters: new Set(),
    });
    this.touchSession(sessionId, inner);
    return { kind: 'owner', token };
  }

  record(
    sessionId: RecentSessionKey,
    key: string,
    bus: Bus,
    sinceHint: number,
    guard?: { token: symbol; fingerprintHash: string },
  ): boolean {
    const inner = this.sessionForSettlement(sessionId, guard !== undefined);
    if (!inner) return false;
    this.sweep(inner);
    const prior = inner.get(key);
    if (
      guard
      && (
        !prior
        || prior.token !== guard.token
        || prior.fingerprintHash !== guard.fingerprintHash
      )
    ) {
      return false;
    }
    if (!prior && !this.ensureKeySlot(inner)) return false;
    const ready: ReadyEntry<Bus> = {
      kind: 'ready',
      ref: new WeakRef(bus),
      token: prior?.token ?? Symbol(key),
      fingerprintHash: prior?.fingerprintHash ?? '',
      sinceHint,
      at: this.now(),
    };
    // Re-insert to move this key to the MRU (tail) position for eviction.
    inner.delete(key);
    inner.set(key, ready);
    if (prior?.kind === 'pending') {
      this.settlePending(prior, this.snapshot(ready));
    }
    this.touchSession(sessionId, inner);
    return true;
  }

  /**
   * Settle a claimed key without a bus. Retries receive an explicit terminal
   * instead of re-running the request. Failed claims use `error`; successful
   * commands whose bus has already gone use `done`.
   */
  recordTerminal(
    sessionId: RecentSessionKey,
    key: string,
    terminal: NonNullable<RecentMessageLookup<Bus>['terminal']>,
    sinceHint = -1,
    guard?: { token: symbol; fingerprintHash: string },
  ): boolean {
    const inner = this.sessionForSettlement(sessionId, guard !== undefined);
    if (!inner) return false;
    this.sweep(inner);
    const prior = inner.get(key);
    if (
      guard
      && (
        !prior
        || prior.token !== guard.token
        || prior.fingerprintHash !== guard.fingerprintHash
      )
    ) {
      return false;
    }
    if (!prior && !this.ensureKeySlot(inner)) return false;
    // WeakRef requires an object. This sentinel is never exposed because a
    // terminal-ready entry always snapshots with `bus: undefined`.
    const sentinel = {} as Bus;
    const ready: ReadyEntry<Bus> = {
      kind: 'ready',
      ref: new WeakRef(sentinel),
      token: prior?.token ?? Symbol(key),
      fingerprintHash: prior?.fingerprintHash ?? '',
      sinceHint,
      terminal,
      at: this.now(),
    };
    inner.delete(key);
    inner.set(key, ready);
    if (prior?.kind === 'pending') {
      this.settlePending(prior, this.snapshot(ready));
    }
    this.touchSession(sessionId, inner);
    return true;
  }

  /**
   * Reject and remove only the pending claim for this exact payload. A
   * payload-conflict response must not remain cached under the key, otherwise
   * it would poison a later retry of the original, valid payload.
   */
  rejectClaim(
    sessionId: RecentSessionKey,
    key: string,
    token: symbol,
    fingerprintHash: string,
    terminal: NonNullable<RecentMessageLookup<Bus>['terminal']>,
  ): void {
    const inner = this.bySession.get(sessionId);
    const pending = inner?.get(key);
    if (
      !inner
      || pending?.kind !== 'pending'
      || pending.token !== token
      || pending.fingerprintHash !== fingerprintHash
    ) return;
    inner.delete(key);
    this.settlePending(pending, { bus: undefined, sinceHint: -1, terminal });
    if (inner.size === 0) this.bySession.delete(sessionId);
  }

  lookup(
    sessionId: RecentSessionKey,
    key: string,
  ): RecentMessageLookup<Bus> | undefined {
    const inner = this.bySession.get(sessionId);
    if (!inner) return undefined;
    this.sweep(inner);
    if (inner.size === 0) {
      this.bySession.delete(sessionId);
      return undefined;
    }
    const entry = inner.get(key);
    if (!entry || entry.kind === 'pending') return undefined;
    const snapshot = this.snapshot(entry);
    if (!snapshot.bus && !snapshot.terminal) {
      inner.delete(key);
      if (inner.size === 0) this.bySession.delete(sessionId);
      return undefined;
    }
    entry.at = this.now();
    this.touchEntry(inner, key, entry);
    this.touchSession(sessionId, inner);
    return snapshot;
  }

  /** Drop stale non-live entries. Cheap — the inner map is tiny (≤ cap). */
  private sweep(inner: Map<string, Entry<Bus>>): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, e] of inner) {
      // Pending is an in-process ownership token. Only explicit owner
      // settlement/rejection (or process death) may remove it.
      if (e.kind === 'pending') continue;
      if (e.at < cutoff) {
        const live = e.ref.deref() as ({ ended?: boolean } & Bus) | undefined;
        // A live run is the exact replay target and remains useful beyond the
        // time-based retry window. Count/session caps still bound retention.
        if (live?.ended === false) continue;
        inner.delete(k);
      }
    }
  }

  private snapshot(entry: ReadyEntry<Bus>): RecentMessageLookup<Bus> {
    return {
      // A terminal settlement deliberately has no bus even while the sentinel
      // object remains reachable inside this call.
      bus: entry.terminal ? undefined : entry.ref.deref(),
      sinceHint: entry.sinceHint,
      ...(entry.terminal ? { terminal: entry.terminal } : {}),
    };
  }

  private waitForPending(entry: PendingEntry<Bus>): Promise<RecentMessageLookup<Bus>> {
    return new Promise((resolve) => {
      let finished = false;
      let timeout!: ReturnType<typeof setTimeout>;
      let waiter!: (value: RecentMessageLookup<Bus>) => void;
      const finish = (value: RecentMessageLookup<Bus>): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        entry.waiters.delete(waiter);
        resolve(value);
      };
      waiter = finish;
      entry.waiters.add(waiter);
      timeout = setTimeout(() => {
        finish({
          bus: undefined,
          sinceHint: -1,
          retryLater: {
            reason: 'idempotency-owner-pending',
            retryAfterMs: this.pendingWaitMs,
          },
        });
      }, this.pendingWaitMs);
      timeout.unref?.();
    });
  }

  private settlePending(
    entry: PendingEntry<Bus>,
    value: RecentMessageLookup<Bus>,
  ): void {
    const waiters = [...entry.waiters];
    entry.waiters.clear();
    for (const waiter of waiters) waiter(value);
  }

  private sessionForSettlement(
    sessionId: RecentSessionKey,
    requireExisting: boolean,
  ): Map<string, Entry<Bus>> | undefined {
    const existing = this.bySession.get(sessionId);
    if (existing || requireExisting) return existing;
    if (!this.ensureGlobalSessionSlot()) return undefined;
    const inner = new Map<string, Entry<Bus>>();
    this.bySession.set(sessionId, inner);
    return inner;
  }

  /** Make room for a new claim without ever evicting an active owner. */
  private ensureKeySlot(inner: Map<string, Entry<Bus>>): boolean {
    if (this.maxPerSession <= 0) return false;
    while (inner.size >= this.maxPerSession) {
      const evictable = [...inner].find(([, entry]) => entry.kind === 'ready');
      if (!evictable) return false;
      inner.delete(evictable[0]);
    }
    return true;
  }

  /** New sessions may evict only sessions that contain no active owners. */
  private ensureGlobalSessionSlot(): boolean {
    if (this.maxSessions <= 0) return false;
    while (this.bySession.size >= this.maxSessions) {
      const evictable = [...this.bySession].find(([, entries]) =>
        [...entries.values()].every((entry) => entry.kind === 'ready'),
      );
      if (!evictable) return false;
      this.bySession.delete(evictable[0]);
    }
    return true;
  }

  private touchEntry(
    inner: Map<string, Entry<Bus>>,
    key: string,
    entry: Entry<Bus>,
  ): void {
    inner.delete(key);
    inner.set(key, entry);
  }

  private touchSession(
    sessionId: RecentSessionKey,
    inner: Map<string, Entry<Bus>>,
  ): void {
    // Move the existing session to MRU. Capacity is preflighted before a new
    // session/claim is installed, so touching can never evict an owner.
    this.bySession.delete(sessionId);
    this.bySession.set(sessionId, inner);
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
  return syntheticTerminalSSE(c, 'done', data);
}

export function syntheticTerminalSSE(
  c: Context,
  event: 'done' | 'error',
  data: Record<string, unknown>,
) {
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event, data: JSON.stringify(data) });
    await stream.close();
  });
}
