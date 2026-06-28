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

const DISCOVERY_INSTRUCTIONS = [
  'To find and use a skill, walk this 3-level hierarchy:',
  '1. `list_skill_namespaces({})` — see installed packs with counts, repos, and sample IDs (use this first to pick a pack by topic)',
  '2. `get_skills_list({namespace: "X"})` — list skills inside a pack you picked',
  '3. `get_skill_content({skill_id: "Y"})` — load full instructions before starting that work',
  '',
  'Skip ahead if you already know the right pack or skill. The hierarchy exists to keep token cost low — do not list everything just to browse.',
  'When a skill clearly matches the request, loading and following it is a BLOCKING REQUIREMENT — do it BEFORE any other tool call or prose. Only use a skill id that appears in your active list or one the user typed as `/<name>`; never invent or guess a skill id from memory.',
].join('\n');

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
  return `\n\n# Active Skills (${skills.length})\n\nGrouped by namespace (pack). Before starting a task that may be covered by a skill, load its body with \`get_skill_content\`.\n\n${DISCOVERY_INSTRUCTIONS}\n\n${sections.join('\n\n')}`;
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
export function buildLazySkillsSection(skills: ResolvedSkill[]): string {
  if (skills.length === 0) return '';
  const grouped = groupSkillsByNamespace(skills);
  const summary = buildNamespaceSummary(skills);
  return `\n\n# Active Skills\n\nYou have ${skills.length} skill(s) across ${grouped.size} pack(s) (namespaces):\n${summary}\n\n${DISCOVERY_INSTRUCTIONS}`;
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
  return `\n\n# Active Skills (${skills.length})\n\nIDs grouped by namespace (pack). Call \`get_skill_content\` with an ID to load the full instructions.\n\n${DISCOVERY_INSTRUCTIONS}\n\n${sections.join('\n\n')}`;
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
      'The following skills may apply to your current context. If one clearly matches the request, loading and following it is a BLOCKING REQUIREMENT — call `get_skill_content` with its ID to load the full instructions BEFORE any other tool call or prose. Use only the IDs listed here or in your active skills; never invent a skill id.',
    );
    const lines = suggested.map((s) => {
      const desc = s.description ? `: ${s.description}` : '';
      return `- \`${s.id}\` _[${s.matchReason}]_${desc}`;
    });
    blocks.push(lines.join('\n'));
  }

  return '\n\n' + blocks.join('\n\n');
}
