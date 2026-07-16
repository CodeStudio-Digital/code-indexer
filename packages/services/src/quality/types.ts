/**
 * Types for the quality classifier pipeline.
 *
 * Each classifier reads the agent's recent output and emits a structured
 * verdict. Verdicts are SOFT by default: 'flagged' is logged but doesn't
 * block. The enforcement layer (master orchestrator, runner middleware)
 * may decide to act on certain (classifier, verdict) tuples.
 */

export type QualityVerdict = 'ok' | 'warn' | 'flagged' | 'error';

export interface AgentOutputForClassification {
  /** Stable session identifier (coder or company). */
  sessionId?: number | null;
  companySessionId?: number | null;
  agentRunId?: number | null;
  coderRunId?: string | null;
  parentRunId?: string | null;
  isSubagent?: boolean;
  subagentProfile?: string | null;
  /** Optional message id within the conversation. */
  messageId?: string | null;
  /** Durable user-message id that owns the completed round. */
  roundMessageId?: number | null;
  /** Free-form task description / user prompt that triggered the output. */
  taskText: string;
  /** The agent's response text. */
  outputText: string;
  /** Optional list of recent tool calls — used by ToolMisuse. */
  recentToolCalls?: Array<{ name: string; success: boolean; timestampMs: number }>;
  /** Terminal, bounded evidence. Never contains raw tool arguments or diffs. */
  stopReason?: string | null;
  changedFiles?: string[];
  toolSummary?: {
    total: number;
    success: number;
    error: number;
    timeout: number;
    refusal: number;
    tools: Array<{ name: string; calls: number; success: number; failures: number }>;
  };
  guardActions?: Array<{ guard: string; tool?: string; count: number; action: string }>;
  validationSignals?: string[];
}

export type QualityAssessmentScope = 'run_final' | 'runtime' | 'legacy_turn';
export type QualityAssessmentSource = 'terminal_llm' | 'deterministic_guard' | 'legacy_llm';
export type QualityActionTaken = 'none' | 'advisory' | 'tool_call_refused' | 'strategy_nudge';

export interface ClassificationDimension {
  classifierName: string;
  verdict: QualityVerdict;
  confidence?: number;
  reason?: string;
}

export interface ClassificationVerdict {
  classifierName: string;
  verdict: QualityVerdict;
  /**
   * True when `verdict==='error'` reflects a CLASSIFIER FAILURE (no binding,
   * LLM call errored, unparseable reply) rather than a content judgement. The
   * LLM may legitimately return verdict='error' to mean "the agent's output is
   * broken" — that is NOT a system error. Telemetry counts only systemError as
   * a failure so content verdicts don't inflate the error metric.
   */
  systemError?: boolean;
  /** Optional model-emitted confidence. */
  confidence?: number;
  /** Free-form reason — surfaced in admin UI tooltips. */
  reason?: string;
  /** Latency of the classifier call in ms. */
  latencyMs: number;
  /** Provider that answered (for telemetry / cost attribution). */
  providerId?: string;
  modelId?: string;
  tokensIn?: number;
  tokensOut?: number;
  providerRequests?: number;
  /** Extra dimensional rows produced by the same provider request. */
  dimensions?: ClassificationDimension[];
  /** Raw response payload — handy when debugging classifier prompts. */
  raw?: unknown;
}

export interface QualityResult {
  /** Per-classifier verdicts in the order they completed. */
  verdicts: ClassificationVerdict[];
  /** Aggregate verdict (worst-of). */
  worstVerdict: QualityVerdict;
  /** Wall-clock duration of the parallel run. */
  durationMs: number;
  /** One id per provider attempt, shared by all dimensional rows. */
  assessmentId?: string;
}
