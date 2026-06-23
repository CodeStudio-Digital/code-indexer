import { describe, it, expect } from 'vitest';
import { resolveRoleSkills } from '@mcp/company/types.js';

describe('resolveRoleSkills', () => {
  it('flattens a legacy string[] verbatim', () => {
    expect(resolveRoleSkills(['ds-extractor', 'qa-playwright'], {})).toEqual([
      'ds-extractor',
      'qa-playwright',
    ]);
  });

  it('returns empty array when skills is undefined', () => {
    expect(resolveRoleSkills(undefined, {})).toEqual([]);
  });

  it('returns empty array for an empty config object', () => {
    expect(resolveRoleSkills({}, {})).toEqual([]);
  });

  it('uses primary when no conditional matches', () => {
    expect(
      resolveRoleSkills({ primary: 'ds-extractor' }, {}),
    ).toEqual(['ds-extractor']);
  });

  it('appends chain after primary', () => {
    expect(
      resolveRoleSkills({ primary: 'ds-extractor', chain: ['qa-playwright'] }, {}),
    ).toEqual(['ds-extractor', 'qa-playwright']);
  });

  it('picks the first conditional branch that matches session.stack', () => {
    const skills = {
      conditional: [
        { when: "session.stack === 'react-ts'", skill: 'ds-components-react' },
        { when: "session.stack === 'vue-ts'", skill: 'ds-components-vue' },
        { when: "session.stack === 'angular'", skill: 'ds-components-angular' },
      ],
    };
    expect(resolveRoleSkills(skills, { stack: 'react-ts' })).toEqual(['ds-components-react']);
    expect(resolveRoleSkills(skills, { stack: 'vue-ts' })).toEqual(['ds-components-vue']);
    expect(resolveRoleSkills(skills, { stack: 'angular' })).toEqual(['ds-components-angular']);
  });

  it('falls back to primary when no conditional branch matches', () => {
    const skills = {
      primary: 'ds-components-react',
      conditional: [{ when: "session.stack === 'svelte'", skill: 'ds-components-svelte' }],
    };
    expect(resolveRoleSkills(skills, { stack: 'react-ts' })).toEqual(['ds-components-react']);
  });

  it('combines conditional pick + chain', () => {
    const skills = {
      conditional: [{ when: "session.stack === 'react-ts'", skill: 'ds-components-react' }],
      chain: ['qa-playwright'],
    };
    expect(resolveRoleSkills(skills, { stack: 'react-ts' })).toEqual([
      'ds-components-react',
      'qa-playwright',
    ]);
  });

  it('rejects expressions with unknown keys (returns no match)', () => {
    const skills = {
      primary: 'fallback',
      conditional: [{ when: "session.foo === 'bar'", skill: 'never' }],
    };
    expect(resolveRoleSkills(skills, { stack: 'react-ts' })).toEqual(['fallback']);
  });

  it('rejects unsafe expressions (no arbitrary code execution)', () => {
    const skills = {
      primary: 'fallback',
      conditional: [
        { when: 'process.exit(1)', skill: 'evil' },
        { when: '() => true', skill: 'evil2' },
        { when: 'session.stack || true', skill: 'evil3' },
      ],
    };
    expect(resolveRoleSkills(skills, { stack: 'react-ts' })).toEqual(['fallback']);
  });

  it('handles == as well as === for the equality operator', () => {
    const skills = {
      conditional: [{ when: "session.stack == 'react-ts'", skill: 'ds-components-react' }],
    };
    expect(resolveRoleSkills(skills, { stack: 'react-ts' })).toEqual(['ds-components-react']);
  });

  it('deduplicates when primary and chain overlap', () => {
    const skills = {
      primary: 'ds-extractor',
      chain: ['ds-extractor', 'qa-playwright'],
    };
    expect(resolveRoleSkills(skills, {})).toEqual(['ds-extractor', 'qa-playwright']);
  });
});
