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
      defaultEffort: null,
      profileEfforts: new Map(),
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
      defaultEffort: null,
      profileEfforts: new Map(),
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
      defaultEffort: null,
      profileEfforts: new Map(),
      createProvider: async (id, model) => fakeProvider(id, model),
    });
    expect((await resolver.forProfile(undefined))?.model).toBe('sonnet');
    expect((await resolver.forProfile('nonexistent'))?.model).toBe('sonnet');
  });

  it('resolves per-profile effort; unset profile uses the default, null entry inherits parent', () => {
    // profileEfforts values are already default-merged by the store, so a null
    // entry means "no effort anywhere" (inherit parent), NOT "use default".
    const resolver = createSubagentProviderResolver({
      sessionProvider: 'openai',
      sessionModel: 'gpt',
      defaultTarget: null,
      profileTargets: new Map(),
      defaultEffort: 'medium',
      profileEfforts: new Map<MicroAgentProfileId, string | null>([
        ['implement', 'xhigh'],
        ['explore', null],
      ]),
      createProvider: async (id, model) => fakeProvider(id, model),
    });
    expect(resolver.effortFor('implement')).toBe('xhigh');   // explicit override
    expect(resolver.effortFor('explore')).toBeUndefined();   // null merged → inherit parent
    expect(resolver.effortFor('verify')).toBe('medium');     // unset profile → default
    expect(resolver.effortFor(undefined)).toBe('medium');    // no profile → default
  });

  it('returns undefined effort when neither profile nor default is set', () => {
    const resolver = createSubagentProviderResolver({
      sessionProvider: 'openai',
      sessionModel: 'gpt',
      defaultTarget: null,
      profileTargets: new Map(),
      defaultEffort: null,
      profileEfforts: new Map(),
      createProvider: async (id, model) => fakeProvider(id, model),
    });
    expect(resolver.effortFor('implement')).toBeUndefined();
  });
});
