import {
  toResolved,
  type SkillDefinition,
} from '@mcp/store/skill-store.js';
import type { ResolvedSkill } from '@mcp/code-agent/skills/types.js';

export interface ActiveSkillCatalog {
  listSkills(filter?: { scope?: string }): SkillDefinition[];
}

/**
 * Resolve global + linked-project definitions. When `activeSkillIds` is
 * present it is the filesystem session's explicit projection; absence means
 * use the current globally enabled defaults for a newly-created session.
 */
export function resolveActiveWorkspaceSkills(
  store: ActiveSkillCatalog,
  projectIds: readonly number[],
  activeSkillIds?: readonly string[] | null,
): ResolvedSkill[] {
  const definitions = new Map<string, SkillDefinition>();
  for (const skill of store.listSkills({ scope: 'global' })) {
    definitions.set(skill.id, skill);
  }
  for (const projectId of projectIds) {
    for (const skill of store.listSkills({ scope: String(projectId) })) {
      if (!definitions.has(skill.id)) definitions.set(skill.id, skill);
    }
  }
  const explicit =
    activeSkillIds == null ? null : new Set(activeSkillIds);
  return [...definitions.values()]
    .filter((skill) => explicit ? explicit.has(skill.id) : skill.enabled)
    .sort(
      (left, right) =>
        left.sort_order - right.sort_order ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    )
    .map(toResolved);
}
