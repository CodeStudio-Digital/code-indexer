import { describe, expect, it } from 'vitest';
import {
  appendResearchContract,
  buildResearchPolicy,
  buildResearchSynthesisNudge,
  inferResearchDepth,
} from '../subagent-research-policy.js';

describe('subagent research policy', () => {
  it('infers quick/deep/exhaustive in Portuguese and English without treating ordinary breadth as exhaustive', () => {
    expect(inferResearchDepth('Faça uma visão inicial rápida')).toBe('quick');
    expect(inferResearchDepth('Faça um levantamento rapido')).toBe('quick');
    expect(inferResearchDepth('Trace the flow end-to-end')).toBe('deep');
    expect(inferResearchDepth('Faça uma pesquisa mais extensa')).toBe('deep');
    expect(inferResearchDepth('Faça uma pesquisa mais lenta')).toBe('deep');
    expect(inferResearchDepth('Audite todos os arquivos linha por linha')).toBe('exhaustive');
    expect(inferResearchDepth('Planeje suporte para todos os aplicativos')).toBe('standard');
  });

  it('defaults to a standard soft contract and keeps explicit zero targets disabled', () => {
    const standard = buildResearchPolicy({ task: 'Inspect the authentication flow' });
    expect(standard).toMatchObject({
      depth: 'standard',
      source: 'inferred',
      softToolTarget: 40,
      softTimeTargetMs: 7 * 60_000,
    });

    const disabled = buildResearchPolicy({
      task: 'Inspect the authentication flow',
      targetMinutes: 0,
      targetToolCalls: 0,
    });
    expect(disabled.softToolTarget).toBe(0);
    expect(disabled.softTimeTargetMs).toBe(0);
  });

  it('renders concrete sufficiency criteria and a non-terminal synthesis checkpoint', () => {
    const policy = buildResearchPolicy({
      task: 'Inspect auth',
      explicitDepth: 'quick',
      completionCriteria: ['Identify the middleware', 'Cite the active config'],
    });
    const prompt = appendResearchContract('BASE', policy);
    expect(prompt).toContain('Depth: **quick**');
    expect(prompt).toContain('Identify the middleware');
    expect(prompt).toContain('File novelty is not decision novelty');

    const nudge = buildResearchSynthesisNudge(policy, 'tools');
    expect(nudge).toContain('not a failure or hard cap');
    expect(nudge).toContain('Do not start another broad validation sweep');
  });
});
