import { resolveToolMetadata, resolveToolInvocationMetadata } from './tool-classification.js';
import type { ResolvedToolMetadata } from './tool-classification.js';
export type { ResolvedToolMetadata } from './tool-classification.js';
export { resolveToolMetadata, isExplicitlyParallelSafeRead, resolveToolInvocationMetadata } from './tool-classification.js';
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

import type { AgentDecisionGuidance } from '@mcp/code-agent/agents/decision-types.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';

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

export type SoftGuardrailReason = 'read_only_risk_budget' | 'admin_escalation';

export type SoftGuardrailDecision =
  | { allowed: true; metadata: ResolvedToolMetadata }
  | {
      allowed: false;
      reason: SoftGuardrailReason;
      detail: string;
      metadata: ResolvedToolMetadata;
    };

export interface SoftGuardrailContext {
  /** Default-off switch owned by the host/runner. */
  enabled: boolean;
  /** Compact decision guidance for the current task/turn. */
  guidance?: AgentDecisionGuidance | null;
  /** Confidence below which the guardrail observes but does not block. Default 0.6. */
  minConfidence?: number;
}

const DEFAULT_SOFT_GUARDRAIL_CONFIDENCE = 0.6;

/**
 * Soft AgentDecision guardrail. Default-off and intentionally narrow: it only
 * blocks high-risk deviations that are almost certainly wrong for the current
 * decision. It does NOT replace plan/spec/task-scope policy and never removes
 * tools from the model's visible list; callers surface this as a normal gate
 * refusal before invocation.
 */
export function evaluateSoftAgentDecisionGuardrail(
  tool: CoderTool,
  ctx: SoftGuardrailContext,
): SoftGuardrailDecision {
  const metadata = resolveToolMetadata(tool);
  const g = ctx.guidance;
  if (!ctx.enabled || !g) return { allowed: true, metadata };
  const minConfidence = ctx.minConfidence ?? DEFAULT_SOFT_GUARDRAIL_CONFIDENCE;
  if (g.confidence < minConfidence) return { allowed: true, metadata };

  // Never allow a non-admin decision to wander into admin-risk tooling. This
  // catches direct git/snapshot/index/admin calls from weaker models without
  // relying on the prompt alone.
  if (metadata.riskLevel === 'admin' && g.riskBudget !== 'admin') {
    return {
      allowed: false,
      reason: 'admin_escalation',
      detail:
        `[agent-decision-guardrail: ${tool.name} is admin-risk, but the current task was classified as ` +
        `${g.intent}/${g.phase} with risk<=${g.riskBudget}. Ask the user explicitly before admin work.]`,
      metadata,
    };
  }

  // For confident read-only decisions, block mutations/admin escalation before
  // they run. Execute-risk tools such as `run_command` may still be legitimate
  // read-only inspection in plan/explore flows; shell-specific safety remains in
  // the shell handler / permission gate.
  const irreversible = isIrreversibleTool(tool.name);
  if (g.riskBudget === 'read' && (metadata.mutates || metadata.riskLevel === 'admin' || irreversible)) {
    return {
      allowed: false,
      reason: 'read_only_risk_budget',
      detail:
        `[agent-decision-guardrail: ${tool.name} risk=${metadata.riskLevel} exceeds ` +
        `the read-only budget for ${g.intent}/${g.phase}. Use read/search/planning tools or ask the user to switch scope.]`,
      metadata,
    };
  }

  return { allowed: true, metadata };
}

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
 * Execution-intent workflow verbs that must reach their handler even in
 * plan mode, despite carrying `mutates: true`. The handler itself runs the
 * human-gated transition (present the plan, wait for approval, switch to
 * build) instead of editing the workspace directly — mirroring how
 * `submit_plan` / `submit_tasks` are allowed because they pause for approval
 * rather than mutating.
 *
 * Scope is deliberately narrow: only the "I'm done planning, execute" verb,
 * and only PLAN mode (the handler has no spec→build path, so spec mode stays
 * strict). Direct mutating tools (`edit_file`, `write_file`, `git_commit`,
 * `run_command`) stay gated so plan mode keeps meaning something.
 */
const PLAN_MODE_WORKFLOW_TOOLS: ReadonlySet<string> = new Set(['execute_tasks']);

/**
 * True when the tool is an execution-intent workflow verb that the plan gate
 * must let through to its handler. Consumed by both gate sites — this module's
 * `evaluateToolInvocation` and the BT-bridge `toolGate` in runner.ts — so the
 * exemption can't drift between them.
 */
export function isPlanModeWorkflowTool(name: string): boolean {
  return PLAN_MODE_WORKFLOW_TOOLS.has(name);
}

/**
 * Spec mode owns a distinct approval contract. A regular plan can never
 * satisfy that contract, while gated task submission is valid only after the
 * specification itself has been approved.
 *
 * Keep this predicate exported so both the invocation policy and the
 * per-turn catalog assembly enforce the same invariant. Handler-level guards
 * remain as a final defense for direct/test/nested invocations that bypass the
 * normal dispatcher.
 */
export function specModeInteractionBlockDetail(
  name: string,
  args: Readonly<Record<string, unknown>>,
  specApproved: boolean,
): string | null {
  if (name === 'submit_plan') {
    return "Tool 'submit_plan' is unavailable in spec mode. Submit the specification with 'submit_spec'; approving a regular plan does not release the spec gate.";
  }
  if (specApproved) return null;
  if (name === 'submit_tasks') {
    return "Tool 'submit_tasks' is blocked until the specification is approved. Call 'submit_spec' first and wait for human approval.";
  }
  if (name === 'task_list' && args.gate === 'approve') {
    return "task_list gate:'approve' is blocked until the specification is approved. Call 'submit_spec' first; gate:'track' remains available for a non-blocking checklist.";
  }
  return null;
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
  const metadata = resolveToolInvocationMetadata(tool, args);

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

  // 1b. Spec mode has exactly one approval primitive. Prompt instructions are
  // not a security or lifecycle boundary: without this hard gate a model can
  // call submit_plan, receive approval, and remain permanently blocked because
  // only submit_spec flips specApproved.
  if (ctx.specMode) {
    const detail = specModeInteractionBlockDetail(
      tool.name,
      args,
      ctx.specApproved === true,
    );
    if (detail) {
      return {
        allowed: false,
        reason: 'spec_mode',
        detail,
        metadata,
      };
    }
  }

  // 2. Plan-mode mutating block — same semantics as the legacy
  //    `MUTATING_TOOLS` check in `runner.ts`. The runner still does the
  //    inline-task-scope unlock when `metadata.scopeAware` is set, by
  //    looking at this decision's reason and re-running the tool when the
  //    paths are inside scope. See runner.ts dispatch site.
  if (
    metadata.mutates
    && ctx.planMode
    && !ctx.planApproved
    && !isPlanModeWorkflowTool(tool.name)
  ) {
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
