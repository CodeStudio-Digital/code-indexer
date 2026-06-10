/**
 * Unit tests for `recedeToPreserveLastNTurns` — focused on the `maxTailTokens`
 * clamp that stops a single long user turn from defeating compaction.
 *
 * Sizes are derived from the real `estimateMessageTokens` so the assertions
 * hold regardless of the tokenizer's exact constant.
 */
import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { estimateMessageTokens } from '@mcp/code-agent/core/token-accounting.js';
import { recedeToPreserveLastNTurns } from '../cutoff.js';

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}
function assistant(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}
function tailTokens(messages: AgentMessage[], from: number): number {
  let t = 0;
  for (let i = from; i < messages.length; i++) t += estimateMessageTokens(messages[i]);
  return t;
}

describe('recedeToPreserveLastNTurns', () => {
  it('returns 0 for a single-user-turn history WITHOUT a budget (the legacy no-op cause)', () => {
    // One user message + many tool/assistant turns → < N(=2) user messages.
    const msgs: AgentMessage[] = [user('the big task')];
    for (let i = 0; i < 12; i++) msgs.push(assistant(`work step ${i}`));
    // recede nukes a perfectly good token cutoff to 0 → caller no-ops.
    expect(recedeToPreserveLastNTurns(msgs, 9, 2)).toBe(0);
  });

  it('returns a positive, budget-bounded cutoff for a single long turn WITH a budget', () => {
    const msgs: AgentMessage[] = [user('the big task')];
    for (let i = 0; i < 12; i++) msgs.push(assistant(`work step ${i} ${'x'.repeat(40)}`));
    const cutoff = 9;
    const budget = tailTokens(msgs, cutoff) + estimateMessageTokens(msgs[8]) * 2;
    const r = recedeToPreserveLastNTurns(msgs, cutoff, 2, budget);
    // The fix: a compactable head ALWAYS remains (never 0)...
    expect(r).toBeGreaterThan(0);
    // ...and the preserved tail never exceeds the ceiling.
    expect(tailTokens(msgs, r)).toBeLessThanOrEqual(budget);
  });

  it('preserves the last N user turns when they fit the budget (multi-turn unchanged)', () => {
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 6; i++) { msgs.push(user(`u${i}`)); msgs.push(assistant(`a${i}`)); }
    // cutoff=11 (tail = just a5). Receding to keep 2 user turns lands on u4
    // (index 8) — identically with no budget or a generous one.
    expect(recedeToPreserveLastNTurns(msgs, 11, 2)).toBe(8);
    expect(recedeToPreserveLastNTurns(msgs, 11, 2, 1_000_000)).toBe(8);
  });

  it('is a no-op for the guard cases (n<=0 / cutoff<=0 / cutoff>=len)', () => {
    const msgs = [user('a'), assistant('b')];
    expect(recedeToPreserveLastNTurns(msgs, 1, 0, 100)).toBe(1);
    expect(recedeToPreserveLastNTurns(msgs, 0, 2, 100)).toBe(0);
    expect(recedeToPreserveLastNTurns(msgs, 2, 2, 100)).toBe(2);
  });
});
