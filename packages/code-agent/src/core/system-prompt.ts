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
import type { ToolContext } from './tool.js';
import { buildGlobalWorkspaceBriefing } from './global-workspace-context.js';
import { permissionsSection, type PromptPermissions } from './permissions-prompt.js';

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

# Subagent contract
Stay inside the delegated scope. An investigation returns evidence and citations without edits; an implementation delivers the scoped change plus verification. Reuse content already in context, retry one recoverable tool failure, and use \`find_tools\` instead of guessing names. Do not spawn children. Stop when the requested result is complete or a concrete parent-owned blocker is identified.`;
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
  /** Synthetic union map for global sessions; absent for ordinary projects. */
  globalWorkspace?: ToolContext['globalWorkspace'];
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
   * Detected verify commands block (`detectVerifyCommands` in
   * core/verify-commands.ts) — package.json scripts + package manager +
   * Makefile/justfile presence. Rendered BELOW the dynamic boundary (sibling
   * of the repo map): project-file contents vary per project and over time,
   * so it must never touch the shared static prefix. Empty/undefined when
   * nothing was detected.
   */
  verifyCommands?: string;
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
   * planning agent investigates without prescribing document length.
   * Session-fixed → cache-stable, stays above the
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
  /** When true, generated code must not introduce comment lines or blocks. */
  blockCodeComments?: boolean;
  /**
   * True when the run is UNSUPERVISED — no human watching in real time (cron /
   * scheduled / company subordinate). Adds an `# Operating autonomously` block
   * that tells the model not to ask blocking questions: proceed on reversible
   * actions, stop only for destructive ones or genuine scope changes, and do
   * pending work instead of ending the turn with a promise. Set from the run
   * context (not a user picker), so it is session-fixed → cache-stable.
   */
  unsupervised?: boolean;
  /**
   * Effective permission/sandbox policy — writable root(s) + the session's
   * tool-approval mode. When set, a `# Permissions & sandbox` block renders the
   * concrete writable root and approval mode so the model's behaviour aligns
   * with what the runtime gate enforces (Codex's `permissions_instructions`).
   * Session-fixed → cache-stable, above the dynamic boundary. Resolved at the
   * call site from projectRoot/sandbox workdir + `tool_permission_mode`.
   */
  permissions?: PromptPermissions;
  /**
   * Hierarchical AGENTS.md instructions (project root → cwd, concatenated) for
   * this project, loaded by `loadAgentsMd`. When non-empty, rendered as a
   * `# Project instructions (AGENTS.md)` block. Session-fixed content →
   * cache-stable; changes only when the file changes.
   */
  agentsMd?: string;
  /**
   * Session-level multi-agent policy. `proactive` is the product's Ultra
   * execution mode; `explicit_request_only` revokes a previously-active
   * proactive policy. The block is session-fixed and therefore belongs above
   * the dynamic cache boundary. When `spawn_agent` is unavailable, proactive
   * delegation is reduced to the explicit-request policy instead of
   * advertising a capability the runner cannot provide.
   */
  multiAgentMode?: 'proactive' | 'explicit_request_only';
  /**
   * Final registry membership after role/specialist filtering. When supplied,
   * the composer advertises only capabilities the session can actually call.
   * Omitted by lightweight tests/legacy callers to preserve the full generic
   * coding surface.
   */
  availableTools?: ReadonlySet<string>;
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

function toolAvailable(available: ReadonlySet<string> | undefined, name: string): boolean {
  return available === undefined || available.has(name);
}

function anyToolAvailable(available: ReadonlySet<string> | undefined, names: readonly string[]): boolean {
  return available === undefined || names.some((name) => available.has(name));
}

function goalLifecycleSection(available?: ReadonlySet<string>): string {
  if (!toolAvailable(available, 'create_goal') || !toolAvailable(available, 'update_goal')) {
    return '';
  }
  return `# Goal lifecycle
Use goals only when durable continuity across turns is useful. They do not authorize work or block a response.
  `;
}

function nativeToolsSection(available?: ReadonlySet<string>): string {
  const writes = ['write_file', 'edit_file', 'multi_edit', 'create_file', 'apply_patch']
    .filter((name) => toolAvailable(available, name));
  const reads = ['read_file', 'list_directory', 'glob']
    .filter((name) => toolAvailable(available, name));
  if (writes.length === 0 && reads.length === 0 && !toolAvailable(available, 'find_tools')) return '';

  const readBeforeWrite = writes.length > 0 && anyToolAvailable(available, [
    'mcp__read_file',
    'mcp__get_symbol_body',
    'read_file',
  ])
    ? ' Read the target before editing.'
    : '';
  const discovery = toolAvailable(available, 'find_tools')
    ? ' Use `find_tools` for a missing capability; do not guess tool names.'
    : '';
  return `# Tool contract
Use each visible tool according to its schema.${readBeforeWrite}${discovery}
`;
}

function overlaySection(available?: ReadonlySet<string>): string {
  const canWrite = anyToolAvailable(available, ['write_file', 'edit_file', 'multi_edit', 'create_file', 'apply_patch']);
  const canReadOverlay = anyToolAvailable(available, [
    'mcp__read_file',
    'mcp__get_file_skeleton',
    'mcp__get_symbol_body',
    'mcp__list_directory',
    'mcp__grep_code',
  ]);
  if (!canWrite || !canReadOverlay) return '';
  return `# Session overlay (automatic freshness)
MCP reads reflect files changed in this session; no re-index is needed after an edit.

`;
}

function subagentsSection(available?: ReadonlySet<string>): string {
  if (!toolAvailable(available, 'spawn_agent')) return '';
  return `# Subagents (isolated delegation)
Delegate only independent work that saves context or wall time; work locally for small or tightly coupled tasks. Give each child a bounded scope and completion criterion, then synthesize its result without repeating the same investigation.

`;
}

/**
 * Codex-faithful multi-agent mode switch. This is deliberately prompt-driven:
 * Ultra authorizes bounded proactive research when useful, but never turns
 * every request into mandatory fan-out and never bypasses write approvals.
 */
function multiAgentModeSection(
  mode: PromptContext['multiAgentMode'],
  available?: ReadonlySet<string>,
): string {
  if (!mode) return '';

  if (mode !== 'proactive' || !toolAvailable(available, 'spawn_agent')) {
    return `

# Multi-agent mode (explicit request only)
Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.`;
  }

  const workflowLine = toolAvailable(available, 'workflow')
    ? `
- Prefer one \`workflow\` DAG when dependent parallel steps need orchestration.`
    : '';
  return `

# Multi-agent mode (Ultra)
Proactive delegation is allowed only when independent read-only work materially improves speed or coverage. Use at most three \`investigator\` or \`reviewer\` children; keep writes in root and retain all normal permission gates. Children do not delegate further.${workflowLine}`;
}

/** Insert a session-fixed extension immediately before the cache boundary. */
export function appendStaticPromptSection(prompt: string, section: string): string {
  const trimmed = section.trim();
  if (!trimmed) return prompt;
  const at = prompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  if (at < 0) return `${prompt.trimEnd()}\n\n${trimmed}`;
  const prefix = prompt.slice(0, at).trimEnd();
  const suffix = prompt.slice(at);
  return `${prefix}\n\n${trimmed}\n\n${suffix}`;
}

/**
 * Promote a prompt that was created while the structural index was still
 * building. A single {@link CoderRunner} can execute several model turns, so
 * waiting for the next `runCoder()` call would leave the live run with the
 * `INDEX_NOT_READY` guidance even after the baseline became available.
 *
 * The repo map is deliberately appended at the very end. It is the volatile
 * portion of the prompt and must not invalidate the stable prefix. The caller
 * owns the one-shot readiness check; the duplicate guard makes retries safe.
 */
export function promoteIndexReadySystemPrompt(
  prompt: string,
  opts: {
    mcpAvailable?: boolean;
    sessionDrive?: boolean;
    repoMap?: string;
  },
): string {
  const waitingSection = mcpSection(opts.mcpAvailable, false, opts.sessionDrive);
  const readySection = mcpSection(opts.mcpAvailable, true, opts.sessionDrive);
  let promoted = waitingSection !== readySection && prompt.includes(waitingSection)
    ? prompt.replace(waitingSection, readySection)
    : prompt;

  const repoMap = opts.repoMap?.trim();
  if (repoMap && !promoted.includes(repoMap)) {
    promoted = `${promoted.trimEnd()}\n\n${repoMap}\n`;
  }
  return promoted;
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
  //   {{projectName}}, {{projectRoot}}, {{os}}, {{tierHint}}, {{mcpSection}},
  //   {{goalLifecycleSection}}
  // tierHint here is the profile-only text; customTiers render below the
  // boundary because the registered MCP-server tier set is volatile.
  const displayName = ctx.workspace?.displayName ?? ctx.projectName;
  const rootPath = ctx.workspace?.rootPath ?? ctx.projectRoot;
  const hasCodeNavigation = anyToolAvailable(ctx.availableTools, [
    'mcp__get_project_pulse',
    'mcp__search',
    'mcp__grep_code',
    'mcp__read_file',
    'read_file',
    'list_directory',
    'glob',
  ]);
  const hasMemory = anyToolAvailable(ctx.availableTools, [
    'remember',
    'recall_memory',
    'forget_memory',
    'save_note',
    'recall_conversation',
    'recall_investigations',
  ]);
  const base = interpolate(loadPrompt('base'), {
    projectName: displayName,
    projectRoot: rootPath,
    // Rich, platform-derived shell descriptor (not a bare "win32"): tells the
    // model the real shell (cmd.exe vs bash) + what NOT to reach for. Cuts the
    // ~69% run_command failure rate from Unix idioms on Windows.
    os: describeShell(ctx.os),
    tierHint: toolAvailable(ctx.availableTools, 'expand_toolset') ? tierHint(ctx.profile) : '',
    mcpSection: hasCodeNavigation ? mcpSection(ctx.mcpAvailable, ctx.isIndexed, ctx.sessionDrive) : '',
    nativeToolsSection: nativeToolsSection(ctx.availableTools),
    overlaySection: overlaySection(ctx.availableTools),
    subagentsSection: subagentsSection(ctx.availableTools),
    visionSection: toolAvailable(ctx.availableTools, 'view_image') ? visionSection(ctx.modelCanSeeImages) : '',
    memorySection: hasMemory ? memorySection(ctx.sessionDrive) : '',
    goalLifecycleSection: goalLifecycleSection(ctx.availableTools),
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
  const interactionLines: string[] = [];
  if (toolAvailable(ctx.availableTools, 'ask_user')) {
    interactionLines.push('- `ask_user`: request a genuine user decision. Provide options for multiple choice; do not ask what you can verify.');
  }
  if (toolAvailable(ctx.availableTools, 'submit_spec')) {
    interactionLines.push(`- \`submit_spec\`: ${isSpec ? 'REQUIRED before mutation; wait for human approval.' : 'available for an explicitly requested specification.'}`);
  }
  if (toolAvailable(ctx.availableTools, 'submit_plan')) {
    interactionLines.push(`- \`submit_plan\`: ${isSpec ? 'BLOCKED in spec mode — the spec is the plan.' : ctx.planMode ? 'REQUIRED before mutating tools for one coherent change.' : 'optional when the user explicitly asks for a plan.'}`);
  }
  if (toolAvailable(ctx.availableTools, 'task_list')) {
    interactionLines.push(ctx.planMode
      ? `- \`task_list\`: the single checklist/task tool. \`gate:'track'\` does not pause; \`gate:'approve'\` ${isSpec ? 'is blocked until spec approval' : 'pauses for multi-item approval'} and arms \`execute_tasks\`.`
      : "- `task_list`: optional progress checklist. Only `gate:'track'` is available and it never pauses; keep executing the authorized work.");
  }
  const taskRuntime = ['execute_tasks', 'task_complete', 'list_tasks']
    .filter((name) => toolAvailable(ctx.availableTools, name));
  if (taskRuntime.length > 0) {
    interactionLines.push(`- ${taskRuntime.map((n) => `\`${n}\``).join(' / ')}: execute or inspect an approved task list; backend ids use \`tsk_...\`.`);
  }
  const taskCleanup = ['cancel_tasks', 'delete_tasks', 'archive_task_list']
    .filter((name) => toolAvailable(ctx.availableTools, name));
  if (taskCleanup.length > 0) {
    interactionLines.push(`- ${taskCleanup.map((n) => `\`${n}\``).join(' / ')}: abandon, remove or archive task rounds.`);
  }
  const interactionSection = interactionLines.length > 0
    ? `\n\n# Interactive tools\n${interactionLines.join('\n')}`
    : '';

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
  const codeCommentsBlock = codeCommentsSection(ctx.blockCodeComments);
  const autonomousBlock = autonomousSection(ctx.unsupervised);
  const multiAgentModeBlock = multiAgentModeSection(ctx.multiAgentMode, ctx.availableTools);
  // Permissions/sandbox policy + AGENTS.md project instructions. Both
  // session-fixed → cache-stable, above the boundary. Collapse to '' when not
  // supplied so prompts that omit them stay byte-identical to before.
  const permissionsBlock = permissionsSection(ctx.permissions);
  const agentsMdBlock = agentsMdSection(ctx.agentsMd);
  const globalWorkspaceText = buildGlobalWorkspaceBriefing({ globalWorkspace: ctx.globalWorkspace });
  const globalWorkspaceBlock = globalWorkspaceText ? `\n\n${globalWorkspaceText}` : '';

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

  // Detected verify commands (B2-dyn) — hands the agent the project's REAL
  // test/typecheck/lint scripts so it doesn't guess `npm test` on a
  // pnpm/cargo project. Volatile (reads package.json) → below the boundary.
  const verifyBlock = ctx.verifyCommands && ctx.verifyCommands.length > 0
    ? `\n\n${ctx.verifyCommands}`
    : '';

  const dynamicSuffix = `${toolCapText}${customTiersText}${extraBlock}${verifyBlock}${repoMapBlock}`;
  // ALWAYS emit the boundary, even when the dynamic suffix is empty. The
  // marker itself costs ~50 chars but it gives consumers a byte-stable
  // hinge to split on — splitting tests, cache-instrumentation code, and
  // future ephemeral-breakpoint placement can all rely on the marker
  // being there. Without this guarantee, the static prefix's tail would
  // differ between "no dynamic content" and "dynamic content present"
  // sessions because of trailing-newline rules.
  const boundary = `\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}`;

  return `${preamble}${base}${planSection}${planDepthSection}${agentSection}${permissionsBlock}${agentsMdBlock}${globalWorkspaceBlock}${interactionSection}${agentLoopBlock}${languageBlock}${outputStyleBlock}${codeCommentsBlock}${autonomousBlock}${multiAgentModeBlock}${agentlessHint}${boundary}${dynamicSuffix}`;
}

/**
 * `# Project instructions (AGENTS.md)` block. Renders the hierarchical
 * AGENTS.md text (loaded by `loadAgentsMd`) as project-scoped user guidance,
 * clearly marked as project-supplied so the model weighs it as instructions
 * from the repo — not as system rules it must never override. '' when empty.
 */
function agentsMdSection(agentsMd?: string): string {
  const trimmed = (agentsMd ?? '').trim();
  if (!trimmed) return '';
  return `

# Project instructions (AGENTS.md)
The following instructions come from this project's AGENTS.md file(s). Treat them as authoritative project conventions; follow them unless they conflict with a direct user request.
${trimmed}`;
}

/**
 * Plan-depth calibration block. Rendered as an H2 (`## Plan depth (...)`) so it
 * folds into the "# Plan mode is ACTIVE" section rather than starting a new
 * top-level section. Depth controls investigation scope, never output length.
 */
function buildPlanDepthBlock(depth: string): string {
  const body = {
    simple:
      'Localize the change, its immediate callers and the focused verification.',
    normal:
      'Establish dependencies, reusable prior art, material risks and the end-to-end verification path.',
    complex:
      'Map cross-system contracts, migrations, rollback and independent workstreams. Surface only genuine architecture or scope decisions.',
  } as const;
  // Normalize at the single rendering chokepoint: callers reach here via a
  // type cast over the persisted column (index.ts), so a value corrupted by
  // direct SQL (never via the validated PATCH) would otherwise render
  // "## Plan depth — <garbage>\nundefined". Anything not simple/complex → normal.
  const key: keyof typeof body = depth === 'simple' || depth === 'complex' ? depth : 'normal';
  return `## Plan depth — ${key}\n${body[key]} Depth changes investigation, never document length.`;
}

/**
 * Static "Agent loop" framing. Cache-stable: depends only on ctx.agentLoopV2
 * (a session-fixed flag). Borrows from codex `gpt_5_1_prompt.md` for the
 * persistence directive and preamble guidance — see
 * docs/agent-research/COMPARISON.md, R6.
 */
function buildAgentLoopBlock(): string {
  return `

# Execution contract
Match the deliverable to intent: answer questions without mutation; carry explicit change requests through implementation and verification. Proceed on reversible in-scope work, but stop for destructive actions, missing authority or a genuine user-owned decision. Respect Plan/Spec approval gates. Retry one recoverable tool failure, then use another supported route and report the degradation. Reuse evidence already in context.

# Active context
The latest \`<active-context>\` contains the live scope and state; it overrides older history.`;
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
Respond in ${trimmed} with correct orthography. Keep code, identifiers and paths unchanged.`;
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
Add only the codebase insight needed to understand the implementation choice; do not pad the result.`;
  }
  if (style === 'learning') {
    return `

# Learning output
Complete the task except for one meaningful, well-scoped design decision presented as \`TODO(human)\` with enough context for the user to implement it.`;
  }
  return '';
}

function codeCommentsSection(enabled?: boolean): string {
  if (!enabled) return '';
  return `

# Code comments
Do not add comments to generated or edited code: no line comments, block comments, doc comments, TODOs or FIXMEs. Write self-explanatory code through names and structure. Preserve existing comments unless the task explicitly requires changing them.`;
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
Proceed with reversible in-scope work without asking. Stop only for destructive action, missing authority or a genuine scope decision; otherwise finish the work or report the concrete blocker.`;
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
Bootstrap exposes focused read/search tools. Unlock \`navigate\` only for editing, shell or deeper impact analysis; unlock \`admin\` only for an explicitly requested privileged operation.
`;
  }
  // navigate
  return `# Tool tiers
Navigate includes editing, shell and deep code navigation. Unlock \`admin\` only for an explicitly requested privileged operation.
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
    '\n\n# Tool visibility\n' +
    `The visible list is capped at ${toolCap.maxTools} of ~${toolCap.approxCatalog} tools. ` +
    'Use `find_tools("<capability>")` for one hidden tool or `expand_toolset` for a needed tier; discovered tools are pinned. Do not guess names.\n'
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
 * returns the concise retrieval contract. When unavailable (project not
 * indexed or bridge failed), tells the agent to stick to native tools.
 *
 * `sessionDrive` (single sessions) drops the `mcp__search_memory` paragraph:
 * those sessions already get `recall_memory` (same durable store) via the
 * memory section, and offering two names for the same thing makes weak
 * models bounce between them. Session-fixed → cache-stable.
 */
function mcpSection(mcpAvailable?: boolean, isIndexed?: boolean, sessionDrive?: boolean): string {
  if (mcpAvailable === false) {
    return `# Tool strategy — native only (MCP bridge unavailable)
MCP tools are unavailable. Use the visible native list/glob/read tools and shell text search; do not call \`mcp__*\`.
`;
  }
  if (isIndexed === false) {
    return `# Tool strategy — index starting
The structural index is building. Search may return \`INDEX_NOT_READY\` or fall back to disk/FTS; use grep, skeleton and focused reads now, then retry semantic/graph navigation later. Indexing is automatic.
`;
  }
  const searchMemoryParagraph = sessionDrive
    ? ''
    : ' Use `mcp__search_memory` only when a prior project decision is likely.';
  return `# Code retrieval
Use \`mcp__search\` in \`auto\` for discovery; use \`mcp__grep_code\` for exact text. Use skeleton/symbol reads to inspect the best hit, and reference/dependency tools only for impact analysis.${searchMemoryParagraph} Stop searching once the responsible code and verification path are known.
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
Images may arrive as \`[Image description]\`. Use \`view_image\` or \`preview_screenshot\` with a task-specific inspection intent when more detail is needed.
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
Use project memory only when an earlier decision, convention or gotcha is likely. Verify recalled facts against current code. Save only durable knowledge a future run would otherwise rediscover; never save transient task state or file dumps. If the user disables memory, do not use it.
`;
  }
  return `
# Memory
Use visible recent context first. Use session notes for facts needed after compaction, conversation recall for older turns, and durable memory only for likely prior decisions or conventions. Verify recalled facts against current code. Save only durable knowledge; never transient state or file dumps. If the user disables memory, do not use it.
`;
}
