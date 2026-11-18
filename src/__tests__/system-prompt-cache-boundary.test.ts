/**
 * Static-prefix byte-stability test for the system prompt.
 *
 * The contract introduced by SYSTEM_PROMPT_DYNAMIC_BOUNDARY (PR-1, R2 from
 * docs/agent-research/COMPARISON.md): everything ABOVE the boundary line
 * must be byte-identical when the cache-keyable inputs match
 * (provider family, project identity, OS, planMode, profile, agentLoopV2,
 * mcpAvailable, isIndexed). Things that vary across sessions of the same
 * project — registered MCP custom tiers, hook-supplied project instructions,
 * repo map — must NOT appear in the prefix.
 *
 * If this test fails, the model provider's prompt cache will start missing
 * across sessions of the same project. That's a real billing impact —
 * cache_read_input_tokens drops, cache_creation_input_tokens climbs.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type PromptContext,
} from '@mcp/code-agent/core/system-prompt.js';

const baseCtx: PromptContext = {
  projectName: 'whatsapp-pro-api',
  projectRoot: '/repo/whatsapp-pro-api',
  os: 'win32',
  providerFamily: 'anthropic',
  profile: 'navigate',
  planMode: false,
  mcpAvailable: true,
  isIndexed: true,
  agentLoopV2: true,
};

function splitOnBoundary(prompt: string): { staticPrefix: string; dynamicSuffix: string } {
  const idx = prompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  if (idx < 0) return { staticPrefix: prompt, dynamicSuffix: '' };
  return {
    staticPrefix: prompt.slice(0, idx),
    dynamicSuffix: prompt.slice(idx + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.length),
  };
}

describe('SYSTEM_PROMPT_DYNAMIC_BOUNDARY — static prefix byte-stability', () => {
  it('static prefix is byte-identical when adding/removing customTiers', () => {
    const a = buildSystemPrompt(baseCtx);
    const b = buildSystemPrompt({
      ...baseCtx,
      customTiers: [
        { tier: 'gh', displayName: 'GitHub MCP', toolCount: 12 },
        { tier: 'jira', displayName: 'Jira MCP', toolCount: 7 },
      ],
    });
    expect(splitOnBoundary(a).staticPrefix).toBe(splitOnBoundary(b).staticPrefix);
  });

  it('static prefix is byte-identical when adding a repo map', () => {
    const a = buildSystemPrompt(baseCtx);
    const b = buildSystemPrompt({
      ...baseCtx,
      repoMap:
        '# Repo map\n- src/app.ts: bootstrap()\n- src/db.ts: init()\n- src/cache.ts: get()',
    });
    expect(splitOnBoundary(a).staticPrefix).toBe(splitOnBoundary(b).staticPrefix);
  });

  it('static prefix changes when planMode flips (cache key change is intentional)', () => {
    const a = buildSystemPrompt({ ...baseCtx, planMode: false });
    const b = buildSystemPrompt({ ...baseCtx, planMode: true });
    expect(splitOnBoundary(a).staticPrefix).not.toBe(splitOnBoundary(b).staticPrefix);
  });

  it('uses the same discovery instructions across tool profiles', () => {
    const a = buildSystemPrompt({ ...baseCtx, profile: 'bootstrap' });
    const b = buildSystemPrompt({ ...baseCtx, profile: 'navigate' });
    expect(splitOnBoundary(a).staticPrefix).toBe(splitOnBoundary(b).staticPrefix);
  });

  it('static prefix is byte-identical when only customTiers ORDER changes', () => {
    const a = buildSystemPrompt({
      ...baseCtx,
      customTiers: [
        { tier: 'gh', displayName: 'GitHub MCP', toolCount: 12 },
        { tier: 'jira', displayName: 'Jira MCP', toolCount: 7 },
      ],
    });
    const b = buildSystemPrompt({
      ...baseCtx,
      customTiers: [
        { tier: 'jira', displayName: 'Jira MCP', toolCount: 7 },
        { tier: 'gh', displayName: 'GitHub MCP', toolCount: 12 },
      ],
    });
    // Static prefix has no customTiers content at all, so trivially equal.
    expect(splitOnBoundary(a).staticPrefix).toBe(splitOnBoundary(b).staticPrefix);
    // Dynamic suffix should ALSO be byte-equal because customTiersBlock sorts.
    expect(splitOnBoundary(a).dynamicSuffix).toBe(splitOnBoundary(b).dynamicSuffix);
  });

  it('boundary marker is always present (byte-stable hinge for cache splitters)', () => {
    const prompt = buildSystemPrompt(baseCtx);
    expect(prompt).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  });

  it('boundary marker is present when any dynamic section is non-empty', () => {
    const prompt = buildSystemPrompt({
      ...baseCtx,
      repoMap: '# Repo map\n- src/app.ts',
    });
    expect(prompt).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  });

  it('customTiers, repo map, and project hook all live BELOW the boundary', () => {
    const prompt = buildSystemPrompt({
      ...baseCtx,
      customTiers: [{ tier: 'gh', displayName: 'GitHub MCP', toolCount: 12 }],
      repoMap: '# Repo map\n- src/app.ts',
    });
    const { staticPrefix, dynamicSuffix } = splitOnBoundary(prompt);
    expect(staticPrefix).not.toContain('External tool groups');
    expect(staticPrefix).not.toContain('# Repo map');
    expect(dynamicSuffix).toContain('External tool groups');
    expect(dynamicSuffix).toContain('# Repo map');
  });

  it('agent-loop block lives ABOVE the boundary (cache-stable)', () => {
    const prompt = buildSystemPrompt({
      ...baseCtx,
      repoMap: '# Repo map\n- src/app.ts',
    });
    const { staticPrefix, dynamicSuffix } = splitOnBoundary(prompt);
    expect(staticPrefix).toContain('# Execution contract');
    expect(staticPrefix).toContain('Before substantial tools, state the immediate objective');
    expect(staticPrefix).toContain('# Active context');
    expect(dynamicSuffix).not.toContain('# Execution contract');
  });

  it('persistence framing (R6) is present in the agent-loop block', () => {
    const prompt = buildSystemPrompt(baseCtx);
    expect(prompt).toContain('Carry authorized action requests through implementation and verification');
    expect(prompt).toContain('continue independent safe work when blocked');
    expect(prompt).toContain('Respect Plan/Spec gates');
  });

  it('preamble guidance (R6) is present', () => {
    const prompt = buildSystemPrompt(baseCtx);
    expect(prompt).toContain('Before substantial tools, state the immediate objective');
    expect(prompt).toContain('at least every 60 seconds');
  });
});

describe('SYSTEM_PROMPT_DYNAMIC_BOUNDARY — cross-session stability simulation', () => {
  it('two sessions of the same project share the static prefix even with different MCP states', () => {
    // Session A: just connected — no custom tiers yet.
    const sessionA = buildSystemPrompt({ ...baseCtx, customTiers: undefined });
    // Session B: connected with two MCP servers, repo map populated.
    const sessionB = buildSystemPrompt({
      ...baseCtx,
      customTiers: [
        { tier: 'gh', displayName: 'GitHub MCP', toolCount: 12 },
        { tier: 'jira', displayName: 'Jira MCP', toolCount: 7 },
      ],
      repoMap: '# Repo map\n- src/app.ts: bootstrap()',
    });
    expect(splitOnBoundary(sessionA).staticPrefix).toBe(splitOnBoundary(sessionB).staticPrefix);
  });

  it('different providers yield different static prefixes (intentional cache split)', () => {
    const claude = buildSystemPrompt({ ...baseCtx, providerFamily: 'anthropic' });
    const openai = buildSystemPrompt({ ...baseCtx, providerFamily: 'openai' });
    expect(splitOnBoundary(claude).staticPrefix).not.toBe(splitOnBoundary(openai).staticPrefix);
  });
});
