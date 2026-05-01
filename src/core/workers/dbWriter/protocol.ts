import type { AgentMessage } from '../../coder/core/messages.js';

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
