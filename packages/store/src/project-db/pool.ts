/**
 * `ProjectDbPool` — per-process LRU cache of open project DB connections.
 *
 * better-sqlite3 is synchronous and single-connection-per-thread, so there is
 * no cross-thread sharing: the main process holds one pool, each worker holds
 * its own. Cross-thread safety over the SAME file is delegated entirely to WAL
 * + busy_timeout (exactly as the central index.db works today).
 *
 * Checkpoint policy: writable handles open with wal_autocheckpoint=0. Normal
 * LRU/idle eviction only closes the main-thread handle and delegates a PASSIVE
 * checkpoint through `onCheckpoint`; a synchronous TRUNCATE here can freeze
 * every Electron window while SQLite waits for readers. Controlled process
 * shutdown still uses checkpointAndClose().
 */
import { ProjectDb, type NowFn } from './handle.js';
import type { OpenProjectDbOpts } from './open.js';

export interface ProjectDbPoolOpts {
  /** Resolve a project id to its DB path. Injected to avoid a store import cycle. */
  resolve: (projectId: number) => { dbPath: string };
  /** Max open handles; kept < ATTACH cap so federation can still attach. Default 8. */
  maxOpen?: number;
  /** Evict handles idle longer than this. Default 60s. */
  idleTtlMs?: number;
  readonly?: boolean;
  now?: NowFn;
  openOpts?: OpenProjectDbOpts;
  /**
   * Schedule a best-effort PASSIVE checkpoint outside the current thread after
   * a normal LRU/idle eviction. Must return immediately and must not re-enter
   * the pool.
   */
  onCheckpoint?: (projectId: number, dbPath: string) => void;
  /**
   * Called after a project's handle is dropped (LRU over-cap or idle sweep) so
   * the owner can release sibling per-project state it keyed by the same id
   * (vector-store connections, alias/route caches). Not called on `closeAll`
   * (process shutdown). Must not re-enter the pool.
   */
  onEvict?: (projectId: number) => void;
}

export class ProjectDbPool {
  /** Insertion-ordered Map doubles as the LRU recency list. */
  private readonly entries = new Map<number, ProjectDb>();
  private readonly opts: Required<Pick<ProjectDbPoolOpts, 'maxOpen' | 'idleTtlMs'>> & ProjectDbPoolOpts;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ProjectDbPoolOpts) {
    this.opts = { maxOpen: 8, idleTtlMs: 60_000, ...opts };
  }

  /** Get (opening if needed) the handle for a project; bumps LRU recency. */
  get(projectId: number): ProjectDb {
    const hit = this.entries.get(projectId);
    if (hit) {
      hit.touch();
      this.bump(projectId);
      return hit;
    }
    const { dbPath } = this.opts.resolve(projectId);
    const pdb = new ProjectDb(projectId, dbPath, {
      ...this.opts.openOpts,
      readonly: this.opts.readonly,
      now: this.opts.now,
    });
    this.entries.set(projectId, pdb);
    this.evictOverCap();
    return pdb;
  }

  has(projectId: number): boolean {
    return this.entries.has(projectId);
  }

  /** Close + drop a single project; checkpointing is delegated off-thread. */
  evict(projectId: number): void {
    const pdb = this.entries.get(projectId);
    if (!pdb) return;
    this.dropEntry(projectId, pdb);
  }

  /** Evict every handle idle longer than the TTL. */
  sweepIdle(): void {
    for (const [id, pdb] of [...this.entries]) {
      if (pdb.idleMs > this.opts.idleTtlMs) {
        this.dropEntry(id, pdb);
      }
    }
  }

  /** Start a background idle sweep. No-op if already running. */
  startSweeper(intervalMs = 30_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweepIdle(), intervalMs);
    this.sweeper.unref?.();
  }

  /** Close all handles and stop the sweeper. Call on process shutdown. */
  closeAll(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    for (const pdb of this.entries.values()) pdb.checkpointAndClose();
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private bump(id: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.entries.set(id, e);
  }

  /** Drop one handle without a main-thread TRUNCATE and notify the owner. */
  private dropEntry(projectId: number, pdb: ProjectDb): void {
    this.entries.delete(projectId);
    try {
      pdb.close();
    } finally {
      this.opts.onCheckpoint?.(projectId, pdb.dbPath);
      this.opts.onEvict?.(projectId);
    }
  }

  private evictOverCap(): void {
    while (this.entries.size > this.opts.maxOpen) {
      const oldest = this.entries.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.dropEntry(oldest, this.entries.get(oldest)!);
    }
  }
}
