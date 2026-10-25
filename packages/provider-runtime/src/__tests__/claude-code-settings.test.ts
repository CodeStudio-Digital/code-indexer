import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveClaudeCodeRequestedModel as runtimeModel } from '../wire-helpers/claude-code.js';
import { resolveClaudeCodeRequestedModel as serviceModel } from '@mcp/services/services/oauth/claude-code.js';

afterEach(() => vi.unstubAllEnvs());
describe('Claude model overrides after settings bootstrap', () => {
  it.each([
    ['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
    ['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
    ['haiku', 'ANTHROPIC_SMALL_FAST_MODEL'],
  ])('resolves %s from current settings after module import', (alias, key) => {
    for (const value of ['configured-at-boot', 'updated-by-operator']) {
      vi.stubEnv(key, value);
      expect(runtimeModel(alias)).toBe(value);
      expect(serviceModel(alias)).toBe(value);
    }
  });
});
