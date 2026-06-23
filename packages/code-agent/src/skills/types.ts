/**
 * Skill system types.
 *
 * Persisted shapes (ResolvedSkill, SkillContextMode, SkillSource) are owned
 * by the store layer and re-exported here so code-agent callers keep the
 * same import surface. Runtime-only types (SkillTemplateContext) live here.
 */
export type { ResolvedSkill, SkillContextMode, SkillSource } from '@mcp/store/skill-types.js';

/** Context variables available for template interpolation in skill prompts. */
export interface SkillTemplateContext {
  PROJECT_NAME: string;
  PROJECT_ROOT: string;
  SESSION_ID: string;
  OS: string;
  USER_INPUT?: string;
  TIMESTAMP: string;
}
