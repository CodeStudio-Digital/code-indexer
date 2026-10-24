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

const MEMORY_TEXT_STOPWORDS = new Set([
  'after', 'before', 'from', 'into', 'must', 'rather', 'than', 'that', 'then',
  'this', 'when', 'with', 'após', 'como', 'deve', 'esse', 'esta', 'isso',
  'para', 'pela', 'pelo', 'porque', 'sem', 'uma',
]);

const MEMORY_TITLE_STOPWORDS = new Set([
  'after', 'fix', 'for', 'gaps', 'in', 'limitation', 'must', 'on', 'requirement',
  'rule', 'the', 'with',
]);

const MEMORY_DUPLICATE_CONTENT_THRESHOLD = 0.5;

const MEMORY_DUPLICATE_TITLE_THRESHOLD = 0.75;

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

function memoryContentTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 3 && !MEMORY_TEXT_STOPWORDS.has(token)),
  );
}

/** Containment overlap works better than union-Jaccard here: an automatic
 * distillation commonly repeats a short canonical fact inside a longer note. */
function memoryContentSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>, minimumShared = 1): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of smaller) if (larger.has(token)) shared += 1;
  if (shared < minimumShared) return 0;
  return shared / Math.min(left.size, right.size);
}

function memoryTitleConcepts(value: string): Set<string> {
  const concepts = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !MEMORY_TITLE_STOPWORDS.has(token))
    .map((token) => {
      if (
        token.startsWith('disconnect')
        || token.startsWith('connection')
        || token === 'socket'
      ) return 'disconnect';
      if (
        token.startsWith('persist')
        || token === 'leak'
        || token === 'stuck'
        || token === 'indefinitely'
      ) return 'unsettled';
      if (token.startsWith('mutat')) return 'mutation';
      if (token.startsWith('optim')) return 'optimistic';
      if (
        token.startsWith('rollback')
        || token.startsWith('restor')
        || token.startsWith('revert')
      ) return 'rollback';
      if (token.startsWith('callback')) return 'callback';
      if (token.startsWith('event')) return 'event';
      return token;
    });
  return new Set(concepts);
}

function memorySourceAuthority(source: string): number {
  if (source === 'user') return 3;
  if (source === 'agent') return 2;
  if (source === 'migrated-snapshot') return 1.5;
  if (source === 'session' || source === 'distill') return 1;
  return 2;
}

/**
 * Collapse automatic paraphrases before they reach either recall_memory or the
 * MCP search bridge. Explicit user/agent memories are never collapsed against
 * each other. When an automatic note overlaps an explicit canonical fact, keep
 * the explicit content while retaining the best retrieval score of the group.
 */
export function dedupeAgentMemoryHits(hits: AgentMemoryHit[]): AgentMemoryHit[] {
  const kept: AgentMemoryHit[] = [];
  // A candidate used to be normalized/tokenized anew for every pair. Cache
  // only within this retrieval; no content or mutable row escapes the call.
  const bodies = new Map<string, Set<string>>(), titles = new Map<string, Set<string>>();
  const tokens = (value: string, title = false) => {
    const cache = title ? titles : bodies;
    let result = cache.get(value);
    if (!result) { result = title ? memoryTitleConcepts(value) : memoryContentTokens(value); cache.set(value, result); }
    return result;
  };
  for (const candidate of hits) {
    const duplicateIndex = kept.findIndex((existing) => {
      if (
        !AUTO_MEMORY_SOURCES.has(existing.source)
        && !AUTO_MEMORY_SOURCES.has(candidate.source)
      ) {
        return false;
      }
      return (
        memoryContentSimilarity(tokens(existing.content), tokens(candidate.content))
          >= MEMORY_DUPLICATE_CONTENT_THRESHOLD
        || memoryContentSimilarity(tokens(existing.name, true), tokens(candidate.name, true), 2)
          >= MEMORY_DUPLICATE_TITLE_THRESHOLD
      );
    });
    if (duplicateIndex < 0) {
      kept.push(candidate);
      continue;
    }

    const existing = kept[duplicateIndex]!;
    const candidateAuthority = memorySourceAuthority(candidate.source);
    const existingAuthority = memorySourceAuthority(existing.source);
    const candidateIsRicherAutomatic =
      candidateAuthority === existingAuthority
      && AUTO_MEMORY_SOURCES.has(candidate.source)
      && tokens(candidate.content).size
        > tokens(existing.content).size;
    if (candidateAuthority > existingAuthority || candidateIsRicherAutomatic) {
      kept[duplicateIndex] = {
        ...candidate,
        score: Math.max(existing.score, candidate.score),
      };
    }
  }
  return kept;
}
