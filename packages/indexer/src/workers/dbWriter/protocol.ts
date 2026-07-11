import type { AgentMessage } from '@mcp/code-agent/core/messages.js';

export interface PersistAssistantTurnPayload {
  session_id: number;
  message: AgentMessage;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | null;
  tool_calls: Array<{
    tool_use_id: string;
    tool_name: string;
    args: Record<string, unknown>;
    result_text: string;
    is_error: boolean;
    duration_ms: number;
    /** Char count of result_text at write time. Materialized for cheap aggregations. */
    output_chars?: number;
    /** Size the LLM actually saw (post reduce+cap). NULL = not recorded. */
    output_chars_shaped?: number | null;
    /** 1 if the bridge clamped the output. Cheap "is this tool noisy?" signal. */
    truncated?: boolean;
    /** Phase detected by PhaseRouter (Camada 2). NULL until that lands. */
    phase?: string | null;
    /** FK to coder_turn_telemetry(id). Wires per-call metrics to the turn row. */
    turn_telemetry_id?: number | null;
    /** Harness refusal tag (dedup/failure-streak/timeout/…); NULL on a real call. */
    refusal_kind?: string | null;
    /** Nested (code_exec) rows only — parent block's tool_use id (mig 133). */
    parent_tool_use_id?: string | null;
    reduction_kind?: string | null;
    reduction_technique?: string | null;
    reduction_meta_json?: string | null;
    output_id?: string | null;
    run_id?: string | null;
    parent_run_id?: string | null;
    is_subagent?: boolean;
    subagent_profile?: string | null;
    logical_operation_id?: string | null;
    productive?: boolean | null;
    guard_action?: 'allow' | 'reuse' | 'warn' | 'block' | 'shadow' | null;
    guard_reason?: string | null;
    would_block?: boolean | null;
    state_epoch?: number | null;
    result_novel?: boolean | null;
    coverage_novel?: boolean | null;
    delivered?: boolean | null;
    repeat_policy?: 'stable' | 'volatile' | 'pollable' | 'mutating' | null;
    execution_class?: 'read' | 'write' | 'execute' | 'control' | null;
    guard_origin_tool_use_id?: string | null;
  }>;
  /**
   * Nested code_exec invocations. Audit rows ONLY — excluded from the paired
   * tool-role message synthesis (no matching tool_use block exists).
   */
  nested_tool_calls?: PersistAssistantTurnPayload['tool_calls'];
  subagent_usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  /**
   * In-flight-turn checkpoint reconciliation — mirrors
   * `PersistAssistantTurnInput.existing_message_id` in
   * store/messages.ts. When set, the assistant row already exists (written by
   * an `awaiting_input` checkpoint); reuse it instead of inserting a duplicate.
   */
  existing_message_id?: number;
}

export type DbWriteReq =
  | { kind: 'persistAssistantTurn'; payload: PersistAssistantTurnPayload };

export type DbWriteRes =
  | { kind: 'persistAssistantTurn'; messageId: number };

export interface DbWriterWorkerData {
  dbPath: string;
}
