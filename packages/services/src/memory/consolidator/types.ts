import type { SnapshotCategory } from '@mcp/shared/types.js';

/**
 * Periodic memory consolidator — types + injected ports.
 *
 * The orchestrator ({@link ./index.ts}) consolidates ONE project per
 * `runOnce` call: it merges near-duplicate snapshots (per category) and
 * garbage-collects fully-stale, cold, low-importance ones. Project selection
 * (idle gate, skip-if-unchanged, caps across projects) is the host
 * scheduler's job — see apps/http-api/sse/memory-consolidator.ts.
 *
 * All side effects go through structural ports so the algorithm is pure and
 * unit-testable with fakes (no SQLite / embedding backend in tests).
 */

/** Minimal snapshot shape the consolidator reads (ContextSnapshot satisfies it). */
export interface ConsolSnapshot {
  id: number;
  category: SnapshotCategory | string;
  title: string;
  content: string;
  importance: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
}

export interface ConsolidatorOptions {
  /** Embedding cosine threshold to treat two snapshots as the same fact. */
  mergeCosine: number;
  /** Title Jaccard-min fallback threshold when no embedding backend. */
  mergeTitleJaccard: number;
  /** Max merge clusters applied per project per pass. */
  maxMergesPerPass: number;
  /** Max snapshots scanned per project per pass (bounded work). */
  maxSnapshotsPerPass: number;
  /** GC: only archive rows below this importance. */
  archiveImportanceMax: number;
  /** GC: only archive rows untouched for at least this many days. */
  archiveUnusedDays: number;
  /** GC: only archive rows accessed at most this many times. */
  archiveMaxAccess: number;
}

export const DEFAULT_CONSOLIDATOR_OPTIONS: ConsolidatorOptions = {
  mergeCosine: 0.92,
  mergeTitleJaccard: 0.6,
  maxMergesPerPass: 50,
  maxSnapshotsPerPass: 500,
  archiveImportanceMax: 0.35,
  archiveUnusedDays: 90,
  archiveMaxAccess: 1,
};

/** A planned merge of a near-duplicate cluster into one surviving winner. */
export interface MergePlan {
  winnerId: number;
  loserIds: number[];
  /** New merged body, or null when it didn't grow (cheap importance-only path). */
  content: string | null;
  /** Bumped importance (capped at 1). */
  importance: number;
  /** Summed access_count across the cluster. */
  accessCount: number;
  /** Latest last_accessed_at across the cluster. */
  lastAccessedAt: string | null;
}

/** Outcome of one project pass. */
export interface ConsolidationPassResult {
  projectId: number;
  merged: number;
  archived: number;
  /** True when the project had more snapshots than maxSnapshotsPerPass. */
  truncated: boolean;
  status: 'ok' | 'empty' | 'error';
  error?: string;
}

export interface ConsolidatorStore {
  /** Live (non-archived) snapshots for a project. */
  listLiveSnapshots(projectId: number): ConsolSnapshot[];
  /** Per-snapshot staleness: id → { stale file paths, total referenced }. */
  staleFilesBatch(ids: number[], projectId: number): Map<number, { stale: string[]; total: number }>;
  /** Fold loser file references into the winner, preserving original hashes. */
  unionFiles(winnerId: number, loserIds: number[]): void;
  /** Overwrite winner usage stats (summed access, latest touch). */
  setAccessStats(id: number, accessCount: number, lastAccessedAt: string | null): void;
  /** Record the pass outcome to memory_distill_log. */
  logDistill(projectId: number, entry: { status: string; merged: number; archived: number; error?: string }): void;
}

export interface ConsolidatorWriter {
  /** Merge winner update (content + importance) — re-embeds when content moves. */
  update(id: number, updates: { content?: string; importance?: number; projectId?: number }): Promise<unknown>;
  /** Vector-consistent soft-delete (archive row + drop vectors). */
  archive(id: number, reason: string): Promise<void>;
}

export interface ConsolidatorEmbedder {
  hasBackend(): boolean;
  /** Embed texts → row-aligned vectors. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface ConsolidatorDeps {
  store: ConsolidatorStore;
  writer: ConsolidatorWriter;
  embedder: ConsolidatorEmbedder;
  options?: Partial<ConsolidatorOptions>;
  /** Injectable clock for deterministic GC tests. Defaults to Date.now(). */
  now?: () => number;
}
