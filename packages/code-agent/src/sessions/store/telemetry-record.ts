import type { Database as DB } from 'better-sqlite3';
import type { ChatProviderResponseMeta } from '@mcp/code-agent/core/messages.js';

export interface RecordTurnTelemetryInput {
  session_id: number | null;
  run_id: string;
  turn: number;
  is_subagent: boolean;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  thinking_tokens: number | null;
  history_chars: number | null;
  tool_count: number;
  tools_called: string[];
  largest_tool_result_chars: number | null;
  compaction_triggered: boolean;
  summarizer_ran: boolean;
  paginate_count: number;
  /** System prompt size in chars on this turn. Migration 072. */
  system_prompt_chars?: number | null;
  /** Tools array (JSON-stringified) size in chars on this turn. Migration 072. */
  tools_def_chars?: number | null;
  /** USD cost computed from pricing table. Migration 072. */
  estimated_cost_usd?: number | null;
  /** Sanitized provider request/response metadata. Migration 093. */
  response_meta?: ChatProviderResponseMeta | null;
}

/**
 * Per-turn telemetry insert (migration 069). One row per (run_id, turn).
 * Best-effort: failures are swallowed because telemetry must never break a
 * real turn.
 */
export function record(db: DB, input: RecordTurnTelemetryInput): number | null {
  try {
    const meta = input.response_meta ?? null;
    const request = meta?.request;
    const response = meta?.response;
    const requestBetasJson = request?.betas && request.betas.length > 0
      ? JSON.stringify(request.betas)
      : null;
    const responseRateLimitsJson =
      response?.rate_limits && Object.keys(response.rate_limits).length > 0
        ? JSON.stringify(response.rate_limits)
        : null;
    const r = db
      .prepare(
        `INSERT INTO coder_turn_telemetry (
          session_id, run_id, turn, is_subagent,
          provider, model,
          input_tokens, output_tokens,
          cache_read_input_tokens, cache_creation_input_tokens, thinking_tokens,
          history_chars, tool_count, tools_called_json,
          largest_tool_result_chars, compaction_triggered, summarizer_ran, paginate_count,
          system_prompt_chars, tools_def_chars, estimated_cost_usd,
          request_api_model, request_requested_model, request_display_model,
          request_max_tokens, request_stream, request_betas_json,
          request_thinking_type, request_effort,
          response_status, response_ok, response_request_id,
          response_retry_after, response_x_should_retry,
          response_rate_limits_json, response_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.session_id, input.run_id, input.turn, input.is_subagent ? 1 : 0,
        input.provider, input.model,
        input.input_tokens, input.output_tokens,
        input.cache_read_input_tokens, input.cache_creation_input_tokens, input.thinking_tokens,
        input.history_chars, input.tool_count, JSON.stringify(input.tools_called),
        input.largest_tool_result_chars,
        input.compaction_triggered ? 1 : 0,
        input.summarizer_ran ? 1 : 0,
        input.paginate_count,
        input.system_prompt_chars ?? null,
        input.tools_def_chars ?? null,
        input.estimated_cost_usd ?? null,
        request?.api_model ?? null,
        request?.requested_model ?? null,
        request?.display_model ?? null,
        request?.max_tokens ?? null,
        request?.stream == null ? null : request.stream ? 1 : 0,
        requestBetasJson,
        request?.thinking_type ?? null,
        request?.effort ?? null,
        response?.status ?? null,
        response?.ok == null ? null : response.ok ? 1 : 0,
        response?.request_id ?? null,
        response?.retry_after ?? null,
        response?.x_should_retry ?? null,
        responseRateLimitsJson,
        meta?.path ?? null,
      );
    return Number(r.lastInsertRowid);
  } catch (e) {
    // Telemetry must never break a turn — surface as warn and move on.
    console.warn(`[coder] recordTurnTelemetry failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
