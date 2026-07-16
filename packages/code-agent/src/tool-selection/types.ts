/**
 * Types for the tool-selection pipeline.
 *
 * Goal: pick the top-K most relevant tools for the current user task,
 * instead of pumping all 60+ tools into every system prompt. Inspired by
 * the two-tower retrieval pattern in
 * `phoenix/recsys_retrieval_model.py:160-389`.
 */
import type { PipelineCandidate, PipelineQuery } from '@mcp/candidate-pipeline';
import type { CoderTool } from '../core/tool.js';

export interface ToolSelectionQuery extends PipelineQuery {
  /** Free-form task text — last user message + optional last tool result. */
  taskText: string;
  /** Pre-computed embedding of taskText (set by TaskEmbeddingHydrator). */
  taskEmbedding?: Float32Array;
  /** Vector-space identity pinned together with taskEmbedding. */
  embeddingFingerprint?: string;
  /**
   * Tool-call history for the current session, used by FrequencyBoostScorer
   * to bump tools the agent has called recently with success.
   */
  recentToolEvents?: Array<{ toolName: string; timestampMs: number; ok: boolean }>;
  /**
   * Currently selected tier. The pipeline always includes tier='bootstrap'
   * tools verbatim — these are the essentials (Read/Edit/Bash/TodoWrite/etc.).
   */
  tier?: 'bootstrap' | 'navigate' | 'full';
  /**
   * Optional tool policy from the Agent Decision Engine (intent/phase aware).
   * `preferred` tools get a score bump; `discouraged` ones get a penalty.
   * Structurally compatible with `ToolPolicy` in agents/decision-types.ts so
   * the engine's output can be passed straight through. When omitted, tool
   * selection behaves EXACTLY as before (the PolicyAffinityScorer disables
   * itself) — this keeps the field a pure, backward-compatible add-on.
   */
  toolPolicy?: ToolSelectionPolicy;
  /** Top-K cap (default 12). */
  k?: number;
}

/** Optional preferred/discouraged tool hints for {@link ToolSelectionQuery}. */
export interface ToolSelectionPolicy {
  /** Tool names to bump (the engine's `toolPolicy.preferred`). */
  preferred?: readonly string[];
  /** Tool names to penalize (the engine's `toolPolicy.discouraged`). */
  discouraged?: readonly string[];
}

export interface ToolCandidate extends PipelineCandidate {
  /** Canonical name of the tool (matches `CoderTool.name`). */
  name: string;
  /** Concatenated `description + parameters` text used for embeddings. */
  descriptionText: string;
  /** Underlying tool descriptor — passed back to the runner verbatim. */
  tool: CoderTool;
  /** Pre-computed embedding of descriptionText (set by ToolEmbeddingHydrator). */
  embedding?: Float32Array;
  /** Whether this tool is in the bootstrap tier (always included). */
  isEssential: boolean;
  /** Logical category for diversity attenuation: 'fs' | 'shell' | 'git' | 'mcp' | etc. */
  category: string;
  /**
   * Final fused score after all scorers run. Higher = more relevant.
   * Set by the weighted-sum scorer.
   */
  score: number;
  /** Per-signal scores for debugging (taskAffinity, frequencyBoost, etc.). */
  signals: Record<string, number>;
}

export const DEFAULT_TOP_K = 12;
