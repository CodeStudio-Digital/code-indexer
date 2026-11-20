import { ultraCoordinationPrompt } from '../sessions/ultra-policy.js';
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
 * (no persistent todos), so this block omits the active-context
 * pointer but keeps the discipline rules: persist end-to-end, do not
 * re-read already-fetched files. Append to a subagent's domain-specific
 * system prompt when `agentLoopV2` is on.
 */
export function buildSubagentLoopFraming(): string {
  return `

# Subagent contract
Stay inside the delegated scope: investigate without edits, or implement and verify the assigned change. Reuse evidence. Discover tools by schema, never guess names. Retry a transient failure once only when replay is safe; reconcile unknown effects before another mutation. Respect refusals and permission gates. Do not spawn children. Return the result or a concrete parent-owned blocker.`;
}

export type ProviderFamily =
  | 'anthropic'
  | 'claude-code'
  | 'codex'
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
  'codex',
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
  const normalized = kind?.trim().toLowerCase();
  if (normalized === 'openai-chatgpt' || normalized === 'chatgpt' || normalized === 'codex') {
    return 'codex';
  }
  return normalized && PROVIDER_FAMILIES.has(normalized)
    ? (normalized as ProviderFamily)
    : 'generic';
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
  specMode?: boolean;
  /** The latest written plan can be reopened in this Build session. */
  canRevisePlan?: boolean;
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
   * directing the model to schema discovery. These are session-start estimates.
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
   * <active-context> user-message injection each turn (todos, active
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
  ultraPolicy?: import('@mcp/agent-runtime-contracts').PresetResolution;
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
      // Compatible gateways may serve different models over the same wire format.
      return `<role>CodeStudio coding agent.</role>
<formatting>
- Batch independent reads when supported; serialize dependent calls and effects.
- Text output to the user is rendered as markdown. Keep it terse.
- When you cite code, use \`file:line\` format.
</formatting>
`;
    case 'codex':
      return `# Role
You are a coding agent (OpenAI Codex family).

# Formatting rules
- Use tools for actions; give concise public progress updates.
- Batch independent reads when supported; serialize dependencies and effects.
- Keep reasoning private. End with a distinct final answer and \`file:line\` citations.
`;
    case 'openai':
      // OpenAI-compatible models respond well to explicit checklist-style cues.
      return `# Role
You are a coding agent in CodeStudio.

# Formatting rules
- Use tools for actions and accompany substantial work with concise progress updates.
- Batch independent reads when supported; serialize dependencies and effects.
- Terse markdown replies. Cite code as \`file:line\`.
`;
    case 'zai':
      // ZAI/GLM is very sensitive to prefix drift — bit-stable header matters.
      // GLM also benefits from explicit "use Chinese only if user does" nudge.
      return `# Role: Coding agent (GLM family)

# Hard rules
- Respond in the user's language. Default English.
- Use tools for actions and emit concise progress updates around substantial work.
- No emojis unless the user uses them first.
- Code citations: \`file:line\`.
- Keep text replies short; the user reads diffs, not recaps.
`;
    case 'gemini':
      return `# Role
Coding agent (Gemini family).

# Formatting
- Use tools for actions and emit concise progress updates around substantial work.
- Batch independent reads when supported; serialize dependencies and effects.
- Markdown, terse. Cite code as \`file:line\`.
`;
    case 'deepseek':
      return `# Role: Coding agent (DeepSeek family)

# Rules
- Use tools and concise progress updates. Batch independent reads when supported; serialize dependencies and effects.
- Terse markdown. Code citations as \`file:line\`.
- No redundant recap unless asked.
`;
    case 'kimi-code':
      return `# Role: Coding agent (Kimi Code family)

# Rules
- Use tools for actions and emit concise progress updates around substantial work.
- Preserve useful reasoning internally, but keep user-facing text concise.
- Markdown, terse. Cite code as \`file:line\`.
`;
    case 'openrouter': // The configured route may serve any model family.
    case 'generic':
    default:
      return `# Role
You are a coding agent.

# Formatting
- Use tools for actions and emit concise progress updates around substantial work.
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

function nativeToolsSection(available?: ReadonlySet<string>): string {
  const writes = ['write_file', 'edit_file', 'apply_patch']
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
  // `find_tools` guidance lives in "# Tool discovery" (rendered under the same
  // availability condition) and in the find_tools contract, which also covers
  // not rediscovering visible schemas; repeating it here only grew the prefix.
  const batching = toolAvailable(available, 'code_exec')
    ? '\nBatch independent reads with Promise.allSettled in code_exec and inspect each result. Serialize dependencies and mutations. Reuse fresh results.'
    : '';
  const checks = toolAvailable(available, 'exec_command')
    ? ' Collect the exit code for long checks.'
    : '';
  return `# Tool contract
Use each visible tool according to its schema.${readBeforeWrite}${batching}${checks}
`;
}

function overlaySection(available?: ReadonlySet<string>): string {
  const canWrite = anyToolAvailable(available, ['write_file', 'edit_file', 'apply_patch']);
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

function subagentsSection(available?: ReadonlySet<string>, mode?: PromptContext['multiAgentMode']): string {
  if (!toolAvailable(available, 'spawn_agent') || mode) return '';
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
  policy?: PromptContext['ultraPolicy'],
): string {
  if (!mode) return '';

  if (mode !== 'proactive' || !toolAvailable(available, 'spawn_agent')
    || policy?.effective.orchestration === 'off'
    || (policy?.effective.parallelism.maxAgents ?? 3) <= 0) {
    return `

# Multi-agent mode (explicit request only)
Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.`;
  }

  return ultraCoordinationPrompt(policy?.effective.parallelism.maxAgents ?? 3, available);
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
    availableTools?: ReadonlySet<string>;
  },
): string {
  const waitingSection = mcpSection(opts.mcpAvailable, false, opts.sessionDrive, opts.availableTools);
  const readySection = mcpSection(opts.mcpAvailable, true, opts.sessionDrive, opts.availableTools);
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
    os: anyToolAvailable(ctx.availableTools, ['run_command', 'exec_command']) ? describeShell(ctx.os) : ctx.os,
    tierHint: toolAvailable(ctx.availableTools, 'find_tools') ? tierHint(ctx.availableTools) : '',
    mcpSection: hasCodeNavigation ? mcpSection(ctx.mcpAvailable, ctx.isIndexed, ctx.sessionDrive, ctx.availableTools) : '',
    nativeToolsSection: nativeToolsSection(ctx.availableTools),
    overlaySection: overlaySection(ctx.availableTools),
    subagentsSection: subagentsSection(ctx.availableTools, ctx.multiAgentMode),
    visionSection: toolAvailable(ctx.availableTools, 'view_image') ? visionSection(ctx.modelCanSeeImages, ctx.availableTools) : '',
    memorySection: hasMemory ? memorySection(ctx.sessionDrive) : '',
  });

  // Plan section — optional, only when planMode is true AND the active agent
  // isn't `spec` (spec mode has its own gate via submit_spec / spec.txt and
  // should NOT also load plan.txt to avoid contradictory tool-discipline
  // instructions).
  const isSpec = ctx.specMode ?? ctx.agentId === 'spec';
  const isPlan = ctx.planMode && !isSpec;
  const planSection = isPlan
    ? `\n\n${loadPrompt('plan')}`
    : '';

  // Plan-depth calibration — appended to the plan section as an H2 sub-block
  // (so it folds into the "# Plan mode is ACTIVE" section, not a new H1). Gives
  // the planning agent a target ambition per the user's Simple/Normal/Complex
  // pick. Only when plan mode is active and the agent isn't `spec`.
  const planDepthSection = isPlan
    ? `\n\n${buildPlanDepthBlock(ctx.planDepth ?? 'normal')}`
    : '';

  // Mode identity section — concrete behavioural prompt for the active built-in
  // agent (`explore` / `build` / `admin`). 'plan' is already covered by
  // planSection via plan.txt, so we don't double-load it. Fixed at session
  // creation → cache-stable; sits above the dynamic boundary.
  const role = isSpec ? 'spec' : isPlan ? 'plan' : ctx.agentId === 'spec' ? undefined : ctx.agentId;
  const agentSection =
    role && role !== 'plan'
      ? `\n\n${loadPrompt(role)}`
      : '';
  const editHint = role === 'build' && !isPlan && toolAvailable(ctx.availableTools, 'mcp__prepare_edit')
    ? '\nUse `mcp__prepare_edit` when callers/tests or a shared contract matter.' : '';

  // Keep approval routes in sync with the active mode and its offered controls.
  const interactionLines: string[] = [];
  if (toolAvailable(ctx.availableTools, 'ask_user')) {
    interactionLines.push('- `ask_user` for a necessary user decision.');
  }
  if (isSpec) {
    const review = ['submit_spec', 'submit_specification_to_master'].find(name => toolAvailable(ctx.availableTools, name));
    interactionLines.push(review
      ? `- Call \`${review}\` directly for approval. Wait for the verdict before implementation.`
      : '- Spec review is unavailable. Report the blocker and keep the workspace read-only.');
  }
  if (isPlan) {
    interactionLines.push(planSubmissionGuidance(ctx.availableTools)
      ?? 'Plan review is unavailable. Report the blocker and keep the workspace read-only.');
  } else if (!isSpec && ctx.canRevisePlan && toolAvailable(ctx.availableTools, 'submit_plan')) {
    interactionLines.push('- For a requested revision, stay read-only and call `submit_plan` directly with the revised plan and `revision: true`.');
  }
  if (toolAvailable(ctx.availableTools, 'task_list')) {
    interactionLines.push("- `task_list` with `gate:'track'` is an optional checklist and never pauses.");
  }
  const taskRuntime = ['execute_tasks', 'task_complete', 'list_tasks']
    .filter((name) => toolAvailable(ctx.availableTools, name));
  if (taskRuntime.length > 0) {
    interactionLines.push(`- ${taskRuntime.join(' / ')} operate on an approved task list using its returned IDs.`);
  }
  const interactionSection = interactionLines.length > 0
    ? `\n\n# Interactive tools\n${interactionLines.join('\n')}`
    : '';

  // Static "agent loop" + "do not re-read" + "active context pointer". The
  // dynamic payload (todos / active task scope) is injected as
  // the last user message each turn under <active-context>...</active-context>
  // by the runner — see buildActiveContextBlock in runner.ts. Keeping the
  // pointer here static preserves prefix-cache stability; only the trailing
  // user message changes turn over turn.
  //
  // Gated on ctx.agentLoopV2 so older sessions don't see the new framing on
  // resume — they keep behaving the way they were started.
  const agentLoopBlock = ctx.agentLoopV2 ? buildAgentLoopBlock() : '';

  // Session-fixed directives (cache-stable, static prefix): response language,
  // output style, and autonomous (unsupervised) framing. Each collapses to ''
  // when not applicable so the prefix stays byte-stable for sessions that share
  // the same (project, provider, profile, language, style, unsupervised) tuple.
  const languageBlock = languageSection(ctx.responseLanguage);
  // Interactive learning exercises are not useful without a human watching.
  // Suppress that style in unsupervised runs; it never changes task authority.
  const effectiveStyle =
    ctx.unsupervised && ctx.outputStyle === 'learning' ? 'proactive' : ctx.outputStyle;
  const outputStyleBlock = outputStyleSection(effectiveStyle);
  const codeCommentsBlock = codeCommentsSection(ctx.blockCodeComments);
  const autonomousBlock = autonomousSection(ctx.unsupervised);
  const multiAgentModeBlock = multiAgentModeSection(ctx.multiAgentMode, ctx.availableTools, ctx.ultraPolicy);
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

  const canDiscover = toolAvailable(ctx.availableTools, 'find_tools');
  const customTiersText = canDiscover ? customTiersBlock(ctx.customTiers) : '';
  const toolCapText = canDiscover ? toolCapBlock(ctx.toolCap) : '';

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
  const verifyBlock = ctx.verifyCommands && anyToolAvailable(ctx.availableTools, ['run_command', 'exec_command'])
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

  return `${preamble}${base}${planSection}${planDepthSection}${agentSection}${editHint}${permissionsBlock}${agentsMdBlock}${globalWorkspaceBlock}${interactionSection}${agentLoopBlock}${languageBlock}${outputStyleBlock}${codeCommentsBlock}${autonomousBlock}${multiAgentModeBlock}${boundary}${dynamicSuffix}`;
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
Project conventions from AGENTS.md follow. Respect them within the active mode and permission boundary; a direct user request takes precedence over project conventions.
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
Carry authorized action requests through implementation and verification. Respect Plan/Spec gates; ask only for missing authority or a user-owned decision. Retry a transient failure once only if replay is safe. Reconcile unknown effects before another mutation; never bypass refusals by switching tools. Reuse evidence and continue independent safe work when blocked.

# Active context
Use \`<active-context>\` for live state, subject to current user instructions and permissions; retain the main objective.`;
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
Complete the task. Explain one meaningful design choice and offer an optional exercise in the final prose; never leave required code unfinished.`;
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
Complete authorized work within mode and permission gates. No human is watching: report missing authority or a user-owned decision as a blocker, continue independent safe work, and never invent approval.`;
}

/** Top-level approval routes shared by Plan mode and its one-time reminder. */
export function planSubmissionGuidance(available?: ReadonlySet<string>): string | undefined {
  const routes: string[] = [];
  if (toolAvailable(available, 'submit_plan')) routes.push('`submit_plan` for a written plan');
  else if (available?.has('submit_plan_to_master')) routes.push('`submit_plan_to_master` for a written plan');
  if (toolAvailable(available, 'task_list')) routes.push("`task_list` with `gate:'approve'` for independent tasks");
  else if (available?.has('submit_tasks_to_master')) routes.push('`submit_tasks_to_master` for independent tasks');
  return routes.length ? `Call ${routes.join(' or ')} directly and wait for review.` : undefined;
}

/**
 * Explain the stable direct surface and schema discovery. Profile is
 * fixed at session start, so this text is byte-stable for the session and
 * lives in the cached prefix above SYSTEM_PROMPT_DYNAMIC_BOUNDARY.
 *
 * NOTE: customTiers were previously inlined here, but they varied with MCP
 * server registration and so polluted the cached prefix across sessions of
 * the same project. They now render in `customTiersBlock` below the
 * boundary instead.
 */
function tierHint(available?: ReadonlySet<string>): string {
  const nested = toolAvailable(available, 'code_exec')
    ? ' Call deferred non-interactive tools in `code_exec` using `tools["exact-name"](args)`, including hyphens.'
    : '';
  return `# Tool discovery
Use visible tools directly. Use \`find_tools\` for a missing capability or schema and follow its invocation route.${nested} Interactive and lifecycle tools require a top-level call. Repeating discovery cannot enable a blocked tool.
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
    `Direct-tool budget: ${toolCap.maxTools} of ~${toolCap.approxCatalog} registered tools. Required controls can exceed this target. ` +
    'Use `find_tools` for a missing schema.\n'
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
    'Use `find_tools` with the server name and capability to obtain exact names and schemas:\n' +
    sorted.map((t) => `- "${t.tier}" (${t.toolCount} tools) — ${t.displayName}`).join('\n') +
    '\n'
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
function mcpSection(mcpAvailable?: boolean, isIndexed?: boolean, sessionDrive?: boolean, available?: ReadonlySet<string>): string {
  if (mcpAvailable === false) {
    return `# Tool strategy — native only (MCP bridge unavailable)
The project index bridge is unavailable. Use the visible native search/read tools for project files.
`;
  }
  if (available && (!available.has('mcp__search') || !available.has('mcp__grep_code'))) {
    return `# Code retrieval
Use the visible search/read tools for focused discovery and exact text. Inspect the best hit; expand references only for impact. Missing capabilities require discovery, not guessed tool names. Stop when evidence covers the change and verification.
`;
  }
  if (isIndexed === false) {
    return `# Tool strategy — index starting
The structural index is building. Search may return \`INDEX_NOT_READY\` or fall back to disk/FTS; use grep, skeleton and focused reads now, then retry semantic/graph navigation later. Indexing is automatic.
`;
  }
  const searchMemoryParagraph = sessionDrive || !toolAvailable(available, 'mcp__search_memory')
    ? ''
    : ' Use `mcp__search_memory` only when a prior project decision is likely.';
  return `# Code retrieval
Use \`mcp__search\` in \`auto\` for discovery; use \`mcp__grep_code\` for exact text. Use skeleton/symbol reads to inspect the best hit, and reference/dependency tools only for impact analysis.${searchMemoryParagraph} Stop searching once the responsible code and verification path are known.
`;
}

/** Explain on-demand pixels for both native vision and description fallback. */
function visionSection(modelCanSeeImages?: boolean, available?: ReadonlySet<string>): string {
  const video = toolAvailable(available, 'view_video') ? ' Use `view_video` for frames.' : '';
  return `
# Images & vision
References lack pixels. Use \`view_image\` with a session attachment_id or authorized path. Use action=list to recover IDs after reopening or compaction. Pixels last one inference. Reopen or crop as needed.${video}${modelCanSeeImages === true ? '' : ' For [Image description] fallback, provide a describe hint.'}
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
