import { describe, expect, it } from 'vitest';
import { withDefaultQaSkill } from '../qa-defaults.js';
import { hasQaPlaywrightSkill } from '@mcp/company/services/qa-skills.js';

describe('QA provisioning defaults', () => {
  it('gives new QA roles preview without adding E2E dependencies', () => {
    const role = withDefaultQaSkill({ role: 'qa-engineer', skills: ['frontend-react'] });
    expect(role.skills).toEqual(['frontend-react', 'qa-preview']);
    expect(hasQaPlaywrightSkill(JSON.stringify({ role_assignments: [role] }))).toBe(false);
    const frontend = { role: 'frontend' }; expect(withDefaultQaSkill(frontend)).toBe(frontend);
  });
  it('preserves explicit legacy regression and honors executor overrides', () => {
    const role = { role: 'qa', skills: ['qa-playwright'] };
    expect(withDefaultQaSkill(role)).toBe(role);
    expect(hasQaPlaywrightSkill(JSON.stringify({ role_assignments: [role] }))).toBe(true);
    expect(hasQaPlaywrightSkill(JSON.stringify({ role_assignments: [role], qa_executor: 'preview' }))).toBe(false);
    expect(hasQaPlaywrightSkill(JSON.stringify({ role_assignments: [{ role: 'qa', skills: ['qa-preview'] }], qa_executor: 'playwright' }))).toBe(true);
  });
  it('preserves explicit primary, chain and conditional QA configurations', () => {
    for (const skills of [
      { primary: 'qa-playwright', chain: ['docs'] },
      { primary: 'frontend-react', chain: ['qa-preview'] },
      { primary: 'frontend-react', conditional: [{ when: "session.stack === 'react-ts'", skill: 'qa-playwright' }] },
    ]) {
      const role = { role: 'qa', skills };
      expect(withDefaultQaSkill(role)).toBe(role);
    }
    expect(hasQaPlaywrightSkill(JSON.stringify({ role_assignments: [{ role: 'qa', skills: { primary: 'qa-playwright' } }] }))).toBe(true);
  });
  it('adds the new preview default to the chain without flattening or mutating conditions', () => {
    const skills = { primary: 'frontend-react', chain: ['docs'], conditional: [{ when: "session.stack === 'react-ts'", skill: 'react-testing' }] };
    const role = { role: 'qa', skills };
    const result = withDefaultQaSkill(role);
    expect(result.skills).toEqual({ ...skills, chain: ['docs', 'qa-preview'] });
    expect(result.skills.conditional).toBe(skills.conditional);
    expect(role.skills.chain).toEqual(['docs']);
    expect(withDefaultQaSkill(result)).toBe(result);
  });
});
