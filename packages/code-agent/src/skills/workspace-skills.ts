import type { ResolvedSkill } from '@mcp/code-agent/skills/types.js';

export interface ActiveSkillResolver {
  resolveActiveSkills(sessionId: number, projectId: number): ResolvedSkill[];
}

/** Resolve real-project skills for a workspace, deduping shared global skills. */
export function resolveActiveWorkspaceSkills(
  store: ActiveSkillResolver,
  sessionId: number,
  projectIds: readonly number[],
): ResolvedSkill[] {
  const byId = new Map<string, ResolvedSkill>();
  for (const projectId of projectIds) {
    for (const skill of store.resolveActiveSkills(sessionId, projectId)) {
      if (!byId.has(skill.id)) byId.set(skill.id, skill);
    }
  }
  return [...byId.values()];
}
