/**
 * Skill system types.
 *
 * A Skill is a reusable prompt instruction package with metadata controlling
 * how and when it's injected into the agent conversation. Skills can be:
 *   - inline: injected into the system prompt
 *   - tool: callable by the model via invoke_skill
 *   - both: inline + tool
 */

export type SkillContextMode = 'inline' | 'tool' | 'both';
export type SkillSource = 'user' | 'builtin' | 'imported';

/** Runtime representation of a resolved skill ready for injection. */
export interface ResolvedSkill {
  id: string;
  name: string;
  description: string;
  slashCommand: string | null;
  promptBody: string;
  allowedTools: string[] | null;
  modelOverride: string | null;
  providerOverride: string | null;
  contextMode: SkillContextMode;
  pathPatterns: string[] | null;
  source: SkillSource;
  sortOrder: number;
}

/** Context variables available for template interpolation in skill prompts. */
export interface SkillTemplateContext {
  PROJECT_NAME: string;
  PROJECT_ROOT: string;
  SESSION_ID: string;
  OS: string;
  USER_INPUT?: string;
  TIMESTAMP: string;
}
