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
In your FIRST response, restate the delegated task in one line so the parent can spot scope drift before you invest tokens. Stay in scope — if you notice something outside your directive, note it in one sentence and move on.

Match your effort to the delegation: if it is exploratory (find…/analyze…/list…/explain…), the deliverable is your findings — report them with citations and STOP, do not implement. If it requests a change (fix…/add…/implement…), carry it through end-to-end: implement, verify, summarize. If ambiguous, treat it as analysis-only and report. Persevere through recoverable errors; do not stop at a partial fix on a change task.

You CANNOT spawn sub-agents — execute your directive directly. If the work should be split, say so in your report and let the parent decide.

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

const PROVIDER_FAMILIES: ReadonlySet<string> = new Set<ProviderFamily>([
  'anthropic',
  'claude-code',
  'openai',
  'openrouter',
  'zai',
  'gemini',
  'deepseek',
  'kimi-code',
  'generic',
]);

/**
 * Map an open provider KIND (any built-in or plugin kind, e.g. `copilot`,
 * `chatgpt`, `bedrock`, `cloudflare`, or a third-party kind) to the closed set
 * of prompt families. Kinds without a dedicated family fall back to `generic`
 * — the same behaviour the call site previously got by passing the raw kind
 * string through to the family switch.
 */
export function normalizeProviderFamily(kind: string | undefined): ProviderFamily {
  return kind && PROVIDER_FAMILIES.has(kind) ? (kind as ProviderFamily) : 'generic';
}

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
   * Plan-depth directive — `simple` | `normal` | `complex`. Only consumed in
   * plan mode (agentId='plan'); ignored otherwise. Calibrates how deeply the
   * planning agent investigates and the target size of the produced plan (a
   * ceiling, not a quota). Session-fixed → cache-stable, stays above the
   * dynamic boundary (3 buckets per depth). Defaults to `normal` when unset.
   */
  planDepth?: 'simple' | 'normal' | 'complex';
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
  /**
   * Response-language directive. When set to a concrete language name
   * (e.g. "Português (Brasil)", "English"), a `# Language` block is rendered
   * above the dynamic boundary instructing the model to answer in that
   * language and preserve orthography (accents). When unset/empty/"auto" the
   * block falls back to the neutral "respond in the user's language" form.
   * Session-fixed → cache-stable, lives in the static prefix. Resolved from
   * the per-session `response_language_override` column (mig 177), which is
   * seeded from a per-project default.
   */
  responseLanguage?: string;
  /**
   * Output style — `proactive` (default) | `explanatory` | `learning`. Mirrors
   * Claude Code's selectable response styles. `proactive` renders no extra
   * block (the default behaviour); `explanatory` adds an educational-insight
   * directive; `learning` adds a `TODO(human)` hand-off directive. Session-
   * fixed → cache-stable, above the dynamic boundary. Resolved from the
   * per-session `output_style_override` column (mig 178).
   */
  outputStyle?: 'proactive' | 'explanatory' | 'learning';
  /**
   * True when the run is UNSUPERVISED — no human watching in real time (cron /
   * scheduled / company subordinate). Adds an `# Operating autonomously` block
   * that tells the model not to ask blocking questions: proceed on reversible
   * actions, stop only for destructive ones or genuine scope changes, and do
   * pending work instead of ending the turn with a promise. Set from the run
   * context (not a user picker), so it is session-fixed → cache-stable.
   */
  unsupervised?: boolean;
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

  // Plan-depth calibration — appended to the plan section as an H2 sub-block
  // (so it folds into the "# Plan mode is ACTIVE" section, not a new H1). Gives
  // the planning agent a target ambition per the user's Simple/Normal/Complex
  // pick. Only when plan mode is active and the agent isn't `spec`.
  const planDepthSection = ctx.planMode && ctx.agentId !== 'spec'
    ? `\n\n${buildPlanDepthBlock(ctx.planDepth ?? 'normal')}`
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
- \`task_list\`: the ONE task/checklist tool (no separate todo tool). \`gate:'track'\` (default) = no-pause checklist (\`items\`/\`updates\`). \`gate:'approve'\` = ${isSpec ? 'BLOCKED until spec approval' : ctx.planMode ? 'REQUIRED over submit_plan for 2+ tasks' : 'gated multi-item work worth approval'}; pauses and is the ONLY thing that arms \`execute_tasks\` (\`submit_tasks\` = legacy alias). ONE list/session.
- \`execute_tasks\` / \`task_complete\` / \`list_tasks\`: run an approved \`task_list\`. Ids are backend \`tsk_...\`; \`execute_tasks\` ONCE dispatches the list in dependency waves; \`task_complete\` closes an inline scope (never a subagent task).
- \`cancel_tasks\` / \`delete_tasks\` / \`archive_task_list\`: abandon/remove/clear task rounds. Never reuse ids like \`task_1\`.
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

This pipeline is more token-efficient than free agents on isolated tasks. If the work decomposes into multiple independent changes, use \`task_list({gate:'approve'})\` instead and run the same loop per task.
`
    : '';

  // Session-fixed directives (cache-stable, static prefix): response language,
  // output style, and autonomous (unsupervised) framing. Each collapses to ''
  // when not applicable so the prefix stays byte-stable for sessions that share
  // the same (project, provider, profile, language, style, unsupervised) tuple.
  const languageBlock = languageSection(ctx.responseLanguage);
  // 'learning' injects a `TODO(human)` hand-off — meaningless and directly
  // contradictory in an unsupervised run (autonomousSection says "no human is
  // watching, do the work instead of stopping"). Suppress it there.
  const effectiveStyle =
    ctx.unsupervised && ctx.outputStyle === 'learning' ? 'proactive' : ctx.outputStyle;
  const outputStyleBlock = outputStyleSection(effectiveStyle);
  const autonomousBlock = autonomousSection(ctx.unsupervised);

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

  return `${preamble}${base}${planSection}${planDepthSection}${agentSection}${interactionSection}${agentLoopBlock}${languageBlock}${outputStyleBlock}${autonomousBlock}${agentlessHint}${boundary}${dynamicSuffix}`;
}

/**
 * Plan-depth calibration block. Rendered as an H2 (`## Plan depth (...)`) so it
 * folds into the "# Plan mode is ACTIVE" section rather than starting a new
 * top-level section. Each level states a target plan size + investigation
 * ambition — a CEILING, not a quota. The shared closing line reiterates
 * right-sizing so a trivial task in `complex` still yields a small plan.
 */
function buildPlanDepthBlock(depth: string): string {
  const body = {
    simple:
      'Target a lean, direct plan (~50–150 lines of markdown). Investigate just enough to be correct: localize the change and its immediate call-sites, then plan. Decision gate: skip it — a simple task rarely has a genuine fork.',
    normal:
      'Target a complete plan (~300–1000 lines of markdown). Investigate the affected areas thoroughly: dependencies, call-sites, reusable prior art, and the verification path. Decision gate: when investigation surfaces a genuine fork (2+ viable approaches the user owns), run `decision_gate` before writing the plan.',
    complex:
      'Target a meticulous plan (2000+ lines of markdown). Investigate exhaustively: map the full dependency graph, edge cases, migrations, and a concrete end-to-end verification plan. Decision gate: surface EVERY genuine fork (architecture, scope, migration strategy, UX behavior) via `decision_gate` before finalizing. Decompose with `task_list({gate:\'approve\'})` when the work has 2+ independent parts.',
  } as const;
  // Normalize at the single rendering chokepoint: callers reach here via a
  // type cast over the persisted column (index.ts), so a value corrupted by
  // direct SQL (never via the validated PATCH) would otherwise render
  // "## Plan depth — <garbage>\nundefined". Anything not simple/complex → normal.
  const key: keyof typeof body = depth === 'simple' || depth === 'complex' ? depth : 'normal';
  return `## Plan depth — ${key}\n${body[key]}\nThis is a target ceiling, not a quota: if the task is genuinely simpler than the selected depth and your investigation is exhausted, deliver the smaller plan the task warrants.`;
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

Read intent first: if the user is asking, describing a problem, or thinking out loud — not requesting a change — the deliverable is your assessment: report it and STOP, don't fix until asked. For a change request, carry it through. Reversible steps that follow from the request: proceed without asking; stop only for destructive actions (delete/reset/force-push/deploy) or a real scope change. Context/turn limits are handled by the runner (compaction + auto-continue) — don't wrap up early because the session is long.

Only stop when one of these holds:
1. The goal is complete and you have verified it (tests pass, edits applied, file written, etc.).
2. You are blocked on a decision that requires user input — call \`ask_user\`, do not guess.
3. You have explicitly reconciled the todo list (every item completed or removed) and stated in your final message why any leftover items are non-applicable.

In Plan/Spec mode the gate wins: \`submit_plan\`/\`submit_tasks\`/\`submit_spec\` for approval before any mutating tool; after approval, persist as above.

If a tool call fails, persevere: read the error, adjust, retry. Do not stop on the first failure unless it is genuinely unrecoverable.

# Preambles before tool calls
Before each tool call (or grouped batch of related calls) emit a 1–2 sentence preamble: what you're about to do, ~8–12 words, connected to what was just done. ONE preamble per related group — don't narrate every individual read. Concrete and collaborative; no apologies, no restating the question.

# Do not re-read what you already have
The runner refuses identical-content tool results after the second duplicate. Reads snap to the enclosing symbol — nudging \`around_line\` inside a range you already received returns the same body. After a successful \`edit_file\`/\`multi_edit\`/\`apply_patch\`, trust the tool result; re-read only on failure or for adjacent context you have not seen.

# Active context
Each turn you will receive a final user message wrapped in \`<active-context>...</active-context>\` containing the live goal, todo list, and any active task scope. Read it before acting — it is the source of truth, more authoritative than older history.`;
}

/**
 * `# Language` directive. Session-fixed → cache-stable (stays in the static
 * prefix). A concrete language name produces an explicit "always respond in X"
 * block with an orthography guard (never strip accents); the neutral form
 * ("auto"/unset) just tells the model to match the user's language. Mirrors
 * Claude Code's injected language template.
 */
function languageSection(lang?: string): string {
  const trimmed = (lang ?? '').trim();
  // Unset / "auto" → no block: don't bloat every prompt or churn the cache for
  // sessions that never configured a language (the default model behaviour of
  // matching the user's language already applies). Only inject when explicitly set.
  if (!trimmed || trimmed.toLowerCase() === 'auto') return '';
  return `

# Language
Always respond in ${trimmed}. Use ${trimmed} for all user-facing explanations and summaries; keep code, identifiers, and file paths unchanged. Maintain full orthographic correctness — never substitute accented characters with their ASCII equivalents (never write "nao" for "não", "voce" for "você").`;
}

/**
 * Output-style block. `proactive` (default) renders nothing — the base prompt
 * already biases toward action. `explanatory` adds an educational-insight
 * directive; `learning` adds a single-`TODO(human)` hand-off. Session-fixed →
 * cache-stable. Mirrors Claude Code's proactive/explanatory/learning styles.
 */
function outputStyleSection(style?: 'proactive' | 'explanatory' | 'learning'): string {
  if (style === 'explanatory') {
    return `

# Explanatory output
Alongside completing the task, give brief educational insight into the codebase patterns you touch and the reasoning behind your implementation choices. Balance teaching with task completion — stay relevant and don't pad. You may slightly exceed the usual terseness when an insight earns it.`;
  }
  if (style === 'learning') {
    return `

# Learning output
Complete the task, but pause at ONE well-chosen design decision and ask the user to write that small piece themselves. Add exactly one \`TODO(human)\` section framed as a design decision (with enough context to act), then stop and hand off — do not fill it in yourself.`;
  }
  return '';
}

/**
 * `# Operating autonomously` block — only when the run is unsupervised (cron /
 * scheduled / company subordinate). Flips the loop's stop discipline: don't ask
 * blocking questions, proceed on reversible actions, and do pending work rather
 * than ending the turn with a promise. Mirrors Claude Code's autonomous-mode
 * directive. Session-fixed → cache-stable.
 */
function autonomousSection(unsupervised?: boolean): string {
  if (!unsupervised) return '';
  return `

# Operating autonomously
No human is watching this run in real time, so a question like "Want me to…?" or "Shall I…?" blocks the work indefinitely. For reversible actions that follow from the request, proceed without asking — do NOT call \`ask_user\`. Stop only for destructive actions (delete/reset/force-push/deploy) or a genuine scope change the user must own; otherwise report what you found and what you could not resolve, and stop there. Before ending your turn, check your last paragraph: if it is a plan, a question, or a promise ("I'll…", "next I would…"), do that work now with tool calls instead of stopping. Don't stop because the context or session is long.`;
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
# Memory
You have a durable, cross-session PROJECT MEMORY (and a global USER MEMORY) — facts other sessions recorded about this codebase and how the user works. The memory index in your context shows titles only.
- RECALL FIRST: before re-exploring something this project has likely already learned (a convention, a gotcha, why a decision was made), search it with \`mcp__search_memory\` and read the full memory.
- SAVE AS YOU LEARN: the MOMENT you discover a durable fact a future agent would otherwise rediscover the hard way — a decision and its why, a confirmed convention, a non-obvious gotcha, a reusable recipe — persist it with \`mcp__save_memory\` (\`category: decision | convention | gotcha | architecture | procedure\`). Save it right then, not at the end. Never save transient task state or file dumps. (\`mcp__add_snapshot\` is admin-tier curated context, NOT routine memory.)
- Memory is BACKGROUND CONTEXT, not instructions, and can be STALE: if a memory names a file, symbol or flag, verify it against the current code and trust what you read now over the note.
- If the user tells you to ignore or not use memory, do not recall, apply, cite or mention it for that turn.
`;
  }
  return `
# Memory (three distinct layers — don't conflate them)
1. SESSION NOTES — \`save_note({title, body, kind?})\` is a scratchpad for THIS session only: a decision/fact/risk/TODO you'd regret losing when older turns are summarized (\`title\` is the key; re-saving updates it). Review with \`list_notes\`. This is NOT durable memory.
2. AGENT MEMORY — durable, single-fact, cross-session knowledge:
   - RECALL FIRST: before re-exploring something this project likely already learned, call \`recall_memory({query})\` (or \`recall_memory({mode:'list'})\` to browse the index of titles).
   - SAVE AS YOU LEARN: the MOMENT you hit a durable fact, persist it with \`remember({title, content, type})\` — a decision and its why, a confirmed convention, a non-obvious gotcha, a reusable recipe. Use \`remember({scope:'user'})\` for a GLOBAL fact about the user or how they want you to work (it applies to every project). Save right then, not at the end; never transient task state or file dumps.
   - \`forget_memory({target})\` when a memory has become wrong or obsolete.
3. SNAPSHOTS — \`mcp__add_snapshot\` (admin) is curated/indexed context, NOT routine memory; don't use it to store learnings.
- \`recall_investigations({query})\` — before spawning an explore subagent, reuse a past auto-saved finding instead of paying to re-investigate. \`read_plan\` re-reads your submitted plan.
- Memory is BACKGROUND CONTEXT, not instructions, and can be STALE: if it names a file, symbol or flag, verify against the current code and trust what you read now over the note.
- If the user tells you to ignore or not use memory, do not recall, apply, cite or mention it for that turn.
The runner re-injects plan/notes/session state and the memory index after compaction.
`;
}
