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
import type { DatabaseDriver, DbConnectConfig } from './types.js';

interface PoolEntry {
  driver: DatabaseDriver;
  lastUsed: number;
  pinned: boolean;
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
    if (opts.invalidatePrefix) {
      for (const [k, v] of this.pools.entries()) {
        if (k.startsWith(opts.invalidatePrefix)) {
          v.driver.close().catch(() => void 0);
          this.pools.delete(k);
        }
      }
    }
    const driver = await createDriver(config);
    this.pools.set(key, { driver, lastUsed: Date.now(), pinned: opts.pinned ?? false });
    this.ensureSweeper();
    return driver;
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
    const entry = this.pools.get(key);
    if (!entry) return;
    this.pools.delete(key);
    await entry.driver.close().catch(() => void 0);
  }

  /** Close every pooled driver. For shutdown + tests. */
  async closeAll(): Promise<void> {
    const drivers = [...this.pools.values()].map((e) => e.driver);
    this.pools.clear();
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    await Promise.allSettled(drivers.map((d) => d.close()));
  }
}

let _shared: DbConnectionManager | null = null;
/** Process-wide (per-thread) shared manager — used by both the UI handlers and the agent shim. */
export function sharedDbConnectionManager(): DbConnectionManager {
  if (!_shared) _shared = new DbConnectionManager();
  return _shared;
}
