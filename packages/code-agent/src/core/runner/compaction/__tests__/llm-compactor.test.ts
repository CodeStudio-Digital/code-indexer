/**
 * Unit tests for `compactWithLLM`.
 *
 * Uses an in-memory `summarize` injection so tests don't hit a real LLM.
 * The real `summarizeSpanV2` path is exercised by the higher-level
 * compacting node test (which builds a mock provider whose stream returns
 * a valid JSON summary).
 *
 * Critical contract: the tail (last 40% of tokens, plus the last N user
 * turns) MUST survive byte-identical. The compactor only ever replaces the
 * head with a single synthetic user message.
 */
import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import { compactWithLLM } from '../llm-compactor.js';

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}
function assistant(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

const NEVER_CALLED_PROVIDER: ChatProvider = {
  name: 'mock',
  model: 'mock-model',
  setModel() {},
  chat() {
    throw new Error('chat called unexpectedly');
  },
};

const STUB_SUMMARY = {
  primary_request: 'do the thing',
  key_concepts: ['concept-a'],
  files_and_code: [{ path: 'src/x.ts', state: 'created' }],
  errors_and_fixes: [],
  problem_solving: 'tried A, switched to B',
  all_user_messages: ['m1', 'm2'],
  pending_tasks: ['finish B'],
  current_work: 'wrapping B',
  next_step: 'commit',
};

describe('compactWithLLM', () => {
  it('returns no-op success when cutoff is 0 (everything fits)', async () => {
    const messages = [user('hi'), assistant('hello')];
    const result = await compactWithLLM({
      messages,
      protectTokens: 1_000_000,
      summaryProvider: NEVER_CALLED_PROVIDER,
      summarize: async () => STUB_SUMMARY,
    });
    expect(result.ok).toBe(true);
    expect(result.collapsedFrom).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it('returns no-op success on empty history', async () => {
    const result = await compactWithLLM({
      messages: [],
      protectTokens: 100,
      summaryProvider: NEVER_CALLED_PROVIDER,
      summarize: async () => STUB_SUMMARY,
    });
    expect(result.ok).toBe(true);
    expect(result.collapsedFrom).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it('compacts head into one synthetic user message and preserves the tail verbatim', async () => {
    // 20 short turns; tiny protect budget so most of head is compactable.
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`u${i}`));
      messages.push(assistant(`a${i}`));
    }
    const result = await compactWithLLM({
      messages,
      protectTokens: 10, // ~10 tokens → tail will be 2-4 messages max
      summaryProvider: NEVER_CALLED_PROVIDER,
      summarize: async () => STUB_SUMMARY,
    });

    expect(result.ok).toBe(true);
    expect(result.collapsedFrom).toBeGreaterThan(0);
    expect(result.collapsedTo).toBe(1);
    expect(result.messages.length).toBeLessThan(messages.length);
    // First message in the new history is the synthetic.
    expect(result.messages[0].role).toBe('user');
    // The tail of the new history matches the tail of the original.
    const tailLen = result.messages.length - 1;
    for (let i = 0; i < tailLen; i++) {
      const newIdx = 1 + i;
      const oldIdx = messages.length - tailLen + i;
      expect(result.messages[newIdx]).toBe(messages[oldIdx]);
    }
  });

  it('does not mutate the input messages array', async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`u${i}`));
      messages.push(assistant(`a${i}`));
    }
    const before = messages.slice();
    await compactWithLLM({
      messages,
      protectTokens: 10,
      summaryProvider: NEVER_CALLED_PROVIDER,
      summarize: async () => STUB_SUMMARY,
    });
    expect(messages).toEqual(before);
  });

  it('returns ok=false with error when summarize returns null', async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`u${i}`));
      messages.push(assistant(`a${i}`));
    }
    const result = await compactWithLLM({
      messages,
      protectTokens: 10,
      summaryProvider: NEVER_CALLED_PROVIDER,
      summarize: async () => null,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/summarize/i);
    // Falls back to the input messages.
    expect(result.messages).toBe(messages);
  });

  it('returns ok=false with the underlying error when summarize throws', async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`u${i}`));
      messages.push(assistant(`a${i}`));
    }
    const result = await compactWithLLM({
      messages,
      protectTokens: 10,
      summaryProvider: NEVER_CALLED_PROVIDER,
      summarize: async () => { throw new Error('LLM down'); },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('LLM down');
  });
});
