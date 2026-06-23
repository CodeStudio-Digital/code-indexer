import { describe, it, expect } from 'vitest';
import { buildQaTeamBlock } from '@mcp/company/system-prompts.js';

const baseRole = {
  role: 'frontend',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  tier: 'full',
};

describe('buildQaTeamBlock', () => {
  it('returns empty string when no role has qa-playwright skill', () => {
    expect(buildQaTeamBlock([])).toBe('');
    expect(buildQaTeamBlock([{ ...baseRole }])).toBe('');
    expect(buildQaTeamBlock([{ ...baseRole, skills: ['frontend-react'] }])).toBe('');
  });

  it('renders QA TEAM section when at least one role has qa-playwright', () => {
    const out = buildQaTeamBlock([
      { ...baseRole, role: 'qa', skills: ['qa-playwright'] },
    ]);
    expect(out).toContain('## QA TEAM IS AVAILABLE');
    expect(out).toContain('`qa`');
    expect(out).toContain('submit_plan_to_master');
    expect(out).toContain("tag='bug'");
    expect(out).toContain('qa_run_completed');
  });

  it('lists all QA roles when multiple exist', () => {
    const out = buildQaTeamBlock([
      { ...baseRole, role: 'qa-explorer', skills: ['qa-playwright'] },
      { ...baseRole, role: 'qa-author', skills: ['qa-playwright'] },
      { ...baseRole, role: 'frontend', skills: ['frontend-react'] },
    ]);
    expect(out).toContain('`qa-explorer`');
    expect(out).toContain('`qa-author`');
    expect(out).not.toContain('`frontend`'); // only QA roles listed
    expect(out).toContain('QA agents'); // plural form
  });

  it('uses singular form for a single QA role', () => {
    const out = buildQaTeamBlock([
      { ...baseRole, role: 'qa', skills: ['qa-playwright'] },
    ]);
    expect(out).toContain('a QA agent');
    expect(out).not.toContain('QA agents (');
  });

  it('handles roles with multiple skills correctly', () => {
    const out = buildQaTeamBlock([
      { ...baseRole, role: 'qa', skills: ['frontend-react', 'qa-playwright', 'something-else'] },
    ]);
    expect(out).toContain('`qa`');
  });
});
