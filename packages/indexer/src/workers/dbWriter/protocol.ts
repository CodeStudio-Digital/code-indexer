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
    /** 1 if the bridge clamped the output. Cheap "is this tool noisy?" signal. */
    truncated?: boolean;
    /** Phase detected by PhaseRouter (Camada 2). NULL until that lands. */
    phase?: string | null;
    /** FK to coder_turn_telemetry(id). Wires per-call metrics to the turn row. */
    turn_telemetry_id?: number | null;
  }>;
  subagent_usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export type DbWriteReq =
  | { kind: 'persistAssistantTurn'; payload: PersistAssistantTurnPayload };

export type DbWriteRes =
  | { kind: 'persistAssistantTurn'; messageId: number };

export interface DbWriterWorkerData {
  dbPath: string;
}
