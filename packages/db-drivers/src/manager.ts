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
  raw: DatabaseDriver;
  active: number;
  retired: boolean;
  drained?: () => void;
  closing?: Promise<void>;
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
  private rotations = new Map<string, number>();
  private nextRotation = 0;
  constructor(private readonly limits = { pools: 64, activePerPool: 32 }) {}

  private retire(entry: PoolEntry): Promise<void> {
    if (entry.closing) return entry.closing;
    entry.retired = true;
    entry.closing = (async () => {
      if (entry.active > 0) await new Promise<void>((resolve) => { entry.drained = resolve; });
      await entry.raw.close();
    })();
    return entry.closing;
  }

  private leased(raw: DatabaseDriver, pinned: boolean): PoolEntry {
    const entry: PoolEntry = { raw, driver: raw, pinned, active: 0, retired: false, lastUsed: Date.now(), meta: {} };
    const methods = new Map<PropertyKey, unknown>();
    entry.driver = new Proxy(raw, {
      get: (target, property) => {
        const value = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        if (!methods.has(property)) methods.set(property, property === 'close'
          ? () => this.retire(entry)
          : async (...args: unknown[]) => {
            if (entry.retired) throw new Error('Database connection is draining; reconnect before dispatch');
            if (property !== 'cancelQuery' && entry.active >= this.limits.activePerPool) {
              throw new Error('Database operation capacity reached; wait for an active operation to finish');
            }
            entry.active++;
            try { return await Reflect.apply(value, target, args); }
            finally {
              entry.lastUsed = Date.now();
              if (--entry.active === 0) entry.drained?.();
            }
          });
        return methods.get(property);
      },
    });
    return entry;
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - IDLE_TTL_MS;
      for (const [key, entry] of this.pools.entries()) {
        if (!entry.pinned && entry.active === 0 && entry.lastUsed < cutoff) {
          void this.retire(entry).catch(() => void 0);
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
    if (existing && !existing.retired) {
      existing.lastUsed = Date.now();
      if (opts.pinned) existing.pinned = true;
      return existing.driver;
    }
    const pending = this.openings.get(key);
    if (pending) {
      pending.pinned ||= opts.pinned ?? false;
      return pending.promise;
    }
    if (this.pools.size + this.openings.size >= this.limits.pools) {
      throw new Error('Database pool capacity reached; disconnect an idle connection before opening another');
    }
    const rotation = opts.invalidatePrefix ? ++this.nextRotation : 0;
    if (opts.invalidatePrefix) this.rotations.set(opts.invalidatePrefix, rotation);
    const opening = { pinned: opts.pinned ?? false, closed: false } as OpeningEntry;
    // Publish before invoking an asynchronous driver factory so concurrent
    // callers share setup and close can fence a not-yet-connected resource.
    opening.promise = Promise.resolve().then(async () => {
      if (opening.closed) throw new Error('Database pool closed during connection setup');
      if (opts.invalidatePrefix) {
        // Two simultaneous rotations must never wait on each other's setup.
        if (this.rotations.get(opts.invalidatePrefix) !== rotation) throw new Error('Database connection setup superseded by a newer configuration');
        const stale = [...new Set([...this.pools.keys(), ...this.openings.keys()])]
          .filter(candidate => candidate !== key && candidate.startsWith(opts.invalidatePrefix!));
        if (stale.length) await Promise.all(stale.map(candidate => this.closeKey(candidate)));
      }
      if (opening.closed) throw new Error('Database pool closed during connection setup');
      const driver = await createDriver(config);
      if (opening.closed || (opts.invalidatePrefix && this.rotations.get(opts.invalidatePrefix) !== rotation)) {
        await driver.close().catch(() => void 0);
        throw new Error('Database pool closed during connection setup');
      }
      const entry = this.leased(driver, opening.pinned);
      this.pools.set(key, entry);
      this.ensureSweeper();
      return entry.driver;
    }).finally(() => {
      if (this.openings.get(key) === opening) this.openings.delete(key);
      if (opts.invalidatePrefix && this.rotations.get(opts.invalidatePrefix) === rotation) this.rotations.delete(opts.invalidatePrefix);
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
    if (!entry || entry.retired) return null;
    entry.lastUsed = Date.now();
    return entry.driver;
  }

  has(key: string): boolean {
    return this.pools.has(key) && !this.pools.get(key)!.retired;
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
      ...(entry ? [this.retire(entry)] : []),
    ]);
  }

  /** Close every pooled driver. For shutdown + tests. */
  async closeAll(): Promise<void> {
    const entries = [...this.pools.values()];
    const pending = [...this.openings.values()];
    for (const opening of pending) opening.closed = true;
    this.openings.clear();
    this.rotations.clear();
    this.pools.clear();
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    await Promise.allSettled([...entries.map((e) => this.retire(e)), ...pending.map(entry => entry.promise)]);
  }
}

let _shared: DbConnectionManager | null = null;
/** Process-wide (per-thread) shared manager — used by both the UI handlers and the agent shim. */
export function sharedDbConnectionManager(): DbConnectionManager {
  if (!_shared) _shared = new DbConnectionManager();
  return _shared;
}
