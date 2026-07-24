/**
 * Hybrid token accounting for context-window-aware compaction.
 *
 * Background — why hybrid:
 *   The naive "char total / 4" estimate breaks for two reasons:
 *     1. JSON-heavy tool outputs are denser (~2 chars/token), so we
 *        underestimate by ~2× when the conversation is mostly tool I/O.
 *     2. Models report `input_tokens` exactly in the API response — that
 *        number is authoritative and free.
 *
 *   Codex (Rust), Kimi-CLI (Python), and Claude Code (TS) all converge on
 *   the same hybrid pattern: trust API usage for the prefix that has
 *   already been sent, estimate only the tail appended since the last
 *   confirmed measurement. This module implements that pattern.
 *
 * Wire-up:
 *   - After every provider call that returns `usage.input_tokens`, the
 *     runner stores it as `confirmed`.
 *   - When deciding whether to compact, the runner calls
 *     `computeSnapshot(messages, lastUsage)` which:
 *       a) finds the index of the assistant message that produced
 *          `lastUsage`,
 *       b) returns `confirmed = lastUsage.input_tokens`,
 *       c) estimates only the messages appended after that point.
 *   - `total = confirmed + pendingEstimate` is what gets compared to the
 *     model's effective context window.
 *
 * Determinism: `estimateBlockTokens` and `estimateMessageTokens` are pure
 * functions of their inputs — same prefix → same estimate, so prompt-cache
 * stability is unaffected by this code.
 */

import type { AgentMessage, ContentBlock } from '@mcp/code-agent/core/messages.js';

/** Default heuristic: 4 chars per token for plain text. */
const DEFAULT_CHARS_PER_TOKEN = 4;
/** JSON / code / dense punctuation — 2 chars per token. */
const DENSE_CHARS_PER_TOKEN = 2;
/** Per-block constant overhead (role markers, JSON braces, etc.). */
const PER_BLOCK_OVERHEAD_TOKENS = 8;

/** Heuristic: text with >25% JSON-ish punctuation is treated as dense. */
function isDenseText(text: string): boolean {
  if (text.length < 40) return false;
  let dense = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // { } [ ] : , " punctuation density
    if (c === 0x7b || c === 0x7d || c === 0x5b || c === 0x5d || c === 0x3a || c === 0x2c || c === 0x22) {
      dense++;
    }
  }
  return dense * 4 >= text.length; // ≥25%
}

function estimateText(text: string): number {
  if (!text) return 0;
  const cpt = isDenseText(text) ? DENSE_CHARS_PER_TOKEN : DEFAULT_CHARS_PER_TOKEN;
  return Math.ceil(text.length / cpt);
}

/**
 * Estimate the token cost of a single content block. Pure function — no I/O,
 * no provider calls. Adds a small per-block overhead for role/structure
 * tokens that the model also counts.
 */
export function estimateBlockTokens(block: ContentBlock): number {
  let n = PER_BLOCK_OVERHEAD_TOKENS;
  switch (block.type) {
    case 'text':
      n += estimateText((block as { text?: string }).text ?? '');
      return n;
    case 'tool_use': {
      const name = (block as { name?: string }).name ?? '';
      const input = (block as { input?: unknown }).input;
      n += estimateText(name);
      try {
        n += estimateText(JSON.stringify(input ?? {}));
      } catch {
        // unserialisable input — fall back to a conservative 200-token bound.
        n += 200;
      }
      return n;
    }
    case 'tool_result': {
      const content = (block as { content?: string }).content ?? '';
      n += estimateText(typeof content === 'string' ? content : JSON.stringify(content));
      return n;
    }
    case 'image':
      // Most providers bill images by tile/area, not by pixels in the base64.
      // We log a fixed conservative overhead (~1000 tokens for a typical
      // image tile) until we wire per-provider sizers.
      return n + 1000;
    case 'document': {
      const text = (block as { text?: string }).text ?? '';
      const path = (block as { path?: string }).path ?? '';
      const base64 = (block as { base64?: string }).base64 ?? '';
      if (text) return n + estimateText(text);
      if (path) return n + estimateText(path) + 40;
      // Assume PDFs ≈ 0.3 tokens per base64 byte (Anthropic average).
      return n + Math.ceil(base64.length * 0.3);
    }
    default:
      return n;
  }
}

export function estimateMessageTokens(message: AgentMessage): number {
  let n = 0;
  for (const block of message.content) {
    n += estimateBlockTokens(block);
  }
  return n;
}

/** Sum of estimated tokens across all messages. Local heuristic only. */
export function estimateTotalTokens(messages: AgentMessage[]): number {
  let n = 0;
  for (const m of messages) n += estimateMessageTokens(m);
  return n;
}

export type TokenSource = 'api' | 'estimate' | 'mixed';

export interface TokenSnapshot {
  /** Authoritative `input_tokens` from the most recent provider response. */
  confirmed: number;
  /** Local estimate of messages appended *after* the confirmed measurement. */
  pendingEstimate: number;
  /** confirmed + pendingEstimate. The number to compare against the window. */
  total: number;
  /** Where the value came from. 'api' = no pending tail, 'estimate' = no API
   *  usage yet, 'mixed' = both signals contributed. */
  source: TokenSource;
  /** Number of messages whose tokens were estimated locally. */
  estimatedMessages: number;
}

export interface UsageInput {
  /** input_tokens from the provider's usage object on the last response. */
  input_tokens: number;
  /**
   * Number of messages that existed at the moment this usage was reported.
   * Used to identify which messages are "pre-confirmed" vs appended since.
   * The runner captures this when it stores `lastKnownInputTokens`.
   */
  messageCountAtTime: number;
}

/**
 * Compute the token snapshot for a message list.
 *
 * If `lastUsage` is provided AND `messageCountAtTime` is ≤ messages.length,
 * we trust the API number for the first `messageCountAtTime` messages and
 * estimate only the tail. Otherwise we fall back to a pure local estimate.
 */
export function computeSnapshot(
  messages: AgentMessage[],
  lastUsage: UsageInput | null | undefined,
): TokenSnapshot {
  if (lastUsage && lastUsage.messageCountAtTime <= messages.length) {
    const confirmed = Math.max(0, lastUsage.input_tokens);
    const tail = messages.slice(lastUsage.messageCountAtTime);
    let pending = 0;
    for (const m of tail) pending += estimateMessageTokens(m);
    return {
      confirmed,
      pendingEstimate: pending,
      total: confirmed + pending,
      source: pending === 0 ? 'api' : 'mixed',
      estimatedMessages: tail.length,
    };
  }

  // No usage signal — pure estimate.
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return {
    confirmed: 0,
    pendingEstimate: total,
    total,
    source: 'estimate',
    estimatedMessages: messages.length,
  };
}

/** Test hook: expose helpers used by the unit tests. */
export const __internal = {
  isDenseText,
  estimateText,
  DEFAULT_CHARS_PER_TOKEN,
  DENSE_CHARS_PER_TOKEN,
  PER_BLOCK_OVERHEAD_TOKENS,
};
