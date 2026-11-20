/**
 * Unit tests for CompactingNode.
 *
 * The node delegates the summarize step to `compactWithLLM`, which we
 * inject via `summarizeOverride` so tests don't depend on the real
 * provider streaming path (that's covered by `llm-compactor.test.ts`).
 */
import { describe, it, expect, vi } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { CompactionSummaryV2 } from '@mcp/code-agent/core/summarizer.js';
import { CompactingNode } from '../compacting.js';
import type { CompactionCheckpoint } from '../../types.js';
import { makeTestContext } from './test-helpers.js';
import { asSessionId } from '@mcp/session-storage';

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


describe('CompactingNode', () => {
  it('compacts a long history, splices a synthetic summary, emits CompactionDone', async () => {
    const { ctx, recordedEvents } = makeTestContext();
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`u${i}`));
      messages.push(assistant(`a${i}`));
    }
    const originalLength = messages.length;
    ctx.messages = messages;

    const event = await new CompactingNode({
      protectTokensOverride: 10,
      summarizeOverride: async () => STUB_SUMMARY,
    }).execute(ctx, null);

    expect(event.kind).toBe('CompactionDone');
    expect(ctx.messages.length).toBeLessThan(originalLength);
    expect(ctx.messages[0].role).toBe('user');

    const histEvent = recordedEvents.find((r) => r.event === 'history_compacted');
    expect(histEvent).toBeDefined();
    expect((histEvent!.args[0] as { strategy: string }).strategy).toBe('summarizer');
  });

  it('hands the single generated summary to the durable checkpoint exactly once', async () => {
    const { ctx } = makeTestContext();
    ctx.messages = Array.from({ length: 20 }, (_, index) => (
      index % 2 === 0 ? user(`u${index}`) : assistant(`a${index}`)
    ));
    const checkpoint = vi.fn(async (_value: CompactionCheckpoint) => ({
      status: 'committed' as const,
      chapterId: '00000000-0000-4000-8000-000000000001',
      boundaryId: 10,
    }));
    ctx.opts.onCompactionCheckpoint = checkpoint;

    const event = await new CompactingNode({
      protectTokensOverride: 10,
      summarizeOverride: async () => STUB_SUMMARY,
    }).execute(ctx, null);

    expect(event.kind).toBe('CompactionDone');
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(checkpoint.mock.calls[0]?.[0].summary.version).toBe(3);
    expect(checkpoint.mock.calls[0]?.[0].headMessages.length).toBeGreaterThan(0);
  });

  it('keeps the in-memory resume when durable persistence fails', async () => {
    const { ctx } = makeTestContext();
    ctx.messages = Array.from({ length: 20 }, (_, index) => (
      index % 2 === 0 ? user(`u${index}`) : assistant(`a${index}`)
    ));
    ctx.opts.onCompactionCheckpoint = async () => { throw new Error('db unavailable'); };

    const event = await new CompactingNode({
      protectTokensOverride: 10,
      summarizeOverride: async () => STUB_SUMMARY,
    }).execute(ctx, null);

    expect(event.kind).toBe('CompactionDone');
    expect(ctx.messages[0].content[0]).toMatchObject({ type: 'text' });
    expect((ctx.messages[0].content[0] as { text: string }).text).toContain('auto-compacted summary');
  });

  it('records an unaligned checkpoint without aborting in-memory compaction', async () => {
    const { ctx } = makeTestContext();
    const finished: Array<{ status: string }> = [];
    Object.assign(ctx.opts, {
      sessionId: asSessionId('11111111-1111-4111-8111-111111111111'),
      sessionStore: {
        startCompactionAttempt: async () =>
          '22222222-2222-4222-8222-222222222222',
        finishCompactionAttempt: async (
          _sessionId: string,
          _id: string,
          value: { status: string },
        ) => {
          finished.push(value);
        },
      },
    });
    const checkpoint = vi.fn()
      .mockResolvedValueOnce({ status: 'noop', reason: 'unaligned', boundaryId: 0 });
    ctx.opts.onCompactionCheckpoint = checkpoint;
    const node = new CompactingNode({
      protectTokensOverride: 100,
      maxTailTokensOverride: 200,
      summarizeOverride: async () => STUB_SUMMARY,
    });

    ctx.messages = Array.from({ length: 40 }, (_, index) => (
      index % 2 === 0 ? user(`first-${index}`) : assistant(`first-${index}`)
    ));
    const firstResult = await node.execute(ctx, null);

    expect(firstResult.kind).toBe('CompactionDone');
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(finished.map((item) => item.status)).toEqual(['checkpoint_failed']);
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

  it('cuts mechanically in the same visit when the summarizer keeps failing', async () => {
    const { ctx, recordedEvents } = makeTestContext();
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`u${i}`));
      messages.push(assistant(`a${i}`));
    }
    const originalLength = messages.length;
    ctx.messages = messages;
    let calls = 0;

    const event = await new CompactingNode({
      protectTokensOverride: 10,
      summarizeOverride: async () => { calls++; return null; },
    }).execute(ctx, null);

    expect(event.kind).toBe('CompactionDone');
    expect(calls).toBe(2);
    expect(ctx.stopReason).toBe(null);
    expect(ctx.messages.length).toBeLessThan(originalLength);
    expect((ctx.messages[0].content[0] as { text: string }).text).toContain('[context truncated]');
    const strategies = recordedEvents
      .filter((r) => r.event === 'history_compacted')
      .map((r) => (r.args[0] as { strategy: string }).strategy);
    expect(strategies).toEqual(['deterministic']);
  });

  it('retries a one-off summarizer failure and keeps the summary', async () => {
    const { ctx, recordedEvents } = makeTestContext();
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`u${i}`));
      messages.push(assistant(`a${i}`));
    }
    ctx.messages = messages;
    let calls = 0;

    const event = await new CompactingNode({
      protectTokensOverride: 10,
      summarizeOverride: async () => (++calls === 1 ? null : STUB_SUMMARY),
    }).execute(ctx, null);

    expect(event.kind).toBe('CompactionDone');
    expect(calls).toBe(2);
    expect((ctx.messages[0].content[0] as { text: string }).text).not.toContain('[context truncated]');
    const strategies = recordedEvents
      .filter((r) => r.event === 'history_compacted')
      .map((r) => (r.args[0] as { strategy: string }).strategy);
    expect(strategies).toEqual(['summarizer']);
  });

  it('keeps a user abort during a failed summary an abort (no retry, no cut)', async () => {
    const abort = new AbortController();
    abort.abort();
    const { ctx, recordedEvents } = makeTestContext({
      toolContext: { signal: abort.signal } as never,
    });
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`u${i}`));
      messages.push(assistant(`a${i}`));
    }
    ctx.messages = messages;
    let calls = 0;

    // A cancelled run must stay cancelled: no retry and no mechanical cut.
    const event = await new CompactingNode({
      protectTokensOverride: 10,
      summarizeOverride: async () => { calls++; return null; },
    }).execute(ctx, null);
    expect(event.kind).toBe('Aborted');
    expect(ctx.stopReason).toBe('aborted');
    expect(calls).toBeLessThanOrEqual(1);
    expect(ctx.messages).toHaveLength(40);
    expect(recordedEvents.find((r) => r.event === 'history_compacted')).toBeUndefined();
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
