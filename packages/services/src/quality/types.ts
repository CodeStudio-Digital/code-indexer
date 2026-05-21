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
  /** Optional message id within the conversation. */
  messageId?: string | null;
  /** Free-form task description / user prompt that triggered the output. */
  taskText: string;
  /** The agent's response text. */
  outputText: string;
  /** Optional list of recent tool calls — used by ToolMisuse. */
  recentToolCalls?: Array<{ name: string; success: boolean; timestampMs: number }>;
}

export interface ClassificationVerdict {
  classifierName: string;
  verdict: QualityVerdict;
  /** Optional model-emitted confidence. */
  confidence?: number;
  /** Free-form reason — surfaced in admin UI tooltips. */
  reason?: string;
  /** Latency of the classifier call in ms. */
  latencyMs: number;
  /** Provider that answered (for telemetry / cost attribution). */
  providerId?: string;
  modelId?: string;
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
}
