import { describe, expect, it } from 'vitest';
import type { ResolvedSkill } from '../types.js';
import { resolveActiveWorkspaceSkills } from '../workspace-skills.js';

function skill(id: string): ResolvedSkill {
  return {
    id,
    name: id,
    description: id,
    slashCommand: null,
    promptBody: '',
    allowedTools: null,
    modelOverride: null,
    providerOverride: null,
    contextMode: 'auto',
    pathPatterns: null,
    triggerPaths: null,
    triggerRoles: null,
    triggerTags: null,
    tags: [],
    source: 'user',
    author: null,
    sortOrder: 0,
  };
}

describe('resolveActiveWorkspaceSkills', () => {
  it('aggregates project skills and deduplicates shared global entries', () => {
    const calls: number[] = [];
    const resolved = resolveActiveWorkspaceSkills({
      resolveActiveSkills(_sessionId, projectId) {
        calls.push(projectId);
        return projectId === 7
          ? [skill('global-guidance'), skill('backend-only')]
          : [skill('global-guidance'), skill('intranet-only')];
      },
    }, 1219, [7, 11]);

    expect(calls).toEqual([7, 11]);
    expect(resolved.map((entry) => entry.id)).toEqual([
      'global-guidance',
      'backend-only',
      'intranet-only',
    ]);
  });
});
