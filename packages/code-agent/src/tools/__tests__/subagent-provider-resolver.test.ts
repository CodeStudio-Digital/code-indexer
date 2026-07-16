import { describe, it, expect } from 'vitest';
import {
  createSubagentProviderResolver,
  type SubagentTarget,
} from '@mcp/code-agent/tools/subagent-provider.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { MicroAgentProfileId } from '@mcp/code-agent/tools/micro-agent-profiles.js';

function fakeProvider(id: string, model?: string): ChatProvider {
  return { name: id, model: model ?? 'default' } as unknown as ChatProvider;
}

describe('createSubagentProviderResolver', () => {
  it('builds one provider per distinct target and memoizes by providerId:model', async () => {
    const calls: string[] = [];
    const createProvider = async (providerId: string, model?: string) => {
      calls.push(`${providerId}:${model ?? ''}`);
      return fakeProvider(providerId, model);
    };
    const profileTargets = new Map<MicroAgentProfileId, SubagentTarget | null>([
      ['implement', { providerId: 'anthropic', modelId: 'opus' }],
      ['explore', { providerId: 'zai', modelId: 'glm' }],
      ['verify', { providerId: 'zai', modelId: 'glm' }], // same key as explore → memoized
      ['review', null], // inherits parent
      ['full', null],
    ]);
    const resolver = createSubagentProviderResolver({
      sessionProvider: 'openai',
      sessionModel: 'gpt',
      defaultTarget: null,
      profileTargets,
      createProvider,
    });

    const impl = await resolver.forProfile('implement');
    const exp = await resolver.forProfile('explore');
    const ver = await resolver.forProfile('verify');
    const rev = await resolver.forProfile('review');

    expect(impl?.model).toBe('opus');
    expect(exp?.model).toBe('glm');
    expect(ver).toBe(exp); // memoized — identical instance for the same target
    expect(rev).toBeUndefined(); // null target → inherit parent
    expect(calls).toEqual(['anthropic:opus', 'zai:glm']); // only two builds
  });

  it('returns undefined when a target equals the session provider with no model', async () => {
    const resolver = createSubagentProviderResolver({
      sessionProvider: 'openai',
      sessionModel: 'gpt',
      defaultTarget: null,
      profileTargets: new Map<MicroAgentProfileId, SubagentTarget | null>([
        ['implement', { providerId: 'openai', modelId: null }],
      ]),
      createProvider: async (id, model) => fakeProvider(id, model),
    });
    expect(await resolver.forProfile('implement')).toBeUndefined();
  });

  it('falls back to the default target for an undefined or unknown profile', async () => {
    const resolver = createSubagentProviderResolver({
      sessionProvider: 'openai',
      sessionModel: 'gpt',
      defaultTarget: { providerId: 'anthropic', modelId: 'sonnet' },
      profileTargets: new Map(),
      createProvider: async (id, model) => fakeProvider(id, model),
    });
    expect((await resolver.forProfile(undefined))?.model).toBe('sonnet');
    expect((await resolver.forProfile('nonexistent'))?.model).toBe('sonnet');
  });
});
