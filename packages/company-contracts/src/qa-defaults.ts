import type { RoleSkills } from './models/template.js';

/** Inspect declarations without evaluating or replacing conditional branches. */
export function declaredRoleSkillIds(skills: unknown): string[] {
  if (Array.isArray(skills)) return skills.filter((skill): skill is string => typeof skill === 'string');
  if (!skills || typeof skills !== 'object') return [];
  const config = skills as Record<string, unknown>;
  return [
    ...(typeof config.primary === 'string' ? [config.primary] : []),
    ...(Array.isArray(config.chain) ? config.chain.filter((skill): skill is string => typeof skill === 'string') : []),
    ...(Array.isArray(config.conditional) ? config.conditional.flatMap((branch) => branch && typeof branch === 'object' && typeof branch.skill === 'string' ? [branch.skill] : []) : []),
  ];
}

/** New QA roles use the desktop preview; explicit regression skills survive. */
export function withDefaultQaSkill<T extends { role: string; skills?: RoleSkills }>(role: T): T {
  if (!/^(qa|quality|verifier)(?:[-_ ].*)?$/i.test(role.role.trim())) return role;
  if (declaredRoleSkillIds(role.skills).some((skill) => skill === 'qa-preview' || skill === 'qa-playwright')) return role;
  if (!role.skills || Array.isArray(role.skills)) return { ...role, skills: [...(role.skills ?? []), 'qa-preview'] };
  return { ...role, skills: { ...role.skills, chain: [...(role.skills.chain ?? []), 'qa-preview'] } };
}
