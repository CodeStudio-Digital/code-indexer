import type { AgentMessage } from '@mcp/provider-sdk';

/**
 * V3 deliberately separates the append-only historical chapter from the
 * small resume snapshot injected back into the model context.
 */
export interface CompactionChapterV3 {
  title: string;
  summary: string;
  user_requests: string[];
  decisions: string[];
  work_completed: string[];
  files: Array<{ path: string; state: string }>;
  open_issues: string[];
  resolved_issues: string[];
}

export interface CompactionResumeV3 {
  objective: string;
  current_focus: string;
  constraints: string[];
  pending_tasks: string[];
  next_step: string;
  /** Ground-truth goal overlay. It is never requested from the model. */
  active_goal?: string;
}

export interface CompactionSummaryMetricsV3 {
  model: string;
  input_chars: number;
  output_chars: number;
  input_messages: number;
  duration_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  compression_ratio: number;
  /** Providers do not expose prices on ChatDelta, so this is null unless a host enriches it. */
  cost_usd?: number | null;
}

export interface CompactionSummaryV3 {
  version: 3;
  chapter: CompactionChapterV3;
  resume: CompactionResumeV3;
  metrics?: CompactionSummaryMetricsV3;
}

export interface CompactionLiveStateV3 {
  goal?: string | { text: string; status?: string } | null;
  activePlan?: string | { text: string; status?: string } | null;
  todos?: Array<{ content: string; activeForm?: string; status: string }>;
  plan?: Array<{ step?: string; content?: string; status: string }>;
}

export interface SummarizeSpanV3Input {
  /** Prior continuation state. It is placed in the system channel, never as a fake user turn. */
  previousResume?: CompactionResumeV3 | string | null;
  /** Only the newly archived conversation interval. */
  messages: AgentMessage[];
  /** Persisted/live state overlaid after the LLM response. */
  liveState?: CompactionLiveStateV3 | null;
}

export interface SummarizeSpanV3Options {
  signal?: AbortSignal;
  /** Hard deadline for the auxiliary call. Defaults to 45 seconds. */
  timeoutMs?: number;
  /** Test/diagnostic override for the prompt sampler budget. */
  budgetChars?: number;
  /** Binding-level deterministic sampling override (clamped by the resolver). */
  temperature?: number;
  /** Binding-level reasoning effort; defaults to minimal. */
  reasoningEffort?: string | null;
  /** Advisory provider output budget mirrored into the strict system prompt. */
  maxOutputTokens?: number;
}

/**
 * LLM-driven compaction summarizer.
 *
 * Complements the deterministic `compactMessages` in core/compaction.ts: when
 * the accumulated history is large enough to trigger compaction, instead of
 * (only) replacing old tool_result contents with deterministic markers, we
 * can ask a cheap model to produce a structured summary that preserves the
 * salient facts (files touched, decisions, next steps, user preferences).
 *
 * The summary replaces a span of old messages with a single synthetic
 * assistant message of ~500 tokens. The continuing agent sees the summary
 * in place of the pruned turns — much better than just `[compacted: N]`
 * markers when the user asks "what did we do earlier?".
 *
 * This path is OPT-IN via `CODER_SUMMARIZER_ENABLE=1`. When disabled (the
 * default), the caller uses the existing deterministic compaction path.
 * The fallback is critical: any failure here — LLM timeout, invalid JSON,
 * provider error — must NOT break the turn. Return null and let the caller
 * fall back to the deterministic marker.
 */

export interface CompactionSummary {
  what_done: string;
  current_work: string;
  files_touched: string[];
  decisions: string[];
  next_steps: string[];
  user_preferences: string[];
}

/**
 * 9-section summary used when CODER_NEW_COMPACTION is enabled. Mirrors
 * Claude Code's compact prompt structure (Primary Request, Key Concepts,
 * Files, Errors, Problem Solving, User Messages, Pending Tasks, Current
 * Work, Next Step) — empirically the right level of detail to let the
 * continuing agent resume cleanly without re-reading the pruned span.
 *
 * Backwards compatible: `toLegacy()` projects this onto the older 6-field
 * shape so the existing `renderSummary` keeps working during the rollout.
 */
export interface CompactionSummaryV2 {
  primary_request: string;
  key_concepts: string[];
  files_and_code: Array<{ path: string; state: string }>;
  errors_and_fixes: string[];
  problem_solving: string;
  all_user_messages: string[];
  pending_tasks: string[];
  current_work: string;
  next_step: string;
  /**
   * Live-state overlay populated by the runner AFTER the LLM summarization
   * step (Agent Loop v2). Keeps the rendered summary anchored to ground truth
   * even when the LLM-extracted pending_tasks/next_step drift from reality.
   * Either field may be omitted when there is nothing to record.
   */
  active_goal?: string;
}
