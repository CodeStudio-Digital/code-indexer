import { runMigrations, getSchemaVersion } from './migrations/index.js';
import type {
  Project, DBFile, DBSymbol, IndexRun, CostSummary, ContextSnapshot, Webhook,
  ProjectStats, DiscoveredModel, SnapshotCategory,
  SnapshotVersion, LLMSymbol, DBFileDependency, DBFileDependent,
  DBSymbolReference, DBSymbolRelation,
  AgentMemoryRow, AgentMemoryScope, AgentMemoryType,
} from '@mcp/shared/types.js';
import { Database, type DB, type PathAlias } from './db/types.js';
import { applyTuningPragmas } from './db/pragmas.js';
import { installSqlTiming } from './db/sql-timing.js';
import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { projectDbFlags, type ProjectDbFlags } from '@mcp/shared/utils/config.js';
import type { EditorSettingsOverride } from '@mcp/shared/editor-settings.js';
import {
  ProjectDbPool, resolveProjectDbLocation, openRawProjectDb, initProjectSchema, type ProjectDb,
} from './project-db/index.js';
import {
  splitProject, type SplitOutcome,
  purgeProjectIndex,
} from './db-split/index.js';
import { initSchema } from './db/schema/index.js';
import { repairCodeFtsIndexes, createDocChunksFtsIfReady } from './db/schema/fts.js';
import * as projects from './db/projects.js';
import * as files from './db/files.js';
import * as agentIndexReads from './db/agent-index-reads.js';
import * as agentSymbolReads from './db/agent-symbol-reads.js';
import * as agentTypeReads from './db/agent-type-reads.js';
import * as agentReferenceReads from './db/agent-reference-reads.js';
import * as agentSemanticReads from './db/agent-semantic-reads.js';
import * as agentEditContext from './db/agent-edit-context.js';
import * as agentRepoMap from './db/agent-repo-map.js';
import * as filesStructural from './db/files-structural.js';
import * as fileContents from './db/file-contents.js';
import * as symbols from './db/symbols.js';
import * as symbolRelations from './db/symbol-relations.js';
import * as symbolMembersDeep from './db/symbol-members-deep.js';
import * as indexHealthMod from './db/index-health.js';
import * as runs from './db/runs.js';
import * as snapshots from './db/snapshots.js';
import * as snapshotsArchive from './db/snapshots-archive.js';
import * as agentMemory from './db/agent-memory.js';
import * as agentMemoryPages from './db/agent-memory-pages.js';
import * as agentMemoryConsolidation from './db/agent-memory-consolidation.js';
import * as agentMemoryKpis from './db/agent-memory-kpis.js';
import * as memoryConsolidation from './db/memory-consolidation.js';
import * as memoryDistillLog from './db/memory-distill-log.js';
import * as costs from './db/costs.js';
import * as webhooks from './db/webhooks.js';
import * as modelsCache from './db/models-cache.js';
import * as stats from './db/stats.js';
import * as deps from './db/dependencies.js';
import * as maintenance from './db/maintenance.js';
import { loadTsconfigPathAliases } from './db/path-resolver.js';
import { ReadCache } from './db/read-cache.js';
import {
  assertNoSessionMigrationMaintenanceLock,
  assertSessionScopedSqliteAbsent,
  assertSessionStorageLayoutReady,
} from './session-layout-guard.js';

/** Short-TTL caches for the synchronous reads that freeze the main thread on
 *  project open. Bounded staleness self-heals against cross-process worker
 *  writes (see read-cache.ts); main-side writes invalidate eagerly. */
const numEnv = (name: string, fallback: number): number => {
  const n = Number(process.env[name]); // NaN-safe: a garbage value falls back, not to NaN (which would disable the cache)
  return Number.isFinite(n) ? n : fallback;
};
const STATS_CACHE_TTL_MS = numEnv('MCP_DB_STATS_CACHE_MS', 2000);
const LIST_CACHE_TTL_MS = numEnv('MCP_DB_LIST_CACHE_MS', 3000);

/**
 * Real constituent of a SYNTHETIC union project (global session). Lightweight
 * mirror of code-agent's `LinkedProject` (kept local because @mcp/store must
 * not depend on @mcp/code-agent).
 */
export interface UnionProjectLink {
  project_id: number;
  name: string;
  root_path: string;
  is_primary: boolean;
}

export interface EmbeddingCoverage {
  files_total: number;
  files_embedded: number;
  symbols_total: number;
  symbols_embedded: number;
  symbol_bodies_total: number;
  symbol_bodies_embedded: number;
}

export class CodeIndexDB {
  private db: DB;
  /** Central DB file path (for ATTACH + backup during the split). */
  private readonly centralDbPath: string;
  /** Cached tsconfig aliases per project id. Populated lazily. */
  private aliasCache = new Map<number, PathAlias[]>();
  /** Tiered-hybrid split flags, read once at construction. */
  private readonly pdbFlags: ProjectDbFlags;
  /** Per-project DB pool (tiered-hybrid split). Lazily opens project DBs. */
  private readonly projectPool: ProjectDbPool;
  /** Cache of the routing decision per project id (avoids a SELECT per call). */
  private readonly routeCache = new Map<number, boolean>();
  /** Short-TTL read cache for the main-thread-freezing hot reads (getStats,
   *  listProjects). Invalidated on the centralized write methods below. */
  private readonly readCache = new ReadCache();
  /** This process's boot time (SQL datetime fmt) — the C3 purge soak gate: only
   *  purge a project whose split landed in a PRIOR session (db_split_at < this). */
  private bootedAt = '';
  /** True only for the single main-process handle that owns WAL checkpointing. */
  private readonly checkpointOwner: boolean;
  /** Periodic PASSIVE-checkpoint timer (checkpoint owner only). */
  private walCheckpointTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    dbPath: string,
    opts: {
      checkpointOwner?: boolean;
      externalCheckpointer?: boolean;
      /** Fire-and-forget project DB checkpoint scheduler owned by a worker. */
      projectDbCheckpoint?: (dbPath: string) => void;
      /**
       * Busy-wait ceiling for this connection, ms. Defaults to the shared 5s.
       * The Electron-main handle passes a small value: better-sqlite3 waits for
       * a contended lock INSIDE a synchronous native call, so on that thread the
       * ceiling is a hard bound on how long the whole app can freeze. Callers
       * that genuinely need to wait re-raise it per operation via
       * `withBusyTimeout`.
       */
      busyTimeoutMs?: number;
    } = {},
  ) {
    const isMemoryDatabase =
      dbPath === ':memory:' || dbPath.startsWith('file::memory:');
    const allowFreshBootstrap =
      isMemoryDatabase ||
      !existsSync(dbPath) ||
      statSync(dbPath).size === 0;
    assertNoSessionMigrationMaintenanceLock(dbPath);
    this.centralDbPath = dbPath;
    this.checkpointOwner = !!opts.checkpointOwner;
    this.db = new Database(dbPath);
    try {
      assertSessionStorageLayoutReady(this.db, { allowFreshBootstrap });
    } catch (error) {
      this.db.close();
      throw error;
    }
    // Prototype patch, idempotent and inert until a sink is installed. Done
    // here so every connection in the process is covered regardless of which
    // one opened first.
    installSqlTiming(this.db);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');
    this.db.pragma('foreign_keys = ON');
    applyTuningPragmas(this.db, { busyTimeoutMs: opts.busyTimeoutMs });
    // WAL checkpoint ownership (anti-freeze). Heavy worker writes + constant
    // main-thread polling readers starve SQLite's auto-checkpointer, so the
    // central `-wal` grows unbounded and every read pages through an ever-larger
    // WAL — reads slow as a multi-agent run proceeds, then recover when it ends.
    // Fix: exactly ONE handle (the main-process one) owns checkpointing. It
    // disables implicit autocheckpoint (so a main-thread write never pays a
    // surprise checkpoint mid-commit) and instead runs a periodic NON-BLOCKING
    // PASSIVE checkpoint, plus a full TRUNCATE on close. Worker handles keep
    // autocheckpoint ON — their PASSIVE checkpoints run off the main thread.
    // Perf W2 — `externalCheckpointer`: the db-maintenance worker owns the
    // periodic PASSIVE checkpoint on its own thread, so even that non-blocking
    // pass leaves the main thread entirely. This handle still disables
    // autocheckpoint (a main-thread write must never pay a surprise
    // checkpoint) and still TRUNCATEs on close.
    if (this.checkpointOwner) {
      this.db.pragma('wal_autocheckpoint = 0');
      if (!opts.externalCheckpointer) this.startWalCheckpointer();
    }
    // Schema must exist before migrations that ALTER it.
    initSchema(this.db);
    runMigrations(this.db);
    // The first schema pass precedes migration 086 on a fresh database.
    // Documentation search must work before the connection is reopened.
    createDocChunksFtsIfReady(this.db);
    try {
      assertSessionScopedSqliteAbsent(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.bootedAt = (this.db.prepare(`SELECT datetime('now') AS t`).get() as { t: string }).t;

    this.pdbFlags = projectDbFlags();
    this.projectPool = new ProjectDbPool({
      maxOpen: this.pdbFlags.maxOpen,
      idleTtlMs: this.pdbFlags.idleMs,
      resolve: (projectId) => ({ dbPath: this.resolveProjectDbPath(projectId) }),
      onCheckpoint: (_projectId, projectDbPath) => opts.projectDbCheckpoint?.(projectDbPath),
      // When a project's DB handle is LRU/idle-evicted, drop the sibling
      // per-project caches keyed by the same id so they don't linger for
      // projects beyond the pool's cap (each rebuilds lazily on next access;
      // the active project is MRU so it is never the one evicted).
      onEvict: (projectId) => {
        this.aliasCache.delete(projectId);
        this.routeCache.delete(projectId);
      },
    });
  }

  getSchemaVersion(): number { return getSchemaVersion(this.db); }
  /** better-sqlite3 handle for stores that need direct prepared-statement access. */
  raw(): DB { return this.db; }

  /**
   * Temporarily override this connection's busy ceiling for one synchronous
   * operation. Electron-main callers use zero and move contention waits to an
   * async retry queue; worker connections retain the normal five-second wait.
   */
  withBusyTimeout<T>(busyTimeoutMs: number, operation: () => T): T {
    const timeout = Math.max(0, Math.trunc(busyTimeoutMs));
    const previous = Number(this.db.pragma('busy_timeout', { simple: true }));
    if (previous === timeout) return operation();
    this.db.pragma(`busy_timeout = ${timeout}`);
    try {
      return operation();
    } finally {
      this.db.pragma(`busy_timeout = ${previous}`);
    }
  }

  /**
   * Fallback for `externalCheckpointer` setups: when the db-maintenance
   * worker can't run (crashed past its restart budget), the caller restores
   * the in-process PASSIVE timer so the WAL never goes unbounded. Idempotent.
   */
  enableInternalCheckpointer(): void {
    if (!this.checkpointOwner || this.walCheckpointTimer || this.closed) return;
    this.startWalCheckpointer();
  }
  private closed = false;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.walCheckpointTimer) {
      clearInterval(this.walCheckpointTimer);
      this.walCheckpointTimer = null;
    }
    this.projectPool.closeAll();
    // Final full checkpoint so the next boot doesn't inherit a large -wal. Only
    // the checkpoint owner does this; TRUNCATE may block briefly until readers
    // drain, but at close time there are no more route reads to stall.
    if (this.checkpointOwner) {
      try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
    }
    this.db.close();
  }

  /**
   * Periodic WAL checkpoint for the owning (main-process) handle. PASSIVE never
   * blocks — it checkpoints as far as it can without waiting on readers, so it
   * can't reintroduce the stall this is removing; it keeps the checkpoint
   * pointer advancing so the WAL is reused rather than growing. `unref`'d so it
   * never keeps the process alive. `MCP_SQLITE_CHECKPOINT_MS=0` disables it.
   */
  private startWalCheckpointer(): void {
    const intervalMs = numEnv('MCP_SQLITE_CHECKPOINT_MS', 30_000);
    if (intervalMs <= 0) return;
    this.walCheckpointTimer = setInterval(() => {
      try {
        this.db.pragma('wal_checkpoint(PASSIVE)');
      } catch { /* best-effort; a locked/closing DB just retries next tick */ }
    }, intervalMs);
    if (typeof (this.walCheckpointTimer as { unref?: () => void }).unref === 'function') {
      (this.walCheckpointTimer as { unref: () => void }).unref();
    }
  }

  // ─── Tiered-hybrid per-project DB routing (plan §6/§7) ──────────────
  /** Are the split flags enabled at all? */
  get projectDbEnabled(): boolean { return this.pdbFlags.enabled; }

  /** The pooled handle for a project's own DB (opens it on first use). */
  forProject(projectId: number): ProjectDb { return this.projectPool.get(projectId); }

  /** Open pooled project handles + the pool cap. For the perf memory ledger. */
  get projectPoolStats(): { open: number; maxOpen: number } {
    return { open: this.projectPool.size, maxOpen: this.pdbFlags.maxOpen };
  }

  /** Close + checkpoint all pooled project handles (shutdown / before file ops). */
  closeProjectPool(): void { this.projectPool.closeAll(); }

  /** Drop one project's pooled handle (e.g. before deleting its files). */
  evictProject(projectId: number): void {
    this.projectPool.evict(projectId);
    this.routeCache.delete(projectId);
  }

  /**
   * Resolve (and persist) a project's DB file path. Reads `projects.db_path`
   * first; computes + stamps it on first use. Used by the pool's resolver.
   */
  resolveProjectDbPath(projectId: number): string {
    const row = this.db.prepare('SELECT root_path, db_path FROM projects WHERE id = ?')
      .get(projectId) as { root_path?: string; db_path?: string } | undefined;
    if (row?.db_path) return row.db_path;
    const loc = resolveProjectDbLocation(projectId, row?.root_path, {
      forceFallback: this.pdbFlags.fallbackAll,
    });
    try {
      this.db.prepare('UPDATE projects SET db_path = ? WHERE id = ?').run(loc.dbPath, projectId);
    } catch { /* projects row may not exist yet (synthetic bootstrap) — non-fatal */ }
    return loc.dbPath;
  }

  /**
   * Whether project-scoped INDEX reads/writes for this project should target
   * its own DB. False (→ central) unless the split is enabled AND the project
   * has finished migrating (`db_split_status='done'`). The user-memory sentinel
   * (id 0) and synthetic union projects always stay central.
   */
  useProjectDb(projectId: number): boolean {
    // Routing is a SEPARATE opt-in from the split/copy (plan §7 / P2b). Until the
    // full projectId-threading is complete + verified, the engine copies project
    // DBs but the app keeps reading/writing central (no bare-id breakage).
    if (!this.pdbFlags.enabled || !this.pdbFlags.route || projectId === 0) return false;
    const cached = this.routeCache.get(projectId);
    if (cached !== undefined) return cached;
    const row = this.db.prepare(
      'SELECT db_split_status AS s, COALESCE(is_synthetic, 0) AS syn FROM projects WHERE id = ?',
    ).get(projectId) as { s?: string; syn?: number } | undefined;
    const route = !!row && row.syn !== 1 && row.s === 'done';
    this.routeCache.set(projectId, route);
    return route;
  }

  /** Invalidate the routing cache for a project (after a status change). */
  invalidateRoute(projectId: number): void { this.routeCache.delete(projectId); }

  /** Read a project's split status marker. */
  getProjectSplitStatus(projectId: number): string {
    const row = this.db.prepare('SELECT db_split_status AS s FROM projects WHERE id = ?')
      .get(projectId) as { s?: string } | undefined;
    return row?.s ?? 'pending';
  }

  /** Update a project's split status marker + timestamp; clears the route cache. */
  setProjectSplitStatus(projectId: number, status: string, err?: string | null): void {
    this.db.prepare(
      `UPDATE projects
         SET db_split_status = ?, db_split_at = datetime('now'),
             db_split_err = ?
       WHERE id = ?`,
    ).run(status, err ?? null, projectId);
    this.routeCache.delete(projectId);
  }

  /**
   * Routed handle for project-scoped INDEX tables (files/symbols/runs/costs/…).
   * Central when the split is off or the project hasn't migrated yet.
   *
   * NOTE (P2): the INDEX method bodies are NOT yet converted to call this — the
   * routing flip is the final attended step (see plan §7 / morning notes). This
   * seam exists and is unit-tested; flag-off behavior is unchanged regardless.
   */
  private idx(projectId?: number): DB {
    if (projectId === undefined || !this.useProjectDb(projectId)) return this.db;
    const pdb = this.projectPool.get(projectId).raw();
    this.ensureProjectRow(projectId, pdb);
    return pdb;
  }

  /**
   * Public routed handle for project-scoped FEATURE stores (API client, builder
   * checkpoints, file local history, doc suggestions, DS
   * studio). Returns the project DB handle when the project is migrated +
   * routing is on, else the central handle. Feature stores are constructed
   * per-project on THIS handle (dual-mode) so their whole project-scoped graph
   * (e.g. collections→requests) lives in one DB — no per-method bare-id routing.
   */
  projectScopedDb(projectId: number): DB { return this.idx(projectId); }

  /** Project ids whose project-DB `projects` row has been seeded this session. */
  private readonly seededRows = new Set<number>();

  /**
   * The project DB reuses the full schema, so `files.project_id REFERENCES
   * projects(id)` is enforced inside it — a freshly-opened project DB (brand-new
   * project, or post-clearProjectData) needs its own catalog row or every write
   * fails the FK. Seed it once per session from the central catalog.
   */
  private ensureProjectRow(projectId: number, pdb: DB): void {
    if (this.seededRows.has(projectId)) return;
    const p = projects.get(this.db, projectId);
    if (p) {
      pdb.prepare('INSERT OR IGNORE INTO projects (id, name, root_path, description) VALUES (?, ?, ?, ?)')
        .run(p.id, p.name, p.root_path, p.description ?? null);
    }
    this.seededRows.add(projectId);
  }

  /** Run `fn` in a transaction on the ROUTED handle for a project (index writes). */
  indexTransaction<T>(projectId: number, fn: () => T): T {
    return this.idx(projectId).transaction(fn)();
  }

  /**
   * Lazily migrate a project's INDEX tables into its own DB on first index
   * (plan §8). No-op unless the split + splitIndex flags are on and the project
   * is still 'pending'. Runs the crash-safe copy→verify→done state machine
   * against the project's `.mcp-indexer/index.db`; central is left intact
   * (purge deferred). Called from runStructuralIndex so it runs off the main
   * thread (indexer worker) or in the in-process executor alike.
   */
  ensureProjectSplit(projectId: number): SplitOutcome | null {
    if (!this.pdbFlags.enabled || !this.pdbFlags.splitIndex || projectId === 0) return null;
    let outcome: SplitOutcome | null = null;
    if (this.getProjectSplitStatus(projectId) !== 'done') {
      // Release any open handle on the file we may delete + recreate.
      this.projectPool.evict(projectId);
      outcome = splitProject({
        central: this.db,
        centralDbPath: this.centralDbPath,
        projectDbPath: this.resolveProjectDbPath(projectId),
        projectId,
        openFreshProjectDb: (path) => {
          const d = openRawProjectDb(path);
          initProjectSchema(d);
          return d;
        },
        classes: ['INDEX', 'FEATURE'],
        purgeMode: this.pdbFlags.purgeMode,
      });
      this.routeCache.delete(projectId);
    }
    // Legacy vector rows are intentionally not copied during the relational
    // split. LocalVectorRouter creates generation tables from original content
    // and FTS remains available until each namespace is complete.
    // C3 — reclaim central space: delete this project's INDEX rows from central
    // once it's 'done', soaked (split in a PRIOR session), and not yet purged.
    // Deferred by default (purgeMode); the one-time .bak is the rollback.
    // CRITICAL gate `useProjectDb`: routing MUST be live (route on + 'done') so
    // the app reads INDEX from the project DB — purging central INDEX while the
    // app still reads it (route off) would lose data. Non-fatal.
    if (
      this.pdbFlags.purgeMode === 'immediate' &&
      this.useProjectDb(projectId) &&
      this.shouldPurgeIndex(projectId)
    ) {
      try {
        purgeProjectIndex(this.db, projectId);
        this.db.prepare(`UPDATE projects SET db_purged_at = datetime('now') WHERE id = ?`).run(projectId);
      } catch { /* non-fatal — retried next open */ }
    }
    return outcome;
  }

  /** C3 purge gate: project 'done', never purged, and split in a prior session
   *  (soak — db_split_at predates this boot, so it survived ≥1 restart). */
  private shouldPurgeIndex(projectId: number): boolean {
    const row = this.db.prepare(
      `SELECT db_split_status AS s, db_split_at AS at, db_purged_at AS purged
         FROM projects WHERE id = ?`,
    ).get(projectId) as { s?: string; at?: string; purged?: string } | undefined;
    return !!row && row.s === 'done' && !row.purged && !!row.at && row.at < this.bootedAt;
  }

  /**
   * Run `fn` (synchronous) inside one SQLite transaction. Inner
   * `db.transaction` calls (files.upsert, symbols.upsert, …) become
   * savepoints, so composite persists commit or roll back as a unit.
   */
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  // ─── Projects ───────────────────────────────────────────────────
  createProject(name: string, rootPath: string, description?: string): Project {
    const project = projects.create(this.db, name, rootPath, description);
    // Tiered-hybrid: stamp the resolved project DB path so it's stable even if
    // the root later moves. A brand-new project has no central data to migrate,
    // so when the split is enabled it is born already-migrated ('done').
    if (this.pdbFlags.enabled) {
      try {
        const loc = resolveProjectDbLocation(project.id, rootPath, {
          forceFallback: this.pdbFlags.fallbackAll,
        });
        const status = this.pdbFlags.newProjects ? 'done' : 'pending';
        this.db.prepare('UPDATE projects SET db_path = ?, db_split_status = ? WHERE id = ?')
          .run(loc.dbPath, status, project.id);
        this.routeCache.delete(project.id);
      } catch { /* non-fatal: stamping is best-effort */ }
    }
    this.readCache.invalidateKey('projects:list');
    return project;
  }
  getProject(id: number): Project | undefined {
    const project = projects.get(this.db, id);
    return project ? this.overlayEditorConfig(this.overlayRuntimeConfig(project, id), id) : project;
  }
  /**
   * Read only the catalog root. Unlike getProject(), this never opens a
   * per-project DB to overlay runtime/editor settings.
   */
  getProjectRootPath(id: number): string | undefined {
    return projects.getRootPath(this.db, id);
  }
  getProjectByName(name: string): Project | undefined { return projects.getByName(this.db, name); }
  getProjectByPath(rootPath: string): Project | undefined { return projects.getByPath(this.db, rootPath); }
  listProjects(): Project[] {
    return this.readCache.get('projects:list', LIST_CACHE_TTL_MS, () => projects.list(this.db));
  }
  /** Legacy synthetic rows are forbidden after the filesystem cutover. */
  listSyntheticProjects(): Project[] { return projects.listSynthetic(this.db); }
  /** Projects for the GLOBAL-session picker: real projects + loose ad-hoc
   *  folders (mig 176), minus the synthetic unions. Superset of listProjects. */
  listProjectsForGlobalPicker(): Project[] { return projects.listForGlobalPicker(this.db); }
  /** Bundle-aware GC owns loose-folder reachability; SQLite cannot decide it. */
  listOrphanLooseProjects(): Project[] { return projects.listOrphanLoose(this.db); }
  /**
   * Synthetic union projects were removed by the filesystem-session cutover.
   * Global bundles carry their linked roots directly; reaching this method
   * proves that a forbidden legacy project escaped migration.
   */
  listUnionProjectIds(syntheticProjectId: number): UnionProjectLink[] {
    throw new Error(
      `Synthetic project ${syntheticProjectId} is unsupported after the filesystem-session cutover`,
    );
  }
  /**
   * Memory writes use the real owning project. A synthetic row is a migration
   * invariant violation and is rejected by `listUnionProjectIds`.
   */
  resolveMemoryWriteProject(projectId: number): { id: number; name: string } {
    const project = this.getProject(projectId);
    if (!project) return { id: projectId, name: '' };
    if (!project.is_synthetic) return { id: project.id, name: project.name };
    const links = this.listUnionProjectIds(projectId);
    const primary = links.find((l) => l.is_primary) ?? links[0];
    return primary
      ? { id: primary.project_id, name: primary.name }
      : { id: project.id, name: project.name };
  }
  updateProject(id: number, updates: Parameters<typeof projects.update>[2] & { editor_settings?: EditorSettingsOverride | null }): void {
    // Runtime/shell config (node_version/runtime_versions/runner_shell/
    // package_managers) lives in the routed `project_runtime_config` table
    // (migrations 168/169) so it travels with the project folder; the rest
    // stays on the central `projects` row. package_managers has NO central
    // column, so it MUST be destructured out (projects.update writes raw keys).
    const { node_version, runtime_versions, runner_shell, package_managers, wsl_runtime_versions, wsl_package_managers, editor_settings, ...rest } = updates;
    const cfg: Record<string, string | null> = {};
    if ('node_version' in updates) cfg.node_version = node_version ?? null;
    if ('runtime_versions' in updates) cfg.runtime_versions = runtime_versions ?? null;
    if ('runner_shell' in updates) cfg.runner_shell = runner_shell ?? null;
    if ('package_managers' in updates) cfg.package_managers = package_managers ?? null;
    if ('wsl_runtime_versions' in updates) cfg.wsl_runtime_versions = wsl_runtime_versions ?? null;
    if ('wsl_package_managers' in updates) cfg.wsl_package_managers = wsl_package_managers ?? null;
    if (Object.keys(cfg).length > 0) this.writeRuntimeConfig(id, cfg);
    if ('editor_settings' in updates) this.writeEditorConfig(id, editor_settings ?? null);
    if (Object.keys(rest).length > 0) projects.update(this.db, id, rest);
    // Counts/name/config changed → drop this project's cached stats + the list.
    this.readCache.invalidateProject(id);
    this.readCache.invalidateKey('projects:list');
  }

  /**
   * Overlay the 3 runtime/shell fields from the routed `project_runtime_config`
   * table onto a central project row. Reads via `idx(id)` (per-project DB when
   * the project is split+routed, else central); falls back to the central row
   * when a routed per-project DB has no config row yet (project split BEFORE
   * migration 168). Tolerant of a missing table (DBs not yet at mig 168).
   */
  private overlayRuntimeConfig(project: Project, id: number): Project {
    try {
      const sql = 'SELECT node_version, runtime_versions, runner_shell, package_managers, wsl_runtime_versions, wsl_package_managers FROM project_runtime_config WHERE project_id = ?';
      const routed = this.idx(id);
      let cfg = routed.prepare(sql).get(id) as
        | { node_version: string | null; runtime_versions: string | null; runner_shell: string | null; package_managers: string | null; wsl_runtime_versions: string | null; wsl_package_managers: string | null }
        | undefined;
      if (!cfg && routed !== this.db) cfg = this.db.prepare(sql).get(id) as typeof cfg;
      if (cfg) {
        project.node_version = cfg.node_version ?? null;
        project.runtime_versions = cfg.runtime_versions ?? null;
        project.runner_shell = cfg.runner_shell ?? null;
        project.package_managers = cfg.package_managers ?? null;
        project.wsl_runtime_versions = cfg.wsl_runtime_versions ?? null;
        project.wsl_package_managers = cfg.wsl_package_managers ?? null;
      }
    } catch {
      /* pre-168 DB (no table) — keep the legacy central columns as-is */
    }
    return project;
  }

  /** Upsert the runtime/shell config row in the routed DB for a project. */
  private writeRuntimeConfig(id: number, cfg: Record<string, string | null>): void {
    const routed = this.idx(id);
    if (routed !== this.db) {
      // Routed project's FIRST write: SEED the per-project row from the central
      // row (the mig-168 backfill or pre-split value) so a PARTIAL update never
      // silently NULLs the sibling fields — once the per-project row exists, the
      // overlay reads it wholesale and skips the central fallback.
      const has = routed.prepare('SELECT 1 FROM project_runtime_config WHERE project_id = ?').get(id);
      if (!has) {
        const c = this.db
          .prepare('SELECT node_version, runtime_versions, runner_shell, package_managers, wsl_runtime_versions, wsl_package_managers FROM project_runtime_config WHERE project_id = ?')
          .get(id) as { node_version: string | null; runtime_versions: string | null; runner_shell: string | null; package_managers: string | null; wsl_runtime_versions: string | null; wsl_package_managers: string | null } | undefined;
        routed
          .prepare('INSERT OR IGNORE INTO project_runtime_config (project_id, node_version, runtime_versions, runner_shell, package_managers, wsl_runtime_versions, wsl_package_managers) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, c?.node_version ?? null, c?.runtime_versions ?? null, c?.runner_shell ?? null, c?.package_managers ?? null, c?.wsl_runtime_versions ?? null, c?.wsl_package_managers ?? null);
      }
    } else {
      routed.prepare('INSERT OR IGNORE INTO project_runtime_config (project_id) VALUES (?)').run(id);
    }
    const cols = Object.keys(cfg);
    const sets = cols.map((c) => `${c} = ?`).join(', ');
    routed.prepare(`UPDATE project_runtime_config SET ${sets} WHERE project_id = ?`).run(...cols.map((c) => cfg[c]), id);
  }

  markProjectStructuralChecked(id: number, checkedAt = new Date().toISOString()): void {
    projects.markStructuralChecked(this.db, id, checkedAt);
    this.readCache.invalidateProject(id);
    this.readCache.invalidateKey('projects:list');
  }

  private overlayEditorConfig(project: Project, id: number): Project {
    try {
      const sql = 'SELECT settings_json FROM project_editor_config WHERE project_id = ?';
      const routed = this.idx(id);
      let row = routed.prepare(sql).get(id) as { settings_json: string | null } | undefined;
      if (!row && routed !== this.db) row = this.db.prepare(sql).get(id) as typeof row;
      if (row?.settings_json) {
        const parsed = JSON.parse(row.settings_json) as EditorSettingsOverride;
        project.editor_settings = parsed && typeof parsed === 'object' ? parsed : null;
      } else project.editor_settings = null;
    } catch {
      project.editor_settings = null;
    }
    return project;
  }

  private writeEditorConfig(id: number, settings: EditorSettingsOverride | null): void {
    const routed = this.idx(id);
    const json = settings && Object.keys(settings).length ? JSON.stringify({ ...settings, version: 1 }) : null;
    routed.prepare(`
      INSERT INTO project_editor_config (project_id, settings_json, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at
    `).run(id, json);
  }
  /** Mark a project as a synthetic global-session union (hidden from listProjects). */
  setProjectSynthetic(id: number, synthetic: boolean): void {
    projects.setSynthetic(this.db, id, synthetic);
    this.readCache.invalidateKey('projects:list'); // synthetic hides from the list
  }
  /** Mark a project as a loose ad-hoc global-session folder (hidden from listProjects). */
  setProjectLoose(id: number, loose: boolean): void {
    projects.setLoose(this.db, id, loose);
    this.readCache.invalidateKey('projects:list'); // loose hides from the list
  }
  deleteProject(id: number): void {
    // Tiered-hybrid: remove the per-project DB files (app-layer cascade — the
    // FK cascade can't cross DB files), then the central catalog row. Best-effort
    // file removal so a missing DB is harmless.
    this.removeProjectDbFiles(id);
    // project_runtime_config has no FK to projects (it lives per-project too),
    // so the central orphan row isn't cascaded — reap it explicitly.
    try { this.db.prepare('DELETE FROM project_runtime_config WHERE project_id = ?').run(id); } catch { /* pre-168 */ }
    try { this.db.prepare('DELETE FROM project_editor_config WHERE project_id = ?').run(id); } catch { /* pre-223 */ }
    projects.del(this.db, id);
    this.readCache.invalidateProject(id);
    this.readCache.invalidateKey('projects:list');
  }
  /** Wipe a project's data (index/sessions/snapshots/runs/costs) but KEEP its row. */
  clearProjectData(id: number): void {
    if (this.useProjectDb(id)) {
      // Clear the project DB's data tables IN PLACE (keeps its catalog row so
      // the FK stays satisfied), then reset the central denormalized counters
      // (the central projects row drives the project list).
      projects.clearData(this.idx(id), id);
      // The relational index is wiped — wipe the routed vectors.db too so search
      // doesn't surface vectors for files that no longer exist. Evict the open
      // handle first, then delete the file (a fresh empty one is reopened lazily
      // for future embeds). Callers perform that worker drain before reaching
      // this relational cleanup seam.
      const vp = join(dirname(this.resolveProjectDbPath(id)), 'vectors.db');
      for (const suffix of ['', '-wal', '-shm']) {
        try { rmSync(vp + suffix, { force: true }); } catch { /* best-effort */ }
      }
      this.db.prepare(
        `UPDATE projects SET file_count = 0, symbol_count = 0, last_indexed = NULL,
           structural_indexed_at = NULL, structural_last_checked_at = NULL,
           updated_at = datetime('now') WHERE id = ?`,
      ).run(id);
      this.readCache.invalidateProject(id);
      this.readCache.invalidateKey('projects:list'); // counts shown in the list reset to 0
      return;
    }
    projects.clearData(this.db, id);
    this.readCache.invalidateProject(id);
    this.readCache.invalidateKey('projects:list');
  }

  /** Evict the pooled handle and delete a project's DB files (index + vectors). */
  private removeProjectDbFiles(projectId: number): void {
    this.projectPool.evict(projectId);
    this.routeCache.delete(projectId);
    this.seededRows.delete(projectId);
    const row = this.db.prepare('SELECT root_path, db_path FROM projects WHERE id = ?')
      .get(projectId) as { root_path?: string; db_path?: string } | undefined;
    if (!row) return;
    const dbPath = row.db_path
      ?? resolveProjectDbLocation(projectId, row.root_path, { forceFallback: this.pdbFlags.fallbackAll }).dbPath;
    const vectorsPath = join(dirname(dbPath), 'vectors.db');
    for (const base of [dbPath, vectorsPath]) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { rmSync(base + suffix, { force: true }); } catch { /* best-effort */ }
      }
    }
  }
  /** Rebuild the code FTS5 indexes from the base tables — recovers SQLITE_CORRUPT_VTAB. */
  repairFtsIndexes(): void { repairCodeFtsIndexes(this.db); }
  resolveProject(name?: string, rootPath?: string): Project { return projects.resolve(this.db, name, rootPath); }

  // ─── Files ──────────────────────────────────────────────────────
  // NOTE (P2b routing flip): project-scoped INDEX methods route via
  // `this.idx(projectId)` — central when the split is off / project not 'done',
  // the project DB otherwise. Bare-id methods take an optional `projectId` so
  // hot callers (the indexer) can route them; absent → central (back-compat).
  upsertFile(projectId: number, data: files.UpsertFileData): number { return files.upsert(this.idx(projectId), projectId, data); }
  getFile(projectId: number, path: string): DBFile | undefined { return files.get(this.idx(projectId), projectId, path); }
  getFileById(id: number, projectId?: number): DBFile | undefined { return files.getById(this.idx(projectId), id); }
  getFileByPath(projectId: number, path: string): DBFile | undefined { return files.get(this.idx(projectId), projectId, path); }
  listFiles(projectId: number, language?: string): DBFile[] { return files.list(this.idx(projectId), projectId, language); }
  listAgentIndexFiles(projectId: number, page: agentIndexReads.IndexPage & { order?: 'path' | 'updated' } = {}) {
    return agentIndexReads.filePage(this.idx(projectId), projectId, page);
  }
  listAgentDirectoryFiles(projectId: number, prefix: string, depth: number, page: agentIndexReads.IndexPage = {}) {
    return agentIndexReads.directoryPage(this.idx(projectId), projectId, prefix, depth, page);
  }
  getAgentFileSkeleton(projectId: number, path: string, page: agentSymbolReads.SymbolPageInput) {
    return agentSymbolReads.skeletonPage(this.idx(projectId), projectId, path, page);
  }
  listAgentSymbolDefinitions(projectId: number, name: string, path: string | undefined, page: agentSymbolReads.SymbolPageInput) {
    return agentSymbolReads.definitionsPage(this.idx(projectId), projectId, name, path, page);
  }
  listAgentSymbolReferences(projectId: number, name: string, page: agentReferenceReads.ReferencePageInput) {
    return agentReferenceReads.referencePage(this.idx(projectId), projectId, name, page);
  }
  getAgentSemanticSeed(id: number, projectId?: number) { return agentSemanticReads.seed(this.idx(projectId), id, projectId); }
  listAgentSemanticNeighbors(projectId: number, ids: number[]) { return agentSemanticReads.neighbors(this.idx(projectId), projectId, ids); }
  getAgentEditContext(projectId: number, path: string, line: number, page: agentEditContext.EditContextPage) {
    return agentEditContext.editContext(this.idx(projectId), projectId, path, line, page);
  }
  listAgentRepoMap(projectId: number, page: agentRepoMap.RepoMapPageInput = {}) {
    return agentRepoMap.repoMapPage(this.idx(projectId), projectId, page);
  }
  listAgentImplementations(projectId: number, name: string, page: agentTypeReads.TypePage) {
    return agentTypeReads.implementationsPage(this.idx(projectId), projectId, name, page);
  }
  getAgentTypeHierarchy(projectId: number, name: string, path: string | undefined, page: agentTypeReads.TypePage) {
    return agentTypeReads.hierarchyPage(this.idx(projectId), projectId, name, path, page);
  }
  listAgentIndexDependencies(projectId: number, fileId: number, reverse: boolean, page: agentIndexReads.IndexPage = {}) {
    return agentIndexReads.dependencyPage(this.idx(projectId), projectId, fileId, reverse, page);
  }
  getAgentProjectShape(projectId: number) { return agentIndexReads.projectShape(this.idx(projectId), projectId); }
  /** Count on the routed index without loading every file row/body. */
  countFiles(projectId: number): number {
    return (this.idx(projectId).prepare('SELECT COUNT(*) AS n FROM files WHERE project_id = ?').get(projectId) as { n: number }).n;
  }
  searchFilePaths(projectId: number, query: string, limit?: number, fuzzy?: boolean): Array<{ path: string }> {
    return files.searchPaths(this.idx(projectId), projectId, query, limit, fuzzy);
  }
  listFileScanMeta(projectId: number): files.FileScanMeta[] { return files.listScanMeta(this.idx(projectId), projectId); }
  touchFileMtime(projectId: number, path: string, mtimeMs: number): void { files.touchMtime(this.idx(projectId), projectId, path, mtimeMs); }
  deleteFile(projectId: number, path: string): void { files.del(this.idx(projectId), projectId, path); }
  deleteFilesByProject(projectId: number): void { files.delByProject(this.idx(projectId), projectId); }
  searchFiles(projectId: number, query: string, limit: number = 20): DBFile[] { return files.search(this.idx(projectId), projectId, query, limit); }
  // ─── Structural layer ───────────────────────────────────────────
  upsertFileStructural(projectId: number, data: filesStructural.UpsertStructuralData): { fileId: number; created: boolean } { return filesStructural.upsertStructural(this.idx(projectId), projectId, data); }
  countSemanticStale(projectId: number): number { return stats.countSemanticBacklog(this.db, projectId); }
  upsertFileContent(fileId: number, content: string, sizeBytes?: number, projectId?: number): boolean { return fileContents.upsertContent(this.idx(projectId), fileId, content, sizeBytes); }
  removeFileContent(fileId: number, projectId?: number): void { fileContents.removeContent(this.idx(projectId), fileId); }
  searchFileContents(projectId: number, match: string, limit?: number): fileContents.ContentMatch[] { return fileContents.searchContent(this.idx(projectId), projectId, match, limit); }
  missingContentFiles(projectId: number, limit?: number): Array<{ id: number; path: string }> { return fileContents.missingContentFiles(this.idx(projectId), projectId, limit); }
  countFileContents(projectId: number): number { return fileContents.countContent(this.idx(projectId), projectId); }

  // ─── Symbols ────────────────────────────────────────────────────
  upsertSymbols(projectId: number, fileId: number, filePath: string, syms: LLMSymbol[]): void { symbols.upsert(this.idx(projectId), projectId, fileId, filePath, syms); }
  getSymbolById(id: number, projectId?: number): DBSymbol | undefined { return symbols.getById(this.idx(projectId), id); }
  getSymbolsByFile(projectId: number, filePath: string): DBSymbol[] { return symbols.getByFile(this.idx(projectId), projectId, filePath); }
  /** Preferred entry for pinning to an exact symbol across re-indexes. */
  findSymbolByStableId(projectId: number, stableId: string): DBSymbol | undefined { return symbols.findByStableId(this.idx(projectId), projectId, stableId); }
  findSymbolByName(projectId: number, name: string, opts?: symbols.FindSymbolOptions): DBSymbol | undefined { return symbols.findByName(this.idx(projectId), projectId, name, opts); }
  findSymbolsByName(projectId: number, name: string, opts?: symbols.FindSymbolsOptions): DBSymbol[] { return symbols.findManyByName(this.idx(projectId), projectId, name, opts); }
  getClassMembers(parentName: string, projectId: number): DBSymbol[] { return symbols.classMembers(this.idx(projectId), parentName, projectId); }
  listAllSymbols(projectId: number): DBSymbol[] { return symbols.listAll(this.idx(projectId), projectId); }
  searchSymbols(projectId: number, query: string, limit: number = 20): DBSymbol[] { return symbols.search(this.idx(projectId), projectId, query, limit); }
  /** Identifier-prefix completion (b-tree range scan — see symbols.searchByPrefix). */
  searchSymbolsByPrefix(projectId: number, prefix: string, limit: number = 50, opts?: symbols.SearchByPrefixOptions): DBSymbol[] { return symbols.searchByPrefix(this.idx(projectId), projectId, prefix, limit, opts); }
  listSymbolsByKind(projectId: number, kind: string, limit: number = 50): DBSymbol[] { return symbols.listByKind(this.idx(projectId), projectId, kind, limit); }

  // ─── Symbol References & Relations ──────────────────────────────
  upsertSymbolReferences(projectId: number, fileId: number, filePath: string, references: symbolRelations.SymbolReferenceInput[]): void { symbolRelations.upsertReferences(this.idx(projectId), projectId, fileId, filePath, references); }
  getSymbolReferences(symbolId: number, projectId?: number): DBSymbolReference[] { return symbolRelations.getReferences(this.idx(projectId), symbolId); }
  getSymbolCallers(projectId: number, symbolName: string): DBSymbolReference[] { return symbolRelations.getCallers(this.idx(projectId), projectId, symbolName); }
  getSymbolRelations(symbolId: number, projectId?: number): DBSymbolRelation[] { return symbolRelations.getRelations(this.idx(projectId), symbolId); }
  getImplementors(projectId: number, interfaceName: string): DBSymbol[] { return symbolRelations.getImplementors(this.idx(projectId), projectId, interfaceName); }
  getSubclasses(projectId: number, className: string): DBSymbol[] { return symbolRelations.getSubclasses(this.idx(projectId), projectId, className); }
  getSymbolHierarchy(projectId: number, symbolName: string): symbolRelations.SymbolHierarchy { return symbolRelations.getHierarchy(this.idx(projectId), projectId, symbolName); }
  /** Members INCLUDING inherited/trait members (BFS over extends/implements/mixes, override-aware). */
  getClassMembersDeep(projectId: number, className: string, includeInherited: boolean = true): symbolMembersDeep.DeepMembersResult { return symbolMembersDeep.getClassMembersDeep(this.idx(projectId), projectId, className, includeInherited); }
  /** Transitive extends chain (A → B → C), cycle-guarded, depth ≤5. */
  getExtendsChain(projectId: number, className: string): string[] { return symbolMembersDeep.getExtendsChain(this.idx(projectId), projectId, className); }
  /** Read-only sanity report over the live index (coverage, dangling refs, parse suspects). */
  indexHealthReport(projectId: number): indexHealthMod.IndexHealthReport { return indexHealthMod.indexHealth(this.idx(projectId), projectId); }
  traceSymbolUsage(projectId: number, symbolName: string, maxDepth: number = 3): symbolRelations.UsageTraceResult { return symbolRelations.traceUsage(this.idx(projectId), projectId, symbolName, maxDepth); }

  // ─── Runs ───────────────────────────────────────────────────────
  // Structural-run provenance stays central. Semantic execution state lives in
  // semantic_jobs/generations instead of sharing the retired LLM-run ledger.
  startRun(projectId: number): number { return runs.start(this.db, projectId); }
  finishRun(runId: number, data: runs.FinishRunData, _projectId?: number): void { runs.finish(this.db, runId, data); }
  getRun(id: number, _projectId?: number): IndexRun | undefined { return runs.get(this.db, id); }
  getRuns(projectId: number, limit: number = 20): IndexRun[] { return runs.list(this.db, projectId, limit); }

  // ─── Snapshots ──────────────────────────────────────────────────
  createSnapshot(projectId: number, data: snapshots.CreateSnapshotData): ContextSnapshot { return snapshots.create(this.db, projectId, data); }
  markSnapshotAccessed(ids: number[]): void { snapshots.markAccessed(this.db, ids); }
  createAgentMemory(data: agentMemory.CreateAgentMemoryData): AgentMemoryRow { return agentMemory.create(this.db, data); }
  archiveAgentMemory(id: number, reason = 'forgotten'): void { agentMemory.archive(this.db, id, reason); }
  restoreAgentMemory(id: number): boolean { return agentMemory.restore(this.db, id); }
  replaceAgentMemory(id: number, data: agentMemory.CreateAgentMemoryData): AgentMemoryRow { return agentMemory.replace(this.db, id, data); }
  listAgentMemoryLive(scope: AgentMemoryScope, projectId: number, opts: { includeArchived?: boolean; limit?: number } = {}): AgentMemoryRow[] { return agentMemory.listLive(this.db, scope, projectId, opts); }
  getAgentMemoryById(id: number): AgentMemoryRow | undefined { return agentMemory.getById(this.db, id); }
  /** Batched hydration; unspecified row order — see agentMemory.getByIds. */
  getAgentMemoriesByIds(ids: readonly number[]): AgentMemoryRow[] { return agentMemory.getByIds(this.db, ids); }
  getProjectMemoryContentPages(projectId: number, ids: readonly number[], offset: number, limit: number) {
    return agentMemoryPages.projectMemoryPages(this.db, projectId, ids, offset, limit);
  }
  getAgentMemoryByName(scope: AgentMemoryScope, projectId: number, name: string): AgentMemoryRow | undefined { return agentMemory.getByName(this.db, scope, projectId, name); }
  listAgentMemoryIndex(scope: AgentMemoryScope, projectId: number, limit = 12, type?: AgentMemoryType): agentMemory.AgentMemoryIndexEntry[] { return agentMemory.listMemoryIndex(this.db, scope, projectId, limit, type); }
  searchAgentMemoryFts(scope: AgentMemoryScope, projectId: number, query: string, limit = 15): AgentMemoryRow[] { return agentMemory.searchFts(this.db, scope, projectId, query, limit); }
  bumpAgentMemoryAccess(ids: number[]): void { agentMemory.bumpAccess(this.db, ids); }
  updateAgentMemoryEmbedding(id: number, hash: string, vectorId: string | null): void { agentMemory.updateEmbedding(this.db, id, hash, vectorId); }
  listAgentMemoryMissingEmbedding(projectId?: number): AgentMemoryRow[] { return agentMemory.listMissingEmbedding(this.db, projectId); }
  listAgentMemoryForSemanticIndex(scope: AgentMemoryScope, projectId: number): AgentMemoryRow[] { return agentMemory.listForSemanticIndex(this.db, scope, projectId); }
  countAgentMemory(scope: AgentMemoryScope, projectId: number): number { return agentMemory.count(this.db, scope, projectId); }
  findAgentMemoryBySourceSnapshot(snapshotId: number): AgentMemoryRow | undefined { return agentMemory.findBySourceSnapshot(this.db, snapshotId); }
  recordAgentMemoryEvent(event: agentMemory.AgentMemoryEvent): void { agentMemory.recordEvent(this.db, event); }
  pruneAgentMemoryEvents(maxAgeDays = 30, maxRows = 50_000): number { return agentMemory.pruneEvents(this.db, maxAgeDays, maxRows); }
  getAgentMemoryStaleBatch(ids: number[]): Map<number, { stale: string[]; total: number }> { return agentMemory.getStaleBatch(this.db, ids); }
  setAgentMemoryImportance(id: number, importance: number): void { agentMemory.setImportance(this.db, id, importance); }
  /** Read-only guard that keeps no-op hygiene passes from creating semantic jobs. */
  hasAgentMemoryHygieneCandidates(scope: AgentMemoryScope, projectId: number): boolean { return agentMemoryConsolidation.hasHygieneCandidates(this.db, scope, projectId); }
  /** WS8 — conservative consolidation (collapse exact-duplicate live memories). */
  consolidateAgentMemory(scope: AgentMemoryScope, projectId: number): agentMemoryConsolidation.ConsolidationResult { return agentMemoryConsolidation.consolidateProject(this.db, scope, projectId); }
  /** WS8 — reversible decay of cold, unused, low-importance `note` memories. */
  decayColdAgentMemoryNotes(scope: AgentMemoryScope, projectId: number): number { return agentMemoryConsolidation.decayColdNotes(this.db, scope, projectId); }
  /** WS10 — aggregate memory-health stats (live counts + telemetry by event). */
  getAgentMemoryStats(projectId?: number): agentMemory.AgentMemoryStats { return agentMemory.getStats(this.db, projectId); }
  /** Effectiveness KPIs over shared memory SQL plus session bundle counters. */
  getMemoryEffectivenessKpis(projectId: number, session: agentMemoryKpis.SessionMemoryKpis): agentMemoryKpis.AgentMemoryKpis { return agentMemoryKpis.getMemoryEffectivenessKpis(this.db, projectId, session); }
  /** Per-project memory toggle (migration 115). Default ON. */
  getProjectMemoryEnabled(projectId: number): boolean {
    const row = this.db.prepare('SELECT memory_enabled FROM projects WHERE id = ?')
      .get(projectId) as { memory_enabled?: number } | undefined;
    return row?.memory_enabled !== 0;
  }
  setProjectMemoryEnabled(projectId: number, enabled: boolean): void {
    this.db.prepare('UPDATE projects SET memory_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, projectId);
  }
  setSnapshotFiles(snapshotId: number, projectId: number, filePaths: string[]): { inserted: number; skipped: string[] } { return snapshots.setFiles(this.db, snapshotId, projectId, filePaths); }
  getStaleSnapshotFiles(snapshotId: number, projectId: number): string[] { return snapshots.getStaleFiles(this.db, snapshotId, projectId); }
  getStaleSnapshotFilesBatch(ids: number[], projectId: number): Map<number, { stale: string[]; total: number }> { return snapshots.getStaleFilesBatch(this.db, ids, projectId); }
  getSnapshotFiles(snapshotId: number): string[] { return snapshots.getFiles(this.db, snapshotId); }
  updateSnapshot(id: number, updates: snapshots.UpdateSnapshotData): void { snapshots.update(this.db, id, updates); }
  updateSnapshotEmbeddingHash(id: number, hash: string): void { snapshots.updateEmbeddingHash(this.db, id, hash); }
  listSnapshotsMissingEmbedding(projectId?: number): ContextSnapshot[] { return snapshots.listMissingEmbedding(this.db, projectId); }
  listSnapshotsForSemanticIndex(projectId?: number): ContextSnapshot[] { return snapshots.listForSemanticIndex(this.db, projectId); }
  countSnapshots(projectId: number): number { return snapshots.count(this.db, projectId); }
  deleteSnapshot(id: number): void { snapshots.del(this.db, id); }
  getSnapshotById(id: number): ContextSnapshot | undefined { return snapshots.getById(this.db, id); }
  listSnapshots(projectId: number, category?: SnapshotCategory): ContextSnapshot[] { return snapshots.list(this.db, projectId, category); }
  listMemoryIndex(projectId: number, limit = 12): snapshots.MemoryIndexEntry[] { return snapshots.listMemoryIndex(this.db, projectId, limit); }
  searchSnapshots(projectId: number, query: string): ContextSnapshot[] { return snapshots.search(this.db, projectId, query); }
  getSnapshotHistory(snapshotId: number): SnapshotVersion[] { return snapshots.getHistory(this.db, snapshotId); }
  // ─── Snapshot archive / merge (migration 146, memory consolidator) ──
  archiveSnapshot(id: number, reason: string): void { snapshotsArchive.archive(this.db, id, reason); }
  unarchiveSnapshot(id: number): void { snapshotsArchive.unarchive(this.db, id); }
  unionSnapshotFiles(winnerId: number, loserIds: number[]): void { snapshotsArchive.unionFiles(this.db, winnerId, loserIds); }
  setSnapshotAccessStats(id: number, accessCount: number, lastAccessedAt: string | null): void { snapshotsArchive.setAccessStats(this.db, id, accessCount, lastAccessedAt); }
  countArchivedSnapshots(projectId: number): number { return snapshotsArchive.countArchived(this.db, projectId); }
  listArchivedSnapshots(projectId: number, limit = 50): ContextSnapshot[] { return snapshotsArchive.listArchived(this.db, projectId, limit); }
  listConsolidationCandidates(): memoryConsolidation.ConsolidationCandidate[] { return memoryConsolidation.listConsolidationCandidates(this.db); }

  // ─── Memory distillation diagnostics (migration 136) ────────────
  insertMemoryDistillLog(projectId: number, entry: memoryDistillLog.MemoryDistillLogEntry): void { memoryDistillLog.insert(this.db, projectId, entry); }
  latestMemoryDistill(projectId: number): memoryDistillLog.MemoryDistillLogRow | null { return memoryDistillLog.latestForProject(this.db, projectId); }
  recentMemoryDistills(projectId: number, limit = 20): memoryDistillLog.MemoryDistillLogRow[] { return memoryDistillLog.recentForProject(this.db, projectId, limit); }
  countMemoryByCategory(projectId: number): Record<string, number> { return memoryDistillLog.countSnapshotsByCategory(this.db, projectId); }
  countMemoryBySource(projectId: number): Record<string, number> { return memoryDistillLog.countSnapshotsBySource(this.db, projectId); }

  // ─── Costs ──────────────────────────────────────────────────────
  // TELEMETRY/STATS stay CENTRAL (not per-project) so platform-wide usage
  // statistics remain faithful — `costs` is small, FK-linked to `runs`, and not
  // the write-contention source (that's files/symbols/embeddings). See plan §4.
  insertCost(data: costs.InsertCostData): void { costs.insert(this.db, data); }
  getCostSummary(projectId: number, since?: string): CostSummary { return costs.projectSummary(this.db, projectId, since); }
  getGlobalCostSummary(since?: string): CostSummary { return costs.globalSummary(this.db, since); }
  getRunCostSummary(runId: number): costs.RunCostSummary { return costs.runSummary(this.db, runId); }

  // ─── Webhooks ───────────────────────────────────────────────────
  createWebhook(data: webhooks.CreateWebhookData): Webhook { return webhooks.create(this.db, data); }
  listWebhooks(projectId?: number): Webhook[] { return webhooks.list(this.db, projectId); }
  deleteWebhook(id: number): void { webhooks.del(this.db, id); }
  getWebhooksForEvent(projectId: number, event: string): Webhook[] { return webhooks.forEvent(this.db, projectId, event); }
  updateWebhookStatus(id: number, statusCode: number): void { webhooks.updateStatus(this.db, id, statusCode); }

  // ─── Vector IDs ─────────────────────────────────────────────────
  getVectorIdStats(projectId: number): { total: number; byType: Record<string, number> } {
    const rows = this.db.prepare(`
      SELECT substr(item_key, 1, instr(item_key, ':') - 1) AS type, COUNT(*) AS cnt
      FROM semantic_items WHERE namespace = ? GROUP BY type
    `).all(`code:p${projectId}`) as Array<{ type: string; cnt: number }>;
    const byType: Record<string, number> = {};
    let total = 0;
    for (const row of rows) { byType[row.type] = row.cnt; total += row.cnt; }
    return { total, byType };
  }

  // ─── Semantic diagnostics ───────────────────────────────────────
  sampleEmbeddedFiles(projectId: number, limit = 5): Array<{ id: number; path: string; embedding_hash: string }> {
    const namespace = `code:p${projectId}`;
    const active = this.db.prepare(
      'SELECT active_generation_id AS id FROM semantic_namespace_generations WHERE namespace = ?',
    ).get(namespace) as { id: number | null } | undefined;
    if (!active?.id) return [];
    const rows = this.db.prepare(`
      SELECT item_key, source_hash FROM semantic_items
      WHERE generation_id = ? AND namespace = ? AND item_key LIKE 'file:%'
        AND status = 'indexed' AND vector_id IS NOT NULL
      ORDER BY RANDOM() LIMIT ?
    `).all(active.id, namespace, limit) as Array<{ item_key: string; source_hash: string }>;
    const getFile = this.idx(projectId).prepare(
      'SELECT id, path FROM files WHERE project_id = ? AND id = ?',
    );
    return rows.flatMap((row) => {
      const file = getFile.get(projectId, Number(row.item_key.slice(5))) as
        | { id: number; path: string }
        | undefined;
      return file ? [{ ...file, embedding_hash: row.source_hash }] : [];
    });
  }
  sampleNotEmbeddedFiles(projectId: number, limit = 5): Array<{ id: number; path: string }> {
    const namespace = `code:p${projectId}`;
    const active = this.db.prepare(
      'SELECT active_generation_id AS id FROM semantic_namespace_generations WHERE namespace = ?',
    ).get(namespace) as { id: number | null } | undefined;
    const embeddedIds = active?.id
      ? new Set((this.db.prepare(`
          SELECT item_key FROM semantic_items
          WHERE generation_id = ? AND namespace = ? AND item_key LIKE 'file:%'
            AND status = 'indexed' AND vector_id IS NOT NULL
        `).all(active.id, namespace) as Array<{ item_key: string }>)
        .map((row) => Number(row.item_key.slice(5))))
      : new Set<number>();
    return (this.idx(projectId).prepare(
      'SELECT id, path FROM files WHERE project_id = ? ORDER BY id',
    ).all(projectId) as Array<{ id: number; path: string }>)
      .filter((file) => !embeddedIds.has(file.id))
      .slice(0, limit);
  }
  getEmbeddingCoverage(projectId: number): EmbeddingCoverage {
    const sourceDb = this.idx(projectId);
    const files = sourceDb.prepare(
      'SELECT COUNT(*) AS total FROM files WHERE project_id = ?',
    ).get(projectId) as { total: number };
    const symbols = sourceDb.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN kind IN ('class','function','interface','method') AND line IS NOT NULL THEN 1 ELSE 0 END) AS bodies_eligible
      FROM symbols WHERE project_id = ?
    `).get(projectId) as { total: number; bodies_eligible: number | null };
    const namespace = `code:p${projectId}`;
    const active = this.db.prepare(`
      SELECT active_generation_id AS id
      FROM semantic_namespace_generations WHERE namespace = ?
    `).get(namespace) as { id: number | null } | undefined;
    const items = active?.id
      ? this.db.prepare(`
          SELECT item_key FROM semantic_items
          WHERE generation_id = ? AND namespace = ?
            AND status = 'indexed' AND vector_id IS NOT NULL
        `).all(active.id, namespace) as Array<{ item_key: string }>
      : [];
    const fileKeys = new Set<string>();
    const symbolKeys = new Set<string>();
    const bodyKeys = new Set<string>();
    for (const item of items) {
      if (item.item_key.startsWith('file:')) fileKeys.add(item.item_key);
      else if (item.item_key.startsWith('symbol:')) symbolKeys.add(item.item_key);
      else if (item.item_key.startsWith('symbol_body:') || item.item_key.startsWith('symbol_group:')) {
        bodyKeys.add(item.item_key.replace(/^symbol_(?:body|group):/, 'symbol:'));
      }
    }
    return {
      files_total: files.total,
      files_embedded: fileKeys.size,
      symbols_total: symbols.total,
      symbols_embedded: symbolKeys.size,
      symbol_bodies_total: symbols.bodies_eligible ?? 0,
      symbol_bodies_embedded: bodyKeys.size,
    };
  }
  /** Embedding model/backend the project was last indexed with (migration 113). */
  getProjectEmbeddingFingerprint(projectId: number): string | null {
    const row = this.db.prepare('SELECT embedding_fingerprint FROM projects WHERE id = ?')
      .get(projectId) as { embedding_fingerprint: string | null } | undefined;
    return row?.embedding_fingerprint ?? null;
  }
  setProjectEmbeddingFingerprint(projectId: number, fingerprint: string): void {
    this.db.prepare('UPDATE projects SET embedding_fingerprint = ? WHERE id = ?').run(fingerprint, projectId);
  }

  // ─── Models Cache ───────────────────────────────────────────────
  getCachedModels(provider: string): DiscoveredModel[] | null { return modelsCache.get(this.db, provider); }
  setCachedModels(provider: string, models: DiscoveredModel[]): void { modelsCache.set(this.db, provider, models); }

  // ─── Stats & Architecture ───────────────────────────────────────
  /**
   * Project stats (file/symbol counts, languages, sizes). The full scan is
   * 50-200ms on a large project and runs SYNCHRONOUSLY on the main thread, so
   * the dashboard path is served from a short-TTL cache to stop it freezing
   * every screen on open. `{ fresh: true }` bypasses + refreshes the cache —
   * REQUIRED for the indexer, which feeds this result straight into the
   * denormalized `projects.file_count` write (a stale read would persist a
   * wrong count). Display/guard callers use the default cached path.
   */
  getStats(projectId: number, opts?: { fresh?: boolean }): ProjectStats {
    const key = `stats:${projectId}`;
    const compute = (): ProjectStats =>
      stats.projectStats(this.idx(projectId), this.db, projectId, this.getProject(projectId));
    if (opts?.fresh) {
      const value = compute();
      this.readCache.set(key, value);
      return value;
    }
    return this.readCache.get(key, STATS_CACHE_TTL_MS, compute);
  }
  // ─── Dependencies ───────────────────────────────────────────────
  upsertFileDependencies(projectId: number, sourceFileId: number, sourceFilePath: string, internalDeps: string[], externalDeps: string[]): void {
    deps.upsert(this.idx(projectId), projectId, sourceFileId, sourceFilePath, internalDeps, externalDeps, this.getAliases(projectId));
  }
  getDependencies(fileId: number, projectId?: number): DBFileDependency[] { return deps.getDependencies(this.idx(projectId), fileId); }
  getDependents(projectId: number, fileId: number): DBFileDependent[] { return deps.getDependents(this.idx(projectId), projectId, fileId); }
  getCircularDeps(projectId: number): Array<{ path_a: string; path_b: string }> { return deps.getCircular(this.idx(projectId), projectId); }
  /** Invalidate alias cache (e.g. after re-index when tsconfig may have changed). */
  clearAliasCache(projectId?: number): void {
    if (projectId === undefined) this.aliasCache.clear();
    else this.aliasCache.delete(projectId);
  }

  // ─── Maintenance / Hygiene ──────────────────────────────────────
  getProjectsHygiene(): maintenance.ProjectHygieneRow[] { return maintenance.listProjectsHygiene(this.db); }
  getOrphanSemanticItems(projectId: number): maintenance.OrphanSemanticItem[] { return maintenance.listOrphanSemanticItems(this.db, projectId); }
  getFileIndegrees(projectId: number): Map<string, number> { return maintenance.getFileIndegrees(this.idx(projectId), projectId); }
  getProjectTierBreakdown(): Array<{ project_id: number; tier: string; count: number }> { return maintenance.getProjectTierBreakdown(this.db); }
  normalizeFileLanguages(projectId?: number): number { return maintenance.normalizeFileLanguages(this.idx(projectId), projectId); }
  // `runs` stays CENTRAL (stats) — stale-run marking operates on the central runs.
  markStaleRuns(olderThanHours = 2, projectId?: number): number { return maintenance.markStaleRuns(this.db, olderThanHours, projectId); }

  private getAliases(projectId: number): PathAlias[] {
    const cached = this.aliasCache.get(projectId);
    if (cached) return cached;
    const project = this.getProject(projectId);
    const aliases = project ? loadTsconfigPathAliases(project.root_path) : [];
    this.aliasCache.set(projectId, aliases);
    return aliases;
  }
}
