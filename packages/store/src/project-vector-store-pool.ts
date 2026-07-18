/** LRU/TTL pool for physical sqlite-vec databases used by semantic generations. */
import { resolve } from 'node:path';
import {
  SqliteVecDatabase,
  SqliteVecVectorStore,
  assertSafeVectorTableName,
} from './sqlite-vec-store.js';

export interface ProjectVectorStorePoolOptions {
  maxOpen?: number;
  idleTtlMs?: number;
  now?: () => number;
  onEvict?: (dbPath: string) => void;
}

export class ProjectVectorStorePoolSaturatedError extends Error {
  readonly code = 'PROJECT_VECTOR_STORE_POOL_SATURATED';

  constructor(readonly maxOpen: number, readonly requestedPath: string) {
    super(`Project vector store pool is saturated (${maxOpen}/${maxOpen}); cannot open ${requestedPath}`);
    this.name = 'ProjectVectorStorePoolSaturatedError';
  }
}

interface PoolEntry {
  dbPath: string;
  database: SqliteVecDatabase;
  stores: Map<string, SqliteVecVectorStore>;
  lastUsedAt: number;
  activeReads: number;
  pendingWrites: number;
  writeTail: Promise<void>;
  draining: boolean;
  idleWaiters: Set<() => void>;
}

function pathKey(dbPath: string): string {
  if (dbPath === ':memory:') return dbPath;
  const absolute = resolve(dbPath);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export class ProjectVectorStorePool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly maxOpen: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private readonly onEvict?: (dbPath: string) => void;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(options: ProjectVectorStorePoolOptions = {}) {
    this.maxOpen = options.maxOpen ?? 8;
    this.idleTtlMs = options.idleTtlMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.onEvict = options.onEvict;
    if (!Number.isInteger(this.maxOpen) || this.maxOpen < 1) throw new Error('maxOpen must be >= 1');
    if (!Number.isFinite(this.idleTtlMs) || this.idleTtlMs < 0) throw new Error('idleTtlMs must be >= 0');
  }

  /** Get one generation table while sharing a single connection per DB file. */
  get(dbPath: string, tableName = 'vectors'): SqliteVecVectorStore {
    const safeTable = assertSafeVectorTableName(tableName);
    const entry = this.getEntry(dbPath);
    return this.getStore(entry, safeTable);
  }

  /** Keep a physical handle pinned for the full async read operation. */
  read<T>(
    dbPath: string,
    tableName: string,
    operation: (store: SqliteVecVectorStore) => Promise<T> | T,
  ): Promise<T> {
    const safeTable = assertSafeVectorTableName(tableName);
    const key = pathKey(dbPath);
    const entry = this.getEntry(dbPath);
    const store = this.getStore(entry, safeTable);
    entry.activeReads += 1;
    const run = Promise.resolve().then(() => operation(store));
    return run.finally(() => {
      entry.activeReads -= 1;
      this.finishOperation(key, entry);
    });
  }

  private getStore(entry: PoolEntry, safeTable: string): SqliteVecVectorStore {
    let store = entry.stores.get(safeTable);
    if (!store) {
      store = new SqliteVecVectorStore({ database: entry.database, tableName: safeTable });
      entry.stores.set(safeTable, store);
    }
    return store;
  }

  /** Serialize writes per physical file while allowing reads and other files concurrently. */
  write<T>(
    dbPath: string,
    tableName: string,
    operation: (store: SqliteVecVectorStore) => Promise<T> | T,
  ): Promise<T> {
    const safeTable = assertSafeVectorTableName(tableName);
    const key = pathKey(dbPath);
    const entry = this.getEntry(dbPath);
    const store = this.getStore(entry, safeTable);
    entry.pendingWrites += 1;
    const run = entry.writeTail.then(() => operation(store));
    entry.writeTail = run.then(() => undefined, () => undefined);
    return run.finally(() => {
      entry.pendingWrites -= 1;
      this.finishOperation(key, entry);
    });
  }

  has(dbPath: string): boolean { return this.entries.has(pathKey(dbPath)); }

  evict(dbPath: string): boolean {
    const key = pathKey(dbPath);
    const entry = this.entries.get(key);
    if (!entry || this.isBusy(entry)) return false;
    this.drop(key, entry);
    return true;
  }

  async drainAndEvict(dbPath: string): Promise<boolean> {
    const key = pathKey(dbPath);
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.draining = true;
    await this.waitForIdle(entry);
    const current = this.entries.get(key);
    if (current !== entry || this.isBusy(current)) return false;
    this.drop(key, current);
    return true;
  }

  /** Exclusively compact one physical SQLite. New reads fail fast while the
   * explicit admin operation waits for existing reads/writes to drain. */
  async compact(dbPath: string): Promise<void> {
    const key = pathKey(dbPath);
    const entry = this.getEntry(dbPath);
    entry.draining = true;
    await this.waitForIdle(entry);
    try {
      if (this.entries.get(key) !== entry) throw new Error(`Vector database was evicted: ${dbPath}`);
      entry.database.compact();
    } finally {
      if (this.entries.get(key) === entry) {
        entry.draining = false;
        entry.lastUsedAt = this.now();
        this.bump(key);
      }
    }
  }

  /** Exclusive administrative cleanup for a retired generation prefix. */
  async dropVirtualTablesWithPrefix(dbPath: string, prefix: string): Promise<number> {
    const key = pathKey(dbPath);
    const entry = this.getEntry(dbPath);
    entry.draining = true;
    await this.waitForIdle(entry);
    try {
      if (this.entries.get(key) !== entry) throw new Error(`Vector database was evicted: ${dbPath}`);
      await entry.database.loadExtension();
      return entry.database.dropVirtualTablesWithPrefix(prefix);
    } finally {
      if (this.entries.get(key) === entry) {
        entry.draining = false;
        entry.lastUsedAt = this.now();
        this.bump(key);
      }
    }
  }

  sweepIdle(): void {
    const now = this.now();
    for (const [key, entry] of [...this.entries]) {
      if (!entry.draining && !this.isBusy(entry) && now - entry.lastUsedAt > this.idleTtlMs) {
        this.drop(key, entry);
      }
    }
  }

  startSweeper(intervalMs = 30_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweepIdle(), intervalMs);
    this.sweeper.unref?.();
  }

  closeAll(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    for (const [key, entry] of [...this.entries]) {
      if (this.isBusy(entry)) continue;
      this.drop(key, entry);
    }
  }

  /** Wait for queued writes, then checkpoint and close every physical DB. */
  async drainAndCloseAll(): Promise<void> {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    const entries = [...this.entries.values()];
    for (const entry of entries) entry.draining = true;
    await Promise.all(entries.map((entry) => this.waitForIdle(entry)));
    for (const [key, entry] of [...this.entries]) this.drop(key, entry);
  }

  get size(): number { return this.entries.size; }
  get openPaths(): string[] { return [...this.entries.values()].map((entry) => entry.dbPath); }

  private getEntry(dbPath: string): PoolEntry {
    const key = pathKey(dbPath);
    let entry = this.entries.get(key);
    if (entry) {
      if (entry.draining) throw new Error(`Vector database is being evicted: ${entry.dbPath}`);
      entry.lastUsedAt = this.now();
      this.bump(key);
      return entry;
    }
    // Enforce the cap before constructing another SQLite handle. Evict the
    // least-recently-used idle entry first; if every slot is pinned by a read
    // or queued write, fail explicitly so the caller can retry/fall back.
    while (this.entries.size >= this.maxOpen) {
      const candidate = [...this.entries].find(([, current]) =>
        !current.draining && !this.isBusy(current));
      if (!candidate) throw new ProjectVectorStorePoolSaturatedError(this.maxOpen, dbPath);
      this.drop(candidate[0], candidate[1]);
    }
    entry = {
      dbPath,
      database: new SqliteVecDatabase(dbPath, { manualCheckpoint: true }),
      stores: new Map(),
      lastUsedAt: this.now(),
      activeReads: 0,
      pendingWrites: 0,
      writeTail: Promise.resolve(),
      draining: false,
      idleWaiters: new Set(),
    };
    this.entries.set(key, entry);
    return entry;
  }

  private bump(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evictOverCap(protectedKey?: string): void {
    while (this.entries.size > this.maxOpen) {
      const candidate = [...this.entries].find(([key, entry]) =>
        key !== protectedKey && !entry.draining && !this.isBusy(entry));
      if (!candidate) return;
      this.drop(candidate[0], candidate[1]);
    }
  }

  private isBusy(entry: PoolEntry): boolean {
    return entry.activeReads > 0 || entry.pendingWrites > 0;
  }

  private waitForIdle(entry: PoolEntry): Promise<void> {
    if (!this.isBusy(entry)) return Promise.resolve();
    return new Promise<void>((resolveIdle) => entry.idleWaiters.add(resolveIdle));
  }

  private finishOperation(key: string, entry: PoolEntry): void {
    if (!this.isBusy(entry)) {
      for (const resolveIdle of entry.idleWaiters) resolveIdle();
      entry.idleWaiters.clear();
    }
    if (this.entries.get(key) !== entry || entry.draining) return;
    entry.lastUsedAt = this.now();
    this.bump(key);
    this.evictOverCap();
  }

  private drop(key: string, entry: PoolEntry): void {
    this.entries.delete(key);
    entry.database.close(); // includes wal_checkpoint(TRUNCATE)
    this.onEvict?.(entry.dbPath);
  }
}
