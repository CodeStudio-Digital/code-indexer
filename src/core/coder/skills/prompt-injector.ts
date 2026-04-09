/**
 * Skill prompt injector — builds the system prompt section for inline skills.
 *
 * Skills with context_mode 'inline' or 'both' get their prompt_body interpolated
 * and appended as a dedicated section in the system prompt. This section is inserted
 * AFTER the interaction section and BEFORE the project-specific hook output.
 *
 * A configurable budget guard (CODER_SKILL_PROMPT_BUDGET, default 4000 chars)
 * prevents skills from consuming too much of the context window. Skills are
 * included in sort_order; overflow skills are dropped with a notice.
 */
import type { ResolvedSkill, SkillTemplateContext } from './types.js';

const DEFAULT_BUDGET = 4000;

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
 * Build the `# Active Skills` system prompt section from resolved inline skills.
 * Returns empty string if no inline skills are active.
 */
export function buildSkillsPromptSection(
  skills: ResolvedSkill[],
  templateCtx: SkillTemplateContext,
): string {
  const inlineSkills = skills.filter(
    (s) => s.contextMode === 'inline' || s.contextMode === 'both',
  );
  if (inlineSkills.length === 0) return '';

  const budget = parseInt(process.env.CODER_SKILL_PROMPT_BUDGET ?? '', 10) || DEFAULT_BUDGET;
  let usedChars = 0;
  const sections: string[] = [];
  const dropped: string[] = [];

  // Skills are already sorted by sortOrder from resolveActiveSkills
  for (const skill of inlineSkills) {
    const interpolated = interpolateSkillVars(skill.promptBody, templateCtx);
    const header = `## Skill: ${skill.name}${skill.slashCommand ? ` (/${skill.slashCommand})` : ''}`;
    const desc = skill.description ? `${skill.description}\n` : '';
    const section = `${header}\n${desc}${interpolated}`;

    if (usedChars + section.length > budget && sections.length > 0) {
      dropped.push(skill.name);
      continue;
    }
    sections.push(section);
    usedChars += section.length;
  }

  let result = `\n\n# Active Skills\n\n${sections.join('\n\n')}`;
  if (dropped.length > 0) {
    result += `\n\n> ${dropped.length} skill(s) omitted due to prompt budget: ${dropped.join(', ')}`;
  }
  return result;
}
