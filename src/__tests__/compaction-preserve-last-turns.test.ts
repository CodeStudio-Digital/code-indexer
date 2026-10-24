/**
 * PR-3 (R4) — preserve last N user turns raw through compaction.
 * Tests `recedeToPreserveLastNTurns` in isolation + interaction with
 * `snapCutoffPreservingPairs` so the combined cutoff behaves correctly.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  recedeToPreserveLastNTurns,
  snapCutoffPreservingPairs,
} from '@mcp/code-agent/core/compaction.js';
import { compactWithLLM } from '@mcp/code-agent/core/runner/compaction/llm-compactor.js';
import { estimateMessageTokens } from '@mcp/code-agent/core/token-accounting.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { AgentMessage } from "@mcp/provider-sdk";

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
function renderableCount(messages: AgentMessage[]): number {
  return messages.reduce((acc, m) => acc + (m.role !== 'tool' ? 1 : 0), 0);
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

describe('message-count floor — compactWithLLM keeps recent turns on a dense, user-turn-free tail', () => {
  const ENV_KEYS = [
    'CODER_COMPACT_PRESERVE_LAST_N_TURNS',
    'CODER_COMPACT_MIN_TAIL_TURNS',
    'CODER_COMPACT_MIN_TAIL_FRACTION',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('an autonomous run (1 user turn, dense tool results) still retains >= floor renderable turns', async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    // Isolate the floor: disable the user-turn recede (only 1 user turn exists
    // anyway) and pin the floor to exactly 8 renderable turns.
    process.env.CODER_COMPACT_PRESERVE_LAST_N_TURNS = '0';
    process.env.CODER_COMPACT_MIN_TAIL_TURNS = '8';
    process.env.CODER_COMPACT_MIN_TAIL_FRACTION = '0';

    // 1 user request, then 20 autonomous (assistant tool_use → big tool_result)
    // turns — no further user messages. The token cutoff alone would keep only a
    // couple of these dense turns.
    const msgs: AgentMessage[] = [user('build the feature')];
    for (let i = 0; i < 20; i++) {
      msgs.push(assistantWithToolUse(`id${i}`, 'read_file'));
      msgs.push(toolResult(`id${i}`, `contents of f${i} `.repeat(120))); // token-dense
    }

    // Tiny protect budget → token cutoff keeps ~the last message only.
    const protectTokens = estimateMessageTokens(msgs[msgs.length - 1]) + 1;
    // Fit eight complete tool turns, but not the entire user turn. The fixed
    // user-turn preservation policy then yields to the bounded tail ceiling.
    const maxTailTokens = msgs.slice(-16).reduce((a, m) => a + estimateMessageTokens(m), 0) + 1;

    const result = await compactWithLLM({
      messages: msgs,
      protectTokens,
      maxTailTokens,
      summaryProvider: { model: 'test-model' } as unknown as ChatProvider,
      // Bypass the real LLM — the cutoff math is what we're asserting.
      summarize: async () => ({
        primary_request: 'build the feature',
        key_concepts: [],
        files_and_code: [],
        errors_and_fixes: [],
        problem_solving: '',
        all_user_messages: ['build the feature'],
        pending_tasks: [],
        current_work: '',
        next_step: '',
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.collapsedFrom).toBeGreaterThan(0); // it really compacted a head
    // result.messages = [synthetic summary, ...tail]; the synthetic is a user
    // message, so exclude it before counting the preserved tail's turns.
    const tail = result.messages.slice(1);
    expect(renderableCount(tail)).toBeGreaterThanOrEqual(8);
  });
});
