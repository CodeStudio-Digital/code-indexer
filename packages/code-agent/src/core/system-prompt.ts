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
 * AND — crucially — give each native family its own stable prefix so the
 * server-side prompt cache (Anthropic ephemeral, ZAI/GLM auto, OpenAI's
 * system-prefix cache) hits reliably without cross-provider cache pollution.
 * OpenRouter intentionally reuses the OpenAI-compatible preamble.
 */
import { loadPrompt, interpolate } from '@mcp/code-agent/prompts/loader.js';
import { describeShell } from '@mcp/code-agent/core/shell-info.js';
import { runSystemPromptHook } from '@mcp/code-agent/core/hooks.js';
import type { AgentId } from '@mcp/code-agent/agents/index.js';
import type { WorkspaceContext } from './workspace.js';

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
The runner refuses identical-content tool results after the second duplicate. Reads snap to the enclosing symbol — nudging \`around_line\` inside a range you already received returns the same body. Repeating yourself burns the parent's tokens and stalls the session.`;
}

export type ProviderFamily =
  | 'anthropic'
  | 'claude-code'
  | 'openai'
  | 'openrouter'
  | 'zai'
  | 'gemini'
  | 'deepseek'
  | 'kimi-code'
  | 'generic';

export interface PromptContext {
  projectName: string;
  projectRoot: string;
  /**
   * When provided, prompt builders prefer `workspace.displayName` /
   * `workspace.rootPath` over the legacy `projectName`/`projectRoot`
   * fields. Carrying the full context lets future call sites pass in
   * sandbox-bound workspaces without re-deriving fields one by one.
   */
  workspace?: WorkspaceContext;
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
  /**
   * Model catalog cap vs. full registry size, computed once at session
   * start. When the cap is smaller than the catalog, a "Tool visibility"
   * block renders BELOW the dynamic boundary (it varies by model and
   * registry size, so it must not pollute the shared static prefix)
   * teaching the model the find_tools → direct-call-pins → expand_toolset
   * ladder. Numbers are session-start values — fine if slightly stale
   * after tier promotions.
   */
  toolCap?: { maxTools: number; approxCatalog: number };
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
  /**
   * True for single (non-company) sessions where the Session Drive tools
   * (`save_note` / `list_notes` / `read_plan` / `recall_investigations`) are
   * registered. Gates the "Session working memory" section so company
   * subordinates — which lack those tools — never see it. Set from the same
   * `!companyContext` condition that registers the tools. Session-fixed →
   * cache-stable, stays above the dynamic boundary.
   */
  sessionDrive?: boolean;
  /**
   * Whether the active model natively consumes images. `true` drops the
   * "Images & vision" section (it only explains the image→text fallback);
   * `false`/`undefined` keeps it. Session-fixed (model is fixed) →
   * cache-stable, one more axis of the static-prefix tuple. The caller
   * passes `false` when the composer "Describe images" flag forces the
   * fallback even on vision-capable models.
   */
  modelCanSeeImages?: boolean;
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
    case 'openrouter':
      // OpenAI-compatible models respond well to explicit checklist-style cues.
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
  const displayName = ctx.workspace?.displayName ?? ctx.projectName;
  const rootPath = ctx.workspace?.rootPath ?? ctx.projectRoot;
  const base = interpolate(loadPrompt('base'), {
    projectName: displayName,
    projectRoot: rootPath,
    // Rich, platform-derived shell descriptor (not a bare "win32"): tells the
    // model the real shell (cmd.exe vs bash) + what NOT to reach for. Cuts the
    // ~69% run_command failure rate from Unix idioms on Windows.
    os: describeShell(ctx.os),
    tierHint: tierHint(ctx.profile),
    mcpSection: mcpSection(ctx.mcpAvailable, ctx.isIndexed),
    visionSection: visionSection(ctx.modelCanSeeImages),
    memorySection: memorySection(ctx.sessionDrive),
  });

  // Plan section — optional, only when planMode is true AND the active agent
  // isn't `spec` (spec mode has its own gate via submit_spec / spec.txt and
  // should NOT also load plan.txt to avoid contradictory tool-discipline
  // instructions).
  const planSection = ctx.planMode && ctx.agentId !== 'spec'
    ? `\n\n${loadPrompt('plan')}`
    : '';

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
  const isSpec = ctx.agentId === 'spec';
  const interactionSection = `

# Interactive tools
- \`ask_user\`: when you need a decision/preference/choice from the user, call this. Provide \`options\` for multiple choice (rendered as buttons) or omit them for free-form. Do NOT use for things you can verify yourself.${isSpec ? `
- \`submit_spec\`: REQUIRED before any mutating tool (see Spec mode above). Pass \`{ name, body, parent_id? }\`. The runner writes the spec to \`.mcp/specs/<slug>-<unix>.md\` and blocks until a human approves or requests changes.` : ''}
- \`submit_plan\`: ${isSpec ? 'BLOCKED in spec mode — the spec IS the plan.' : ctx.planMode ? 'REQUIRED before mutating tools when the work is linear/informational (see Plan mode above).' : 'Optional — call when the user explicitly asks for a plan.'}
- \`submit_tasks\`: ${isSpec ? 'BLOCKED before spec approval. After approval, derive tasks from the spec\'s Implementation Plan and call submit_tasks.' : ctx.planMode ? 'REQUIRED instead of submit_plan when the work decomposes into 2+ independent tasks (see Plan mode above).' : 'Optional — for multi-item work that benefits from per-task context curation and individual user approval.'}
- \`list_tasks\` / \`execute_tasks\` / \`task_complete\`: companions to submit_tasks. Task ids are backend-generated \`tsk_...\`; \`execute_tasks\` ONCE dispatches the whole approved list in dependency waves; \`task_complete\` only closes an inline scope opened by \`execute_tasks\` — never call it on a subagent-mode task.
- \`cancel_tasks\` / \`delete_tasks\` / \`archive_task_list\`: abandon, remove, or clear task rounds. Never reuse legacy ids like \`task_1\`.
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
  const toolCapText = toolCapBlock(ctx.toolCap);

  // Plugin hook — projects can drop `.mcp-indexer/hooks/system-prompt.js`
  // to append extra instructions without forking the coder. Runs in a vm
  // sandbox with 200ms timeout; on failure returns '' so the prompt is
  // unchanged. Output is project-supplied and may read disk → treat as
  // dynamic and place below the boundary.
  const extra = runSystemPromptHook(rootPath, {
    projectName: displayName,
    projectRoot: rootPath,
    os: ctx.os,
    profile: ctx.profile,
  });
  const extraBlock = extra ? `\n\n# Project-specific instructions\n${extra}` : '';

  // Repo map varies as files are edited — the most volatile dynamic section.
  // When the project is below the auto-sizing threshold (or CODER_REPOMAP_TOKENS=0)
  // ctx.repoMap is empty/undefined and this collapses to nothing.
  const repoMapBlock = ctx.repoMap && ctx.repoMap.length > 0 ? `\n\n${ctx.repoMap}` : '';

  const dynamicSuffix = `${toolCapText}${customTiersText}${extraBlock}${repoMapBlock}`;
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
Before each tool call (or grouped batch of related calls) emit a 1–2 sentence preamble: what you're about to do, ~8–12 words, connected to what was just done. ONE preamble per related group — don't narrate every individual read. Concrete and collaborative; no apologies, no restating the question.

# Do not re-read what you already have
The runner refuses identical-content tool results after the second duplicate. Reads snap to the enclosing symbol — nudging \`around_line\` inside a range you already received returns the same body. After a successful \`edit_file\`/\`multi_edit\`/\`apply_patch\`, trust the tool result; re-read only on failure or for adjacent context you have not seen.

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
    // No enumeration of VISIBLE tools — the model already sees them (with
    // descriptions) in the tools array; the hint's job is what's hidden.
    return `# Tool tiers (IMPORTANT)
You started in the **bootstrap** tier — the essential read/search, workflow, and delegation tools you can already see in your tools array. Write/edit/git/shell and deep-navigation tools (find_references, trace_usage, prepare_edit, get_symbol_body, ...) are HIDDEN: call \`expand_toolset({tier: "navigate", reason: "..."})\` the moment the task requires code changes, shell commands, or deep cross-reference analysis (visible next turn). Admin tools (git_commit, add_snapshot, index_project, ...) need \`expand_toolset({tier: "admin"})\` — unlock ONLY when the user explicitly asks. Stay in bootstrap for informational questions.
`;
  }
  // navigate
  return `# Tool tiers
You started in the **navigate** tier. Bootstrap + write/edit/shell/git-read/deep-navigation tools are visible (including \`save_memory\` to persist durable project memory). Admin tools (git_commit, add_snapshot, index_project, costs/models, snapshot mutations) are HIDDEN — call \`expand_toolset({tier: "admin"})\` ONLY when the user explicitly asks for them.
`;
}

/**
 * Render the "Tool visibility" block for models whose catalog cap is smaller
 * than the full registry (weak models — GLM flash class — get ~32 tools).
 * Without this the model has no idea tools were trimmed and never reaches
 * for find_tools. Lives BELOW the dynamic boundary: the text varies by
 * (model, registry size), so placing it in the static prefix would break
 * cross-session prefix sharing for the same (project, provider, profile)
 * tuple. Within a session it is byte-stable across turns.
 */
function toolCapBlock(toolCap?: { maxTools: number; approxCatalog: number }): string {
  if (!toolCap || toolCap.maxTools >= toolCap.approxCatalog) return '';
  return (
    '\n\n# Tool visibility (model-adapted)\n' +
    `Your visible tool list is trimmed to at most ${toolCap.maxTools} high-priority tools for this model; ` +
    `the full catalog is larger (~${toolCap.approxCatalog} tools). Hidden tools remain fully usable:\n` +
    '1. `find_tools("<capability>")` returns exact names + argument summaries.\n' +
    '2. Calling a discovered tool by name WORKS even while hidden — it executes and is pinned into your visible list from the next turn.\n' +
    '3. `expand_toolset({tier: "<name>"})` unlocks a whole tier when you need several of its tools.\n' +
    'Never invent tool names — discover first, then call.\n'
  );
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
    // Category-level stripped list — the per-tool refusal error already
    // names the exact tool when the model hits one.
    return `# Tool strategy — project NOT indexed
The MCP bridge is connected, but this project was never indexed. Tools that strictly need the symbol DB were stripped — DB-backed search/overview/graph tools (\`search*\`, \`get_project_*\`, \`get_context_for\`, \`query_snapshots\`, \`get_hierarchy\`, \`semantic_neighbors\`, \`get_dependencies\`/\`get_dependents\`, ...) are NOT callable; the error names the tool if you hit one.

Still available with automatic tree-sitter / disk-grep fallbacks: \`mcp__read_file\`, \`mcp__list_directory\`, \`mcp__grep_code\`, \`mcp__get_file_skeleton\` / \`get_file_structure\`, \`mcp__get_symbol_body\`, \`mcp__find_references\`, \`mcp__trace_usage\` (depth=1), \`mcp__prepare_edit\` (no imports/tests).
Native always works: \`read_file\` (pass \`symbol\` or \`around_line\`), \`glob\`, \`run_command\` with \`rg\`.
For full caller graphs / scored search / vector neighbors, ask the user to index the project via the admin panel.
`;
  }
  return `# Tool strategy — token economy
Dozens of MCP tools (prefixed \`mcp__\`) power semantic codebase navigation; deeper ones (find_references, prepare_edit, semantic_neighbors, ...) live in the \`navigate\` tier, loaded on demand. The 5 cheap entry points (always visible):
1. \`mcp__get_project_pulse\` — ultra-compact overview (~100 tokens). Start here.
2. \`mcp__query_snapshots\` — full-text search over saved knowledge. Try this BEFORE exploring code.
3. \`mcp__get_context_for\` — curated bundle for "how does X work?". Add \`hyde: true\` if recall is weak.
4. \`mcp__search\` / \`mcp__grep_code\` — hybrid search and ripgrep with filters.
5. \`mcp__get_file_skeleton\` — file outline; ALWAYS prefer over a full \`read_file\`.

When you need a tool you cannot see: \`find_tools({ query: "<what you need>" })\` searches the FULL catalog (all tiers, returns names + tier + unlock hint), then \`expand_toolset({ tier: "<tier>" })\` if needed — visible next turn. Always prefer MCP semantic tools over native file reads; never grep when \`mcp__find_references\` exists.
`;
}

/**
 * "Images & vision" — only relevant when the active model can NOT see
 * images natively (or the composer forces the describe-images fallback).
 * Vision-capable sessions drop it entirely (~450 chars saved).
 */
function visionSection(modelCanSeeImages?: boolean): string {
  if (modelCanSeeImages === true) return '';
  return `
# Images & vision
If your model can't natively see images, uploaded attachments and screenshots may arrive as \`[Image description]\` TEXT (a vision model translates them for you) — treat that text as the image. To steer it, pass an intent: \`view_image({ describe: "..." })\` and \`preview_screenshot({ lookFor: "..." })\` — say what you need (e.g. "detailed layout to recreate" for design work, "list alignment/overflow bugs" for QA). It's task-specific.
`;
}

/**
 * Unified memory section. With Session Drive (single sessions): one block
 * covering session notes + project memory + the mcp__save_memory pointer
 * (previously split across "# Long-term memory" and "# Session & project
 * memory"). Without it (company subordinates): just the long-term pointer.
 */
function memorySection(sessionDrive?: boolean): string {
  if (!sessionDrive) {
    return `
# Long-term memory
When you make an important architectural decision or identify a reusable pattern, save it via \`mcp__save_memory\` (\`category: decision | convention | gotcha | architecture\`). It lives in the \`navigate\` tier; future sessions retrieve it via \`mcp__search_memory\`. (\`mcp__add_snapshot\` is a separate, \`admin\`-tier tool for curated project snapshots — not for routine memory.)
`;
  }
  return `
# Memory (session + project)
This session has a durable working memory (Session Drive) plus a cross-session PROJECT MEMORY:
- \`save_note({title, body, kind?, scope?})\` — scope 'session' (default): a decision, non-obvious fact, risk, or TODO you'd regret losing when older turns get summarized (\`title\` is the key; re-saving updates it). scope 'project': a DURABLE fact about THIS CODEBASE — a gotcha you hit, a confirmed convention, a decision with its why, a recipe that worked. Save project memory AS YOU LEARN IT; never transient task state or file dumps.
- \`recall_memory({query})\` — fetch full project memories BEFORE re-exploring something this project likely already learned (the index in context shows titles only).
- \`list_notes\` / \`read_plan\` — review your saved notes / re-read your submitted plan.
- \`recall_investigations({query})\` — BEFORE spawning an explore subagent, reuse past auto-saved findings instead of paying to re-investigate.
The runner re-injects plan/notes/session state after compaction. \`mcp__save_memory\` (navigate tier) also persists durable decisions/conventions/gotchas; \`mcp__add_snapshot\` is admin-tier for curated snapshots, not routine memory.
`;
}
