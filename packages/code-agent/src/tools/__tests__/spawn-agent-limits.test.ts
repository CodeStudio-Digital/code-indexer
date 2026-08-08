import { describe, expect, it } from 'vitest';
import { MICRO_AGENT_PROFILES } from '../micro-agent-profiles.js';
import { limitsForAgent, type NormalizedAgent } from '../spawn-agent-core.js';
import { buildResearchPolicy, RESEARCH_DEPTH_DEFAULTS, type ResearchDepth } from '../subagent-research-policy.js';
import { ToolRegistry } from '../../core/registry.js';
import { buildSpawnAgentTool } from '../spawn-agent.js';

function agent(
  profile: keyof typeof MICRO_AGENT_PROFILES,
  researchDepth?: ResearchDepth,
): NormalizedAgent {
  const resolved = MICRO_AGENT_PROFILES[profile];
  return {
    task: 'test',
    type: resolved.capability,
    profile: resolved,
    label: profile,
    maxTurns: 0,
    researchPolicy: researchDepth
      ? buildResearchPolicy({ task: 'test', explicitDepth: researchDepth })
      : undefined,
  };
}

describe('spawn agent limits', () => {
  it('defaults every capability to a flat hard cap when no research policy exists', () => {
    const expected = {
      explore: { maxToolCalls: 80, timeoutMs: 840_000 },
      implement: { maxToolCalls: 150, timeoutMs: 1_800_000 },
      verify: { maxToolCalls: 80, timeoutMs: 900_000 },
      review: { maxToolCalls: 80, timeoutMs: 840_000 },
      full: { maxToolCalls: 150, timeoutMs: 1_800_000 },
    } as const;
    for (const profile of ['explore', 'implement', 'verify', 'review', 'full'] as const) {
      const limits = limitsForAgent(agent(profile));
      expect(limits, profile).toMatchObject(expected[profile]);
      expect(limits.stallMs).toBeGreaterThan(0);
    }
  });

  it('derives 2x the depth soft target when a research policy is present', () => {
    for (const depth of ['quick', 'standard', 'deep', 'exhaustive'] as const) {
      const defaults = RESEARCH_DEPTH_DEFAULTS[depth];
      const limits = limitsForAgent(agent('explore', depth));
      expect(limits.maxToolCalls, depth).toBe(defaults.softToolTarget * 2);
      expect(limits.timeoutMs, depth).toBe(defaults.softTimeTargetMs * 2);
    }
  });

  it('derives 2x custom soft targets (target_tool_calls / target_minutes)', () => {
    const custom = agent('explore');
    custom.researchPolicy = buildResearchPolicy({
      task: 'test',
      explicitDepth: 'deep',
      targetToolCalls: 30,
      targetMinutes: 5,
    });
    const limits = limitsForAgent(custom);
    expect(limits.maxToolCalls).toBe(60);
    expect(limits.timeoutMs).toBe(10 * 60_000);
  });

  it('falls back to the flat default when a soft target is explicitly disabled', () => {
    const disabled = agent('explore');
    disabled.researchPolicy = buildResearchPolicy({
      task: 'test',
      explicitDepth: 'deep',
      targetToolCalls: 0,
      targetMinutes: 0,
    });
    // Disabling the NUDGE must not silently disable the safety net.
    const limits = limitsForAgent(disabled);
    expect(limits.maxToolCalls).toBe(80);
    expect(limits.timeoutMs).toBe(840_000);
  });

  it('ignores retired process-env escape hatches', () => {
    for (const profile of ['explore', 'implement', 'verify', 'review', 'full'] as const) {
      const prefix = `CODER_SPAWN_${profile.toUpperCase()}`;
      process.env[`${prefix}_MAX_TOOLS`] = '0';
      process.env[`${prefix}_TIMEOUT_MS`] = '0';
      const limits = limitsForAgent(agent(profile));
      expect(limits.maxToolCalls).toBeGreaterThan(0);
      expect(limits.timeoutMs).toBeGreaterThan(0);
      expect(limits.stallMs).toBeGreaterThan(0);
      delete process.env[`${prefix}_MAX_TOOLS`];
      delete process.env[`${prefix}_TIMEOUT_MS`];
    }
  });

  it('keeps limits stable when retired env values change', () => {
    const target = agent('explore');
    process.env.CODER_SPAWN_EXPLORE_MAX_TOOLS = '12';
    process.env.CODER_SPAWN_EXPLORE_TIMEOUT_MS = '300000';
    expect(limitsForAgent(target)).toMatchObject({ maxToolCalls: 80, timeoutMs: 840000 });
    delete process.env.CODER_SPAWN_EXPLORE_MAX_TOOLS;
    delete process.env.CODER_SPAWN_EXPLORE_TIMEOUT_MS;
  });

  it('lets the DB per-profile override beat defaults, per axis', () => {
    const deps = {
      resolveLimitsForProfile: (id?: string) =>
        id === 'explore' ? { maxToolCalls: 40, timeoutMs: null } : undefined,
    };
    const limits = limitsForAgent(agent('explore', 'deep'), deps);
    expect(limits.maxToolCalls).toBe(40);
    expect(limits.timeoutMs).toBe(RESEARCH_DEPTH_DEFAULTS.deep.softTimeTargetMs * 2);
  });

  it('honors an explicit DB 0 as unlimited even with env and derived defaults set', () => {
    const deps = {
      resolveLimitsForProfile: () => ({ maxToolCalls: 0, timeoutMs: null }),
    };
    const limits = limitsForAgent(agent('explore', 'deep'), deps);
    expect(limits.maxToolCalls).toBe(0);
    expect(limits.timeoutMs).toBe(RESEARCH_DEPTH_DEFAULTS.deep.softTimeTargetMs * 2);
  });

  it('advertises soft research depth separately from exact operational caps', () => {
    const tool = buildSpawnAgentTool(new ToolRegistry());
    const schema = tool.parameters as unknown as {
      properties: { agents: { items: { properties: Record<string, { enum?: readonly string[]; description?: string }> } } };
    };
    const properties = schema.properties.agents.items.properties;
    expect(properties.research_depth.enum).toEqual(['quick', 'standard', 'deep', 'exhaustive']);
    expect(properties.target_minutes.description).toContain('soft synthesis target');
    expect(properties.max_turns.description).toContain('exact turn cap');
  });
});
