/**
 * Skill matcher — decides which `auto`-mode skills are relevant for the
 * current session context.
 *
 * The legacy "inline" mode injected every active skill into every system
 * prompt regardless of whether the skill applied to the task at hand. That
 * polluted prompts and let agents ignore the skills they actually needed.
 *
 * The matcher reads three frontmatter signals (set by ensure-builtin-skills
 * via migration 055):
 *
 *   - `trigger.roles` — a subordinate role name (e.g. `extractor`) that
 *     auto-loads the skill. Strongest signal: confidence 1.0.
 *   - `trigger.tags` — session-level tags (e.g. `design-system`). Stored
 *     as `trigger:<tag>` markers in the flat tags column. Confidence 0.7.
 *   - `trigger.paths` — glob patterns matched against `recentFiles`.
 *     Confidence 0.6.
 *
 * Skills with no triggers (or scores below the threshold) are still
 * discoverable through `get_skills_list` and `invoke_skill`; they're just
 * not pre-loaded into the system prompt.
 */
import { minimatch } from 'minimatch';
import type { ResolvedSkill } from '@mcp/code-agent/skills/types.js';

export interface SkillMatchContext {
  /** Subordinate role (e.g. 'extractor') or 'master' for the orchestrator. */
  role?: string;
  /** 'master' for the orchestrator, 'subordinate' for spawned agents. */
  mode?: 'master' | 'subordinate';
  /** Project root or sandbox workdir — used as a fallback file for path triggers. */
  cwd?: string;
  /**
   * Files the agent is about to interact with (e.g. files referenced in the
   * task description, or recently edited). Matched against `triggerPaths`.
   */
  recentFiles?: string[];
  /**
   * Session-level tags (e.g. ['design-system', 'qa']). Compared against
   * each skill's `triggerTags`.
   */
  sessionTags?: string[];
}

export interface MatchedSkill extends ResolvedSkill {
  matchConfidence: number;
  matchReason: string;
}

export interface SkillMatchOptions {
  /** Minimum confidence to surface a skill in the system prompt. Default 0.5. */
  threshold?: number;
  /** Cap on number of matched skills to avoid prompt bloat. Default 8. */
  topK?: number;
}

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_TOP_K = 8;

const ROLE_CONFIDENCE = 1.0;
const TAG_CONFIDENCE = 0.7;
const PATH_CONFIDENCE = 0.6;

/**
 * Score a single skill against a context. Returns `null` when no signal fires.
 *
 * Multiple signals can fire on the same skill — the matcher picks the
 * strongest one (role > tag > path) and records its reason for telemetry.
 * We don't add scores together because the dimensions are categorical, not
 * cumulative.
 */
export function scoreSkill(
  skill: ResolvedSkill,
  ctx: SkillMatchContext,
): { confidence: number; reason: string } | null {
  if (skill.triggerRoles && ctx.role && skill.triggerRoles.includes(ctx.role)) {
    return { confidence: ROLE_CONFIDENCE, reason: `role:${ctx.role}` };
  }

  if (skill.triggerTags && ctx.sessionTags && ctx.sessionTags.length > 0) {
    const hit = skill.triggerTags.find((tag) => ctx.sessionTags!.includes(tag));
    if (hit) return { confidence: TAG_CONFIDENCE, reason: `tag:${hit}` };
  }

  const patterns = skill.triggerPaths;
  const candidates = ctx.recentFiles ?? [];
  if (patterns && patterns.length > 0 && candidates.length > 0) {
    for (const pattern of patterns) {
      const file = candidates.find((f) => minimatch(f, pattern, { matchBase: true, nocase: false }));
      if (file) return { confidence: PATH_CONFIDENCE, reason: `path:${pattern}` };
    }
  }

  return null;
}

/**
 * Filter and rank `auto`-mode skills relevant to the current context. Skills
 * with `contextMode === 'tool'` are NOT injected into the prompt by this
 * function — they're surfaced through `invoke_skill` registration instead;
 * `'both'` skills go through both pipelines.
 *
 * Returns matched skills sorted by confidence (desc), then by `sortOrder`
 * (asc), capped at `topK`. Each entry carries `matchConfidence` and
 * `matchReason` so the caller can render explainability ("ds-extractor
 * [trigger:role=extractor]") and feed telemetry.
 */
export function matchSkills(
  skills: ResolvedSkill[],
  ctx: SkillMatchContext,
  opts: SkillMatchOptions = {},
): MatchedSkill[] {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const topK = opts.topK ?? DEFAULT_TOP_K;

  const matched: MatchedSkill[] = [];
  for (const skill of skills) {
    if (skill.contextMode === 'tool') continue;
    const score = scoreSkill(skill, ctx);
    if (!score || score.confidence < threshold) continue;
    matched.push({ ...skill, matchConfidence: score.confidence, matchReason: score.reason });
  }

  matched.sort((a, b) => {
    if (b.matchConfidence !== a.matchConfidence) return b.matchConfidence - a.matchConfidence;
    return a.sortOrder - b.sortOrder;
  });

  return matched.slice(0, topK);
}
