/**
 * Types for the context-relevance pipeline.
 *
 * Goal: when a session's context window fills up, drop messages by
 * relevance instead of by chronology. Preserves decisions/declarations made
 * early in the session that the model would otherwise forget.
 *
 * Inspired by the two-tower retrieval + candidate-isolation pattern from
 * Phoenix (xai-org/x-algorithm) but applied to in-conversation memory
 * compaction instead of feed ranking.
 */
import type { PipelineCandidate, PipelineQuery } from '@mcp/candidate-pipeline';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'tool_result';

export interface SessionMessage {
  /** Stable id within the session — used for cache keys + audit. */
  id: string;
  role: MessageRole;
  /** Plain-text content for embedding / signal extraction. */
  text: string;
  /** Approximate token count (length / 4 if not provided). */
  tokenCount?: number;
  /** Original creation timestamp in ms. */
  createdAtMs: number;
  /**
   * Atomic block identifier. Messages in the same block are kept or
   * dropped together (e.g. assistant → tool_call → tool_result triplets).
   * If omitted, the message is its own block.
   */
  atomicBlockId?: string;
  /** Whether the message originally contained tool_use or tool_result events. */
  hasToolEvent?: boolean;
}

export interface ContextRelevanceQuery extends PipelineQuery {
  /** Free-form text of the current task — usually the latest user message. */
  taskText: string;
  /** Pre-computed task embedding (set by QueryHydrator). */
  taskEmbedding?: Float32Array;
  /** Total token budget available for retained messages. */
  tokenBudget: number;
  /** How many turns at the tail of the conversation are non-droppable. */
  preserveRecentTurns?: number;
  /** Optional half-life for recency decay. Default 30 turns ≈ 30 minutes. */
  recencyHalfLifeMs?: number;
  /** Custom weights override (rarely needed). */
  weights?: {
    taskAffinity: number;
    recency: number;
    infoDensity: number;
    decisionMarker: number;
  };
}

export interface MessageCandidate extends PipelineCandidate {
  message: SessionMessage;
  /** Computed token count (falls back to text.length / 4). */
  tokens: number;
  /** Pre-computed embedding (set by hydrator). */
  embedding?: Float32Array;
  /** Whether this message is hard-pinned and must NOT be dropped. */
  pinned: boolean;
  /** Per-signal scores for debugging. */
  signals: {
    taskAffinity?: number;
    recency?: number;
    infoDensity?: number;
    decisionMarker?: number;
  };
  /** Final fused score (higher = more valuable to retain). */
  score: number;
}

export const DEFAULT_PRESERVE_RECENT_TURNS = 5;
export const DEFAULT_RECENCY_HALF_LIFE_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_WEIGHTS = {
  taskAffinity: 0.4,
  recency: 0.2,
  infoDensity: 0.2,
  decisionMarker: 0.2,
};
