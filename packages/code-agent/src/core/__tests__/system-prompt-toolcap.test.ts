/**
 * The "Tool visibility" block — rendered for models whose catalog cap is
 * smaller than the registry (GLM flash class). Contract:
 *   - renders BELOW SYSTEM_PROMPT_DYNAMIC_BOUNDARY (model-dependent text
 *     must not pollute the shared static prefix)
 *   - absent when the cap covers the catalog
 *   - the static prefix is byte-identical with and without toolCap
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type PromptContext } from '../system-prompt.js';

function baseCtx(overrides?: Partial<PromptContext>): PromptContext {
  return {
    projectName: 'demo',
    projectRoot: 'D:/demo',
    os: 'win32',
    providerFamily: 'zai',
    profile: 'bootstrap',
    ...overrides,
  };
}

describe('system prompt — tool visibility (cap) block', () => {
  it('renders below the dynamic boundary when the cap is smaller than the catalog', () => {
    const prompt = buildSystemPrompt(baseCtx({ toolCap: { maxTools: 32, approxCatalog: 90 } }));
    const [prefix, suffix] = prompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(suffix).toContain('# Tool visibility (model-adapted)');
    expect(suffix).toContain('at most 32 high-priority tools');
    expect(suffix).toContain('find_tools');
    expect(suffix).toContain('pinned into your visible list');
    expect(prefix).not.toContain('Tool visibility (model-adapted)');
  });

  it('is absent when the cap covers the catalog', () => {
    const prompt = buildSystemPrompt(baseCtx({ toolCap: { maxTools: 200, approxCatalog: 90 } }));
    expect(prompt).not.toContain('# Tool visibility (model-adapted)');
  });

  it('does not change the static prefix (prompt-cache safety)', () => {
    const withCap = buildSystemPrompt(baseCtx({ toolCap: { maxTools: 32, approxCatalog: 90 } }));
    const without = buildSystemPrompt(baseCtx());
    const prefixOf = (p: string) => p.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)[0];
    expect(prefixOf(withCap)).toBe(prefixOf(without));
  });
});
