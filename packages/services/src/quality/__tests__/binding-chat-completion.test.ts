import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import type { ResolvedBinding } from '../../pipelines/provider-resolver.js';

const chat = vi.fn();
vi.mock('../../providers/factory.js', () => ({
  createCoderProvider: vi.fn(async () => ({ model: 'm', name: 'fake', setModel: vi.fn(), chat })),
}));

import { coderProviderChat } from '../binding-chat.js';

const binding = {
  pipelineName: 'editor', bindingRole: 'autocomplete', bindingId: 1,
  provider: { id: 'oauth', kind: 'chatgpt', name: 'OAuth' },
  modelId: 'gpt', modelMode: '', config: {}, resolvedFrom: 'global',
} as ResolvedBinding;

beforeEach(() => chat.mockReset());

describe('OAuth completion streaming guards', () => {
  it('removes the caller listener on successful completion', async () => {
    const controller = new AbortController();
    chat.mockImplementation(async function* () { yield { type: 'done', stop_reason: 'completed' }; });
    await coderProviderChat(binding, [], { signal: controller.signal });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
  it('never dispatches an already-cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    expect((await coderProviderChat(binding, [], { signal: controller.signal })).finishReason).toBe('aborted');
    expect(chat).not.toHaveBeenCalled();
  });
  it('does not accept a terminal delta delivered after caller cancellation', async () => {
    const controller = new AbortController();
    chat.mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'partial' };
      controller.abort();
      yield { type: 'done', stop_reason: 'completed' };
    });
    expect(await coderProviderChat(binding, [], { signal: controller.signal })).toMatchObject({ content: 'partial', finishReason: 'aborted' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
  it('accepts a stream only after the provider emits a terminal event', async () => {
    chat.mockImplementation(async function* () {
      yield { type: 'text_delta', text: '{"findings":[]}' };
      yield { type: 'done', stop_reason: 'completed' };
    });
    const result = await coderProviderChat(binding, [{ role: 'user', content: 'complete' }], {
      timeoutMs: 1000,
    });
    expect(result.content).toBe('{"findings":[]}');
    expect(result.errorBody).toBeUndefined();
    expect(result.finishReason).toBe('provider');
  });

  it('keeps partial output but rejects a stream cut by the timeout before done', async () => {
    chat.mockImplementation(async function* (req: { signal?: AbortSignal }) {
      yield { type: 'text_delta', text: '{"findings":[{"severity":"high"}' };
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) resolve();
        else req.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const result = await coderProviderChat(binding, [{ role: 'user', content: 'complete' }], {
      timeoutMs: 10,
    });
    expect(result.content).toBe('{"findings":[{"severity":"high"}');
    expect(result.errorBody).toMatch(/timed out.*terminal event/i);
    expect(result.finishReason).toBe('timeout');
  });

  it('keeps partial output when the provider stream throws', async () => {
    chat.mockImplementation(async function* () {
      yield { type: 'text_delta', text: '{"findings":[' };
      throw new Error('socket reset');
    });
    const result = await coderProviderChat(binding, [{ role: 'user', content: 'complete' }], {
      timeoutMs: 1000,
    });
    expect(result.content).toBe('{"findings":[');
    expect(result.errorBody).toBe('socket reset');
    expect(result.finishReason).toBe('error');
  });

  it('records TTFT and stops incrementally at a local stop sequence', async () => {
    chat.mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'return value;' };
      yield { type: 'text_delta', text: '\n\nexplanation that must not leak' };
      yield { type: 'text_delta', text: 'never consumed' };
    });
    const result = await coderProviderChat(binding, [{ role: 'user', content: 'complete' }], {
      stop: ['\n\n'], maxTokens: 64, timeoutMs: 1000,
    });
    expect(result.content).toBe('return value;');
    expect(result.finishReason).toBe('local_stop');
    expect(result.ttftMs).toBeTypeOf('number');
    expect(chat.mock.calls[0]![0]).toMatchObject({ reasoningEffort: 'minimal', thinking: false });
  });

  it('cuts output locally when the OAuth adapter ignores max tokens', async () => {
    chat.mockImplementation(async function* () { yield { type: 'text_delta', text: 'x'.repeat(1000) }; });
    const result = await coderProviderChat(binding, [{ role: 'user', content: 'complete' }], { maxTokens: 10, timeoutMs: 1000 });
    expect(result.content).toHaveLength(40);
    expect(result.finishReason).toBe('local_max_tokens');
  });
});
