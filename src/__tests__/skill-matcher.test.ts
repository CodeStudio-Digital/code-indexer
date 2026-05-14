import { describe, it, expect } from 'vitest';
import { matchSkills, scoreSkill } from '../core/coder/skills/skill-matcher.js';
import type { ResolvedSkill } from '../core/coder/skills/types.js';

function skill(partial: Partial<ResolvedSkill> & { id: string }): ResolvedSkill {
  const { id, ...rest } = partial;
  return {
    id,
    name: id,
    description: '',
    slashCommand: null,
    promptBody: 'body',
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
    author: null,
    sortOrder: 50,
    ...rest,
  };
}

describe('scoreSkill', () => {
  it('returns the strongest signal when multiple fire (role wins)', () => {
    const s = skill({
      id: 'ds-extractor',
      triggerRoles: ['extractor'],
      triggerTags: ['design-system'],
      triggerPaths: ['**/manifest.json'],
    });

    const result = scoreSkill(s, {
      role: 'extractor',
      sessionTags: ['design-system'],
      recentFiles: ['/work/manifest.json'],
    });

    expect(result?.confidence).toBe(1.0);
    expect(result?.reason).toBe('role:extractor');
  });

  it('matches by role when role is in triggerRoles', () => {
    const s = skill({ id: 'ds-extractor', triggerRoles: ['extractor'] });
    expect(scoreSkill(s, { role: 'extractor' })).toEqual({
      confidence: 1.0,
      reason: 'role:extractor',
    });
  });

  it('does not match when role is unrelated', () => {
    const s = skill({ id: 'ds-extractor', triggerRoles: ['extractor'] });
    expect(scoreSkill(s, { role: 'master' })).toBeNull();
  });

  it('matches by sessionTag overlap with triggerTags', () => {
    const s = skill({ id: 'ds-storybook', triggerTags: ['design-system'] });
    expect(scoreSkill(s, { sessionTags: ['design-system'] })).toEqual({
      confidence: 0.7,
      reason: 'tag:design-system',
    });
  });

  it('matches by path glob against recentFiles using minimatch matchBase', () => {
    const s = skill({ id: 'qa-playwright', triggerPaths: ['**/*.spec.ts'] });
    expect(scoreSkill(s, { recentFiles: ['src/foo.spec.ts'] })).toEqual({
      confidence: 0.6,
      reason: 'path:**/*.spec.ts',
    });
  });

  it('returns null when no signals match', () => {
    const s = skill({ id: 'ds-docs', triggerRoles: ['docs-writer'] });
    expect(scoreSkill(s, { role: 'extractor' })).toBeNull();
  });

  it('returns null when skill has no triggers at all', () => {
    const s = skill({ id: 'naked' });
    expect(
      scoreSkill(s, {
        role: 'extractor',
        sessionTags: ['anything'],
        recentFiles: ['x.ts'],
      }),
    ).toBeNull();
  });
});

describe('matchSkills', () => {
  it('skips tool-mode skills (they go through invoke_skill instead)', () => {
    const skills = [
      skill({ id: 'auto-skill', triggerRoles: ['extractor'], contextMode: 'auto' }),
      skill({ id: 'tool-skill', triggerRoles: ['extractor'], contextMode: 'tool' }),
      skill({ id: 'both-skill', triggerRoles: ['extractor'], contextMode: 'both' }),
    ];
    const matched = matchSkills(skills, { role: 'extractor' });
    const ids = matched.map((m) => m.id);
    expect(ids).toContain('auto-skill');
    expect(ids).toContain('both-skill');
    expect(ids).not.toContain('tool-skill');
  });

  it('filters out skills below the threshold', () => {
    const skills = [
      skill({ id: 'role-hit', triggerRoles: ['extractor'] }),       // 1.0
      skill({ id: 'tag-hit', triggerTags: ['design-system'] }),     // 0.7
      skill({ id: 'path-hit', triggerPaths: ['**/*.spec.ts'] }),    // 0.6
    ];
    const matched = matchSkills(
      skills,
      { role: 'extractor', sessionTags: ['design-system'], recentFiles: ['x.spec.ts'] },
      { threshold: 0.65 },
    );
    expect(matched.map((m) => m.id)).toEqual(['role-hit', 'tag-hit']);
  });

  it('sorts by confidence desc then by sortOrder asc', () => {
    const skills = [
      skill({ id: 'a-tag', triggerTags: ['ds'], sortOrder: 60 }),
      skill({ id: 'b-role', triggerRoles: ['extractor'], sortOrder: 70 }),
      skill({ id: 'c-tag', triggerTags: ['ds'], sortOrder: 50 }),
    ];
    const matched = matchSkills(skills, { role: 'extractor', sessionTags: ['ds'] });
    expect(matched.map((m) => m.id)).toEqual(['b-role', 'c-tag', 'a-tag']);
  });

  it('caps results at topK', () => {
    const skills = Array.from({ length: 12 }, (_, i) =>
      skill({ id: `s${i}`, triggerRoles: ['extractor'], sortOrder: i }),
    );
    const matched = matchSkills(skills, { role: 'extractor' }, { topK: 5 });
    expect(matched).toHaveLength(5);
  });

  it('attaches matchConfidence and matchReason to each result', () => {
    const skills = [skill({ id: 'ds-extractor', triggerRoles: ['extractor'] })];
    const matched = matchSkills(skills, { role: 'extractor' });
    expect(matched[0].matchConfidence).toBe(1.0);
    expect(matched[0].matchReason).toBe('role:extractor');
  });

  it('returns empty when no skills match (matcher does NOT fall back to all skills)', () => {
    const skills = [
      skill({ id: 'qa-playwright', triggerPaths: ['**/*.spec.ts'] }),
      skill({ id: 'ds-extractor', triggerRoles: ['extractor'] }),
    ];
    const matched = matchSkills(skills, { role: 'master' });
    expect(matched).toEqual([]);
  });
});
