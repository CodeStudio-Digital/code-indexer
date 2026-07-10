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
  it('evaluates all legacy dimensions in one provider call', async () => {
    const resolver = {
      resolveChain: vi.fn(async () => [binding]),
    } as unknown as PipelineProviderResolver;
    const chatFn = vi.fn(async (_binding: ResolvedBinding, messages: ChatMessage[]) => ({
      content: JSON.stringify({
        verdict: 'warn',
        confidence: 0.8,
        reason: 'completeness needs attention',
        dimensions: {
          relevance: 'ok', completeness: 'warn', code_quality: 'ok', policy: 'ok', tool_use: 'ok',
        },
      }),
      latencyMs: 1,
    }));
    const classifier = new CombinedQualityClassifier(resolver, { chatFn });
    const result = await classifier.classify({
      taskText: 'Implement the requested change',
      outputText: 'Partial result',
      recentToolCalls: [{ name: 'read_file', success: true, timestampMs: 1 }],
    });

    expect(chatFn).toHaveBeenCalledTimes(1);
    const messages = chatFn.mock.calls[0][1];
    expect(messages[0].content).toContain('relevance');
    expect(messages[0].content).toContain('completeness');
    expect(messages[0].content).toContain('code_quality');
    expect(messages[0].content).toContain('policy');
    expect(messages[0].content).toContain('tool_use');
    expect(result).toMatchObject({ classifierName: 'quality_combined', verdict: 'warn' });
  });
});
