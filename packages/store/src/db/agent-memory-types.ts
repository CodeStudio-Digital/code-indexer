import type { AgentMemoryScope, AgentMemoryType } from '@mcp/shared/types.js';
/**
 * Dedicated Agent Memory store (migration 181) — durable single-fact memory the
 * agent writes for future sessions, SEPARATE from snapshots.
 *
 * Logical immutability: rows are never edited in place as the source of truth.
 * `replace` archives the old live row and creates a fresh one in ONE
 * transaction (archive + create + supersede link). The unique partial index
 * `(scope, project_id, name) WHERE archived_at IS NULL` guarantees one live row
 * per identity while allowing archive + recreate-same-name.
 */

export interface CreateAgentMemoryData {
  scope?: AgentMemoryScope;
  projectId?: number;
  /** kebab-case slug; callers normally pass a title and let {@link slugify} run. */
  name: string;
  description?: string;
  type?: AgentMemoryType;
  content: string;
  source?: string;
  sourceSnapshotId?: number | null;
  importance?: number;
  referencedFiles?: string[];
  /** Sync intent; ignored (forced 0) for local scope. */
  sync?: boolean;
}

export interface AgentMemoryIndexEntry {
  id: number;
  name: string;
  description: string;
  type: string;
  source: string;
  scope: string;
  importance: number;
  created_at: string;
  last_accessed_at: string | null;
  excerpt?: string;
}

export interface AgentMemoryEvent {
  eventType: string;
  scope?: string | null;
  projectId?: number | null;
  memoryId?: number | null;
  kept?: number | null;
  dropped?: number | null;
  queryHash?: string | null;
  meta?: Record<string, unknown> | null;
}

/** A referenced file captured WITH the content hash at memory-creation time, so
 *  the retriever can flag staleness (file changed or vanished since). */
export interface ReferencedFileSnapshot {
  path: string;
  /** content_hash at creation; null when the path wasn't in the file index. */
  hash: string | null;
}

export interface AgentMemoryStats {
  /** Live (non-archived) project-scope memories (optionally for one project). */
  liveProject: number;
  /** Live global user-scope memories. */
  liveUser: number;
  /** Telemetry event counts by type (remember/recall/forget/selector/…). */
  events: Record<string, number>;
  /** Recall events that injected ≥1 memory — the "actually used" signal. */
  recallHits: number;
  /** Recall events that returned nothing (cold/irrelevant store). */
  recallEmpty: number;
}
