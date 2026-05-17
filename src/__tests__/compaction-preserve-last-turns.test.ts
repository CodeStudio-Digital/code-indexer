/**
 * PR-3 (R4) — preserve last N user turns raw through compaction.
 * Tests `recedeToPreserveLastNTurns` in isolation + interaction with
 * `snapCutoffPreservingPairs` so the combined cutoff behaves correctly.
 */
import { describe, it, expect } from 'vitest';
import {
  recedeToPreserveLastNTurns,
  snapCutoffPreservingPairs,
} from '@mcp/code-agent/core/compaction.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}
function assistant(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}
function assistantWithToolUse(id: string, name: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] };
}
function toolResult(id: string, text: string): AgentMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool_result', tool_use_id: id, content: text }],
  };
}

describe('recedeToPreserveLastNTurns', () => {
  it('returns the input cutoff when N=0', () => {
    const msgs = [user('a'), assistant('A'), user('b'), assistant('B')];
    expect(recedeToPreserveLastNTurns(msgs, 2, 0)).toBe(2);
  });

  it('returns input cutoff when tail already has >= N user messages', () => {
    const msgs = [user('a'), assistant('A'), user('b'), assistant('B'), user('c'), assistant('C')];
    // cutoff=2 keeps user b, user c in tail (2 user messages) → no change for N=2.
    expect(recedeToPreserveLastNTurns(msgs, 2, 2)).toBe(2);
  });

  it('recedes to include the Nth-from-tail user message', () => {
    const msgs = [
      user('a'),       // 0
      assistant('A'),  // 1
      user('b'),       // 2
      assistant('B'),  // 3
      user('c'),       // 4
      assistant('C'),  // 5
    ];
    // cutoff=4 keeps only user('c') in tail (1 user msg). N=2 → recede to
    // include user('b') at index 2.
    expect(recedeToPreserveLastNTurns(msgs, 4, 2)).toBe(2);
  });

  it('returns 0 when fewer than N user messages exist in the entire history', () => {
    const msgs = [user('a'), assistant('A'), assistant('B')];
    expect(recedeToPreserveLastNTurns(msgs, 2, 5)).toBe(0);
  });

  it('returns the input cutoff when cutoff is already 0 or beyond messages.length', () => {
    const msgs = [user('a'), assistant('A')];
    expect(recedeToPreserveLastNTurns(msgs, 0, 2)).toBe(0);
    expect(recedeToPreserveLastNTurns(msgs, 99, 2)).toBe(99);
  });

  it('counts only role=user (not assistant or tool)', () => {
    const msgs = [
      user('a'),                       // 0
      assistantWithToolUse('t1', 'r'), // 1
      toolResult('t1', 'ok'),          // 2 — role=tool, not user
      assistant('A'),                  // 3
      user('b'),                       // 4
      assistant('B'),                  // 5
    ];
    // cutoff=4 keeps only user('b'). N=2 should recede to user('a') at 0.
    expect(recedeToPreserveLastNTurns(msgs, 4, 2)).toBe(0);
  });
});

describe('R4 + R5 interaction (recede + pair-preserve)', () => {
  it('recede then snap pairs keeps tool_use/tool_result groups intact', () => {
    // Layout:
    //   0 user('a')
    //   1 assistant tool_use t1
    //   2 tool_result t1
    //   3 user('b')
    //   4 assistant tool_use t2
    //   5 tool_result t2
    //   6 user('c')
    //   7 assistant final
    const msgs = [
      user('a'),
      assistantWithToolUse('t1', 'r1'),
      toolResult('t1', 'r1 result'),
      user('b'),
      assistantWithToolUse('t2', 'r2'),
      toolResult('t2', 'r2 result'),
      user('c'),
      assistant('final'),
    ];
    // Suppose computeCutoffIndex returned 6 (only tail = user c + assistant
    // final). With N=2 we should recede to include user b at index 3.
    // Then snap pairs should leave it alone (no pair is split).
    const receded = recedeToPreserveLastNTurns(msgs, 6, 2);
    expect(receded).toBe(3);
    const final = snapCutoffPreservingPairs(msgs, receded);
    expect(final).toBe(3);
  });

  it('snap pairs may recede further if cutoff lands inside a pair', () => {
    const msgs = [
      user('a'),                       // 0
      assistant('A'),                  // 1
      assistantWithToolUse('t1', 'r'), // 2
      toolResult('t1', 'ok'),          // 3
      user('b'),                       // 4
      assistant('B'),                  // 5
    ];
    // computeCutoffIndex=3 would split the pair (use=2, result=3). After
    // recede to preserve user('a') (already in head) the cutoff is still 3
    // for N=1 (user('b') alone in tail). snap pairs recedes to 2 to keep
    // both halves of the pair on the same side.
    const receded = recedeToPreserveLastNTurns(msgs, 3, 1);
    const final = snapCutoffPreservingPairs(msgs, receded);
    expect(final).toBeLessThanOrEqual(2);
  });
});
