/**
 * Skill prompt injector — builds the system prompt awareness block for active skills.
 *
 * Two flavours:
 *   - `buildSkillsPromptSection`: legacy compact list of all active skills.
 *      Used as a fallback when no matcher context is available.
 *   - `buildMatchedSkillsPromptSection`: rich block for skills selected by
 *      `skill-matcher.matchSkills`. High-confidence matches (role-triggered)
 *      are inlined verbatim; weaker matches (path/tag) are listed as
 *      suggestions that the agent can load on demand via `get_skill_content`.
 */
import type { ResolvedSkill, SkillTemplateContext } from './types.js';
import type { MatchedSkill } from './skill-matcher.js';

/**
 * Interpolate `${VAR}` placeholders in a skill prompt.
 * Uses `${...}` syntax (not `{{...}}`) to avoid collision with the base prompt loader.
 */
export function interpolateSkillVars(template: string, ctx: SkillTemplateContext): string {
  return template.replace(/\$\{(\w+)\}/g, (_m, key: string) => {
    return (ctx as unknown as Record<string, string | undefined>)[key] ?? `\${${key}}`;
  });
}

/**
 * Build a compact `# Active Skills` awareness block for the system prompt.
 * Lists available skills with ID + description and instructs the model to call
 * `get_skill_content` before starting relevant tasks — keeping the system prompt
 * small regardless of how many or how large the skills are.
 */
export function buildSkillsPromptSection(
  skills: ResolvedSkill[],
  _templateCtx: SkillTemplateContext,
): string {
  if (skills.length === 0) return '';

  // Sort by skill ID so the awareness block is byte-identical across turns
  // regardless of resolver insertion order. This is critical for prompt
  // caching: the section is part of the cache key prefix and any reorder
  // would invalidate the cache for the whole session.
  const sorted = [...skills].sort((a, b) => a.id.localeCompare(b.id));
  const lines = sorted.map((s) => {
    const desc = s.description ? `: ${s.description}` : '';
    return `- \`${s.id}\`${desc}`;
  });

  return `\n\n# Active Skills\n\nYou have ${skills.length} skill(s) configured for this session. Before starting a task that may be covered by a skill, load its instructions with \`get_skill_content\`.\n\n${lines.join('\n')}\n\nUse \`get_skills_list\` to see all skills or \`get_skill_content\` with a skill ID to load full instructions.`;
}

/** Confidence threshold above which a matched skill is inlined verbatim. */
const INLINE_CONFIDENCE_THRESHOLD = 0.9;

/**
 * Build the system prompt block for skills auto-selected by the matcher.
 *
 * Two-tier output:
 *   - Inline: skills with confidence ≥ 0.9 (today: only role triggers) get
 *     their full body interpolated into the prompt. The agent doesn't need
 *     to call `get_skill_content` — they're already loaded.
 *   - Suggested: skills with confidence < 0.9 (path/tag triggers) are listed
 *     as candidates with their match reason. The agent calls
 *     `get_skill_content` to load them on demand.
 *
 * Skills not surfaced by the matcher remain discoverable through
 * `get_skills_list` (registered separately by the runner).
 */
export function buildMatchedSkillsPromptSection(
  matched: MatchedSkill[],
  templateCtx: SkillTemplateContext,
): string {
  if (matched.length === 0) return '';

  const sorted = [...matched].sort((a, b) => {
    if (b.matchConfidence !== a.matchConfidence) return b.matchConfidence - a.matchConfidence;
    return a.id.localeCompare(b.id);
  });

  const inline = sorted.filter((s) => s.matchConfidence >= INLINE_CONFIDENCE_THRESHOLD);
  const suggested = sorted.filter((s) => s.matchConfidence < INLINE_CONFIDENCE_THRESHOLD);

  const blocks: string[] = [];

  if (inline.length > 0) {
    blocks.push('# Skill instructions (auto-loaded for this session)');
    blocks.push(
      `These skills were auto-loaded based on your role and session context. Follow their instructions when relevant. ${
        suggested.length === 0 ? '' : 'Additional related skills are listed below as suggestions.'
      }`.trim(),
    );
    for (const s of inline) {
      const body = interpolateSkillVars(s.promptBody, templateCtx);
      const allowedToolsHint =
        s.allowedTools && s.allowedTools.length > 0
          ? `\n_Allowed tools for this skill: ${s.allowedTools.map((t) => `\`${t}\``).join(', ')}_\n`
          : '';
      blocks.push(`## ${s.name} _[${s.matchReason}]_${allowedToolsHint}\n\n${body}`);
    }
  }

  if (suggested.length > 0) {
    blocks.push('# Suggested skills (load on demand)');
    blocks.push(
      'The following skills may apply to your current context. Call `get_skill_content` with a skill ID to load full instructions before starting that work.',
    );
    const lines = suggested.map((s) => {
      const desc = s.description ? `: ${s.description}` : '';
      return `- \`${s.id}\` _[${s.matchReason}]_${desc}`;
    });
    blocks.push(lines.join('\n'));
  }

  return '\n\n' + blocks.join('\n\n');
}
