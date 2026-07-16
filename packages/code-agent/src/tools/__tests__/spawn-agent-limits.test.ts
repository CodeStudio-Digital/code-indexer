import { afterEach, describe, expect, it, vi } from 'vitest';
import { MICRO_AGENT_PROFILES } from '../micro-agent-profiles.js';
import { limitsForAgent, type NormalizedAgent } from '../spawn-agent-core.js';

function agent(profile: keyof typeof MICRO_AGENT_PROFILES): NormalizedAgent {
  const resolved = MICRO_AGENT_PROFILES[profile];
  return {
    task: 'test',
    type: resolved.capability,
    profile: resolved,
    label: profile,
    maxTurns: 0,
  };
}

describe('spawn agent limits', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults every capability to unlimited tool calls and wall-clock time', () => {
    for (const profile of ['explore', 'implement', 'verify', 'review', 'full'] as const) {
      const prefix = `CODER_SPAWN_${profile.toUpperCase()}`;
      vi.stubEnv(`${prefix}_MAX_TOOLS`, '0');
      vi.stubEnv(`${prefix}_TIMEOUT_MS`, '0');
      const limits = limitsForAgent(agent(profile));
      expect(limits.maxToolCalls).toBe(0);
      expect(limits.timeoutMs).toBe(0);
      expect(limits.stallMs).toBeGreaterThan(0);
    }
  });

  it('hot-applies positive operator overrides on the next dispatch', () => {
    const target = agent('explore');
    vi.stubEnv('CODER_SPAWN_EXPLORE_MAX_TOOLS', '0');
    vi.stubEnv('CODER_SPAWN_EXPLORE_TIMEOUT_MS', '0');
    expect(limitsForAgent(target)).toMatchObject({ maxToolCalls: 0, timeoutMs: 0 });

    vi.stubEnv('CODER_SPAWN_EXPLORE_MAX_TOOLS', '12');
    vi.stubEnv('CODER_SPAWN_EXPLORE_TIMEOUT_MS', '300000');
    expect(limitsForAgent(target)).toMatchObject({ maxToolCalls: 12, timeoutMs: 300000 });
  });
});
