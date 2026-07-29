import {
  asAgentRunId,
  asSessionId,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import {
  FsSessionEntityFiles,
  type FsEntityEnvelope,
} from './entity-files.js';
import type {
  FsProviderAttemptRow,
  FsRecordProviderAttemptInput,
} from './history-metrics-types.js';

interface ProviderAttemptData {
  run_id: string;
  turn: number;
  attempt: number;
  provider: string | null;
  model: string | null;
  status: number | null;
  ok: boolean;
  generation_id: string | null;
  request_id: string | null;
  upstream_provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost_usd: number | null;
  retry_after: string | null;
  error_code: string | null;
  error_message: string | null;
  duration_ms: number;
  metadata: Readonly<Record<string, JsonValue>>;
}

function row(
  sessionId: SessionId,
  envelope: FsEntityEnvelope<JsonValue>,
): FsProviderAttemptRow {
  const data = envelope.data as unknown as ProviderAttemptData;
  return {
    id: envelope.id,
    seq: envelope.seq,
    session_id: sessionId,
    run_id: asAgentRunId(data.run_id),
    turn: data.turn,
    attempt: data.attempt,
    provider: data.provider,
    model: data.model,
    status: data.status,
    ok: data.ok,
    generation_id: data.generation_id,
    request_id: data.request_id,
    upstream_provider: data.upstream_provider,
    input_tokens: data.input_tokens,
    output_tokens: data.output_tokens,
    cached_tokens: data.cached_tokens,
    cost_usd: data.cost_usd,
    retry_after: data.retry_after,
    error_code: data.error_code,
    error_message: data.error_message,
    duration_ms: data.duration_ms,
    created_at: envelope.created_at,
    metadata: data.metadata,
  };
}

function nullableFinite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

/**
 * One immutable JSON file per physical provider attempt. Replays with the same
 * run/attempt and payload return the existing UUID; a conflicting replay is
 * rejected by the shared operation-id guard instead of mutating telemetry.
 */
export class FsProviderAttemptRepository {
  constructor(private readonly entities: FsSessionEntityFiles) {}

  async record(
    input: FsRecordProviderAttemptInput,
  ): Promise<string | null> {
    if (input.session_id == null) return null;
    try {
      const runId = asAgentRunId(input.run_id);
      if (!Number.isSafeInteger(input.turn) || input.turn < 0) {
        throw new RangeError(`invalid provider attempt turn ${input.turn}`);
      }
      if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
        throw new RangeError(
          `invalid provider attempt ordinal ${input.attempt}`,
        );
      }
      const data: ProviderAttemptData = {
        run_id: runId,
        turn: input.turn,
        attempt: input.attempt,
        provider: input.provider,
        model: input.model,
        status: nullableFinite(input.status),
        ok: input.ok,
        generation_id: input.generation_id ?? null,
        request_id: input.request_id ?? null,
        upstream_provider: input.upstream_provider ?? null,
        input_tokens: nullableFinite(input.input_tokens),
        output_tokens: nullableFinite(input.output_tokens),
        cached_tokens: nullableFinite(input.cached_tokens),
        cost_usd: nullableFinite(input.cost_usd),
        retry_after: input.retry_after ?? null,
        error_code: input.error_code ?? null,
        error_message: input.error_message?.slice(0, 1_000) ?? null,
        duration_ms: Math.max(0, Math.round(input.duration_ms)),
        metadata: {},
      };
      const saved = await this.entities.create(
        input.session_id,
        'metrics/provider_attempts',
        {
          kind: 'provider_attempt',
          data,
          operation_id:
            input.operation_id ??
            `provider-attempt:${runId}:${input.attempt}`,
          operation_key: {
            action: 'record_provider_attempt',
            ...data,
          },
        },
      );
      return saved.id;
    } catch (error) {
      console.warn(
        `[coder] recordProviderAttempt failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async list(
    sessionId: SessionId | string,
    limit = 500,
  ): Promise<FsProviderAttemptRow[]> {
    const capped = Math.max(1, Math.min(5_000, Math.trunc(limit)));
    return (
      await this.entities.list<JsonValue>(
        sessionId,
        'metrics/provider_attempts',
        'provider_attempt',
      )
    )
      .slice(0, capped)
      .map((item) => row(asSessionId(String(sessionId)), item));
  }
}
