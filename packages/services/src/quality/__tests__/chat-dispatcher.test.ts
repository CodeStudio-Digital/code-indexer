import { describe, it, expect } from 'vitest';
import { suppressThinkingFor } from '../chat-dispatcher.js';
import type { ResolvedBinding } from '../../pipelines/provider-resolver.js';

const b = (id: string, kind: string): ResolvedBinding =>
  ({ provider: { id, kind } } as unknown as ResolvedBinding);

describe('suppressThinkingFor', () => {
  it('suppresses for Gemini (the distiller binding that was returning empty)', () => {
    expect(suppressThinkingFor(b('gemini', 'gemini'))).toBe(true);
    expect(suppressThinkingFor(b('google-oauth', 'google-oauth'))).toBe(true);
  });

  it('suppresses for OpenAI-compatible thinking hosts that ignore unknown params', () => {
    expect(suppressThinkingFor(b('zai', 'openai'))).toBe(true);
    expect(suppressThinkingFor(b('deepseek', 'openai'))).toBe(true);
    expect(suppressThinkingFor(b('cloudflare', 'cloudflare'))).toBe(true);
    expect(suppressThinkingFor(b('kimi-code', 'kimi-code'))).toBe(true);
    expect(suppressThinkingFor(b('moonshot', 'moonshot'))).toBe(true);
  });

  it('does NOT suppress for OpenAI-proper / strict providers (they 400 on unknown body params)', () => {
    expect(suppressThinkingFor(b('openai', 'openai'))).toBe(false);
    expect(suppressThinkingFor(b('openai-chatgpt', 'chatgpt'))).toBe(false);
    expect(suppressThinkingFor(b('aws', 'openai'))).toBe(false);
    expect(suppressThinkingFor(b('openrouter', 'openrouter'))).toBe(false);
    expect(suppressThinkingFor(b('copilot', 'copilot'))).toBe(false);
  });
});
