/**
 * Prompt-cache head fingerprint (migration 143).
 *
 * Providers cache the request prefix as tools → system → messages; a byte
 * change in an EARLY message invalidates everything after it. This hash
 * samples the first messages of the assembled history so the telemetry can
 * tell "an old message mutated in place" (rolling reducer retirement,
 * compaction splice) apart from "toolset changed" (tools_fingerprint) and
 * "provider TTL eviction" (neither changed).
 *
 * Sampling the head only is deliberate: tail growth (normal turn appends)
 * must NOT change the hash, or every turn would look like a mutation.
 */
import { createHash } from 'node:crypto';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';

const HEAD_MESSAGES = 3;
const HEAD_SAMPLE_CHARS = 2048;

/** Stable SHA-1 over the first messages of the LLM view. Never throws. */
export function computePrefixHeadHash(messages: ReadonlyArray<AgentMessage>): string | null {
  if (messages.length === 0) return null;
  try {
    const sample = JSON.stringify(messages.slice(0, HEAD_MESSAGES)).slice(0, HEAD_SAMPLE_CHARS);
    return createHash('sha1').update(sample).digest('hex');
  } catch {
    return null;
  }
}
