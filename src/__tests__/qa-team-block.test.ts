import { describe, it, expect } from 'vitest';
import { buildQaTeamBlock } from '@mcp/company/system-prompts.js';

const baseRole = {
  role: 'frontend',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  tier: 'full',
};

describe('buildQaTeamBlock', () => {
  it('offers preview acceptance without requiring a legacy Playwright role', () => {
    for (const roster of [[], [{ ...baseRole }], [{ ...baseRole, skills: ['frontend-react'] }]]) {
      expect(buildQaTeamBlock(roster)).toContain('executor="preview"');
      expect(buildQaTeamBlock(roster)).toContain('a role with preview tools');
    }
  });

  it('renders QA TEAM section when at least one role has qa-playwright', () => {
    const out = buildQaTeamBlock([
      { ...baseRole, role: 'qa', skills: ['qa-playwright'] },
    ]);
    expect(out).toContain('## QA — VERIFIED ACCEPTANCE');
    expect(out).toContain('Delegate acceptance checks to qa.');
    expect(out).toContain('qa_check_preview');
    expect(out).toContain('links failures to the Kanban card');
    expect(out).toContain('persistent run_id');
  });

  it('lists all QA roles when multiple exist', () => {
    const out = buildQaTeamBlock([
      { ...baseRole, role: 'qa-explorer', skills: ['qa-playwright'] },
      { ...baseRole, role: 'qa-author', skills: ['qa-playwright'] },
      { ...baseRole, role: 'frontend', skills: ['frontend-react'] },
    ]);
    expect(out).toContain('Delegate acceptance checks to qa-explorer, qa-author.');
    expect(out).not.toContain('frontend');
  });

  it('preserves explicit Playwright regression approval and reporter contracts', () => {
    const out = buildQaTeamBlock([
      { ...baseRole, role: 'qa', skills: ['qa-playwright'] },
    ]);
    expect(out).toContain('executor="playwright" only');
    expect(out).toContain('plan approval and reporter contract');
  });

  it('handles roles with multiple skills correctly', () => {
    const out = buildQaTeamBlock([
      { ...baseRole, role: 'qa', skills: ['frontend-react', 'qa-playwright', 'something-else'] },
    ]);
    expect(out).toContain('Delegate acceptance checks to qa.');
  });
});
