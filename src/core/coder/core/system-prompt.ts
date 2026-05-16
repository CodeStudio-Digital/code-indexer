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
import type { AgentId } from '../agents/index.js';

/**
 * Cache-stratification marker. Everything BEFORE this line is intended to be
 * byte-identical across sessions of the same (project, provider, profile,
 * planMode, agentLoopV2) tuple — that's the prefix the model provider's
 * cache can hit. Everything AFTER varies per session (custom MCP tiers
 * registered, project-specific hook output, repo map of recently-edited
 * files). Borrowed from claude-code's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`
 * (see docs/agent-research/COMPARISON.md, R2). Inert text — providers
 * pass it through to the model as a comment line; cache logic can split
 * on it for ephemeral-breakpoint placement.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '<!-- SYSTEM_PROMPT_DYNAMIC_BOUNDARY -->';

/**
 * PR-6 (Row 23) — short agent-loop framing intended for SUBAGENT system
 * prompts. Subagents don't receive the live `<active-context>` injection
 * (no persistent goal/todos), so this block omits the active-context
 * pointer but keeps the discipline rules: persist end-to-end, do not
 * re-read already-fetched files. Append to a subagent's domain-specific
 * system prompt when `agentLoopV2` is on.
 */
export function buildSubagentLoopFraming(): string {
  return `

# Agent loop (subagent)
Persist until the assigned task is fully resolved end-to-end before yielding. Do not stop at analysis or partial fixes — carry changes through implementation, verification, and a clear final summary.

Only stop when one of these holds:
1. The delegated task is complete and verified.
2. You are blocked by a structural constraint (missing file, permission denied, sandbox refusal) that the parent must resolve.
3. You have produced the result block format the parent expects.

If a tool call fails, persevere: read the error, adjust, retry. Do not stop on first failure.

# Do not re-read what you already have
Before reading a file (\`read_file\`, \`mcp__read_file\`, \`mcp__get_file_skeleton\`, \`mcp__get_file_structure\`) check the prior tool results. The slice resolver snaps line ranges to enclosing symbols, so shifting \`around_line\` by a few does NOT yield new content. The runner refuses identical-result reads after the second duplicate — repeating yourself burns the parent's tokens and stalls the session.`;
}

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
   * cached preamble/body prefix when files are edited. Budget resolved by
   * `resolveRepoMapBudget` in index.ts — auto-sized by indexed file count
   * (off for <50-file projects). Honors `CODER_REPOMAP_TOKENS` override.
   */
  repoMap?: string;
  /**
   * Opt-in to Agent Loop v2 framing — adds a static "Agent loop" + "Active
   * context" block to the system prompt. The runner pairs this with a live
   * <active-context> user-message injection each turn (goal, todos, active
   * task scope). Gated per session so existing sessions keep their original
   * prompt on resume; index.ts sets this for newly-created sessions.
   */
  agentLoopV2?: boolean;
  /**
   * Built-in agent identity — `explore` / `plan` / `build` / `admin`. When
   * set (and not 'plan'), the matching `prompts/{agentId}.txt` is loaded and
   * appended below the optional plan section to give the mode a concrete
   * behavioural identity (what it should and shouldn't do, tool discipline,
   * output shape). 'plan' is handled via planSection / plan.txt already, so
   * we skip the redundant load for it. Fixed at session creation → lives
   * above the dynamic boundary so it stays cache-stable.
   */
  agentId?: AgentId;
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
  // ─── STATIC PREFIX ─────────────────────────────────────────────────
  // Everything in this block is determined entirely by inputs that are
  // fixed at session creation: provider family, project identity, OS,
  // planMode, profile, agentLoopV2 flag, and the static MCP availability
  // signals. Two sessions that share these inputs share this prefix
  // byte-for-byte — that's what lets the model provider's prompt cache
  // hit across sessions of the same (project, provider, profile, ...) tuple.

  const preamble = providerPreamble(ctx.providerFamily ?? 'generic');

  // Main body — loaded from src/core/coder/prompts/base.txt. Placeholders:
  //   {{projectName}}, {{projectRoot}}, {{os}}, {{tierHint}}, {{mcpSection}}
  // tierHint here is the profile-only text; customTiers render below the
  // boundary because the registered MCP-server tier set is volatile.
  const base = interpolate(loadPrompt('base'), {
    projectName: ctx.projectName,
    projectRoot: ctx.projectRoot,
    os: ctx.os,
    tierHint: tierHint(ctx.profile),
    mcpSection: mcpSection(ctx.mcpAvailable, ctx.isIndexed),
  });

  // Plan section — optional, only when planMode is true. Loaded from plan.txt.
  const planSection = ctx.planMode ? `\n\n${loadPrompt('plan')}` : '';

  // Mode identity section — concrete behavioural prompt for the active built-in
  // agent (`explore` / `build` / `admin`). 'plan' is already covered by
  // planSection via plan.txt, so we don't double-load it. Fixed at session
  // creation → cache-stable; sits above the dynamic boundary.
  const agentSection =
    ctx.agentId && ctx.agentId !== 'plan'
      ? `\n\n${loadPrompt(ctx.agentId)}`
      : '';

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

  // Static "agent loop" + "do not re-read" + "active context pointer". The
  // dynamic payload (live goal / todos / active task scope) is injected as
  // the last user message each turn under <active-context>...</active-context>
  // by the runner — see buildActiveContextBlock in runner.ts. Keeping the
  // pointer here static preserves prefix-cache stability; only the trailing
  // user message changes turn over turn.
  //
  // Gated on ctx.agentLoopV2 so older sessions don't see the new framing on
  // resume — they keep behaving the way they were started.
  const agentLoopBlock = ctx.agentLoopV2 ? buildAgentLoopBlock() : '';

  // Optional Agentless-style pipeline hint (B7). Off by default. When the
  // CODER_AGENTLESS_MODE=1 env is set, we add a short procedural directive:
  // localize → plan → patch → verify. Env-gated at process startup so it is
  // effectively static for a deployment — kept above the boundary.
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

  // ─── DYNAMIC SUFFIX ────────────────────────────────────────────────
  // Everything below the boundary marker can vary across sessions of the
  // same (project, provider, profile, ...) tuple. Cache logic that splits
  // on SYSTEM_PROMPT_DYNAMIC_BOUNDARY can place ephemeral breakpoints
  // exactly here.

  const customTiersText = customTiersBlock(ctx.customTiers);

  // Plugin hook — projects can drop `.mcp-indexer/hooks/system-prompt.js`
  // to append extra instructions without forking the coder. Runs in a vm
  // sandbox with 200ms timeout; on failure returns '' so the prompt is
  // unchanged. Output is project-supplied and may read disk → treat as
  // dynamic and place below the boundary.
  const extra = runSystemPromptHook(ctx.projectRoot, {
    projectName: ctx.projectName,
    projectRoot: ctx.projectRoot,
    os: ctx.os,
    profile: ctx.profile,
  });
  const extraBlock = extra ? `\n\n# Project-specific instructions\n${extra}` : '';

  // Repo map varies as files are edited — the most volatile dynamic section.
  // When the project is below the auto-sizing threshold (or CODER_REPOMAP_TOKENS=0)
  // ctx.repoMap is empty/undefined and this collapses to nothing.
  const repoMapBlock = ctx.repoMap && ctx.repoMap.length > 0 ? `\n\n${ctx.repoMap}` : '';

  const dynamicSuffix = `${customTiersText}${extraBlock}${repoMapBlock}`;
  // ALWAYS emit the boundary, even when the dynamic suffix is empty. The
  // marker itself costs ~50 chars but it gives consumers a byte-stable
  // hinge to split on — splitting tests, cache-instrumentation code, and
  // future ephemeral-breakpoint placement can all rely on the marker
  // being there. Without this guarantee, the static prefix's tail would
  // differ between "no dynamic content" and "dynamic content present"
  // sessions because of trailing-newline rules.
  const boundary = `\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}`;

  return `${preamble}${base}${planSection}${agentSection}${interactionSection}${agentLoopBlock}${agentlessHint}${boundary}${dynamicSuffix}`;
}

/**
 * Static "Agent loop" framing. Cache-stable: depends only on ctx.agentLoopV2
 * (a session-fixed flag). Borrows from codex `gpt_5_1_prompt.md` for the
 * persistence directive and preamble guidance — see
 * docs/agent-research/COMPARISON.md, R6.
 */
function buildAgentLoopBlock(): string {
  return `

# Agent loop
You are a coding agent. Persist until the user's request is fully resolved end-to-end within the current turn whenever feasible: do not stop at analysis, partial fixes, or "here's what I'd do" — carry changes through implementation, verification, and a clear final summary unless the user explicitly pauses or redirects you. Update todos progressively as you work — flip to in_progress before starting an item, completed immediately after finishing. Do not batch completions.

Only stop when one of these holds:
1. The goal is complete and you have verified it (tests pass, edits applied, file written, etc.).
2. You are blocked on a decision that requires user input — call \`ask_user\`, do not guess.
3. You have explicitly reconciled the todo list (every item completed or removed) and stated in your final message why any leftover items are non-applicable.

If a tool call fails, persevere: read the error, adjust, retry. Do not stop on the first failure unless it is genuinely unrecoverable.

# Preambles before tool calls
Before each tool call (or grouped batch of related calls) emit a 1–2 sentence preamble explaining what you are about to do. Keep it tight: roughly 8–12 words for a quick update, longer only when the action is novel and needs context.
- Group related calls into ONE preamble — do not narrate every individual read.
- Build on prior context: connect to what was just done so the user sees momentum.
- Skip preambles for trivial reads inside a larger grouped action you already announced.
- Keep the tone collaborative and concrete; no apologies, no restating the user's question.

# Do not re-read what you already have
Before reading a file (\`read_file\`, \`mcp__read_file\`, \`mcp__get_file_skeleton\`, \`mcp__get_file_structure\`) check the prior tool results in this conversation:
- If the same path/range/symbol was already returned, the content is in your context. Do NOT re-fetch — quote it from memory or scroll back.
- The slice resolver snaps \`around_line\` to enclosing symbols, so shifting the line number by a few does NOT yield new content. If the previous read returned lines X–Y and your new \`around_line\` falls inside that range, you will get the same body back.
- If you genuinely need a different region, change \`start_line\`/\`end_line\` or pass a different \`symbol\` — and only after confirming the previous slice did not cover it.
- After \`apply_patch\`, \`edit_file\`, or \`multi_edit\`, the tool already reported the result. Re-reading just to verify is wasteful — only re-read if the edit failed or you need adjacent context not in your last view.
The runner enforces this: identical-content tool results are refused after the second duplicate. Repeating yourself burns tokens and stalls the session.

# Active context
Each turn you will receive a final user message wrapped in \`<active-context>...</active-context>\` containing the live goal, todo list, and any active task scope. Read it before acting — it is the source of truth, more authoritative than older history.`;
}

/**
 * Emit a short hint about the tiered tool system when the runner started
 * with a profile smaller than 'full'. The agent needs to know that certain
 * tools are hidden and how to unlock them via `expand_toolset`. Profile is
 * fixed at session start, so this text is byte-stable for the session and
 * lives in the cached prefix above SYSTEM_PROMPT_DYNAMIC_BOUNDARY.
 *
 * NOTE: customTiers were previously inlined here, but they varied with MCP
 * server registration and so polluted the cached prefix across sessions of
 * the same project. They now render in `customTiersBlock` below the
 * boundary instead.
 */
function tierHint(profile?: 'bootstrap' | 'navigate' | 'full'): string {
  if (!profile || profile === 'full') {
    return '';
  }

  if (profile === 'bootstrap') {
    return `# Tool tiers (IMPORTANT)
You started in the **bootstrap** tier. Only ~13 essential read/search tools are visible right now (get_project_pulse, query_snapshots, get_context_for, search, grep_code, get_file_skeleton, read_file, list_directory, ask_user, submit_plan, submit_tasks, expand_toolset).

Write/edit/git/shell tools and deep navigation tools (find_references, trace_usage, prepare_edit, get_symbol_body, etc.) are HIDDEN. To unlock them, call \`expand_toolset({tier: "navigate", reason: "..."})\`. They become visible on the next turn.

Admin tools (git_commit, add_snapshot, index_project, ...) require \`expand_toolset({tier: "admin"})\` — unlock ONLY when the user explicitly asks.

Rule of thumb: stay in bootstrap for informational questions. Unlock navigate the moment you realize the task requires code changes, shell commands, or deep cross-reference analysis.
`;
  }
  // navigate
  return `# Tool tiers
You started in the **navigate** tier. Bootstrap + write/edit/shell/git-read/deep-navigation tools are visible. Admin tools (git_commit, add_snapshot, index_project, costs/models, snapshot mutations) are HIDDEN — call \`expand_toolset({tier: "admin"})\` ONLY when the user explicitly asks for them.
`;
}

/**
 * Render the external-MCP custom-tiers listing. Lives BELOW the dynamic
 * boundary because the set of registered tiers varies with MCP server
 * connection state (a project may add or remove a server between sessions
 * without touching its identity). Sorted lexicographically by tier name so
 * within a single session the text is byte-stable across turns even if the
 * registry's iteration order varies.
 */
function customTiersBlock(
  customTiers?: Array<{ tier: string; displayName: string; toolCount: number }>,
): string {
  if (!customTiers || customTiers.length === 0) return '';
  const sorted = [...customTiers].sort((a, b) => a.tier.localeCompare(b.tier));
  return (
    '\n\n# External tool groups (hidden, on-demand)\n' +
    'The following external MCP server tool groups are available but HIDDEN. ' +
    'Call `expand_toolset({tier: "<name>"})` to unlock:\n' +
    sorted.map((t) => `- "${t.tier}" (${t.toolCount} tools) — ${t.displayName}`).join('\n') +
    '\nUnlock ONLY when your task requires them. They stay active for the rest of the session.\n'
  );
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
This project ships ~41 MCP tools (prefixed \`mcp__\`) for semantic codebase navigation. The bootstrap tier shows the cheap, common ones; deeper tools (find_references, prepare_edit, semantic_neighbors, etc.) live in the \`navigate\` tier and are loaded on demand.

The 5 default cheap entry points (always visible):
1. \`mcp__get_project_pulse\` — ultra-compact overview (~100 tokens). Start here.
2. \`mcp__query_snapshots\` — full-text search over saved knowledge. Try this BEFORE exploring code.
3. \`mcp__get_context_for\` — curated bundle for "how does X work?". Add \`hyde: true\` if recall is weak.
4. \`mcp__search\` / \`mcp__grep_code\` — hybrid search and ripgrep with filters.
5. \`mcp__get_file_skeleton\` — file outline; ALWAYS prefer over a full \`read_file\`.

When you need a tool you cannot see in the visible tools array:
- Call \`find_tools({ query: "<what you need>" })\` first — it searches the FULL catalog (all tiers) and returns up to 5 matches with their tier and a hint to unlock.
- Then call \`expand_toolset({ tier: "<tier>" })\` if needed; the new tools become visible next turn.

Always prefer MCP semantic tools over native file reads. Never grep when \`mcp__find_references\` exists.
`;
}
