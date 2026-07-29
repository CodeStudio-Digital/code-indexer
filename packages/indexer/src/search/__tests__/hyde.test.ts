import { describe, expect, it, vi } from 'vitest';
import type {
  PipelineProviderResolver,
  ResolvedBinding,
} from '@mcp/services/pipelines/index.js';
import type { ChatFn } from '@mcp/services/quality/index.js';
import { HyDEService } from '../hyde.js';

function binding(overrides: Partial<ResolvedBinding> = {}): ResolvedBinding {
  return {
    pipelineName: 'indexer_search',
    bindingRole: 'hyde',
    provider: {
      id: 'openai-1',
      name: 'OpenAI',
      kind: 'openai',
      base_url: null,
      api_key: 'test-key',
      auth_mode: 'api_key',
      enabled: true,
      use_for_agent: true,
      use_for_coder: true,
      use_for_general: true,
      is_default: false,
      extra: {},
      fallback_provider_id: null,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    },
    modelId: 'gpt-test',
    modelMode: '',
    config: {},
    resolvedFrom: 'global',
    bindingId: 7,
    ...overrides,
  };
}

function resolverWith(chain: ResolvedBinding[]) {
  const resolveChain = vi.fn(async () => chain);
  return {
    resolver: { resolveChain } as unknown as Pick<PipelineProviderResolver, 'resolveChain'>,
    resolveChain,
  };
}

describe('HyDEService pipeline binding', () => {
  it('is disabled when no indexer_search/hyde binding exists', async () => {
    const { resolver, resolveChain } = resolverWith([]);
    const chat = vi.fn() as unknown as ChatFn;
    const service = new HyDEService(resolver, { chat });

    await expect(service.generate('how are retries handled?')).resolves.toBe(
      'how are retries handled?',
    );
    expect(resolveChain).toHaveBeenCalledWith('indexer_search', 'hyde', {});
    expect(chat).not.toHaveBeenCalled();
  });

  it('uses exactly the provider, model and config resolved by PipelineBindings', async () => {
    const selected = binding({
      modelId: 'one-model-for-hyde',
      config: { temperature: 0.05, max_tokens: 96, timeout_ms: 4_000 },
    });
    const { resolver } = resolverWith([selected]);
    const chat = vi.fn<ChatFn>(async (_binding, messages, options) => ({
      content: '```ts\nfunction retryWithBackoff(): Promise<void>;\n```',
      latencyMs: 3,
    }));
    const service = new HyDEService(resolver, { chat });

    await expect(service.generate('how are retries handled?')).resolves.toBe(
      'function retryWithBackoff(): Promise<void>;',
    );
    expect(chat).toHaveBeenCalledWith(
      selected,
      [expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Question: how are retries handled?'),
      })],
      { temperature: 0.05, maxTokens: 96, timeoutMs: 4_000 },
    );
  });

  it('invalidates the query cache when the active binding changes', async () => {
    let active = binding({ bindingId: 1, modelId: 'model-a' });
    const resolveChain = vi.fn(async () => [active]);
    const chat = vi.fn<ChatFn>(async (resolved) => ({
      content: `function generatedBy${resolved.modelId.replace('-', '')}() { return true; }`,
      latencyMs: 1,
    }));
    const service = new HyDEService(
      { resolveChain } as unknown as Pick<PipelineProviderResolver, 'resolveChain'>,
      { chat },
    );

    const first = await service.generate('find the implementation');
    expect(await service.generate('find the implementation')).toBe(first);
    expect(chat).toHaveBeenCalledTimes(1);

    active = binding({ bindingId: 2, modelId: 'model-b' });
    expect(await service.generate('find the implementation')).toContain('modelb');
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('keys cached documents by project language context', async () => {
    const { resolver } = resolverWith([binding()]);
    const chat = vi.fn<ChatFn>(async (_binding, messages) => ({
      content: String(messages[0]?.content).includes('primary language: php')
        ? 'function retryPayment(): void {}'
        : 'def retry_payment():\n    return True',
      latencyMs: 1,
    }));
    const service = new HyDEService(resolver, { chat });

    await expect(service.generate('retry payment', { language: 'php' }))
      .resolves.toContain('retryPayment');
    await expect(service.generate('retry payment', { language: 'python' }))
      .resolves.toContain('retry_payment');
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('rejects Python drift for a PHP project and keeps the raw query', async () => {
    const { resolver } = resolverWith([binding()]);
    const chat = vi.fn<ChatFn>(async () => ({
      content: 'def update_payment(self, account):\n    return account',
      latencyMs: 1,
    }));
    const service = new HyDEService(resolver, { chat });

    await expect(service.generate(
      'como a conta de pagamento é atualizada?',
      { language: 'php', concepts: ['associado', 'débito automático'] },
    )).resolves.toBe('como a conta de pagamento é atualizada?');
  });

  it('fails open to the original query when the configured pipeline call fails', async () => {
    const { resolver } = resolverWith([binding()]);
    const chat = vi.fn<ChatFn>(async () => ({
      content: '',
      errorBody: 'provider unavailable',
      latencyMs: 1,
    }));
    const service = new HyDEService(resolver, { chat });

    await expect(service.generate('semantic question')).resolves.toBe('semantic question');
  });
});
