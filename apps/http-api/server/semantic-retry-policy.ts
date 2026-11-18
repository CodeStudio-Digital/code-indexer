/** Durable circuit breaker for background inference. Manual reindex bypasses it. */
interface SemanticRetryState {
  attempt: number;
  not_before_ms: number;
  blocked: boolean;
}

export class SemanticRetryDeferredError extends Error {
  constructor(readonly retryAt: number) {
    super(Number.isFinite(retryAt)
      ? 'Semantic inference is cooling down after a failure'
      : 'Semantic inference paused after repeated failures; retry manually after repairing the provider/runtime');
  }
}

export function nextSemanticRetry(error: unknown, previousAttempt = 0, now = Date.now()): SemanticRetryState {
  const message = error instanceof Error ? error.message : String(error);
  const attempt = Math.max(0, previousAttempt) + 1;
  const permanent = /NODE_MODULE_VERSION|cannot find module|could not find.*module|módulo especificado|unauthorized|invalid.api.key|\b401\b|\b403\b/i.test(message);
  const busy = /SQLITE_BUSY|database is locked/i.test(message);
  const rateLimited = /\b429\b|rate.limit|quota/i.test(message);
  const retryAfter = /retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)/i.exec(message);
  const base = busy ? 100 : rateLimited ? 60_000 : 10_000;
  const ceiling = busy ? 5_000 : 15 * 60_000;
  const delay = Math.max(Math.min(ceiling, base * 2 ** Math.min(attempt - 1, 10)),
    retryAfter ? Math.min(86_400_000, Number(retryAfter[1]) * 1_000) : 0);
  // A quota window is temporary even after many requests. Keep a bounded
  // cooldown; only permanent/unknown repeated failures require manual repair.
  return { attempt, not_before_ms: now + delay, blocked: permanent || (!busy && !rateLimited && attempt >= 8) };
}
