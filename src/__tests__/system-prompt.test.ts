import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, normalizeProviderFamily, type ProviderFamily } from '@mcp/code-agent/core/system-prompt.js';

const base = {
  projectName: 'acme/app',
  projectRoot: '/tmp/acme',
  os: 'linux',
};

const families: ProviderFamily[] = ['anthropic', 'openai', 'openrouter', 'zai', 'gemini', 'deepseek', 'kimi-code', 'generic'];

describe('buildSystemPrompt per-provider preambles', () => {
  it('produces distinct prefixes for native provider families', () => {
    const distinctFamilies = families.filter((f) => f !== 'openrouter');
    const prefixes = new Set<string>();
    for (const f of distinctFamilies) {
      const p = buildSystemPrompt({ ...base, providerFamily: f });
      prefixes.add(p.slice(0, 120));
    }
    expect(prefixes.size).toBe(distinctFamilies.length);
  });

  it.each(['copilot', 'bedrock', 'openai', 'anthropic'])('does not infer a model identity from the local %s connection', (kind) => {
    const prompt = buildSystemPrompt({ ...base, providerFamily: normalizeProviderFamily(kind) });
    expect(prompt).not.toMatch(/Claude family|OpenAI GPT family|Codex family/i);
  });

  it('uses the family-neutral preamble for OpenRouter', () => {
    // An OpenRouter route may serve any model family (Claude, GPT, Gemini…),
    // so it must not claim the OpenAI GPT identity (bafca3dc, 2026-11-08).
    const generic = buildSystemPrompt({ ...base, providerFamily: 'generic' });
    const openrouter = buildSystemPrompt({ ...base, providerFamily: 'openrouter' });
    expect(openrouter.slice(0, 120)).toBe(generic.slice(0, 120));
    expect(openrouter).not.toContain('OpenAI GPT family');
  });

  it('is bit-stable across calls (critical for prefix cache)', () => {
    const a = buildSystemPrompt({ ...base, providerFamily: 'zai' });
    const b = buildSystemPrompt({ ...base, providerFamily: 'zai' });
    expect(a).toBe(b);
  });

  it('still contains the shared body regardless of family', () => {
    for (const f of families) {
      const p = buildSystemPrompt({ ...base, providerFamily: f });
      expect(p).toContain('You work inside CodeStudio');
      expect(p).toContain('# Operating contract');
      expect(p).toContain('Project root: /tmp/acme');
    }
  });

  it('falls back to generic when providerFamily is unset', () => {
    const p = buildSystemPrompt(base);
    expect(p).toContain('coding agent');
    expect(p).toContain('# Role');
  });

  it('plan mode section toggles on planMode=true', () => {
    const off = buildSystemPrompt({ ...base, providerFamily: 'anthropic' });
    const on = buildSystemPrompt({ ...base, providerFamily: 'anthropic', planMode: true });
    expect(off).not.toContain('Plan mode is ACTIVE');
    expect(on).toContain('Plan mode is ACTIVE');
  });
});
