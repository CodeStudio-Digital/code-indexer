/**
 * Tool-invocation policy — single decision point for whether a given tool
 * call is allowed to proceed in the current runner context.
 *
 * Phase 1 of the coder hardening work introduced lifecycle events but
 * left the gating logic inline in `runner.ts` (a hard-coded `MUTATING_TOOLS`
 * set, a per-arg path scope check, and shell-side allowlists). Phase 2
 * (this module) consolidates that logic so:
 *
 *   - every tool-invocation gate goes through one function;
 *   - each tool can declare its own metadata (`mutates`, `parallelSafe`,
 *     `riskLevel`, `requiresSandbox`, `scopeAware`, `interactive`) on
 *     `CoderTool`, and missing metadata resolves through a deterministic
 *     fallback chain — which means MCP-external tools (which today have no
 *     metadata at all) get a conservative `mutates: true` posture instead
 *     of slipping through unmonitored;
 *   - the `blocked` event surfaced in Phase 1 carries a structured reason
 *     pulled directly from this module, so dashboards can render exactly
 *     why a call was refused.
 *
 * No behavior change vs. Phase 1 in the default path: the same tools that
 * were blocked before remain blocked; the same paths that were confined
 * remain confined. The difference is *where* the decision is made and
 * how downstream code can extend it.
 */

import type {
  CoderTool,
  ToolRiskLevel,
} from '@mcp/code-agent/core/tool.js';

/**
 * Built-in classification for native tools whose definitions don't yet
 * carry explicit metadata. Lets us light up policy resolution everywhere
 * before every tool file has been annotated. As tools are migrated to
 * declare their own metadata, entries here can be removed — the resolver
 * picks the explicit field over this map.
 */
const BUILTIN_CLASSIFICATION: Record<
  string,
  Pick<CoderTool, 'mutates' | 'parallelSafe' | 'riskLevel' | 'scopeAware' | 'interactive'>
> = {
  // ─── Filesystem reads ─────────────────────────────────────────
  read_file:        { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  list_directory:   { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  glob:             { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  get_diagnostics:  { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  get_tool_output:  { mutates: false, parallelSafe: true,  riskLevel: 'read' },

  // ─── Filesystem writes (path-scoped) ──────────────────────────
  write_file:       { mutates: true, parallelSafe: false, riskLevel: 'write', scopeAware: true },
  edit_file:        { mutates: true, parallelSafe: false, riskLevel: 'write', scopeAware: true },
  multi_edit:       { mutates: true, parallelSafe: false, riskLevel: 'write', scopeAware: true },
  create_file:      { mutates: true, parallelSafe: false, riskLevel: 'write', scopeAware: true },
  apply_patch:      { mutates: true, parallelSafe: false, riskLevel: 'write', scopeAware: true },

  // ─── Shell ────────────────────────────────────────────────────
  // `mutates: false` here is deliberate: shell tools SELF-GATE inside
  // their handler (see `tools/shell.ts` `isReadOnlyCommand` allowlist
  // for plan mode). If we marked them as mutating at the policy level
  // we'd double-block — even read-only commands like `ls` and `git
  // status` would refuse during plan mode, which is the opposite of
  // what the agent needs to explore the workspace before submitting a
  // plan. `parallelSafe: false` because shell side effects make
  // parallel dispatch unsafe regardless of how the gate resolves.
  run_command:      { mutates: false, parallelSafe: false, riskLevel: 'execute' },
  run_command_pty:  { mutates: false, parallelSafe: false, riskLevel: 'execute' },

  // ─── Git ──────────────────────────────────────────────────────
  git_status:       { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  git_diff:         { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  git_log:          { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  git_add:          { mutates: true,  parallelSafe: false, riskLevel: 'admin' },
  git_commit:       { mutates: true,  parallelSafe: false, riskLevel: 'admin' },
  git_branch:       { mutates: true,  parallelSafe: false, riskLevel: 'admin' },

  // ─── Web / external IO (read-only) ────────────────────────────
  web_fetch:        { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  web_search:       { mutates: false, parallelSafe: true,  riskLevel: 'read' },

  // ─── LSP (read) ───────────────────────────────────────────────
  lsp_definition:   { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  lsp_references:   { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  lsp_hover:        { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  lsp_diagnostics:  { mutates: false, parallelSafe: true,  riskLevel: 'read' },

  // ─── Worktree (admin) ─────────────────────────────────────────
  enter_worktree:   { mutates: true, parallelSafe: false, riskLevel: 'admin' },
  exit_worktree:    { mutates: true, parallelSafe: false, riskLevel: 'admin' },

  // ─── Subagent / orchestration ─────────────────────────────────
  spawn_agent:      { mutates: false, parallelSafe: false, riskLevel: 'admin' },
  expand_toolset:   { mutates: false, parallelSafe: false, riskLevel: 'admin' },
  invoke_skill:     { mutates: false, parallelSafe: false, riskLevel: 'read' },

  // ─── Interactive (pause for human) ────────────────────────────
  ask_user:         { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
  submit_plan:      { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
  submit_tasks:     { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
  execute_task:     { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
  task_complete:    { mutates: false, parallelSafe: false, riskLevel: 'read' },
  todo_write:       { mutates: false, parallelSafe: false, riskLevel: 'read' },

  // ─── Subordinate company variants (master-directed) ───────────
  ask_master:               { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
  submit_plan_to_master:    { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
  submit_tasks_to_master:   { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
};

/**
 * Resolved metadata after applying the precedence chain:
 *   1. explicit field on the tool definition;
 *   2. `BUILTIN_CLASSIFICATION` lookup by tool name;
 *   3. conservative fallback by source.
 *
 * Always returns a fully populated record so callers don't need to
 * second-guess defaults.
 */
export interface ResolvedToolMetadata {
  mutates: boolean;
  parallelSafe: boolean;
  riskLevel: ToolRiskLevel;
  requiresSandbox: boolean;
  scopeAware: boolean;
  interactive: boolean;
}

export function resolveToolMetadata(tool: CoderTool): ResolvedToolMetadata {
  const builtin = BUILTIN_CLASSIFICATION[tool.name];

  // Phase 2 default posture: legacy-compatible. Tools that don't declare
  // metadata and aren't in `BUILTIN_CLASSIFICATION` fall through as
  // `mutates: false` so the policy module preserves the pre-hardening
  // behaviour where unknown tools (master/company tools, MCP external,
  // etc) ran freely. Tightening this default to "mutates by default"
  // is reserved for Phase 5 (strict mode) — at that point the policy
  // context's `strict: true` flag will make the difference.
  //
  // Within this default posture, `parallelSafe` still respects the
  // `mutates` outcome (a tool declared mutating is never paralelizable).
  const sourceDefault = {
    mutates: false,
    parallelSafe: true,
    riskLevel: 'read' as ToolRiskLevel,
  };

  const mutates = tool.mutates ?? builtin?.mutates ?? sourceDefault.mutates;
  const parallelSafe =
    tool.parallelSafe
    ?? builtin?.parallelSafe
    ?? (mutates ? false : sourceDefault.parallelSafe);
  const riskLevel = tool.riskLevel ?? builtin?.riskLevel ?? sourceDefault.riskLevel;
  const requiresSandbox = tool.requiresSandbox ?? false;
  const scopeAware = tool.scopeAware ?? builtin?.scopeAware ?? false;
  const interactive = tool.interactive ?? builtin?.interactive ?? false;

  return { mutates, parallelSafe, riskLevel, requiresSandbox, scopeAware, interactive };
}

/**
 * The runtime context the policy needs to decide an invocation. Constructed
 * by the runner from its own state right before each tool dispatch.
 */
export interface PolicyContext {
  /** Plan mode is active for this run. */
  planMode: boolean;
  /** A `submit_plan` was approved by the user. */
  planApproved: boolean;
  /** Spec mode is active for this run (agentId='spec'). */
  specMode?: boolean;
  /** A `submit_spec` was approved by the user — unblocks mutating tools the same way `planApproved` does. */
  specApproved?: boolean;
  /** Inline task scope, when one is open. */
  taskScope: { id: string; files: string[] } | null;
  /**
   * Reserved for Phase 5 hardening. When `true`, the policy enforces
   * stricter outside-plan-mode checks (e.g., shell allowlist active even
   * with no planMode) unless the caller explicitly opts back in via
   * `adminOverride: true`. Today the runner constructs the context with
   * `strict: false` so behaviour matches Phase 1.
   */
  strict?: boolean;
  /** Operator-set escape hatch — when `true`, bypasses the strict checks. */
  adminOverride?: boolean;
  /** Whether a sandbox runtime is bound to the session. */
  sandboxBound?: boolean;
}

/**
 * Why a particular invocation was refused. Fed into the `blocked` event
 * payload so dashboards can render a precise message.
 */
export type PolicyReason =
  | 'plan_mode'
  | 'spec_mode'
  | 'task_scope'
  | 'sandbox_required'
  | 'admin_required';

export type PolicyDecision =
  | { allowed: true; metadata: ResolvedToolMetadata }
  | {
      allowed: false;
      reason: PolicyReason;
      detail: string;
      metadata: ResolvedToolMetadata;
    };

/**
 * Internal tools that ALWAYS require user confirmation when the active
 * agent opted into `confirmBeforeIrreversible`. Explicit, auditable set
 * — easier to reason about than relying purely on the regex heuristic.
 *
 * External MCP tools (whose names we cannot enumerate ahead of time)
 * fall through to the destructive-verb heuristic in `isIrreversibleTool`.
 */
const INTERNAL_IRREVERSIBLE: ReadonlySet<string> = new Set([
  // Native git mutations
  'git_add',
  'git_commit',
  'git_branch',
  // Worktree lifecycle
  'enter_worktree',
  'exit_worktree',
  // MCP project / snapshot / index mutations
  'mcp__index_project',
  'mcp__delete_project',
  'mcp__add_snapshot',
  'mcp__update_snapshot',
  'mcp__delete_snapshot',
]);

/**
 * Conservative regex over tool names. Catches the common destructive-verb
 * prefixes that external MCP servers use (cloudflare `r2_bucket_delete`,
 * `kv_namespace_create`, `hyperdrive_config_edit`, etc.) without us having
 * to maintain a registry of every external MCP tool.
 *
 * Trade-off: an external read-only tool that happens to use a verb like
 * `set_` will be flagged as irreversible and prompt the user. That is an
 * acceptable false-positive cost — the user confirms and proceeds. The
 * upside is zero-maintenance coverage of any MCP server registered in
 * the future.
 */
const IRREVERSIBLE_VERB_REGEX = /(?:^|_)(delete|destroy|drop|remove|create|publish|apply|commit|push|update|replace|set)(?:_|$)/i;

/**
 * Whether a tool name should trip the `confirmBeforeIrreversible` gate.
 *
 * Priority:
 *   1. Internal set — fastest path, explicit allow/deny audit.
 *   2. Heuristic over name — covers external MCP mutations.
 *
 * Returns `false` for clearly read-only tools whose name doesn't match
 * the destructive-verb pattern, including ALL `mcp__list_*`, `mcp__get_*`,
 * `mcp__search_*`, `mcp__find_*` families.
 */
export function isIrreversibleTool(name: string): boolean {
  if (INTERNAL_IRREVERSIBLE.has(name)) return true;
  return IRREVERSIBLE_VERB_REGEX.test(name);
}

/**
 * Predicate exposed for callers (the runner) that already know the
 * candidate paths. Returns the violators when the policy has a scope and
 * any path is outside it. Keeping the predicate here lets the runner do
 * a single resolveToolMetadata + a single scope check; the path
 * extractor stays in the runner where it has access to argument shapes.
 */
export function findScopeViolations(
  candidatePaths: readonly string[],
  scopeFiles: string[],
  isInsideScope: (candidate: string, files: string[]) => boolean,
): string[] {
  if (candidatePaths.length === 0) return [];
  return candidatePaths.filter((p) => !isInsideScope(p, scopeFiles));
}

/**
 * Decide whether `tool` may be invoked with `args` under `ctx`.
 *
 * Path-scope enforcement is split: we tell the caller *whether* the
 * tool needs scope validation (via `metadata.scopeAware`), and the
 * caller — which knows how to extract paths from this tool's argument
 * shape — applies `findScopeViolations`. Splitting it keeps this
 * module argument-shape agnostic and easy to test.
 */
export function evaluateToolInvocation(
  tool: CoderTool,
  args: Record<string, unknown>,
  ctx: PolicyContext,
): PolicyDecision {
  const metadata = resolveToolMetadata(tool);
  void args;

  // 1. Sandbox requirement — fails fast if the tool needs one and the
  //    session has none bound.
  if (metadata.requiresSandbox && !ctx.sandboxBound) {
    return {
      allowed: false,
      reason: 'sandbox_required',
      detail: `Tool '${tool.name}' requires a sandbox runtime but none is bound to this session.`,
      metadata,
    };
  }

  // 2. Plan-mode mutating block — same semantics as the legacy
  //    `MUTATING_TOOLS` check in `runner.ts`. The runner still does the
  //    inline-task-scope unlock when `metadata.scopeAware` is set, by
  //    looking at this decision's reason and re-running the tool when the
  //    paths are inside scope. See runner.ts dispatch site.
  if (metadata.mutates && ctx.planMode && !ctx.planApproved) {
    return {
      allowed: false,
      reason: 'plan_mode',
      detail: `Tool '${tool.name}' is blocked in plan mode. Call 'submit_plan' first and wait for user approval before mutating the workspace.`,
      metadata,
    };
  }

  // 2b. Spec-mode mutating block — parallel to plan mode but driven by
  //     `submit_spec` approval. The runner unlocks `specApproved` when the
  //     user approves the written specification; until then, mutating tools
  //     are refused. Inline task scope still grants per-task unlocks via
  //     the same scope-aware path the planMode branch uses.
  if (metadata.mutates && ctx.specMode && !ctx.specApproved) {
    return {
      allowed: false,
      reason: 'spec_mode',
      detail: `Tool '${tool.name}' is blocked in spec mode. Call 'submit_spec' first and wait for human approval before mutating the workspace.`,
      metadata,
    };
  }

  // 3. Strict mode — Phase 5 reserved. Today `ctx.strict` is always
  //    falsy, so this branch is dead code by design. Wired in advance
  //    so the call-site contract is stable.
  if (
    ctx.strict
    && !ctx.adminOverride
    && (metadata.riskLevel === 'execute' || metadata.riskLevel === 'admin')
  ) {
    return {
      allowed: false,
      reason: 'admin_required',
      detail: `Tool '${tool.name}' (riskLevel=${metadata.riskLevel}) requires adminOverride in strict mode.`,
      metadata,
    };
  }

  return { allowed: true, metadata };
}
