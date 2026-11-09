/**
 * Per-session tool permission gate — pauses write/execute/admin-class tool
 * calls and asks the user for approval before executing, depending on the
 * session's permission mode:
 *
 *   - 'ask'           → write + execute + admin pause;
 *   - 'auto'          → execute + admin pause (file edits run free);
 *   - 'unrestricted'  → new work runs freely; DB writes and exact uncertain replays remain explicit.
 *
 * Enforced in code at the dispatch layer (executing-dispatch + code_exec
 * nested calls), NOT by the model. The gate lives on `ToolContext`, so
 * subagent contexts inherit the same instance — approvals always surface
 * and resolve on the PARENT runner (session level).
 *
 * Pause protocol: register a keyed resolver slot via the runner's
 * `waitForUserInput(askId)` BEFORE emitting `tool_approval_request` (no
 * resolve-before-register race), then await the user's verdict delivered
 * through `provideUserInput(json, askId)`. `interruptWait()` / abort resolve
 * the slot with `{interrupted:true}` / `{aborted:true}` — both deny.
 * Unparseable or foreign payloads deny too (fail-safe).
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { createHash } from 'node:crypto';
import { stableArgsKey } from './runner/dup-utils.js';
import { needsOutcomeRecoveryApproval } from './uncertain-tool-outcome.js';
import { isIrreversibleTool, resolveToolInvocationMetadata } from './policy.js';
import type { OutcomeRecoverySnapshot } from './outcome-recovery-state.js';

export type ToolPermissionMode = 'ask' | 'auto' | 'unrestricted';
export type ApprovalRiskClass = 'write' | 'execute' | 'admin';
export type ApprovalKind = 'standard' | 'database_write' | 'outcome_recovery';

export const TOOL_PERMISSION_MODES: readonly ToolPermissionMode[] = ['ask', 'auto', 'unrestricted'];

/** Coerce arbitrary input (DB column, HTTP body) to a valid mode. */
export function normalizeToolPermissionMode(v: unknown, fallback: ToolPermissionMode = 'auto'): ToolPermissionMode {
  return TOOL_PERMISSION_MODES.includes(v as ToolPermissionMode) ? (v as ToolPermissionMode) : fallback;
}

/** Keyed slot id for `waitForUserInput`/`provideUserInput`. */
export function approvalAskId(toolUseId: string): string {
  return `tool_approval:${toolUseId}`;
}

/**
 * Stable `[user-denied` prefix — `classifyToolRefusal` maps it to
 * `refusal_kind='user_denied'`, which keeps denials out of error telemetry
 * and failure-streak counting.
 */
export function buildUserDeniedText(toolName: string, note?: string): string {
  const motive = note && note.trim() ? ` Motivo: ${note.trim()}.` : '';
  return `[user-denied: o usuário negou permissão para \`${toolName}\`.${motive} `
    + 'Não repita a mesma chamada sem mudar a abordagem — ajuste os argumentos, '
    + 'use outra ferramenta, ou pergunte ao usuário via ask_user.]';
}

/**
 * Tools whose own execution is never gated: wrappers whose INNER calls are
 * gated individually (double-gating would pause twice for one action).
 */
const NEVER_GATE: ReadonlySet<string> = new Set([
  'code_exec', 'spawn_agent', 'spawn_agents', 'execute_tasks', 'get_tool_output',
  // workflow — DAG orchestrator; its steps' INNER tool calls are gated
  // individually inside each subagent (same rationale as execute_tasks).
  'workflow',
]);

const READ_VERB_REGEX = /(?:^|_)(list|get|read|search|find|query|status|describe|fetch|count|head|show|view|preview)(?:_|$)/i;
const DESTRUCTIVE_VERB_REGEX = /(?:^|_)(delete|destroy|drop|remove|push|publish|deploy)(?:_|$)/i;

/**
 * Map a tool to its gate class. Reuses the policy metadata chain
 * (explicit field → BUILTIN_CLASSIFICATION → fallback). The policy fallback
 * resolves unclassified tools as read/non-mutating, which would mean MCP
 * tools NEVER gate — so for non-native tools with no declared metadata we
 * apply name heuristics instead (destructive verb → admin, read verb →
 * allow, anything else → write).
 */
export function classifyForGate(
  tool: CoderTool | undefined,
  name: string,
  input?: unknown,
): 'allow' | ApprovalRiskClass {
  if (NEVER_GATE.has(name)) return 'allow';
  if (!tool) return 'write'; // unknown tool name — conservative (invoke will error anyway)
  const declared = tool.riskLevel !== undefined || tool.mutates !== undefined;
  // Keep the approval UX's established verb-based refinement for genuinely
  // unannotated external tools. The shared policy metadata remains
  // conservative for lifecycle/accounting, while obvious remote reads do not
  // prompt and destructive verbs receive the stronger admin class.
  if (tool.source !== 'native' && !declared && typeof tool.riskOf !== 'function') {
    if (DESTRUCTIVE_VERB_REGEX.test(name)) return 'admin';
    if (READ_VERB_REGEX.test(name)) return 'allow';
    return 'write';
  }
  const meta = resolveToolInvocationMetadata(tool, input);
  if (meta.interactive) return 'allow'; // already pauses via its own wait — double-pause deadlocks the UX
  if (meta.riskLevel === 'admin') return 'admin';
  if (meta.riskLevel === 'execute') return 'execute';
  if (meta.riskLevel === 'write') return 'write';
  // riskLevel === 'read':
  if (meta.mutates) return 'write'; // declared mutating but read-risk — gate as write
  if (tool.source === 'native' || declared) return 'allow';
  // MCP/plugin tool with no metadata at all — classify by name.
  if (DESTRUCTIVE_VERB_REGEX.test(name)) return 'admin';
  if (READ_VERB_REGEX.test(name)) return 'allow';
  return isIrreversibleTool(name) ? 'write' : 'write';
}

/**
 * Compact-but-useful preview of the call's args for the approval card.
 * Larger than the 80-char dup marker on purpose: the user is deciding
 * whether to allow this exact call, so the command/path/content matters.
 */
export function approvalArgsSummary(input: unknown): string {
  try {
    const flat = (JSON.stringify(input ?? {}) ?? '{}').replace(/[\r\n\t]+/g, ' ');
    return flat.length <= 600 ? flat : flat.slice(0, 597) + '...';
  } catch {
    return '<unserialisable>';
  }
}

/** Database mutations always require an explicit session-level safety decision. */
export function approvalKindFor(toolName: string, riskClass: ApprovalRiskClass): ApprovalKind {
  return riskClass === 'write' && (toolName === 'db_query' || toolName === 'db_command')
    ? 'database_write'
    : 'standard';
}

export interface ApprovalCheckInput {
  /** Unique per request — `tu.id` at dispatch, synthetic for nested calls. */
  toolUseId: string;
  toolName: string;
  input: unknown;
  /** Undefined when the name doesn't resolve to a registered tool. */
  tool?: CoderTool;
  /** Chat-visible anchor block when the request is raised in a nested context. */
  parentToolUseId?: string;
  turn?: number;
  nested?: boolean;
  outcomeRecovery?: import('./tool.js').ToolContext['outcomeRecovery'];
}

export type ApprovalCheckResult =
  | { allowed: true }
  | { allowed: false; refusalText: string };

export interface PermissionGateDeps {
  /** Read live so mid-run mode changes apply to the next check. */
  getMode: () => ToolPermissionMode;
  emit: (event: 'tool_approval_request' | 'tool_approval_resolved', payload: Record<string, unknown>) => void;
  waitForUserInput: (askId: string) => Promise<string>;
  /** Release the existing keyed slot after durable recovery restores policy. */
  resolvePending?: (askId: string, value: string) => boolean;
  /** Session "always allow" grants persisted from previous runs. */
  initialGrants?: readonly string[];
  /** Persist a new "always allow" grant. */
  onGrant?: (toolName: string) => void;
  /** Keep-alive while ≥1 approval is pending (stuck-running watchdog). */
  onPendingTick?: () => void;
}

const KEEP_ALIVE_MS = 4 * 60_000; // watchdog flips at 10 min — tick well under it

export class PermissionGate {
  private readonly deps: PermissionGateDeps;
  private readonly grants: Set<string>;
  /** Exact invocation grants only; historical uncertainty is never erased. */
  private readonly recoveryApprovals = new Set<string>();
  private readonly pendingPolicyChecks = new Set<() => void>();
  private pending = 0;
  private keepAlive: ReturnType<typeof setInterval> | null = null;

  constructor(deps: PermissionGateDeps) {
    this.deps = deps;
    this.grants = new Set(deps.initialGrants ?? []);
  }

  pendingCount(): number {
    return this.pending;
  }

  getMode(): ToolPermissionMode { return this.deps.getMode(); }

  requiresOutcomeRecoveryApproval(req: ApprovalCheckInput): boolean {
    return needsOutcomeRecoveryApproval(req.outcomeRecovery, req.tool, req.input, this.getMode());
  }

  /** Event-driven: a live mode switch can release an already waiting new call. */
  refreshPending(): void {
    for (const check of this.pendingPolicyChecks) check();
  }

  /**
   * A gate clone for BACKGROUND (fire-and-forget) subagents. Same allow logic
   * — the parent's live `getMode` and a snapshot of its "always allow" grants —
   * but any decision that WOULD pause for the user instead auto-denies: a
   * background job may settle between runs, where there is no runner/SSE to
   * surface or resolve an approval prompt (it would hang until a watchdog
   * kills it). The denial is tagged `[user-denied` so it stays out of error
   * telemetry and failure-streak counting, with a note explaining the cause.
   */
  forBackground(): PermissionGate {
    return new PermissionGate({
      getMode: this.deps.getMode,
      emit: () => { /* no approval UI in a detached background context */ },
      initialGrants: [...this.grants],
      waitForUserInput: async () => JSON.stringify({
        note: 'background agents run non-interactively — grant "always allow" first, '
          + 'or run this in a foreground spawn_agent',
      }),
    });
  }

  async check(req: ApprovalCheckInput): Promise<ApprovalCheckResult> {
    if (req.outcomeRecovery?.toolUseIds.length && req.outcomeRecovery.refresh) {
      await req.outcomeRecovery.refresh();
    }
    const recovery = this.requiresOutcomeRecoveryApproval(req);
    if (recovery && this.hasOutcomeRecoveryApproval(req)) return { allowed: true };
    const classified = classifyForGate(req.tool, req.toolName, req.input);
    const riskClass = recovery && classified === 'allow' ? 'execute' : classified;
    if (riskClass === 'allow') return { allowed: true };
    const approvalKind = recovery ? 'outcome_recovery' : approvalKindFor(req.toolName, riskClass);
    // A deliberate "always allow" grant is the only bypass for DB writes.
    // Global auto/unrestricted modes must not silently authorize data mutation.
    if (!recovery && this.grants.has(req.toolName)) return { allowed: true };
    const mode = this.deps.getMode();
    if (approvalKind === 'standard') {
      if (mode === 'unrestricted') return { allowed: true };
      if (mode === 'auto' && riskClass === 'write') return { allowed: true };
    }

    const recoverySnapshot = recovery ? req.outcomeRecovery?.snapshot?.() : undefined;
    // Bind this decision to the occurrences present before the card is shown.
    // Reusing a toolUseId does not make a later incident the same operation.
    const admissionKey = this.recoveryKey(req);

    // Slot first, event second — a same-tick approval must find the resolver.
    const wait = this.deps.waitForUserInput(approvalAskId(req.toolUseId));
    let automaticRecovery = false;
    const closeRecovered = (): void => {
      if (!this.deps.resolvePending || this.requiresOutcomeRecoveryApproval(req)) return;
      if (this.policyAllows(req) && this.deps.resolvePending(approvalAskId(req.toolUseId), JSON.stringify({ approved: true }))) automaticRecovery = true;
    };
    const unsubscribe = recovery ? req.outcomeRecovery?.subscribe?.(closeRecovered) : undefined;
    this.pendingPolicyChecks.add(closeRecovered);
    this.beginPending();
    try {
      this.deps.emit('tool_approval_request', {
        toolUseId: req.toolUseId,
        parentToolUseId: req.parentToolUseId,
        toolName: req.toolName,
        argsSummary: approvalArgsSummary(req.input),
        // Database and recovery approvals need the exact call, not the compact
        // 600-character summary, so the user can make an informed decision.
        // Keep other tools summary-only to avoid duplicating arbitrarily large
        // file contents in the SSE stream.
        ...((recovery || req.toolName === 'db_query' || req.toolName === 'db_command')
          && req.input && typeof req.input === 'object'
          ? { input: req.input }
          : {}),
        riskClass,
        approvalKind,
        ...(recoverySnapshot?.acknowledge && recoverySnapshot.incidents.length ? {
          recovery: { fingerprint: recoverySnapshot.fingerprint, incidents: recoverySnapshot.incidents },
        } : {}),
        turn: req.turn,
        nested: req.nested ?? false,
      });
      const answer = await wait;
      return await this.resolve(req, answer, recoverySnapshot, admissionKey, recovery, automaticRecovery);
    } finally {
      unsubscribe?.();
      this.pendingPolicyChecks.delete(closeRecovered);
      this.endPending();
    }
  }

  hasOutcomeRecoveryApproval(req: ApprovalCheckInput): boolean {
    return this.recoveryApprovals.has(this.recoveryKey(req));
  }

  /** The Registry consumes admission once; a repeated physical call needs a new decision. */
  consumeOutcomeRecoveryApproval(req: ApprovalCheckInput): boolean {
    return this.recoveryApprovals.delete(this.recoveryKey(req));
  }

  private recoveryKey(req: ApprovalCheckInput): string {
    return createHash('sha256').update(stableArgsKey({
      id: req.toolUseId, name: req.toolName, input: req.input,
      pending: [...(req.outcomeRecovery?.toolUseIds ?? [])].sort(),
      fingerprint: req.outcomeRecovery?.snapshot?.().fingerprint,
      replay: [...(req.outcomeRecovery?.replayToolUseIds?.(req.toolName, req.input) ?? [])].sort(),
    })).digest('hex');
  }

  private policyAllows(req: ApprovalCheckInput): boolean {
    const currentClass = classifyForGate(req.tool, req.toolName, req.input);
    const currentMode = this.deps.getMode();
    return currentClass === 'allow' || this.grants.has(req.toolName)
      || (approvalKindFor(req.toolName, currentClass) === 'standard'
        && (currentMode === 'unrestricted' || (currentMode === 'auto' && currentClass === 'write')));
  }

  private async resolve(req: ApprovalCheckInput, raw: string, snapshot: OutcomeRecoverySnapshot | undefined, admissionKey: string, recoveryOrigin: boolean, automaticRecovery: boolean): Promise<ApprovalCheckResult> {
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
    } catch { /* fail-safe deny below */ }

    if (payload.approved === true) {
      // Resolving the wait slot schedules a continuation. A new incident or a
      // mode change can arrive before that continuation actually runs.
      if (automaticRecovery) {
        if (this.requiresOutcomeRecoveryApproval(req) || !this.policyAllows(req)) {
          this.emitResolved(req, false, 'recovery', 'recovery or permission state changed before dispatch');
          return { allowed: false, refusalText: '[tool-recovery-state-changed: recovery or permission state changed before dispatch. Nothing was dispatched; check the current state before requesting approval again.]' };
        }
        this.emitResolved(req, true, 'recovery');
        return { allowed: true };
      }
      if (payload.recoveryReviewed === true) {
        if (!snapshot?.acknowledge || payload.recoveryFingerprint !== snapshot.fingerprint) {
          this.emitResolved(req, false, 'user', 'recovery snapshot changed or is unavailable');
          return { allowed: false, refusalText: '[tool-recovery-review-invalid: recovery review did not match the displayed incidents. Nothing was dispatched.]' };
        }
        try {
          await snapshot.acknowledge();
          if (req.outcomeRecovery?.toolUseIds.length) throw new Error('New unresolved incidents require review.');
        } catch {
          this.emitResolved(req, false, 'user', 'recovery review could not be durably confirmed');
          return { allowed: false, refusalText: '[tool-recovery-review-unconfirmed: the incident review could not be committed or new incidents appeared. Nothing was dispatched. Inspect recovery status before proceeding.]' };
        }
      }
      const recovery = this.requiresOutcomeRecoveryApproval(req);
      if (recovery) {
        if (payload.recoveryReviewed !== true && (!recoveryOrigin || this.recoveryKey(req) !== admissionKey)) {
          this.emitResolved(req, false, 'user', 'recovery incidents changed after the approval was requested');
          return { allowed: false, refusalText: '[tool-recovery-state-changed: new recovery incidents were not covered by this approval. Nothing was dispatched; inspect the updated incidents before requesting approval again.]' };
        }
        // A successful durable review explicitly authorizes the transition to
        // its post-review state. Execute-once never grants a different state.
        this.recoveryApprovals.add(payload.recoveryReviewed === true ? this.recoveryKey(req) : admissionKey);
      }
      if (!recoveryOrigin && !recovery && payload.alwaysAllow === true) {
        this.grants.add(req.toolName);
        try { this.deps.onGrant?.(req.toolName); } catch { /* persistence is best-effort */ }
      }
      this.emitResolved(req, true, 'user');
      return { allowed: true };
    }
    if (payload.aborted === true) {
      this.emitResolved(req, false, 'abort');
      // Intentionally NOT `[user-denied` — aborts must not be tagged as user denials.
      return { allowed: false, refusalText: `[tool-aborted: \`${req.toolName}\` cancelled by user/session.]` };
    }
    if (payload.interrupted === true) {
      this.emitResolved(req, false, 'interrupt');
      return {
        allowed: false,
        refusalText: buildUserDeniedText(req.toolName, 'aprovação interrompida por nova mensagem do usuário'),
      };
    }
    // Explicit deny — or unparseable/foreign payload (fail-safe: deny).
    const note = typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim() : undefined;
    this.emitResolved(req, false, 'user', note);
    return { allowed: false, refusalText: buildUserDeniedText(req.toolName, note) };
  }

  private emitResolved(req: ApprovalCheckInput, approved: boolean, source: 'user' | 'interrupt' | 'abort' | 'recovery', note?: string): void {
    this.deps.emit('tool_approval_resolved', {
      toolUseId: req.toolUseId,
      toolName: req.toolName,
      approved,
      source,
      ...(note ? { note } : {}),
    });
  }

  private beginPending(): void {
    this.pending += 1;
    if (this.pending === 1 && this.deps.onPendingTick && !this.keepAlive) {
      this.keepAlive = setInterval(() => {
        try { this.deps.onPendingTick?.(); } catch { /* best-effort */ }
      }, KEEP_ALIVE_MS);
      this.keepAlive.unref?.();
    }
  }

  private endPending(): void {
    this.pending -= 1;
    if (this.pending === 0 && this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }
}
