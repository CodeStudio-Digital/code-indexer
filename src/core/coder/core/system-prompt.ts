/**
 * System prompt for the coder agent.
 *
 * Mirrors the rules in CLAUDE.md so the agent prefers token-efficient MCP tools
 * over raw file reads, and uses snapshots as long-term memory for the project.
 *
 * The body lives in `../prompts/*.txt` — see loader.ts. This file is only the
 * composer: it picks the right provider preamble, loads the base body, splices
 * in the plan section when needed, and interpolates project variables + the
 * tier hint.
 *
 * Per-provider preambles (`providerFamily`) tune tone/format per model family
 * AND — crucially — give each family its own stable, unique prefix so the
 * server-side prompt cache (Anthropic ephemeral, ZAI/GLM auto, OpenAI's
 * system-prefix cache) hits reliably without cross-provider cache pollution.
 */
import { loadPrompt, interpolate } from '../prompts/loader.js';
import { runSystemPromptHook } from './hooks.js';
import type { ResolvedSkill, SkillTemplateContext } from '../skills/types.js';
import { buildSkillsPromptSection } from '../skills/prompt-injector.js';
export type ProviderFamily = 'anthropic' | 'openai' | 'zai' | 'gemini' | 'deepseek' | 'generic';

export interface PromptContext {
  projectName: string;
  projectRoot: string;
  os: string;
  planMode?: boolean;
  providerFamily?: ProviderFamily;
  /** Profile the runner started in ('bootstrap' | 'navigate' | 'full'). Controls the tier hint. */
  profile?: 'bootstrap' | 'navigate' | 'full';
  /**
   * Custom tiers from external MCP servers. Listed in the tier hint so the
   * agent knows which external tool groups are available for on-demand expansion.
   */
  customTiers?: Array<{ tier: string; displayName: string; toolCount: number }>;
  /** Resolved skills for the session (inline ones get injected into the prompt). */
  skills?: ResolvedSkill[];
  /** Session ID for skill template variable interpolation. */
  sessionId?: string;
}

/**
 * Small provider-specific header rendered at the top of the system prompt.
 * Keep these under ~12 lines — their value is (a) nudging each family's
 * known formatting quirks, (b) giving each family a stable prefix.
 */
function providerPreamble(family: ProviderFamily): string {
  switch (family) {
    case 'anthropic':
      // Claude already obeys XML tags and handles long contexts — keep it brief.
      return `<role>Coding agent (Claude family).</role>
<formatting>
- Use tool calls aggressively; prefer parallel independent tool calls in one turn.
- Text output to the user is rendered as markdown. Keep it terse.
- When you cite code, use \`file:line\` format.
</formatting>
`;
    case 'openai':
      // GPT-4/5 responds well to explicit checklists and "think step by step" cues.
      return `# Role
You are a coding agent (OpenAI GPT family).

# Formatting rules
- Issue tool calls instead of describing what you would do.
- Independent tool calls MUST be emitted in parallel in the same turn.
- Terse markdown replies. Cite code as \`file:line\`.
- Never apologize or restate the user's request.
`;
    case 'zai':
      // ZAI/GLM is very sensitive to prefix drift — bit-stable header matters.
      // GLM also benefits from explicit "use Chinese only if user does" nudge.
      return `# Role: Coding agent (GLM family)

# Hard rules
- Respond in the user's language. Default English.
- Always prefer tool calls over narration. Emit independent tool calls in parallel.
- No emojis unless the user uses them first.
- Code citations: \`file:line\`.
- Keep text replies short; the user reads diffs, not recaps.
`;
    case 'gemini':
      return `# Role
Coding agent (Gemini family).

# Formatting
- Prefer tool calls over explanations.
- Emit independent tool calls in parallel in one turn.
- Markdown, terse. Cite code as \`file:line\`.
`;
    case 'deepseek':
      return `# Role: Coding agent (DeepSeek family)

# Rules
- Tool calls > narration. Parallelize independent calls in one turn.
- Terse markdown. Code citations as \`file:line\`.
- No preamble, no summary unless asked.
`;
    case 'generic':
    default:
      return `# Role
You are a coding agent.

# Formatting
- Prefer tool calls over narration. Emit independent calls in parallel.
- Terse markdown. Cite code as \`file:line\`.
`;
  }
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const preamble = providerPreamble(ctx.providerFamily ?? 'generic');

  // Main body — loaded from src/core/coder/prompts/base.txt. Placeholders:
  //   {{projectName}}, {{projectRoot}}, {{os}}, {{tierHint}}
  const base = interpolate(loadPrompt('base'), {
    projectName: ctx.projectName,
    projectRoot: ctx.projectRoot,
    os: ctx.os,
    tierHint: tierHint(ctx.profile, ctx.customTiers),
  });

  // Plan section — optional, only when planMode is true. Loaded from plan.txt.
  const planSection = ctx.planMode ? `\n\n${loadPrompt('plan')}` : '';

  // Interactive-tools footer — small enough to keep inline, and the two lines
  // that mention submit_plan/submit_tasks depend on planMode so they'd need
  // a second placeholder dance in the txt file for no real benefit.
  const interactionSection = `

# Interactive tools
- \`ask_user\`: when you need a decision/preference/choice from the user, call this. Provide \`options\` for multiple choice (rendered as buttons) or omit them for free-form. Do NOT use for things you can verify yourself.
- \`submit_plan\`: ${ctx.planMode ? 'REQUIRED before mutating tools when the work is linear/informational (see Plan mode above).' : 'Optional — call when the user explicitly asks for a plan.'}
- \`submit_tasks\`: ${ctx.planMode ? 'REQUIRED instead of submit_plan when the work decomposes into 2+ independent tasks (see Plan mode above).' : 'Optional — for multi-item work that benefits from per-task context curation and individual user approval.'}
- \`execute_task\` / \`task_complete\`: companions to submit_tasks; call execute_task once per approved task in dependency order, then task_complete to close the inline scope.
`;

  // Plugin hook — projects can drop `.mcp-indexer/hooks/system-prompt.js` to
  // append extra instructions without forking the coder. Runs in a vm
  // sandbox with 200ms timeout; on failure returns '' so the prompt is
  // unchanged.
  const extra = runSystemPromptHook(ctx.projectRoot, {
    projectName: ctx.projectName,
    projectRoot: ctx.projectRoot,
    os: ctx.os,
    profile: ctx.profile,
  });
  const extraBlock = extra ? `\n\n# Project-specific instructions\n${extra}` : '';

  // Skills section — inline skills are appended between interaction and hook sections.
  // Resolved once at session start so the prefix stays byte-stable across turns.
  const skillsSection = ctx.skills?.length
    ? buildSkillsPromptSection(ctx.skills, {
        PROJECT_NAME: ctx.projectName,
        PROJECT_ROOT: ctx.projectRoot,
        SESSION_ID: ctx.sessionId ?? '0',
        OS: ctx.os,
        TIMESTAMP: new Date().toISOString(),
      })
    : '';

  return `${preamble}${base}${planSection}${interactionSection}${skillsSection}${extraBlock}`;
}

/**
 * Emit a short hint about the tiered tool system when the runner started
 * with a profile smaller than 'full'. The agent needs to know that certain
 * tools are hidden and how to unlock them via `expand_toolset`. We keep this
 * cache-stable (same text for the same profile) so the system prompt prefix
 * stays byte-identical turn over turn.
 */
function tierHint(
  profile?: 'bootstrap' | 'navigate' | 'full',
  customTiers?: Array<{ tier: string; displayName: string; toolCount: number }>,
): string {
  // Build the custom tiers block (shared across all profiles when custom tiers exist)
  const customBlock = customTiers && customTiers.length > 0
    ? '\n\n## External tool groups (hidden, on-demand)\n' +
      'The following external MCP server tool groups are available but HIDDEN. ' +
      'Call `expand_toolset({tier: "<name>"})` to unlock:\n' +
      customTiers.map((t) => `- "${t.tier}" (${t.toolCount} tools) — ${t.displayName}`).join('\n') +
      '\nUnlock ONLY when your task requires them. They stay active for the rest of the session.\n'
    : '';

  if (!profile || profile === 'full') {
    // Full profile: core tiers are all active, but custom tiers still need expansion
    return customBlock ? `# External tools\n${customBlock}\n` : '';
  }

  if (profile === 'bootstrap') {
    return `# Tool tiers (IMPORTANT)
You started in the **bootstrap** tier. Only ~13 essential read/search tools are visible right now (get_project_pulse, query_snapshots, get_context_for, search, grep_code, get_file_skeleton, read_file, list_directory, ask_user, submit_plan, submit_tasks, expand_toolset).

Write/edit/git/shell tools and deep navigation tools (find_references, trace_usage, prepare_edit, get_symbol_body, etc.) are HIDDEN. To unlock them, call \`expand_toolset({tier: "navigate", reason: "..."})\`. They become visible on the next turn.

Admin tools (git_commit, add_snapshot, index_project, ...) require \`expand_toolset({tier: "admin"})\` — unlock ONLY when the user explicitly asks.

Rule of thumb: stay in bootstrap for informational questions. Unlock navigate the moment you realize the task requires code changes, shell commands, or deep cross-reference analysis.
${customBlock}
`;
  }
  // navigate
  return `# Tool tiers
You started in the **navigate** tier. Bootstrap + write/edit/shell/git-read/deep-navigation tools are visible. Admin tools (git_commit, add_snapshot, index_project, costs/models, snapshot mutations) are HIDDEN — call \`expand_toolset({tier: "admin"})\` ONLY when the user explicitly asks for them.
${customBlock}
`;
}
