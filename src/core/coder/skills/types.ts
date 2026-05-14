/**
 * Skill system types.
 *
 * A Skill is a reusable prompt instruction package with metadata controlling
 * how and when it's injected into the agent conversation. Skills can be:
 *   - auto: injected into the system prompt only when the matcher
 *     (skill-matcher.ts) considers the skill relevant for the current
 *     session context (role, recent files, tags). Replaces the legacy
 *     "inline" mode, which always injected regardless of relevance.
 *   - tool: callable by the model via invoke_skill
 *   - both: auto-injected + also callable via invoke_skill
 */

export type SkillContextMode = 'auto' | 'tool' | 'both';
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
  /** @deprecated Use `triggerPaths`. Retained until builtin .md migration completes. */
  pathPatterns: string[] | null;
  /** Glob patterns that auto-trigger this skill when recent files match. */
  triggerPaths: string[] | null;
  /** Subordinate roles that auto-load this skill (e.g. ['extractor']). */
  triggerRoles: string[] | null;
  /** Tags that auto-load this skill when present in the session. */
  triggerTags: string[] | null;
  /** Free-form tag list (used by matcher and dashboard filtering). */
  tags: string[];
  source: SkillSource;
  /**
   * Pack origin — set to the namespace name for skills installed via
   * agent-skills-installer (e.g. "anthropic-skills"). null for user-authored
   * or built-in skills. Used by the discovery tools to group skills by pack.
   */
  author: string | null;
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
