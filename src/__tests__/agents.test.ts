import { describe, it, expect } from 'vitest';
import { AGENTS, isAgentId, getAgent, agentsSummary } from '@mcp/code-agent/agents/index.js';

describe('agent presets', () => {
  it('exposes the built-in core and specialist agents', () => {
    expect(Object.keys(AGENTS).sort()).toEqual(['admin', 'api', 'app_db', 'app_orchestrator', 'build', 'builder', 'diagram', 'explore', 'plan', 'research', 'spec']);
  });

  it('explore is read-only with bootstrap profile', () => {
    const a = getAgent('explore');
    expect(a.profile).toBe('bootstrap');
    expect(a.planMode).toBe(false);
  });

  it('plan is navigate + plan mode on', () => {
    const a = getAgent('plan');
    expect(a.profile).toBe('navigate');
    expect(a.planMode).toBe(true);
  });

  it('build is navigate with no plan gate', () => {
    const a = getAgent('build');
    expect(a.profile).toBe('navigate');
    expect(a.planMode).toBe(false);
  });

  it('admin is full tier, no plan gate', () => {
    const a = getAgent('admin');
    expect(a.profile).toBe('full');
    expect(a.planMode).toBe(false);
  });

  it('isAgentId accepts known ids and rejects unknown', () => {
    expect(isAgentId('explore')).toBe(true);
    expect(isAgentId('plan')).toBe(true);
    expect(isAgentId('build')).toBe(true);
    expect(isAgentId('admin')).toBe(true);
    expect(isAgentId('random')).toBe(false);
    expect(isAgentId('')).toBe(false);
  });

  it('agentsSummary includes the four core agents', () => {
    const s = agentsSummary();
    expect(s).toContain('explore');
    expect(s).toContain('plan');
    expect(s).toContain('build');
    expect(s).toContain('admin');
  });
});
