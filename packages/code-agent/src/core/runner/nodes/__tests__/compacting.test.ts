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
});
