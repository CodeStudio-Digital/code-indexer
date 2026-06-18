/**
 * Unit tests for CompactingNode.
 *
 * The node delegates the summarize step to `compactWithLLM`, which we
 * inject via `summarizeOverride` so tests don't depend on the real
 * provider streaming path (that's covered by `llm-compactor.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { CompactionSummaryV2 } from '@mcp/code-agent/core/summarizer.js';
import { CompactingNode } from '../compacting.js';
import { makeTestContext } from './test-helpers.js';

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}
function assistant(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}
function toolUse(id: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'run', input: {} }] };
}
function toolResult(id: string, content: string): AgentMessage {
  return { role: 'tool', content: [{ type: 'tool_result', tool_use_id: id, content }] };
}

const STUB_SUMMARY: CompactionSummaryV2 = {
  primary_request: 'build the thing',
  key_concepts: ['react'],
  files_and_code: [{ path: 'a.ts', state: 'created' }],
  errors_and_fixes: [],
  problem_solving: 'A → B',
  all_user_messages: ['m1'],
  pending_tasks: ['ship'],
  current_work: 'tests',
  next_step: 'commit',
};

beforeEach(() => {
  vi.stubEnv('CODER_STRUCTURED_SUMMARY', '1');
  vi.stubEnv('CODER_NEW_COMPACTION', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('CompactingNode', () => {
  it('compacts a long history, splices a synthetic summary, emits CompactionDone', async () => {
    const { ctx, recordedEvents } = makeTestContext();
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`u${i}`));
      messages.push(assistant(`a${i}`));
    }
    ctx.messages = messages;

    const event = await new CompactingNode({
      protectTokensOverride: 10,
      summarizeOverride: async () => STUB_SUMMARY,
    }).execute(ctx, null);

    expect(event.kind).toBe('CompactionDone');
    expect(ctx.messages.length).toBeLessThan(messages.length);
    expect(ctx.messages[0].role).toBe('user');

    const histEvent = recordedEvents.find((r) => r.event === 'history_compacted');
    expect(histEvent).toBeDefined();
    expect((histEvent!.args[0] as { strategy: string }).strategy).toBe('summarizer');
  });

  it('emits CompactionDone with collapsedFrom=0 when history already fits', async () => {
    const { ctx } = makeTestContext();
    ctx.messages = [user('short'), assistant('also short')];

    const event = await new CompactingNode({
      summarizeOverride: async () => STUB_SUMMARY,
    }).execute(ctx, null);

    expect(event.kind).toBe('CompactionDone');
    if (event.kind === 'CompactionDone') {
      expect(event.collapsedFrom).toBe(0);
    }
    expect(ctx.messages).toEqual([user('short'), assistant('also short')]);
  });

  it('falls through to ProviderError(retryable) when summarize fails under cap', async () => {
    const { ctx } = makeTestContext();
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`u${i}`));
      messages.push(assistant(`a${i}`));
    }
    ctx.messages = messages;

    const event = await new CompactingNode({
      protectTokensOverride: 10,
      summarizeOverride: async () => null,
    }).execute(ctx, null);

    expect(event.kind).toBe('ProviderError');
    expect(ctx.recovery.get('compact-failure')).toBe(1);
    expect(ctx.stopReason).toBe(null);
  });

  it('aborts with stopReason=compact_failure when over the recovery cap', async () => {
    vi.stubEnv('CODER_RECOVERY_COMPACT_MAX', '1');
    const { ctx, recordedEvents } = makeTestContext();
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`u${i}`));
      messages.push(assistant(`a${i}`));
    }
    ctx.messages = messages;

    // First call: 1/1 still under cap → ProviderError (retry).
    const first = await new CompactingNode({
      protectTokensOverride: 10,
      summarizeOverride: async () => null,
    }).execute(ctx, null);
    expect(first.kind).toBe('ProviderError');

    // Second call: 2/1 → aborts.
    const second = await new CompactingNode({
      protectTokensOverride: 10,
      summarizeOverride: async () => null,
    }).execute(ctx, null);
    expect(second.kind).toBe('Aborted');
    expect(ctx.stopReason).toBe('compact_failure');

    const aborted = recordedEvents.find((r) => r.event === 'recovery_aborted');
    expect(aborted).toBeDefined();
    expect((aborted!.args[0] as { kind: string }).kind).toBe('compact-failure');
  });

  it('increments consecutiveNoopCompactions on a no-op (collapsedFrom=0)', async () => {
    const { ctx } = makeTestContext();
    ctx.messages = [user('short'), assistant('also short')];
    expect(ctx.consecutiveNoopCompactions).toBe(0);

    await new CompactingNode({ summarizeOverride: async () => STUB_SUMMARY }).execute(ctx, null);
    expect(ctx.consecutiveNoopCompactions).toBe(1);

    await new CompactingNode({ summarizeOverride: async () => STUB_SUMMARY }).execute(ctx, null);
    expect(ctx.consecutiveNoopCompactions).toBe(2);
  });

  it('P1: spills an oversized tool_result on no-op instead of looping (deterministic)', async () => {
    const puts: string[] = [];
    const store = { put: (c: string) => { puts.push(c); return `oid-${puts.length}`; } };
    const { ctx, recordedEvents } = makeTestContext({
      toolContext: { toolOutputStore: store } as never,
    });
    const big = 'x'.repeat(8000); // ~2000 tokens — far exceeds the protect override
    ctx.messages = [user('run the tool'), toolUse('tu1'), toolResult('tu1', big)];
    ctx.consecutiveNoopCompactions = 1; // a prior no-op streak

    // summarize must NOT be called on the spill path (cutoff >= length no-ops first).
    let summarizeCalls = 0;
    const event = await new CompactingNode({
      protectTokensOverride: 100,
      summarizeOverride: async () => { summarizeCalls += 1; return STUB_SUMMARY; },
    }).execute(ctx, null);

    expect(event.kind).toBe('CompactionDone');
    expect(summarizeCalls).toBe(0);
    // Spill is a REAL reduction → the no-op streak is cleared, not incremented.
    expect(ctx.consecutiveNoopCompactions).toBe(0);
    // The oversized block was replaced with a capped head + recovery marker.
    const block = ctx.messages[2].content[0] as { content: string };
    expect(block.content.length).toBeLessThan(big.length);
    expect(block.content).toContain('get_tool_output');
    expect(puts).toEqual([big]);
    const hist = recordedEvents.find((r) => r.event === 'history_compacted');
    expect((hist!.args[0] as { strategy: string }).strategy).toBe('deterministic');
  });

  it('resets consecutiveNoopCompactions on a real compaction', async () => {
    const { ctx } = makeTestContext();
    ctx.consecutiveNoopCompactions = 5; // simulate a prior no-op streak
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`u${i}`));
      messages.push(assistant(`a${i}`));
    }
    ctx.messages = messages;

    const event = await new CompactingNode({
      protectTokensOverride: 10,
      summarizeOverride: async () => STUB_SUMMARY,
    }).execute(ctx, null);

    expect(event.kind).toBe('CompactionDone');
    expect(ctx.consecutiveNoopCompactions).toBe(0);
  });
});
