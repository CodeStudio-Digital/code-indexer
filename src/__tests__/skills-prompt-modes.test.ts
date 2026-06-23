import { describe, it, expect } from 'vitest';
import {
  buildLazySkillsSection,
  buildCompactSkillsSection,
  buildSkillsPromptSection,
} from '@mcp/code-agent/skills/prompt-injector.js';
import type { ResolvedSkill, SkillSource } from '@mcp/code-agent/skills/types.js';

/**
 * Skills section sizing — guards the cost reduction of the lazy default.
 * The previous behaviour dumped every skill name + description into the
 * system prompt on every turn (~3k tokens for 47 skills). The lazy mode
 * now sends a per-namespace summary (~150 tokens) plus the 3-level
 * discovery instructions (list_skill_namespaces → get_skills_list →
 * get_skill_content), still bounded regardless of skill count.
 */

function fakeSkill(
  id: string,
  options: {
    description?: string;
    source?: SkillSource;
    author?: string | null;
  } = {},
): ResolvedSkill {
  return {
    id,
    name: id,
    description: options.description ?? `Description for ${id}`,
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
    source: options.source ?? 'builtin',
    author: options.author ?? null,
    sortOrder: 0,
  };
}

describe('skills prompt modes — sizing + determinism', () => {
  describe('buildLazySkillsSection (default)', () => {
    it('returns a bounded summary with namespace counts and 3-level discovery instructions', () => {
      const for10 = buildLazySkillsSection(
        Array.from({ length: 10 }, (_, i) =>
          fakeSkill(`builtin-${i}`, { source: 'builtin' }),
        ),
      );
      const for47 = buildLazySkillsSection([
        ...Array.from({ length: 5 }, (_, i) => fakeSkill(`user-${i}`, { source: 'user' })),
        ...Array.from({ length: 12 }, (_, i) =>
          fakeSkill(`pack-a-${i}`, { source: 'imported', author: 'pack-a' }),
        ),
        ...Array.from({ length: 27 }, (_, i) =>
          fakeSkill(`pack-b-${i}`, { source: 'imported', author: 'pack-b' }),
        ),
        ...Array.from({ length: 3 }, (_, i) => fakeSkill(`b-${i}`, { source: 'builtin' })),
      ]);
      // Both contain the count and reference all three discovery tools
      expect(for10).toContain('10 skill');
      expect(for47).toContain('47 skill');
      expect(for47).toContain('list_skill_namespaces');
      expect(for47).toContain('get_skills_list');
      expect(for47).toContain('get_skill_content');
      // Per-namespace summary present
      expect(for47).toContain('user (5)');
      expect(for47).toContain('pack-a (12)');
      expect(for47).toContain('pack-b (27)');
      expect(for47).toContain('builtin (3)');
      // Lazy mode is bounded — never grows with skill count.
      // Even 47 skills across 4 namespaces fits comfortably.
      expect(for47.length).toBeLessThan(900);
      // 0 skills → empty string (no awareness block)
      expect(buildLazySkillsSection([])).toBe('');
    });

    it('produces identical output across calls (cache-stable)', () => {
      const skills = [
        fakeSkill('u-1', { source: 'user' }),
        fakeSkill('b-1', { source: 'builtin' }),
      ];
      expect(buildLazySkillsSection(skills)).toBe(buildLazySkillsSection(skills));
    });

    it('orders namespaces deterministically (user → installed A-Z → builtin → unknown)', () => {
      const skills = [
        fakeSkill('builtin-1', { source: 'builtin' }),
        fakeSkill('zeta-pack-1', { source: 'imported', author: 'zeta-pack' }),
        fakeSkill('user-1', { source: 'user' }),
        fakeSkill('alpha-pack-1', { source: 'imported', author: 'alpha-pack' }),
      ];
      const out = buildLazySkillsSection(skills);
      const userIdx = out.indexOf('user (1)');
      const alphaIdx = out.indexOf('alpha-pack (1)');
      const zetaIdx = out.indexOf('zeta-pack (1)');
      const builtinIdx = out.indexOf('builtin (1)');
      expect(userIdx).toBeGreaterThan(-1);
      expect(userIdx).toBeLessThan(alphaIdx);
      expect(alphaIdx).toBeLessThan(zetaIdx);
      expect(zetaIdx).toBeLessThan(builtinIdx);
    });
  });

  describe('buildCompactSkillsSection', () => {
    it('lists IDs grouped by namespace, sorted alphabetically inside each group, no descriptions', () => {
      const skills = [
        fakeSkill('zeta-skill', {
          source: 'imported',
          author: 'pack-x',
          description: 'desc with lots of words that should NOT appear',
        }),
        fakeSkill('alpha-skill', { source: 'imported', author: 'pack-x' }),
        fakeSkill('user-thing', { source: 'user' }),
      ];
      const out = buildCompactSkillsSection(skills);
      // IDs present
      expect(out).toContain('alpha-skill');
      expect(out).toContain('zeta-skill');
      expect(out).toContain('user-thing');
      // Descriptions absent
      expect(out).not.toContain('lots of words');
      // Namespace headers present
      expect(out).toContain('## user (1)');
      expect(out).toContain('## pack-x (2)');
      // Inside pack-x: alpha before zeta (alphabetical by id)
      const alphaIdx = out.indexOf('alpha-skill');
      const zetaIdx = out.indexOf('zeta-skill');
      expect(alphaIdx).toBeLessThan(zetaIdx);
    });

    it('compact mode is meaningfully smaller than full mode', () => {
      const skills = Array.from({ length: 30 }, (_, i) =>
        fakeSkill(`skill-${i}`, {
          description:
            'A reasonably detailed description that runs about a hundred and fifty characters or so to mimic real skills like the ones we ship.',
        }),
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
      fakeSkill('b-skill', { source: 'builtin' }),
      fakeSkill('a-skill', { source: 'builtin' }),
      fakeSkill('c-skill', { source: 'builtin' }),
    ];
    const ctx = {
      PROJECT_NAME: 'p',
      PROJECT_ROOT: '/p',
      SESSION_ID: '1',
      OS: 'linux',
      TIMESTAMP: 'now',
    };

    it('lazy is byte-stable', () => {
      expect(buildLazySkillsSection(skills)).toBe(buildLazySkillsSection(skills));
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
