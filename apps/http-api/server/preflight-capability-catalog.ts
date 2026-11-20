/**
 * Builds the skill catalog the task-preflight analyzer reasons over (active
 * skills for the session). Kept out of deps.ts
 * (a god-file) so the merge/cap logic stays small and testable.
 *
 * Fail-open by construction: any failure degrades to the native catalog / an
 * empty skill list, never throws — preflight is best-effort.
 */
import { deriveSkillNamespace } from '@mcp/code-agent/skills/namespace.js';
import { resolveActiveWorkspaceSkills } from '@mcp/code-agent/skills/workspace-skills.js';
import type { SkillStore } from '@mcp/store/skill-store.js';
import type {
  PreflightSkillMeta,
} from '@mcp/services/services/task-preflight/index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_SKILLS_MAX = 30;

/**
 * Active skills for the session (project-scoped + session overrides), shaped
 * for the analyzer: id + description + namespace. Capped to bound prompt cost.
 */
export function buildPreflightSkillCatalog(
  skillStore: SkillStore,
  projectId: number,
  activeSkillIds?: readonly string[] | null,
  projectRoot?: string,
): PreflightSkillMeta[] {
  try {
    let dependencies = new Set<string>();
    if (projectRoot) {
      try {
        const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as Record<string, unknown>;
        for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          const section = pkg[key];
          if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
          for (const name of Object.keys(section)) dependencies.add(name.toLowerCase());
        }
      } catch { /* non-Node projects simply have no package evidence */ }
    }
    return resolveActiveWorkspaceSkills(
      skillStore,
      [projectId],
      activeSkillIds,
    )
      .slice(0, DEFAULT_SKILLS_MAX)
      .map((s) => {
        const definition = typeof (skillStore as SkillStore & { getSkill?: unknown }).getSkill === 'function'
          ? skillStore.getSkill(s.id)
          : null;
        const packageNames = [...`${s.name} ${s.description}`.matchAll(/@[a-z0-9._-]+\/[a-z0-9._-]+/gi)]
          .map((m) => m[0]!.toLowerCase())
          .filter((name, index, all) => all.indexOf(name) === index);
        return {
          id: s.id,
          name: s.name,
          description: s.description,
          namespace: deriveSkillNamespace(s),
          scope: definition?.scope,
          triggerPaths: s.triggerPaths ?? undefined,
          triggerRoles: s.triggerRoles ?? undefined,
          triggerTags: s.triggerTags ?? undefined,
          packageNames,
          dependencyMatched: packageNames.some((name) => dependencies.has(name)),
        };
      });
  } catch {
    return [];
  }
}
