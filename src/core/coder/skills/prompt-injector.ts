/**
 * Skill prompt injector — builds the system prompt awareness block for active skills.
 *
 * Instead of inlining full skill content (which bloats the prompt with many/large skills),
 * we inject a compact list of available skill IDs + descriptions and instruct the model
 * to call `get_skill_content` on demand before starting relevant tasks.
 */
import type { ResolvedSkill, SkillTemplateContext } from './types.js';

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

  const lines = skills.map((s) => {
    const desc = s.description ? `: ${s.description}` : '';
    return `- \`${s.id}\`${desc}`;
  });

  return `\n\n# Active Skills\n\nYou have ${skills.length} skill(s) configured for this session. Before starting a task that may be covered by a skill, load its instructions with \`get_skill_content\`.\n\n${lines.join('\n')}\n\nUse \`get_skills_list\` to see all skills or \`get_skill_content\` with a skill ID to load full instructions.`;
}
