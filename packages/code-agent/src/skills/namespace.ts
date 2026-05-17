/**
 * Namespace derivation + grouping for the skill discovery tools and prompt
 * sections.
 *
 * Each skill belongs to exactly one namespace (a "pack"):
 *   - `user`     — skills the user authored (source='user')
 *   - `builtin`  — skills shipped with the app (source='builtin')
 *   - `<author>` — skills imported via agent-skills-installer; the namespace
 *                  is the `author` field on the skill (set during install)
 *   - `unknown`  — imported skills with no author (rare edge case)
 *
 * The grouping ordering is deterministic — `user` first, installed
 * namespaces alphabetically, then `builtin`, then `unknown`. This ordering
 * is part of the system-prompt cache key prefix (see prompt-injector.ts),
 * so keep it stable.
 */
import type { ResolvedSkill } from '@mcp/code-agent/skills/types.js';

export const SKILL_NS_USER = 'user';
export const SKILL_NS_BUILTIN = 'builtin';
export const SKILL_NS_UNKNOWN = 'unknown';

/** A subset of ResolvedSkill fields needed to derive the namespace. */
type NamespacedSkill = Pick<ResolvedSkill, 'source' | 'author'>;

export function deriveSkillNamespace(skill: NamespacedSkill): string {
  if (skill.source === 'user') return SKILL_NS_USER;
  if (skill.source === 'builtin') return SKILL_NS_BUILTIN;
  if (skill.author && skill.author.length > 0) return skill.author;
  return SKILL_NS_UNKNOWN;
}

/**
 * Group skills by namespace, returning a Map with deterministic ordering:
 * `user` → installed packs (alphabetical) → `builtin` → `unknown`.
 *
 * Within each group, the skills appear in the order they were passed in;
 * callers that need byte-stable output should pre-sort by `id`.
 */
export function groupSkillsByNamespace<T extends NamespacedSkill>(
  skills: readonly T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const s of skills) {
    const key = deriveSkillNamespace(s);
    const bucket = map.get(key) ?? [];
    bucket.push(s);
    map.set(key, bucket);
  }
  const sorted = new Map<string, T[]>();
  const userBucket = map.get(SKILL_NS_USER);
  if (userBucket) sorted.set(SKILL_NS_USER, userBucket);
  const installedKeys = [...map.keys()]
    .filter((k) => k !== SKILL_NS_USER && k !== SKILL_NS_BUILTIN && k !== SKILL_NS_UNKNOWN)
    .sort((a, b) => a.localeCompare(b));
  for (const k of installedKeys) sorted.set(k, map.get(k)!);
  const builtinBucket = map.get(SKILL_NS_BUILTIN);
  if (builtinBucket) sorted.set(SKILL_NS_BUILTIN, builtinBucket);
  const unknownBucket = map.get(SKILL_NS_UNKNOWN);
  if (unknownBucket) sorted.set(SKILL_NS_UNKNOWN, unknownBucket);
  return sorted;
}
