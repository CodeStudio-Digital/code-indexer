/**
 * DbConnectionManager — process-wide pool registry, keyed by an opaque string.
 *
 * Two keyspaces share one manager without colliding:
 *   - UI sessions:  `conn:<connectionId>`  (pinned — live until disconnect/shutdown)
 *   - agent pools:  `<sessionId>:<dbId>:<url>` (idle-evictable, TTL 5 min)
 *
 * Mirrors the sweeper semantics of the old company `database-driver.ts` (5-min
 * idle TTL, 60s sweep, unref) but pinned entries are never idle-evicted so an
 * open DB tab keeps its connection.
 */
import { createDriver } from './factory.js';
import type { DatabaseDriver, DbConnectConfig, DbEngine, DbEngineKind } from './types.js';

/** Per-connection metadata co-located with the pool so EVERY handler instance
 *  (IPC + Hono fallback + agent path) resolves it from one shared source. */
export interface ConnMeta {
  engine?: DbEngine;
  readOnly?: boolean;
  /** Engine category — lets the handler/UI gate relational vs document/keyvalue ops. */
  kind?: DbEngineKind;
}

interface PoolEntry {
  driver: DatabaseDriver;
  lastUsed: number;
  pinned: boolean;
  meta: ConnMeta;
}

interface OpeningEntry {
  promise: Promise<DatabaseDriver>;
  pinned: boolean;
  closed: boolean;
}

const IDLE_TTL_MS = 5 * 60 * 1000;

export interface AcquireOptions {
  /** Close any existing entries whose key starts with this prefix first (env rotation). */
  invalidatePrefix?: string;
  /** Pinned entries survive idle eviction (UI sessions). Default false. */
  pinned?: boolean;
}

export class DbConnectionManager {
  private pools = new Map<string, PoolEntry>();
  private openings = new Map<string, OpeningEntry>();
  private sweeper: NodeJS.Timeout | null = null;

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - IDLE_TTL_MS;
      for (const [key, entry] of this.pools.entries()) {
        if (!entry.pinned && entry.lastUsed < cutoff) {
          entry.driver.close().catch(() => void 0);
          this.pools.delete(key);
        }
      }
      // Only stop sweeping when nothing remains that could ever be evicted.
      if ([...this.pools.values()].every((e) => e.pinned) && this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = null;
      }
    }, 60 * 1000);
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref();
  }

  /** Get an existing driver by key, or create one from `config`. */
  async acquire(key: string, config: DbConnectConfig, opts: AcquireOptions = {}): Promise<DatabaseDriver> {
    const existing = this.pools.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      if (opts.pinned) existing.pinned = true;
      return existing.driver;
    }
    const pending = this.openings.get(key);
    if (pending) {
      pending.pinned ||= opts.pinned ?? false;
      return pending.promise;
    }
    const opening = { pinned: opts.pinned ?? false, closed: false } as OpeningEntry;
    // Publish before invoking an asynchronous driver factory so concurrent
    // callers share setup and close can fence a not-yet-connected resource.
    opening.promise = Promise.resolve().then(async () => {
      if (opening.closed) throw new Error('Database pool closed during connection setup');
      if (opts.invalidatePrefix) {
        const stale = [...new Set([...this.pools.keys(), ...this.openings.keys()])]
          .filter(candidate => candidate !== key && candidate.startsWith(opts.invalidatePrefix!));
        if (stale.length) await Promise.all(stale.map(candidate => this.closeKey(candidate)));
      }
      if (opening.closed) throw new Error('Database pool closed during connection setup');
      const driver = await createDriver(config);
      if (opening.closed) {
        await driver.close().catch(() => void 0);
        throw new Error('Database pool closed during connection setup');
      }
      this.pools.set(key, { driver, lastUsed: Date.now(), pinned: opening.pinned, meta: {} });
      this.ensureSweeper();
      return driver;
    }).finally(() => {
      if (this.openings.get(key) === opening) this.openings.delete(key);
    });
    this.openings.set(key, opening);
    return opening.promise;
  }

  /** Attach metadata (engine / read-only) to a pooled connection. */
  setMeta(key: string, meta: ConnMeta): void {
    const entry = this.pools.get(key);
    if (entry) entry.meta = { ...entry.meta, ...meta };
  }

  /** Read a pooled connection's metadata (undefined if not connected). */
  getMeta(key: string): ConnMeta | undefined {
    return this.pools.get(key)?.meta;
  }

  /** Look up an established driver (no create). Bumps lastUsed. */
  get(key: string): DatabaseDriver | null {
    const entry = this.pools.get(key);
    if (!entry) return null;
    entry.lastUsed = Date.now();
    return entry.driver;
  }

  has(key: string): boolean {
    return this.pools.has(key);
  }

  /** Close + drop a single connection. */
  async closeKey(key: string): Promise<void> {
    const pending = this.openings.get(key);
    if (pending) {
      pending.closed = true;
      this.openings.delete(key);
    }
    const entry = this.pools.get(key);
    this.pools.delete(key);
    await Promise.allSettled([
      ...(pending ? [pending.promise] : []),
      ...(entry ? [entry.driver.close()] : []),
    ]);
  }

  /** Close every pooled driver. For shutdown + tests. */
  async closeAll(): Promise<void> {
    const drivers = [...this.pools.values()].map((e) => e.driver);
    const pending = [...this.openings.values()];
    for (const opening of pending) opening.closed = true;
    this.openings.clear();
    this.pools.clear();
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    await Promise.allSettled([...drivers.map((d) => d.close()), ...pending.map(entry => entry.promise)]);
  }
}

let _shared: DbConnectionManager | null = null;
/** Process-wide (per-thread) shared manager — used by both the UI handlers and the agent shim. */
export function sharedDbConnectionManager(): DbConnectionManager {
  if (!_shared) _shared = new DbConnectionManager();
  return _shared;
}
