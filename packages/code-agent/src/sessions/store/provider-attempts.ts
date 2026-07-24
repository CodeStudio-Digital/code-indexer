import type { Database as DB } from 'better-sqlite3';

export interface RecordProviderAttemptInput {
  session_id: number | null;
  run_id: string;
  turn: number;
  attempt: number;
  provider: string | null;
  model: string | null;
  status: number | null;
  ok: boolean;
  generation_id?: string | null;
  request_id?: string | null;
  upstream_provider?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_tokens?: number | null;
  cost_usd?: number | null;
  retry_after?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  duration_ms: number;
}

/**
 * Best-effort upsert keyed by the run-wide physical-attempt ordinal.
 * Telemetry failures are logged and swallowed; inference must continue.
 */
export function record(db: DB, input: RecordProviderAttemptInput): number | null {
  try {
    const result = db.prepare(`
      INSERT INTO coder_provider_attempts (
        session_id, project_id, run_id, turn, attempt, provider, model,
        status, ok, generation_id, request_id, upstream_provider,
        input_tokens, output_tokens, cached_tokens, cost_usd,
        retry_after, error_code, error_message, duration_ms
      ) VALUES (
        ?, (SELECT project_id FROM coder_sessions WHERE id = ?), ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(run_id, attempt) DO UPDATE SET
        status = excluded.status,
        ok = excluded.ok,
        generation_id = excluded.generation_id,
        request_id = excluded.request_id,
        upstream_provider = excluded.upstream_provider,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cached_tokens = excluded.cached_tokens,
        cost_usd = excluded.cost_usd,
        retry_after = excluded.retry_after,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        duration_ms = excluded.duration_ms
    `).run(
      input.session_id,
      input.session_id,
      input.run_id,
      input.turn,
      input.attempt,
      input.provider,
      input.model,
      input.status,
      input.ok ? 1 : 0,
      input.generation_id ?? null,
      input.request_id ?? null,
      input.upstream_provider ?? null,
      input.input_tokens ?? null,
      input.output_tokens ?? null,
      input.cached_tokens ?? null,
      input.cost_usd ?? null,
      input.retry_after ?? null,
      input.error_code ?? null,
      input.error_message?.slice(0, 1_000) ?? null,
      Math.max(0, Math.round(input.duration_ms)),
    );
    if (result.lastInsertRowid) return Number(result.lastInsertRowid);
    const row = db.prepare(
      'SELECT id FROM coder_provider_attempts WHERE run_id = ? AND attempt = ?',
    ).get(input.run_id, input.attempt) as { id: number } | undefined;
    return row?.id ?? null;
  } catch (error) {
    console.warn(
      `[coder] recordProviderAttempt failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export function list(db: DB, sessionId: number, limit = 500): Array<Record<string, unknown>> {
  try {
    return db.prepare(`
      SELECT *
      FROM coder_provider_attempts
      WHERE session_id = ?
      ORDER BY id ASC
      LIMIT ?
    `).all(sessionId, Math.max(1, Math.min(5_000, limit))) as Array<Record<string, unknown>>;
  } catch {
    // Pre-migration/read-only compatibility during a rolling restart.
    return [];
  }
}
