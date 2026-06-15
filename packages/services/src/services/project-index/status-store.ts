import type { CodeIndexDB } from '@mcp/store/db.js';
import type { ProjectIndexPhase, ProjectIndexStatus } from './types.js';

type Listener = (s: ProjectIndexStatus) => void;

interface Entry {
  status: ProjectIndexStatus;
  hydrated: boolean;
  listeners: Set<Listener>;
}

/**
 * In-memory status per project, lazily hydrated from the DB row (the
 * persistent truth: structural_indexed_at / last_indexed / counters).
 * Phase transitions and progress are runtime-only; a restart re-derives
 * the resting phase from the DB.
 */
export class ProjectIndexStatusStore {
  private entries = new Map<number, Entry>();

  constructor(private db: CodeIndexDB) {}

  get(projectId: number): ProjectIndexStatus {
    return { ...this.entry(projectId).status };
  }

  subscribe(projectId: number, fn: Listener): () => void {
    const entry = this.entry(projectId);
    entry.listeners.add(fn);
    return () => entry.listeners.delete(fn);
  }

  setPhase(projectId: number, phase: ProjectIndexPhase, error?: string): void {
    this.patch(projectId, { phase, error, progress: undefined });
  }

  setProgress(projectId: number, current: number, total: number): void {
    this.patch(projectId, { phase: 'structural_indexing', progress: { current, total } });
  }

  setWatcher(projectId: number, active: boolean): void {
    this.patch(projectId, { watcherActive: active });
  }

  setDirtyPending(projectId: number, dirtyPending: number): void {
    this.patch(projectId, { dirtyPending });
  }

  /**
   * Re-read counters + stamps from the DB and settle into the resting phase
   * (semantic_ready ⊃ structural_ready ⊃ none). Called after every run/drain.
   */
  refreshFromDb(projectId: number): void {
    const entry = this.entry(projectId);
    const fresh = this.derive(projectId);
    this.patch(projectId, {
      ...fresh,
      // Keep runtime-only bits.
      watcherActive: entry.status.watcherActive,
      dirtyPending: entry.status.dirtyPending,
      progress: undefined,
      error: undefined,
    });
  }

  private patch(projectId: number, partial: Partial<ProjectIndexStatus>): void {
    const entry = this.entry(projectId);
    entry.status = { ...entry.status, ...partial, projectId };
    for (const fn of entry.listeners) {
      try { fn({ ...entry.status }); } catch { /* listener errors never propagate */ }
    }
  }

  private entry(projectId: number): Entry {
    let entry = this.entries.get(projectId);
    if (!entry) {
      entry = {
        status: { watcherActive: false, dirtyPending: 0, ...this.derive(projectId) },
        hydrated: true,
        listeners: new Set(),
      };
      this.entries.set(projectId, entry);
    }
    return entry;
  }

  private derive(projectId: number): Omit<ProjectIndexStatus, 'watcherActive' | 'dirtyPending'> {
    const project = this.db.getProject(projectId);
    // A ready phase additionally requires actual rows — a stale/buggy stamp
    // over an empty index must never render "Symbols ready · 0 files".
    const hasRows = (project?.file_count ?? 0) > 0;
    const phase: ProjectIndexPhase = project?.last_indexed && hasRows
      ? 'semantic_ready'
      : project?.structural_indexed_at && hasRows
        ? 'structural_ready'
        : 'none';
    let semanticStaleCount = 0;
    try { semanticStaleCount = this.db.countSemanticStale(projectId); } catch { /* pre-migration DB */ }
    return {
      projectId,
      phase,
      fileCount: project?.file_count ?? 0,
      symbolCount: project?.symbol_count ?? 0,
      semanticStaleCount,
      lastStructuralAt: project?.structural_indexed_at ?? null,
      lastSemanticAt: project?.last_indexed ?? null,
    };
  }
}
