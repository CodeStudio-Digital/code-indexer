import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_PACKAGE_VERSION as serviceVersion,
  resolveClaudeCodeModel as resolveServiceModel,
} from '@mcp/services/services/oauth/claude-code.js';
import {
  CLAUDE_CODE_PACKAGE_VERSION as runtimeVersion,
  resolveClaudeCodeModel as resolveRuntimeModel,
} from '@mcp/provider-runtime/wire-helpers/claude-code.js';

describe('Claude Code host/plugin wire-helper parity', () => {
  it('keeps model, effort, thinking, and beta resolution identical', () => {
    const priorDisableExperimental = process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
    try {
      expect(runtimeVersion).toBe(serviceVersion);
      const cases = [
        { model: 'default', account: { subscriptionType: 'max' } },
        { model: 'default', account: { subscriptionType: 'pro' } },
        {
          model: 'default',
          account: {
            subscriptionType: 'enterprise',
            billingType: 'enterprise_usage_based',
          },
        },
        { model: 'sonnet-4-6[1m]', account: null },
        { model: 'fable', account: null },
        { model: 'opus-4-7', account: null },
        { model: 'haiku', account: null },
      ] as const;

      for (const entry of cases) {
        const opts = {
          includeOAuth: true,
          thinking: true,
          effort: 'auto' as const,
          hasTools: true,
        };
        expect(resolveRuntimeModel(entry.model, entry.account, opts)).toEqual(
          resolveServiceModel(entry.model, entry.account, opts),
        );
      }
    } finally {
      if (priorDisableExperimental === undefined) {
        delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
      } else {
        process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = priorDisableExperimental;
      }
    }
  });
});
