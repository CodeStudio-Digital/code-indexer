/**
 * Worker -> main-process ceiling for one `rag_search_docs` call.
 *
 * A search can include remote query embedding plus an LLM rerank. The old
 * fixed 60s RPC timeout could therefore abandon a healthy main-thread search
 * before its provider returned. Keep a finite ceiling for genuinely stuck
 * requests, but make it configurable and long enough for slow providers.
 */
export const DEFAULT_DOC_SEARCH_TIMEOUT_MS = 5 * 60_000;
export const MIN_DOC_SEARCH_TIMEOUT_MS = 60_000;
export const MAX_DOC_SEARCH_TIMEOUT_MS = 30 * 60_000;

export function resolveDocSearchTimeoutMs(
  raw = process.env.MCP_DOC_SEARCH_TIMEOUT_MS,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_DOC_SEARCH_TIMEOUT_MS;
  const timeoutMs = Math.floor(parsed);
  if (timeoutMs < MIN_DOC_SEARCH_TIMEOUT_MS || timeoutMs > MAX_DOC_SEARCH_TIMEOUT_MS) {
    return DEFAULT_DOC_SEARCH_TIMEOUT_MS;
  }
  return timeoutMs;
}
