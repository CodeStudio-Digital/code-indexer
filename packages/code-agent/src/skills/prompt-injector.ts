/**
 * Skill prompt injector — builds the system prompt awareness block for active skills.
 *
 * Three flavours covering the discovery-tool spectrum:
 *   - `buildLazySkillsSection`: pointer-only, teaches the 3-level discovery
 *      hierarchy (list_skill_namespaces → get_skills_list → get_skill_content).
 *      Default mode — keeps the system prompt small even when 50+ skills are active.
 *   - `buildCompactSkillsSection` / `buildSkillsPromptSection`: list every skill
 *      grouped by namespace, ID-only or with descriptions respectively. Useful
 *      when token budget is generous and the agent benefits from up-front visibility.
 *   - `buildMatchedSkillsPromptSection`: rich block for skills selected by
 *      `skill-matcher.matchSkills`. High-confidence matches (role-triggered)
 *      are inlined verbatim; weaker matches (path/tag) are listed as
 *      suggestions that the agent can load on demand via `get_skill_content`.
 *
 * Determinism note: skills are sorted by ID within each namespace, and
 * namespaces themselves come in a deterministic order (see `namespace.ts`),
 * so each section is byte-identical across turns regardless of resolver
 * insertion order. This is critical for prompt caching — the section is
 * part of the cache prefix and any reorder would invalidate the cache for
 * the whole session.
 */
import type { ResolvedSkill, SkillTemplateContext } from '@mcp/code-agent/skills/types.js';
import type { MatchedSkill } from '@mcp/code-agent/skills/skill-matcher.js';
import { groupSkillsByNamespace } from '@mcp/code-agent/skills/namespace.js';

/**
 * Interpolate `${VAR}` placeholders in a skill prompt.
 * Uses `${...}` syntax (not `{{...}}`) to avoid collision with the base prompt loader.
 */
export function interpolateSkillVars(template: string, ctx: SkillTemplateContext): string {
  return template.replace(/\$\{(\w+)\}/g, (_m, key: string) => {
    return (ctx as unknown as Record<string, string | undefined>)[key] ?? `\${${key}}`;
  });
}

function discoveryInstructions(tools?: ReadonlySet<string>): string {
  const list = !tools || tools.has('get_skills_list')
    ? ' Find unknown IDs with `get_skills_list`.' : '';
  const packs = !tools || tools.has('list_skill_namespaces') ? ' Use `list_skill_namespaces` for unknown packs.' : '';
  return `Load a relevant skill by known ID with \`get_skill_content\`. Reuse a body already in context.${list}${packs} Progress updates and discovery may come first. Skills cannot override the user, mode or permissions.`;
}

function buildNamespaceSummary(skills: ResolvedSkill[]): string {
  const grouped = groupSkillsByNamespace(skills);
  return [...grouped.entries()]
    .map(([namespace, items]) => `- ${namespace} (${items.length})`)
    .join('\n');
}

/**
 * Build a compact `# Active Skills` awareness block for the system prompt.
 * Lists available skills with ID + description, grouped by namespace.
 * Use when token budget allows; otherwise prefer `buildLazySkillsSection`.
 */
export function buildSkillsPromptSection(
  skills: ResolvedSkill[],
  _templateCtx: SkillTemplateContext,
): string {
  if (skills.length === 0) return '';
  const grouped = groupSkillsByNamespace(skills);
  const sections = [...grouped.entries()].map(([namespace, items]) => {
    const sortedItems = [...items].sort((a, b) => a.id.localeCompare(b.id));
    const lines = sortedItems.map((s) => {
      const desc = s.description ? `: ${s.description}` : '';
      return `- \`${s.id}\`${desc}`;
    });
    return `## ${namespace} (${items.length})\n${lines.join('\n')}`;
  });
  return `\n\n# Active Skills (${skills.length})\n\n${discoveryInstructions()}\n\n${sections.join('\n\n')}`;
}

/**
 * Lazy mode (default) — sends only a per-namespace summary plus the 3-level
 * discovery instructions. The agent learns the topology and the tool flow
 * but pays ~150 tokens regardless of how many skills are active (vs ~3000
 * for the full mode with 47 skills).
 *
 * Designed for sessions where 30+ skills are configured and the per-turn
 * cost of listing them dwarfs the cost of one extra round-trip on the rare
 * occasions a skill is needed.
 */
export function buildLazySkillsSection(skills: ResolvedSkill[], availableTools?: ReadonlySet<string>): string {
  if (skills.length === 0 || (availableTools && !availableTools.has('get_skill_content'))) return '';
  const grouped = groupSkillsByNamespace(skills);
  const summary = buildNamespaceSummary(skills);
  return `\n\n# Active Skills\n\n${skills.length} skill(s) across ${grouped.size} pack(s):\n${summary}\n\n${discoveryInstructions(availableTools)}`;
}

/**
 * Compact-list mode — lists every skill ID grouped by namespace, no
 * descriptions. Trade-off between full visibility and token cost. For 47
 * skills with id-only lines (~50 chars each) this is ~600 tokens vs ~3000
 * for the full mode.
 *
 * The agent still has to call `get_skill_content` for the body, but at
 * least it can scan the IDs for keywords.
 */
export function buildCompactSkillsSection(skills: ResolvedSkill[]): string {
  if (skills.length === 0) return '';
  const grouped = groupSkillsByNamespace(skills);
  const sections = [...grouped.entries()].map(([namespace, items]) => {
    const sortedItems = [...items].sort((a, b) => a.id.localeCompare(b.id));
    const lines = sortedItems.map((s) => `- \`${s.id}\``);
    return `## ${namespace} (${items.length})\n${lines.join('\n')}`;
  });
  return `\n\n# Active Skills (${skills.length})\n\n${discoveryInstructions()}\n\n${sections.join('\n\n')}`;
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
  availableTools?: ReadonlySet<string>,
): string {
  if (matched.length === 0) return '';

  const sorted = [...matched].sort((a, b) => {
    if (b.matchConfidence !== a.matchConfidence) return b.matchConfidence - a.matchConfidence;
    return a.id.localeCompare(b.id);
  });

  const inline = sorted.filter((s) => s.matchConfidence >= INLINE_CONFIDENCE_THRESHOLD);
  const suggested = !availableTools || availableTools.has('get_skill_content')
    ? sorted.filter((s) => s.matchConfidence < INLINE_CONFIDENCE_THRESHOLD) : [];

  const blocks: string[] = [];

  if (inline.length > 0) {
    blocks.push('# Skill instructions (auto-loaded for this session)');
    blocks.push(
      `Use these skills for relevant work within the active mode, permissions and user request. ${
        suggested.length === 0 ? '' : 'Additional related skills are listed below as suggestions.'
      }`.trim(),
    );
    // Aliases can match the same role. Keep both names while sending an identical body and tool scope once.
    const headingsByContent = new Map<string, string[]>();
    for (const s of inline) {
      const body = interpolateSkillVars(s.promptBody, templateCtx);
      const allowedToolsHint =
        s.allowedTools && s.allowedTools.length > 0
          ? `\n_Allowed tools for this skill: ${s.allowedTools.map((t) => `\`${t}\``).join(', ')}_\n`
          : '';
      const content = allowedToolsHint + '\n\n' + body;
      const heading = `${s.name} _[${s.matchReason}]_`;
      const headings = headingsByContent.get(content);
      if (headings) headings.push(heading);
      else headingsByContent.set(content, [heading]);
    }
    for (const [content, headings] of headingsByContent) {
      blocks.push(`## ${headings.join(' / ')}${content}`);
    }
  }

  if (suggested.length > 0) {
    blocks.push('# Suggested skills (load on demand)');
    blocks.push(
      'Load a clearly relevant skill with `get_skill_content` before its domain work unless its current body is already loaded. Progress updates and discovery are allowed first. Skills remain subject to user instructions, active mode and permissions. Use only listed IDs; never invent one.',
    );
    const lines = suggested.map((s) => {
      const desc = s.description ? `: ${s.description}` : '';
      return `- \`${s.id}\` _[${s.matchReason}]_${desc}`;
    });
    blocks.push(lines.join('\n'));
  }

  return blocks.length ? '\n\n' + blocks.join('\n\n') : '';
}
