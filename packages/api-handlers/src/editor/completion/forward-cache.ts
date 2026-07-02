/**
 * Prefix-forward cache (Continue's AutocompleteLruCache semantics): when the
 * user types FORWARD through a completion we already returned, serve the
 * remainder without a provider call. Key is (project,file,line); the match
 * anchors the stored prefix tail against the new prefix tail, so any edit
 * that rewrites earlier text misses naturally.
 */
import { TtlLru } from '../completion-context.js';

const TAIL_CHARS = 400;
const TTL_MS = 30_000;

interface ForwardEntry {
  prefixTail: string;
  text: string;
  requestId: string;
}

// Module-level (Electron dual-factory).
const cache = new TtlLru<ForwardEntry>(64, TTL_MS);

const key = (projectId: number, file: string, line: number) => `${projectId}:${file}:${line}`;

export function rememberCompletion(
  projectId: number, file: string, line: number, prefix: string, text: string, requestId: string,
): void {
  cache.set(key(projectId, file, line), { prefixTail: prefix.slice(-TAIL_CHARS), text, requestId });
}

/**
 * Serve the remainder when the new prefix extends the stored one AND the
 * typed extension matches the stored completion's head. `typed.length === 0`
 * (same position re-request) is left to the exact result cache.
 */
export function forwardMatch(
  projectId: number, file: string, line: number, prefix: string,
): { text: string; requestId: string } | null {
  const hit = cache.get(key(projectId, file, line));
  if (!hit || !hit.prefixTail) return null;
  const newTail = prefix.slice(-(TAIL_CHARS + hit.text.length));
  const idx = newTail.lastIndexOf(hit.prefixTail);
  if (idx < 0) return null;
  const typed = newTail.slice(idx + hit.prefixTail.length);
  if (typed.length === 0 || typed.length >= hit.text.length) return null;
  if (!hit.text.startsWith(typed)) return null;
  return { text: hit.text.slice(typed.length), requestId: hit.requestId };
}

/** Test hook. */
export function __resetForwardCacheForTests(): void {
  cache.clear();
}
