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
export type ProviderFamily =
  | 'anthropic'
  | 'claude-code'
  | 'openai'
  | 'zai'
  | 'gemini'
  | 'deepseek'
  | 'kimi-code'
  | 'generic';

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
  /** Session ID for skill template variable interpolation. */
  sessionId?: string;
  /**
   * Whether MCP tools were successfully registered. When false, the system
   * prompt instructs the agent to use native tools only, avoiding wasted
   * turns on `mcp__*` calls that would fail.
   */
  mcpAvailable?: boolean;
  /**
   * Whether the project has at least one completed indexing run. When false
   * (even with `mcpAvailable === true`), tools that depend on the symbol DB
   * are stripped at the registry level; the prompt reflects that and steers
   * the agent toward disk-based reads + tree-sitter-aware `read_file`.
   */
  isIndexed?: boolean;
  /**
   * Optional repo map (top-level symbols of recently-modified files).
   * Appended at the END of the system prompt so it doesn't invalidate the
   * cached preamble/body prefix when files are edited. Gated by index.ts
   * via the CODER_REPOMAP_TOKENS env var (off when 0, which is the default).
   */
  repoMap?: string;
}

/**
 * Small provider-specific header rendered at the top of the system prompt.
 * Keep these under ~12 lines — their value is (a) nudging each family's
 * known formatting quirks, (b) giving each family a stable prefix.
 */
function providerPreamble(family: ProviderFamily): string {
  switch (family) {
    case 'anthropic':
    case 'claude-code':
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
    case 'kimi-code':
      return `# Role: Coding agent (Kimi Code family)

# Rules
- Prefer tool calls over narration. Emit independent tool calls in parallel.
- Preserve useful reasoning internally, but keep user-facing text concise.
- Markdown, terse. Cite code as \`file:line\`.
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
  //   {{projectName}}, {{projectRoot}}, {{os}}, {{tierHint}}, {{mcpSection}}
  const base = interpolate(loadPrompt('base'), {
    projectName: ctx.projectName,
    projectRoot: ctx.projectRoot,
    os: ctx.os,
    tierHint: tierHint(ctx.profile, ctx.customTiers),
    mcpSection: mcpSection(ctx.mcpAvailable, ctx.isIndexed),
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

  // Optional Agentless-style pipeline hint (B7). Off by default. When the
  // CODER_AGENTLESS_MODE=1 env is set, we add a short procedural directive:
  // localize → plan → patch → verify. Pure prompt-engineering, no tool
  // changes — the existing submit_plan/submit_tasks/execute_task lifecycle
  // is the substrate, this just nudges the agent to use it linearly for
  // bug-fix-style tasks instead of free-form exploration.
  const agentlessHint = process.env.CODER_AGENTLESS_MODE === '1'
    ? `

# Pipeline mode (procedural)
Follow this order for code-fix tasks; do NOT free-explore:
1. **Localize** — use grep_code / get_symbol_body to identify the smallest set of files+symbols that need to change. Stop as soon as you have a hypothesis you can verify.
2. **Plan** — call submit_plan with the exact files you intend to touch. Wait for approval.
3. **Patch** — make the edits in one or two passes (multi_edit when feasible). Do not browse around.
4. **Verify** — run the relevant test/lint/build and report the result.

This pipeline is more token-efficient than free agents on isolated tasks. If the work decomposes into multiple independent changes, use submit_tasks instead and run the same loop per task.
`
    : '';

  // Repo map goes LAST so file-edit churn doesn't invalidate the cached
  // prefix above. When CODER_REPOMAP_TOKENS=0 (default) ctx.repoMap is
  // empty/undefined and this collapses to nothing.
  const repoMapBlock = ctx.repoMap && ctx.repoMap.length > 0 ? `\n\n${ctx.repoMap}` : '';

  return `${preamble}${base}${planSection}${interactionSection}${extraBlock}${agentlessHint}${repoMapBlock}`;
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
  // Build the custom tiers block (shared across all profiles when custom tiers exist).
  // Sort lexicographically by tier name so the block is byte-identical across
  // turns even if MCP server registration order varies — critical for prompt
  // caching (the block is part of the cached prefix).
  const sortedTiers = customTiers
    ? [...customTiers].sort((a, b) => a.tier.localeCompare(b.tier))
    : undefined;
  const customBlock = sortedTiers && sortedTiers.length > 0
    ? '\n\n## External tool groups (hidden, on-demand)\n' +
      'The following external MCP server tool groups are available but HIDDEN. ' +
      'Call `expand_toolset({tier: "<name>"})` to unlock:\n' +
      sortedTiers.map((t) => `- "${t.tier}" (${t.toolCount} tools) — ${t.displayName}`).join('\n') +
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

/**
 * Conditional MCP tool strategy section. When MCP tools are available,
 * returns the full semantic navigation guide. When unavailable (project not
 * indexed or bridge failed), tells the agent to stick to native tools.
 */
function mcpSection(mcpAvailable?: boolean, isIndexed?: boolean): string {
  if (mcpAvailable === false) {
    return `# Tool strategy — native only (MCP bridge unavailable)
MCP semantic tools (\`mcp__*\`) are NOT available this session. Do NOT call any \`mcp__\` prefixed tool — they will error with "Unknown tool".

Use native tools for all code exploration:
1. \`list_directory\` — browse project structure.
2. \`read_file\` — read file contents. Pass \`symbol: "<name>"\` to get just one function/class body, or \`around_line: <n>\` to grab the symbol that contains that line. Falls back to a line range when the file's language has no AST grammar.
3. \`glob\` (native) or \`run_command\` with \`rg\`/\`grep -rn\` — text search across files.
4. \`run_command\` with \`find\` (or \`dir /s\` on Windows) — file discovery by name/pattern.
`;
  }
  if (isIndexed === false) {
    return `# Tool strategy — project NOT indexed
The MCP bridge is connected, but this project has never been indexed. The runtime kept the tools that have a tree-sitter / disk-grep fallback and stripped the ones that strictly need the symbol DB.

Stripped (do not call): \`get_symbol_details\`, \`get_class_members\`, \`get_hierarchy\`, \`find_implementations\`, \`semantic_neighbors\`, \`get_dependencies\`, \`get_dependents\`, \`search\`, \`search_global\`, \`search_concepts\`, \`search_by_kind\`, \`get_project_overview\`, \`get_project_pulse\`, \`get_architecture\`, \`get_repo_map\`, \`get_context_for\`, \`query_snapshots\`, \`get_project_context\`.

Still available — fall back to tree-sitter or disk grep automatically:
- \`mcp__read_file\`, \`mcp__list_directory\` — overlay-aware.
- \`mcp__grep_code\` — ripgrep on disk.
- \`mcp__get_file_skeleton\`, \`mcp__get_file_structure\` — tree-sitter on disk; outputs are tagged "tree-sitter fallback".
- \`mcp__get_symbol_body\` — regex declaration locator + brace/indent body extractor.
- \`mcp__find_references\`, \`mcp__trace_usage\` (depth=1 only), \`mcp__prepare_edit\` — disk-grep callers + tree-sitter neighbors. Imports/tests are omitted by prepare_edit because they need DB dependency tables.

Native tools that always work:
1. \`read_file\` — pass \`symbol: "<name>"\` for one function/class body, or \`around_line: <n>\` to grab the symbol containing that line.
2. \`glob\` — fast filename matching.
3. \`run_command\` with \`rg\` for text search, \`find\`/\`dir /s\` for path discovery.

If you want full caller graphs / search scoring / vector neighbors, ask the user to index the project via the admin panel.
`;
  }
  return `# Tool strategy — token economy
This project ships with 41 MCP tools (prefixed \`mcp__\`) for semantic codebase navigation. ALWAYS prefer them over native file reads:

1. Start exploration with \`mcp__get_project_pulse\` (~100 tokens) — never \`mcp__get_project_overview\` without a token budget. Check the \`vector_coverage\` line: if it says "none (search will use FTS only)" or shows very low %, prefer \`mcp__grep_code\`/FTS-mode searches over vector/semantic tools on this project.
2. Search existing knowledge with \`mcp__query_snapshots\` BEFORE exploring code manually.
3. For "how does X work?" questions use \`mcp__get_context_for\` (curated bundle). For short NL questions where the first attempt returns weak recall, retry with \`hyde: true\` — it runs an LLM-generated hypothetical-document expansion that dramatically improves recall for questions the codebase never phrases the same way.
4. To understand a file, use \`mcp__get_file_skeleton\` (NOT \`mcp__read_file\` of the whole file, NOT \`mcp__get_file_structure\`).
5. To read just one function/class body, use \`mcp__get_symbol_body\`.
6. Before editing a symbol, use \`mcp__prepare_edit\` — it returns body + callers + neighbors + imports + tests in one call.
7. To find where something is used: \`mcp__find_references\` or \`mcp__trace_usage\`. NEVER grep for that.
8. For text search across files: \`mcp__grep_code\` with filters (\`language\`, \`layer\`, \`glob\`).
9. To find symbols that *behave* similarly to a known one (wrappers, alternative implementations, helpers with different names), use \`mcp__semantic_neighbors\` with the seed symbol_id — it queries body embeddings, so it catches cases where names diverge but logic is alike. Requires \`expand_toolset('navigate')\`. Complements \`mcp__grep_code\` (literal) and \`mcp__find_references\` (syntactic).
`;
}
