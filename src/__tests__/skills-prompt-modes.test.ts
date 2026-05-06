import { describe, it, expect } from 'vitest';
import {
  buildLazySkillsSection,
  buildCompactSkillsSection,
  buildSkillsPromptSection,
} from '../core/coder/skills/prompt-injector.js';
import type { ResolvedSkill } from '../core/coder/skills/types.js';

/**
 * Skills section sizing — guards the cost reduction of the lazy default.
 * The previous behaviour dumped every skill name + description into the
 * system prompt on every turn (~3k tokens for 47 skills). The lazy mode
 * trades the up-front list for a single pointer + a tool call when needed.
 */

function fakeSkill(id: string, description = `Description for ${id}`): ResolvedSkill {
  return {
    id,
    name: id,
    description,
    slashCommand: null,
    promptBody: `body of ${id}`,
    allowedTools: null,
    modelOverride: null,
    providerOverride: null,
    contextMode: 'auto',
    pathPatterns: null,
    triggerPaths: null,
    triggerRoles: null,
    triggerTags: null,
    tags: [],
    source: 'builtin',
    sortOrder: 0,
  };
}

describe('skills prompt modes — sizing + determinism', () => {
  describe('buildLazySkillsSection (default)', () => {
    it('returns a single short pointer regardless of skill count', () => {
      const for10 = buildLazySkillsSection(10);
      const for47 = buildLazySkillsSection(47);
      // Both contain the count and the tool reference
      expect(for10).toContain('10 skill');
      expect(for47).toContain('47 skill');
      expect(for47).toContain('get_skills_list');
      expect(for47).toContain('get_skill_content');
      // Lazy mode is bounded — never grows with skill count
      expect(for47.length).toBeLessThan(400);
      // 0 skills → empty string (no awareness block)
      expect(buildLazySkillsSection(0)).toBe('');
    });

    it('produces identical output across calls (cache-stable)', () => {
      expect(buildLazySkillsSection(47)).toBe(buildLazySkillsSection(47));
    });
  });

  describe('buildCompactSkillsSection', () => {
    it('lists only IDs, sorted, no descriptions', () => {
      const skills = [
        fakeSkill('zeta-skill', 'desc with lots of words that should NOT appear'),
        fakeSkill('alpha-skill'),
        fakeSkill('mu-skill'),
      ];
      const out = buildCompactSkillsSection(skills);
      // IDs present
      expect(out).toContain('alpha-skill');
      expect(out).toContain('mu-skill');
      expect(out).toContain('zeta-skill');
      // Descriptions absent
      expect(out).not.toContain('lots of words');
      // Sorted alphabetically
      const alphaIdx = out.indexOf('alpha-skill');
      const muIdx = out.indexOf('mu-skill');
      const zetaIdx = out.indexOf('zeta-skill');
      expect(alphaIdx).toBeLessThan(muIdx);
      expect(muIdx).toBeLessThan(zetaIdx);
    });

    it('compact mode is meaningfully smaller than full mode', () => {
      const skills = Array.from({ length: 30 }, (_, i) =>
        fakeSkill(`skill-${i}`, 'A reasonably detailed description that runs about a hundred and fifty characters or so to mimic real skills like the ones we ship.'),
      );
      const compactBytes = buildCompactSkillsSection(skills).length;
      const fullBytes = buildSkillsPromptSection(skills, {
        PROJECT_NAME: 'p',
        PROJECT_ROOT: '/p',
        SESSION_ID: '1',
        OS: 'linux',
        TIMESTAMP: 'now',
      }).length;
      expect(compactBytes).toBeLessThan(fullBytes / 2);
    });

    it('returns empty for 0 skills', () => {
      expect(buildCompactSkillsSection([])).toBe('');
    });
  });

  describe('byte-stability across the modes', () => {
    const skills = [
      fakeSkill('b-skill'),
      fakeSkill('a-skill'),
      fakeSkill('c-skill'),
    ];
    const ctx = {
      PROJECT_NAME: 'p',
      PROJECT_ROOT: '/p',
      SESSION_ID: '1',
      OS: 'linux',
      TIMESTAMP: 'now',
    };

    it('lazy is byte-stable', () => {
      expect(buildLazySkillsSection(skills.length)).toBe(buildLazySkillsSection(skills.length));
    });

    it('compact is byte-stable regardless of input order', () => {
      const a = buildCompactSkillsSection([skills[0], skills[1], skills[2]]);
      const b = buildCompactSkillsSection([skills[2], skills[0], skills[1]]);
      expect(a).toBe(b);
    });

    it('full mode is byte-stable regardless of input order', () => {
      const a = buildSkillsPromptSection([skills[0], skills[1], skills[2]], ctx);
      const b = buildSkillsPromptSection([skills[2], skills[0], skills[1]], ctx);
      expect(a).toBe(b);
    });
  });
});
