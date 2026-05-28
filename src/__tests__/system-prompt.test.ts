import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, type ProviderFamily } from '@mcp/code-agent/core/system-prompt.js';

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

  it('uses the OpenAI-compatible preamble for OpenRouter', () => {
    const openai = buildSystemPrompt({ ...base, providerFamily: 'openai' });
    const openrouter = buildSystemPrompt({ ...base, providerFamily: 'openrouter' });
    expect(openrouter.slice(0, 120)).toBe(openai.slice(0, 120));
  });

  it('is bit-stable across calls (critical for prefix cache)', () => {
    const a = buildSystemPrompt({ ...base, providerFamily: 'zai' });
    const b = buildSystemPrompt({ ...base, providerFamily: 'zai' });
    expect(a).toBe(b);
  });

  it('still contains the shared body regardless of family', () => {
    for (const f of families) {
      const p = buildSystemPrompt({ ...base, providerFamily: f });
      expect(p).toContain('MCP Code Indexer');
      expect(p).toContain('get_project_pulse');
      expect(p).toContain('Long-term memory');
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
