/**
 * PR-F pending-tokens tests.
 *
 * Pins the pre-emit projection:
 *   - message tokens grow with content size
 *   - tool_result batch tokens add on top
 *   - prefix tokens add on top
 *   - first-turn (≤1 message) never pre-empts (noisy estimate)
 *   - degenerate effective window → no compaction signal
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import {
  estimateMessagesTokens,
  estimateToolResultsTokens,
  estimatePendingPayload,
  shouldCompactPreEmit,
} from '../pending-tokens.js';

function userMsg(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function toolResultMsg(content: string): AgentMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool_result', tool_use_id: 'tu_x', content }],
  };
}

function imageMsg(base64: string): AgentMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'use o mcp vision para ver a imagem' },
      { type: 'image', mediaType: 'image/png', base64 },
    ],
  };
}

describe('estimateMessagesTokens', () => {
  it('returns near-zero for empty array', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it('grows linearly with content size', () => {
    const small = estimateMessagesTokens([userMsg('hi')]);
    const big = estimateMessagesTokens([userMsg('hi '.repeat(1000))]);
    expect(big).toBeGreaterThan(small * 10);
  });

  it('includes tool_result content size', () => {
    const justUser = estimateMessagesTokens([userMsg('q')]);
    const userPlusTool = estimateMessagesTokens([
      userMsg('q'),
      toolResultMsg('long tool output '.repeat(50)),
    ]);
    expect(userPlusTool).toBeGreaterThan(justUser);
  });

  it('costs an image by fixed per-tile overhead, NOT its base64 length', () => {
    // Regression: a ~1.6MB base64 image (the dashboard screenshot) used to be
    // counted as ~417K tokens via the JSON.stringify fallback, falsely tripping
    // the pre-emit gate into `compact_exhausted`. It must now cost a few
    // thousand tokens at most (image overhead + the short text block).
    const bigBase64 = 'A'.repeat(1_600_000);
    const t = estimateMessagesTokens([imageMsg(bigBase64)]);
    expect(t).toBeLessThan(5_000);
  });

  it('costs a base64-only document by the 0.3 heuristic, not raw length', () => {
    const base64 = 'A'.repeat(100_000);
    const t = estimateMessagesTokens([
      { role: 'user', content: [{ type: 'document', name: 'f.pdf', mediaType: 'application/pdf', base64 }] },
    ]);
    // 0.3 * 100K = ~30K tokens — far below the ~25K-token raw-length/4 count
    // would imply for arbitrary text, but specifically the base64 must not be
    // counted as plain text (which would be 25K) — it uses the PDF heuristic.
    expect(t).toBeGreaterThan(25_000);
    expect(t).toBeLessThan(40_000);
  });

  it('handles tool_use content blocks', () => {
    const withToolUse: AgentMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'src/a.ts' } },
      ],
    };
    const t = estimateMessagesTokens([withToolUse]);
    expect(t).toBeGreaterThan(0);
  });
});

describe('estimateToolResultsTokens', () => {
  it('returns 0 for empty batch', () => {
    expect(estimateToolResultsTokens([])).toBe(0);
  });

  it('grows with content length', () => {
    const small = estimateToolResultsTokens([{ content: 'x' }]);
    const big = estimateToolResultsTokens([{ content: 'x'.repeat(1000) }]);
    expect(big).toBeGreaterThan(small * 10);
  });

  it('JSON-stringifies non-string content', () => {
    const t = estimateToolResultsTokens([{ content: { a: 1, b: [1, 2, 3] } }]);
    expect(t).toBeGreaterThan(0);
  });
});

describe('estimatePendingPayload', () => {
  it('sums messages + toolResults + prefix', () => {
    const messages = [userMsg('hi')];
    const toolResults = [{ content: 'result-body' }];
    const just = estimatePendingPayload({ messages });
    const withTr = estimatePendingPayload({ messages, toolResults });
    const withPrefix = estimatePendingPayload({ messages, toolResults, prefixTokens: 100 });
    expect(withTr).toBeGreaterThan(just);
    expect(withPrefix).toBe(withTr + 100);
  });
});

describe('shouldCompactPreEmit', () => {
  const model = 'claude-sonnet-4-5';

  it('returns shouldCompact=false on first turn (messages ≤ 1)', () => {
    const d = shouldCompactPreEmit({
      messages: [userMsg('first')],
      prefixTokens: 10_000,
      model,
    });
    expect(d.shouldCompact).toBe(false);
    expect(d.projectedTokens).toBe(0);
  });

  it('returns shouldCompact=true when projection >= 90% of effective', () => {
    // Build a message big enough to exceed 90% of the model's effective.
    const bigText = 'x'.repeat(800_000); // ~200K tokens (chars/4)
    const messages = [userMsg('seed'), userMsg(bigText)];
    const d = shouldCompactPreEmit({ messages, model });
    expect(d.shouldCompact).toBe(true);
    expect(d.ratio).toBeGreaterThanOrEqual(0.9);
  });

  it('does NOT pre-empt for a huge-base64 image (the compact_exhausted bug)', () => {
    // 200K-window model; a single attached image must keep the ratio tiny.
    const bigBase64 = 'A'.repeat(1_600_000);
    const messages = [userMsg('seed'), imageMsg(bigBase64)];
    const d = shouldCompactPreEmit({ messages, model });
    expect(d.shouldCompact).toBe(false);
    expect(d.ratio).toBeLessThan(0.1);
  });

  it('returns shouldCompact=false when well under cap', () => {
    const messages = [userMsg('seed'), userMsg('short reply')];
    const d = shouldCompactPreEmit({ messages, model });
    expect(d.shouldCompact).toBe(false);
  });

  it('respects custom triggerRatio override', () => {
    const messages = [userMsg('seed'), userMsg('x'.repeat(1000))];
    const lax = shouldCompactPreEmit({ messages, model, triggerRatio: 0.99 });
    const strict = shouldCompactPreEmit({ messages, model, triggerRatio: 0.0001 });
    expect(strict.shouldCompact).toBe(true);
    expect(lax.shouldCompact).toBe(false);
  });

  it('accounts for the pending tool_results batch (matters when batch is big)', () => {
    const messages = [userMsg('seed'), userMsg('q')];
    const smallTr = shouldCompactPreEmit({ messages, model, toolResults: [{ content: 'tiny' }] });
    const bigTr = shouldCompactPreEmit({
      messages, model,
      toolResults: [{ content: 'x'.repeat(800_000) }],
    });
    expect(bigTr.projectedTokens).toBeGreaterThan(smallTr.projectedTokens);
  });
});
