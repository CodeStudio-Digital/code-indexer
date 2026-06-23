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
  /** Top-K cap (default 12). */
  k?: number;
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
