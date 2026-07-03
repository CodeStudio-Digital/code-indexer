import { describe, it, expect } from 'vitest';
import { BUILTIN_SPECS, getSpecByKind } from '../specs/index.js';
import { buildProviderDefinition } from '../build-definition.js';

/**
 * Guards the registry cutover (registry.ts builds BUILTIN_SPECS.map(build...)).
 * The order is load-bearing: pricing.ts resolves a model's price by walking the
 * registry in insertion order and taking the FIRST definition whose pricing map
 * has it. Several model ids appear in multiple providers with different prices.
 */
const REGISTRY_ORDER = [
  'anthropic',
  'claude-code',
  'openai',
  'deepseek',
  'zai',
  'gemini',
  'copilot',
  'chatgpt',
  'bedrock',
  'google-oauth',
  'kimi-code',
  'cloudflare',
  'moonshot',
  'openrouter',
  // Appended after the cutover (no model-id collisions → position irrelevant for pricing).
  'fugu',
  'mistral',
];

describe('registry cutover parity', () => {
  it('BUILTIN_SPECS is the expected kinds in stable registry order', () => {
    expect(BUILTIN_SPECS.map((s) => s.kind)).toEqual(REGISTRY_ORDER);
  });

  it('getSpecByKind resolves every built-in and nothing else', () => {
    for (const kind of REGISTRY_ORDER) expect(getSpecByKind(kind)?.kind).toBe(kind);
    expect(getSpecByKind('does-not-exist')).toBeUndefined();
  });

  it('building all specs yields the same kinds, all with a coder builder', () => {
    const defs = BUILTIN_SPECS.map(buildProviderDefinition);
    expect(defs.map((d) => d.kind)).toEqual(REGISTRY_ORDER);
    expect(defs.every((d) => typeof d.createCoder === 'function')).toBe(true);
    expect(defs.every((d) => typeof d.createIndexer === 'function' || typeof d.createIndexerAsync === 'function')).toBe(
      true,
    );
  });

  it('pricing first-match is preserved for the cross-provider duplicate model ids', () => {
    const defs = BUILTIN_SPECS.map(buildProviderDefinition);
    const lookup = (model: string) => defs.find((d) => d.pricing?.[model])?.pricing![model];
    // gpt-4o: openai (idx2, 2.50/10) wins over copilot (0) + chatgpt (2.50/10)
    expect(lookup('gpt-4o')).toEqual({ inputPer1M: 2.5, outputPer1M: 10.0 });
    // gpt-4o-mini: openai (0.15/0.60) wins over copilot (0)
    expect(lookup('gpt-4o-mini')).toEqual({ inputPer1M: 0.15, outputPer1M: 0.6 });
    // kimi-k2-turbo-preview: kimi-code (idx10, 0/0) wins over moonshot (idx12, 0.60/2.50)
    expect(lookup('kimi-k2-turbo-preview')).toEqual({ inputPer1M: 0.0, outputPer1M: 0.0 });
    expect(lookup('kimi-k2-thinking-turbo')).toEqual({ inputPer1M: 0.0, outputPer1M: 0.0 });
  });
});
