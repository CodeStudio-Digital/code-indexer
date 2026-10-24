/**
 * Periodic memory consolidator — the "tidy the project memory" maintenance pass.
 *
 * Sibling of the idle sweeper, but project-scoped: every `intervalMs` it picks
 * idle projects whose memory changed since the last pass and, per project,
 * merges near-duplicate snapshots (importance-bumped) and garbage-collects
 * fully-stale, cold, low-importance ones (reversible archive, never delete).
 *
 * Runs in the MAIN process where the canonical SnapshotService + retriever
 * live (no worker RPC). Same lifecycle posture as the sweeper: unref()-ed
 * timer, inFlight guard, best-effort, never throws. Ships DARK — opt in with
 * MCP_MEMORY_CONSOLIDATE=1 (archiving is destructive-ish, so an operator
 * enables it deliberately and can audit the first passes via snapshot_versions).
 */
import { createMemoryConsolidator } from '@mcp/services/memory/consolidator/index.js';
import { DEFAULT_CONSOLIDATOR_OPTIONS, type ConsolidationPassResult, type ConsolidatorOptions } from '@mcp/services/memory/consolidator/types.js';
import type { SnapshotService } from '@mcp/services/services/snapshots.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import {
  sessionEntryIncludesProject,
  type FsSessionStore,
} from '@mcp/session-storage/fs-store/index.js';

const DEFAULT_INTERVAL_MS = Number(process.env.MCP_MEMORY_CONSOLIDATE_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
const DEFAULT_IDLE_MS = Number(process.env.MCP_MEMORY_CONSOLIDATE_IDLE_MS ?? 30 * 60 * 1000);
const DEFAULT_MAX_PROJECTS = Number(process.env.MCP_MEMORY_CONSOLIDATE_MAX_PROJECTS ?? 3);

/**
 * Off by default (opt-in). Archiving is reversible (rows soft-delete with a
 * restore UI in Admin → Memory), but the periodic pass runs UNATTENDED on idle
 * projects every few hours — silently hiding a memory the user still relied on
 * erodes trust in the whole memory feature, so an operator arms it deliberately.
 * Set `MCP_MEMORY_CONSOLIDATE` to `1`/`true`/`on` to arm the periodic timer;
 * anything else (including unset) leaves it disarmed. The manual "run now" route
 * (`POST /api/projects/:id/memory/consolidate`) works regardless of this flag.
 */
export function memoryConsolidateEnabled(): boolean {
  const raw = process.env.MCP_MEMORY_CONSOLIDATE;
  if (raw == null || raw === '') return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

function num(env: string | undefined, fallback: number): number {
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Merge/GC thresholds read from env, falling back to conservative defaults. */
export function consolidatorOptionsFromEnv(): ConsolidatorOptions {
  return {
    mergeCosine: num(process.env.MCP_MEMORY_MERGE_COSINE, DEFAULT_CONSOLIDATOR_OPTIONS.mergeCosine),
    mergeTitleJaccard: num(process.env.MCP_MEMORY_MERGE_TITLE_JACCARD, DEFAULT_CONSOLIDATOR_OPTIONS.mergeTitleJaccard),
    maxMergesPerPass: num(process.env.MCP_MEMORY_MAX_MERGES_PER_PASS, DEFAULT_CONSOLIDATOR_OPTIONS.maxMergesPerPass),
    maxSnapshotsPerPass: num(process.env.MCP_MEMORY_MAX_SNAPSHOTS_PER_PASS, DEFAULT_CONSOLIDATOR_OPTIONS.maxSnapshotsPerPass),
    archiveImportanceMax: num(process.env.MCP_MEMORY_ARCHIVE_IMPORTANCE_MAX, DEFAULT_CONSOLIDATOR_OPTIONS.archiveImportanceMax),
    archiveUnusedDays: num(process.env.MCP_MEMORY_ARCHIVE_UNUSED_DAYS, DEFAULT_CONSOLIDATOR_OPTIONS.archiveUnusedDays),
    archiveMaxAccess: num(process.env.MCP_MEMORY_ARCHIVE_MAX_ACCESS, DEFAULT_CONSOLIDATOR_OPTIONS.archiveMaxAccess),
  };
}

export interface MemoryConsolidatorHandle {
  stop(): void;
  /** One pass; pass a projectId to consolidate just that project (manual/tests). */
  runOnce(onlyProjectId?: number): Promise<ConsolidationPassResult[]>;
  readonly intervalMs: number;
}

export interface StartMemoryConsolidatorArgs {
  db: CodeIndexDB;
  sessionStore: FsSessionStore;
  snapshotService: SnapshotService;
  embeddingService: EmbeddingService;
  intervalMs?: number;
  idleMs?: number;
  maxProjects?: number;
  options?: ConsolidatorOptions;
  /** When false, the handle is built (so the manual "run now" route works) but
   *  the periodic timer is NOT armed. Defaults to true. */
  armed?: boolean;
}

/** Main-process singleton so the manual consolidate route can reach the handle
 *  even when the periodic timer is disarmed (flag off). */
let activeHandle: MemoryConsolidatorHandle | null = null;
export function getMemoryConsolidator(): MemoryConsolidatorHandle | null {
  return activeHandle;
}

type ConsolidationSessionStore = Pick<
  FsSessionStore,
  'catalog' | 'repository'
>;

/**
 * The catalog must be refreshed by the caller. A project is idle only when
 * every owning or linked session is non-running and older than the idle
 * threshold. Unreadable/invalid state fails closed.
 */
export function projectIsIdleForConsolidation(
  sessions: ConsolidationSessionStore,
  projectId: number,
  idleMs: number,
  now = Date.now(),
): boolean {
  const relevant = sessions.catalog
    .list()
    .filter((entry) => sessionEntryIncludesProject(entry, projectId));

  for (const entry of relevant) {
    try {
      const state =
        entry.state ??
        sessions.repository.readStateSync(entry.location);
      if (state.status === 'running') return false;
      const sessionUpdated = Date.parse(entry.session.updated_at);
      const stateUpdated = Date.parse(state.updated_at);
      if (!Number.isFinite(sessionUpdated) || !Number.isFinite(stateUpdated)) {
        return false;
      }
      if (now - Math.max(sessionUpdated, stateUpdated) < idleMs) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function startMemoryConsolidator(args: StartMemoryConsolidatorArgs): MemoryConsolidatorHandle {
  // createApp() may be rebuilt in-process by tests/dev harnesses. Never leave
  // the previous timer and its full dependency graph retained.
  activeHandle?.stop();
  const intervalMs = args.intervalMs ?? DEFAULT_INTERVAL_MS;
  const idleMs = args.idleMs ?? DEFAULT_IDLE_MS;
  const maxProjects = args.maxProjects ?? DEFAULT_MAX_PROJECTS;
  const options = args.options ?? consolidatorOptionsFromEnv();
  const { db, sessionStore, snapshotService, embeddingService } = args;

  let stopped = false;
  let inFlight = false;

  const consolidator = createMemoryConsolidator({
    store: {
      listLiveSnapshots: (pid) => db.listSnapshots(pid),
      staleFilesBatch: (ids, pid) => db.getStaleSnapshotFilesBatch(ids, pid),
      unionFiles: (winnerId, loserIds) => db.unionSnapshotFiles(winnerId, loserIds),
      setAccessStats: (id, count, last) => db.setSnapshotAccessStats(id, count, last),
      logDistill: (pid, e) =>
        db.insertMemoryDistillLog(pid, {
          trigger: 'consolidation',
          status: e.status,
          merged: e.merged,
          // `skipped` carries the archived count for the consolidation trigger
          // (the log schema is fixed; the health card reads it back per-trigger).
          skipped: e.archived,
          error: e.error ?? null,
        }),
    },
    writer: {
      update: (id, u) => snapshotService.update(id, u),
      archive: (id, reason) => snapshotService.archive(id, reason),
    },
    embedder: {
      hasBackend: () => snapshotService.hasEmbeddingBackend(),
      embed: async (texts) => (await embeddingService.embed(texts)).vectors,
    },
    options,
  });

  const runOnce = async (onlyProjectId?: number): Promise<ConsolidationPassResult[]> => {
    if (stopped || inFlight) return [];
    inFlight = true;
    try {
      let candidates = onlyProjectId != null
        ? [{
            project_id: onlyProjectId,
            project_name: db.getProject(onlyProjectId)?.name ?? '',
          }]
        : [];
      if (onlyProjectId == null) {
        await sessionStore.refresh();
        if (sessionStore.catalog.issues.length > 0) {
          console.warn(
            `[memory/consolidator] skipped: filesystem session catalog has ` +
            `${sessionStore.catalog.issues.length} scan issue(s)`,
          );
          return [];
        }
        candidates = db
          .listConsolidationCandidates()
          .filter((candidate) =>
            projectIsIdleForConsolidation(
              sessionStore,
              candidate.project_id,
              idleMs,
            ),
          )
          .slice(0, Math.max(1, Math.floor(maxProjects)));
      }
      const results: ConsolidationPassResult[] = [];
      for (const c of candidates) {
        if (stopped) break;
        const r = await consolidator.runOnce(c.project_id, c.project_name);
        results.push(r);
        if (r.truncated) {
          console.log(
            `[memory/consolidator] project ${c.project_id} capped at ${options.maxSnapshotsPerPass} ` +
            `snapshots — remainder handled next pass`,
          );
        }
      }
      const merged = results.reduce((s, r) => s + r.merged, 0);
      const archived = results.reduce((s, r) => s + r.archived, 0);
      if (merged > 0 || archived > 0) {
        console.log(`[memory/consolidator] merged=${merged} archived=${archived} across ${results.length} project(s)`);
      }
      return results;
    } catch (e) {
      console.warn(`[memory/consolidator] pass failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    } finally {
      inFlight = false;
    }
  };

  const armed = args.armed !== false;
  const timer = armed ? setInterval(() => { void runOnce(); }, intervalMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();

  console.log(
    `[memory/consolidator] ${armed ? 'armed' : 'idle (manual-only)'} — interval=${Math.round(intervalMs / 1000)}s ` +
    `idle=${Math.round(idleMs / 1000)}s maxProjects=${maxProjects} cosine=${options.mergeCosine}`,
  );

  const handle: MemoryConsolidatorHandle = {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      if (activeHandle === handle) activeHandle = null;
      console.log('[memory/consolidator] stopped');
    },
    runOnce,
    intervalMs,
  };
  activeHandle = handle;
  return handle;
}
