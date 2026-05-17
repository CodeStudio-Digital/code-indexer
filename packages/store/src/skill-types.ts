/**
 * Skill schema types — owned by the store layer.
 *
 * Persisted shapes for skill definitions live here so the SkillStore can
 * type its rows without reaching into other packages. Consumer packages
 * (code-agent) re-export these and add their own runtime concerns on top.
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
