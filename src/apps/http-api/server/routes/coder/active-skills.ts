/**
 * Server-side enrichment for user messages that arrive with manually
 * pre-selected skill IDs (the sidebar's SkillsSection).
 *
 * The picked skills are expanded into an `<active_skills>` block prepended to
 * the user message body — full interpolated prompt body included — so the
 * agent receives the skill content inline on the very next turn, without
 * needing to call `get_skill_content` / `invoke_skill` first.
 *
 * This complements (does NOT replace) the auto-matcher in
 * `src/core/coder/skills/skill-matcher.ts`. Auto-matched skills still appear
 * in the system prompt; picked skills are reinforced inside the user message
 * so the model treats them as deliberately requested for THIS turn.
 */
import { interpolateSkillVars } from '../../../../../core/coder/skills/prompt-injector.js';
import type { SkillTemplateContext } from '../../../../../core/coder/skills/types.js';
import type { CoderDeps, CoreDeps } from '../../deps.js';

export interface EnrichResult {
  /** Final content with the `<active_skills>` block prepended, or the original if nothing applied. */
  content: string;
  /** IDs that were resolved and inlined. */
  applied: string[];
  /** IDs that were requested but could not be resolved (deleted / unknown). */
  missing: string[];
}

type EnrichDeps = Pick<CoderDeps, 'sessionStore' | 'skillStore'> & Pick<CoreDeps, 'db'>;

/**
 * Build the `<active_skills>` block and return the enriched content.
 *
 * Reuses the shared `deps.skillStore` (no extra DB handle) so calls from the
 * request handler hit the same WAL transaction set as everything else.
 *
 * Logs a usage row with `invoked_by='user'` for every applied skill so the
 * admin telemetry tab can attribute manual picks.
 */
export async function enrichContentWithActiveSkills(
  content: string,
  skillIds: readonly string[],
  sessionId: number,
  deps: EnrichDeps,
): Promise<EnrichResult> {
  if (skillIds.length === 0) {
    return { content, applied: [], missing: [] };
  }
  const session = deps.sessionStore.getSession(sessionId);
  if (!session) {
    return { content, applied: [], missing: [...skillIds] };
  }
  const project = deps.db.getProject(session.project_id);
  const store = deps.skillStore;
  const templateCtx: SkillTemplateContext = {
    SESSION_ID: String(sessionId),
    PROJECT_NAME: project?.name ?? '',
    PROJECT_ROOT: project?.root_path ?? '',
    OS: process.platform,
    TIMESTAMP: new Date().toISOString(),
    USER_INPUT: content,
  };

  const applied: string[] = [];
  const missing: string[] = [];
  const blocks: string[] = [];
  // Dedupe while preserving order so the block is deterministic when the
  // client accidentally double-picks (e.g. clicked twice through a render).
  const seen = new Set<string>();
  for (const id of skillIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const skill = store.getSkill(id);
    if (!skill) {
      missing.push(id);
      continue;
    }
    const interpolated = interpolateSkillVars(skill.prompt_body, templateCtx);
    blocks.push(`## ${skill.id} — ${skill.name}\n\n${interpolated}`);
    applied.push(skill.id);
    store.logSkillUsage({
      session_id: sessionId,
      skill_id: id,
      invoked_by: 'user',
      input_text: content,
    });
  }

  if (blocks.length === 0) {
    return { content, applied, missing };
  }
  const enriched = `<active_skills>\n${blocks.join('\n\n')}\n</active_skills>\n\n${content}`;
  return { content: enriched, applied, missing };
}
