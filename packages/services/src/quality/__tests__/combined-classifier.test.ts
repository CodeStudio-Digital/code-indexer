import { describe, expect, it, vi } from 'vitest';
import { CombinedQualityClassifier } from '../classifiers.js';
import type { ResolvedBinding } from '../../pipelines/index.js';
import type { PipelineProviderResolver } from '../../pipelines/provider-resolver.js';
import type { ChatMessage } from '../llm-chat.js';

const binding: ResolvedBinding = {
  pipelineName: 'quality_completeness',
  bindingRole: 'classifier',
  provider: {
    id: 'test-provider',
    name: 'Test provider',
    kind: 'openai',
    base_url: 'https://example.invalid',
    api_key: 'test',
    auth_mode: 'api_key',
    enabled: true,
    use_for_agent: true,
    use_for_coder: true,
    use_for_general: true,
    is_default: true,
    extra: {},
    fallback_provider_id: null,
    created_at: '2026-07-10 00:00:00',
    updated_at: '2026-07-10 00:00:00',
  },
  modelId: 'test-model',
  modelMode: 'chat',
  config: {},
  resolvedFrom: 'global',
  bindingId: 1,
};

describe('CombinedQualityClassifier', () => {
  it('evaluates the terminal delivery dimensions in one provider call', async () => {
    const resolver = {
      resolveChain: vi.fn(async () => [binding]),
    } as unknown as PipelineProviderResolver;
    const chatFn = vi.fn(async (_binding: ResolvedBinding, messages: ChatMessage[]) => ({
      content: JSON.stringify({
        verdict: 'warn',
        confidence: 0.8,
        reason: 'completeness needs attention',
        dimensions: {
          delivery_relevance: { verdict: 'ok', confidence: 0.9, reason: 'on task' },
          delivery_completeness: { verdict: 'warn', confidence: 0.8, reason: 'partial' },
          evidence_alignment: { verdict: 'ok', confidence: 0.95, reason: 'supported' },
        },
      }),
      latencyMs: 1,
    }));
    const classifier = new CombinedQualityClassifier(resolver, { chatFn });
    const result = await classifier.classify({
      taskText: 'Implement the requested change',
      outputText: 'Partial result',
      stopReason: 'completed',
      changedFiles: ['src/user.ts'],
      toolSummary: { total: 2, success: 2, error: 0, timeout: 0, refusal: 0, tools: [] },
      validationSignals: ['npm test'],
    });

    expect(chatFn).toHaveBeenCalledTimes(1);
    const messages = chatFn.mock.calls[0][1];
    expect(messages[0].content).toContain('relevance');
    expect(messages[0].content).toContain('completeness');
    expect(messages[0].content).toContain('evidence_alignment');
    expect(messages[0].content).not.toContain('code_quality');
    expect(messages[1].content).toContain('src/user.ts');
    expect(messages[1].content).not.toContain('Recent tool calls');
    expect(result).toMatchObject({
      classifierName: 'delivery_overall',
      verdict: 'warn',
      dimensions: [
        { classifierName: 'delivery_relevance', verdict: 'ok' },
        { classifierName: 'delivery_completeness', verdict: 'warn' },
        { classifierName: 'evidence_alignment', verdict: 'ok' },
      ],
    });
  });

  it('does not retry or fail over the terminal provider attempt', async () => {
    const resolver = {
      resolveChain: vi.fn(async () => [
        binding,
        { ...binding, bindingId: 2, provider: { ...binding.provider, id: 'fallback-provider' } },
      ]),
    } as unknown as PipelineProviderResolver;
    const chatFn = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const classifier = new CombinedQualityClassifier(resolver, {
      chatFn,
      singleAttempt: true,
      retry: { maxRetries: 0 },
    });

    const result = await classifier.classify({ taskText: 'task', outputText: 'final' });

    expect(chatFn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ verdict: 'error', systemError: true });
  });
});
