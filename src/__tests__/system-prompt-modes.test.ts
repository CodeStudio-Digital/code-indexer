import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '@mcp/code-agent/core/system-prompt.js';
import type { AgentId } from '@mcp/code-agent/agents/index.js';

const base = {
  projectName: 'acme/app',
  projectRoot: '/tmp/acme',
  os: 'linux',
  providerFamily: 'anthropic' as const,
};

describe('buildSystemPrompt per-agent identity sections', () => {
  it('injects a distinct mode marker phrase for explore / build / admin', () => {
    const explore = buildSystemPrompt({ ...base, agentId: 'explore' });
    const build = buildSystemPrompt({ ...base, agentId: 'build' });
    const admin = buildSystemPrompt({ ...base, agentId: 'admin' });

    expect(explore).toContain('Explore mode is ACTIVE');
    expect(explore).not.toContain('Build mode is ACTIVE');
    expect(explore).not.toContain('Admin mode is ACTIVE');

    expect(build).toContain('Build mode is ACTIVE');
    expect(build).not.toContain('Explore mode is ACTIVE');
    expect(build).not.toContain('Admin mode is ACTIVE');

    expect(admin).toContain('Admin mode is ACTIVE');
    expect(admin).not.toContain('Explore mode is ACTIVE');
    expect(admin).not.toContain('Build mode is ACTIVE');
  });

  it('plan agent activates plan.txt via planMode (not via agentSection double-load)', () => {
    // agentId='plan' is intentionally not loaded as agentSection — plan.txt is
    // already injected via planSection when planMode is true.
    const planOn = buildSystemPrompt({ ...base, agentId: 'plan', planMode: true });
    expect(planOn).toContain('Plan mode is ACTIVE');
    // Exactly one occurrence — no double-load from agentSection.
    const matches = planOn.match(/Plan mode is ACTIVE/g) ?? [];
    expect(matches.length).toBe(1);

    // Sanity: without planMode, agentId='plan' alone does not inject plan.txt.
    const planOff = buildSystemPrompt({ ...base, agentId: 'plan' });
    expect(planOff).not.toContain('Plan mode is ACTIVE');
  });

  it('emits no mode marker when agentId is unset', () => {
    const noAgent = buildSystemPrompt(base);
    expect(noAgent).not.toContain('Explore mode is ACTIVE');
    expect(noAgent).not.toContain('Build mode is ACTIVE');
    expect(noAgent).not.toContain('Admin mode is ACTIVE');
    expect(noAgent).not.toContain('Plan mode is ACTIVE');
  });

  it('is bit-stable per agent (cache prefix safety)', () => {
    for (const id of ['explore', 'build', 'admin'] satisfies AgentId[]) {
      const a = buildSystemPrompt({ ...base, agentId: id });
      const b = buildSystemPrompt({ ...base, agentId: id });
      expect(a).toBe(b);
    }
  });

  it('mode section sits above the dynamic boundary (cache-stable position)', () => {
    const prompt = buildSystemPrompt({ ...base, agentId: 'build' });
    const modeIdx = prompt.indexOf('Build mode is ACTIVE');
    const boundaryIdx = prompt.indexOf('SYSTEM_PROMPT_DYNAMIC_BOUNDARY');
    expect(modeIdx).toBeGreaterThan(-1);
    expect(boundaryIdx).toBeGreaterThan(-1);
    expect(modeIdx).toBeLessThan(boundaryIdx);
  });

  it('keeps the base body regardless of agentId', () => {
    for (const id of ['explore', 'build', 'admin'] satisfies AgentId[]) {
      const p = buildSystemPrompt({ ...base, agentId: id });
      expect(p).toContain('MCP Code Indexer');
      expect(p).toContain('get_project_pulse');
    }
  });
});
