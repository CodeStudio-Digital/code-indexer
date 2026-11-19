import { createHash } from 'node:crypto';
import type { AgentMemoryRow } from '@mcp/shared/types.js';
import { slidingWindows } from '@mcp/shared/utils/sliding-window.js';
/**
 * Agent Memory service — embed-on-write + hybrid (FTS + vector RRF) search over
 * the dedicated `agent_memory` table, SEPARATE from snapshots.
 *
 * Deliberately NOT built on SnapshotService / HybridSearch (those are coupled
 * to the snapshots/code/docs flows). This is a small adapter that reuses the
 * SAME proven patterns: sliding-window chunking, scope-specific local vector
 * namespaces, reciprocal-rank fusion, and an FTS-only fallback when no
 * embedding backend is configured.
 */

const MEMORY_WINDOW_CHARS = 2000;

const MEMORY_OVERLAP_CHARS = 200;

export const MAX_MEMORY_CHUNKS = 4;

export const RRF_K = 60;

const AUTO_MEMORY_SOURCES = new Set(['session', 'distill', 'migrated-snapshot']);

/** Stable vector id for an agent-memory chunk (shape mirrors `sn_…`). */
export function memoryVecId(memoryId: number, chunk = 0): string {
  const seed = chunk === 0 ? `agent_memory:${memoryId}` : `agent_memory:${memoryId}:${chunk}`;
  return 'am_' + createHash('md5').update(seed).digest('hex').slice(0, 24);
}

/**
 * R1 — embedding hash includes the model fingerprint, so switching embedding
 * models invalidates the vector instead of leaving it silently stale.
 */
export function agentMemoryEmbeddingTextHash(
  row: Pick<AgentMemoryRow, 'name' | 'description' | 'content'>,
  fingerprint: string,
): string {
  return createHash('md5')
    .update(`${fingerprint}\n${row.name}\n${row.description}\n${row.content}`)
    .digest('hex');
}

export function agentMemoryEmbeddingTexts(
  row: Pick<AgentMemoryRow, 'name' | 'description' | 'content'>,
): string[] {
  const windows = slidingWindows(`${row.name}\n${row.description}\n${row.content}`, {
    windowChars: MEMORY_WINDOW_CHARS,
    overlapChars: MEMORY_OVERLAP_CHARS,
    maxChunks: MAX_MEMORY_CHUNKS,
  });
  return windows.map((window, index) => index === 0 ? window : `${row.name}\n${window}`);
}

export interface AgentMemoryHit extends AgentMemoryRow {
  /** Blended retrieval score (RRF fusion of FTS + vector ranks). */
  score: number;
}

function memorySourceAuthority(source: string): number {
  if (source === 'user') return 3;
  if (source === 'agent') return 2;
  if (source === 'migrated-snapshot') return 1.5;
  if (source === 'session' || source === 'distill') return 1;
  return 2;
}

/** Collapse only identical automatic facts. Similar words/titles are not proof
 * of equivalence: negation, versions and conditions must survive retrieval.
 * Semantic consolidation is handled separately, with archived provenance. */
export function dedupeAgentMemoryHits(hits: AgentMemoryHit[]): AgentMemoryHit[] {
  const kept: AgentMemoryHit[] = [];
  const normalized = new Map<number, string>();
  const body = (row: AgentMemoryHit) => {
    if (!normalized.has(row.id)) normalized.set(row.id, row.content.replace(/\s+/g, ' ').trim());
    return normalized.get(row.id);
  };
  for (const candidate of hits) {
    const duplicateIndex = kept.findIndex(existing => existing.type === candidate.type
      && existing.scope === candidate.scope && existing.project_id === candidate.project_id
      && (AUTO_MEMORY_SOURCES.has(existing.source) || AUTO_MEMORY_SOURCES.has(candidate.source))
      && body(existing) === body(candidate));
    if (duplicateIndex < 0) { kept.push(candidate); continue; }
    const existing = kept[duplicateIndex]!;
    const preferred = memorySourceAuthority(candidate.source) > memorySourceAuthority(existing.source) ? candidate : existing;
    kept[duplicateIndex] = { ...preferred, score: Math.max(existing.score, candidate.score) };
  }
  return kept;
}
