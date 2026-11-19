import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const slots = new Map<string, number>();
function accountKey(endpoint: string, model: string, apiKey = ''): string | null {
  try {
    const url = new URL(endpoint);
    if (url.hostname !== 'openrouter.ai' || !model.endsWith(':free')) return null;
    return createHash('sha256').update(`${url.origin}\0${apiKey}`).digest('hex');
  } catch { return null; }
}

/** Shared by free embeddings and reranking in the semantic worker. Reserve
 * below the observed 20 rpm tier; short cancellable waits never block the UI. */
export async function waitForFreeModelSlot(endpoint: string, model: string, apiKey?: string, signal?: AbortSignal): Promise<void> {
  const key = accountKey(endpoint, model, apiKey);
  if (!key) return;
  signal?.throwIfAborted();
  const now = Date.now();
  // Expired entries are cheap to discard and never retain credentials.
  for (const [entry, time] of slots) if (time < now - 60_000) slots.delete(entry);
  const slot = Math.max(now, slots.get(key) ?? 0);
  const wait = slot - now;
  if (wait > 15_000) throw new Error(`429 semantic provider cooling down; Retry-After: ${Math.ceil(wait / 1000)}`);
  slots.set(key, slot + 3_500);
  if (wait) await delay(wait, undefined, { signal });
}

/** Preserve retry guidance without exposing provider request bodies. */
export function noteFreeModelRateLimit(endpoint: string, model: string, apiKey: string | undefined, response: Response, body: string): string {
  if (response.status !== 429) return '';
  const now = Date.now();
  let seconds = Number(response.headers.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds <= 0) seconds = 60;
  try {
    const headers = JSON.parse(body)?.error?.metadata?.headers;
    const reset = Number(headers?.['X-RateLimit-Reset']);
    if (Number.isFinite(reset) && reset > now) seconds = Math.max(seconds, Math.ceil((reset - now) / 1000));
  } catch { /* generic rate limit still gets a cooldown */ }
  seconds = Math.min(86_400, Math.max(1, seconds));
  const key = accountKey(endpoint, model, apiKey);
  if (key) slots.set(key, Math.max(slots.get(key) ?? 0, now + seconds * 1000));
  return ` Retry-After: ${seconds}`;
}
