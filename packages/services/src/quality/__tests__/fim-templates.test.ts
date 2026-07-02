import { describe, it, expect } from 'vitest';
import type { ResolvedBinding } from '../../pipelines/index.js';
import { resolveFimTemplate, mergeStops } from '../fim-templates.js';

function binding(kind: string, model: string, config: Record<string, unknown> = {}): ResolvedBinding {
  return {
    modelId: model,
    config,
    provider: { id: 'p', name: 'P', kind, api_key: 'k', extra: {} },
  } as unknown as ResolvedBinding;
}

describe('resolveFimTemplate', () => {
  it('picks the template family by model id on generic hosts', () => {
    expect(resolveFimTemplate(binding('openrouter', 'qwen2.5-coder-32b'))?.id).toBe('qwen');
    expect(resolveFimTemplate(binding('openai', 'starcoder2-15b'))?.id).toBe('starcoder');
    expect(resolveFimTemplate(binding('openai', 'stable-code-3b'))?.id).toBe('starcoder');
    expect(resolveFimTemplate(binding('openai', 'codellama-13b'))?.id).toBe('codellama');
    expect(resolveFimTemplate(binding('openai', 'codegemma-7b'))?.id).toBe('codegemma');
    expect(resolveFimTemplate(binding('openai', 'granite-8b-code'))?.id).toBe('granite');
    expect(resolveFimTemplate(binding('openai', 'seed-coder-8b'))?.id).toBe('seedcoder');
    expect(resolveFimTemplate(binding('openrouter', 'codestral-2508'))?.id).toBe('codestral-raw');
  });

  it('returns null for native-FIM kinds regardless of model id', () => {
    expect(resolveFimTemplate(binding('deepseek', 'deepseek-chat'))).toBeNull();
    expect(resolveFimTemplate(binding('mistral', 'codestral-latest'))).toBeNull();
  });

  it('returns null for models with no known FIM format', () => {
    expect(resolveFimTemplate(binding('openai', 'gpt-4o-mini'))).toBeNull();
  });

  it('honors the explicit fim_template override in both directions', () => {
    expect(resolveFimTemplate(binding('openrouter', 'qwen2.5-coder', { fim_template: 'native' }))).toBeNull();
    expect(resolveFimTemplate(binding('openai', 'gpt-4o', { fim_template: 'qwen' }))?.id).toBe('qwen');
    expect(resolveFimTemplate(binding('mistral', 'codestral-latest', { fim_template: 'codestral-raw' }))?.id)
      .toBe('codestral-raw');
    // 'auto' behaves like unset; unknown ids fail open to null.
    expect(resolveFimTemplate(binding('openrouter', 'qwen2.5-coder', { fim_template: 'auto' }))?.id).toBe('qwen');
    expect(resolveFimTemplate(binding('openrouter', 'qwen2.5-coder', { fim_template: 'nope' }))).toBeNull();
  });

  it('assembles byte-exact prompts per family', () => {
    const p = { prefix: 'A', suffix: 'B' };
    expect(resolveFimTemplate(binding('x', 'qwen2.5-coder'))!.assemble(p))
      .toBe('<|fim_prefix|>A<|fim_suffix|>B<|fim_middle|>');
    // CodeLlama's surrounding spaces are part of the trained format.
    expect(resolveFimTemplate(binding('x', 'codellama'))!.assemble(p)).toBe('<PRE> A <SUF>B <MID>');
    expect(resolveFimTemplate(binding('x', 'seed-coder'))!.assemble(p))
      .toBe('<[fim-prefix]>A<[fim-suffix]>B<[fim-middle]>');
    // Codestral raw is SPM: suffix first.
    expect(resolveFimTemplate(binding('x', 'codestral'))!.assemble(p)).toBe('[SUFFIX]B[PREFIX]A');
  });
});

describe('mergeStops', () => {
  it('keeps caller stops first and caps at 4', () => {
    const merged = mergeStops(['\n'], ['<|endoftext|>', '<|fim_prefix|>', '<|repo_name|>']);
    expect(merged).toEqual(['\n', '<|endoftext|>', '<|fim_prefix|>', '<|repo_name|>']);
    const overflow = mergeStops(['\n', 'X'], ['a', 'b', 'c']);
    expect(overflow).toEqual(['\n', 'X', 'a', 'b']);
  });

  it('dedupes and tolerates an undefined caller list', () => {
    expect(mergeStops(undefined, ['a', 'a', 'b'])).toEqual(['a', 'b']);
    expect(mergeStops(['a'], ['a', 'b'])).toEqual(['a', 'b']);
  });
});
