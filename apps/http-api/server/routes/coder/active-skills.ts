/**
 * Resolve and interpolate the skill bodies for IDs the user pre-selected in
 * the sidebar's SkillsSection.
 *
 * Historical note: this module used to prepend an `<active_skills>` block
 * directly into the user's message body so the model would see the skills
 * inline on the next turn. The downside was that the enriched (huge)
 * content got persisted into `coder_messages.content_json`, bloating the
 * chat transcript with thousands of tokens of skill instructions per turn.
 *
 * Today the route handler stores the user's raw text + a small array of
 * skill IDs (`coder_messages.selected_skill_ids_json`, migration 095). The
 * runner re-resolves the IDs every turn inside `assembleMessagesForChat`
 * and inlines the bodies as a per-turn `<active_skills>` block on the
 * trailing user message — same mechanism as `<active-context>`, never
 * persisted. This module is no longer used by the request handler; it
 * stays only as a deprecated helper kept available to legacy callers.
 *
 * @deprecated The block is now assembled by the runner per turn; do not
 *   pre-compute it from the HTTP layer.
 */
import { interpolateSkillVars } from '@mcp/code-agent/skills/prompt-injector.js';
import type { SkillTemplateContext } from '@mcp/code-agent/skills/types.js';
import type { CoderDeps, CoreDeps } from '../../deps.js';

export interface PreparedActiveSkills {
  /** Skill blocks already interpolated against the session/project context, deduped, order-preserved. */
  blocks: string[];
  /** IDs that were resolved and turned into blocks. */
  applied: string[];
  /** IDs that were requested but could not be resolved (deleted / unknown). */
  missing: string[];
}

type EnrichDeps = Pick<CoderDeps, 'sessionStore' | 'skillStore'> & Pick<CoreDeps, 'db'>;

/**
 * Resolve each picked skill against the store, interpolate template vars,
 * and return ordered, deduped markdown blocks. The caller is responsible
 * for wrapping them into `<active_skills>…</active_skills>` and deciding
 * where to inject (system prompt, last user message, etc.).
 */
export function prepareActiveSkillsBlocks(
  userInput: string,
  skillIds: readonly string[],
  sessionId: number,
  deps: EnrichDeps,
): PreparedActiveSkills {
  if (skillIds.length === 0) {
    return { blocks: [], applied: [], missing: [] };
  }
  const session = deps.sessionStore.getSession(sessionId);
  if (!session) {
    return { blocks: [], applied: [], missing: [...skillIds] };
  }
  const project = deps.db.getProject(session.project_id);
  const store = deps.skillStore;
  const templateCtx: SkillTemplateContext = {
    SESSION_ID: String(sessionId),
    PROJECT_NAME: project?.name ?? '',
    PROJECT_ROOT: project?.root_path ?? '',
    OS: process.platform,
    TIMESTAMP: new Date().toISOString(),
    USER_INPUT: userInput,
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
  }

  return { blocks, applied, missing };
}
