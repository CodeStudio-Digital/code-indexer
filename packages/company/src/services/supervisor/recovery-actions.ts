/**
 * AgentSupervisor — Recovery Action Library (Sprint 4 Phase 2.2).
 *
 * Catalog of deterministic recovery actions. The supervisor's periodic
 * tick (`AgentSupervisor.tickOnce`) dispatches the first matching
 * action when a stuck state is detected. Actions are pure functions
 * with explicit pre/post-conditions — no AI, no heuristics, no surprise.
 *
 * Phase 2.2 ships 3 actions:
 *
 *   1. `abortStuckTool`            — STUCK_TOOL → inject tool_result error
 *   2. `forceResumeSubordinate`    — STUCK_AWAITING_MASTER → kick sub forward
 *   3. `resurrectMasterIfOrphaned` — master TERMINAL + subs active → resurrect
 *
 * **NOT in Phase 2.2** (deferred): hardKillRunner, quarantineRole,
 * forceCompactionAndContinue, cancelOrphanMessages, requestMasterAttention.
 * These need either circuit breakers (Phase 2.3) or persistence
 * (Phase 2.4) to land cleanly.
 *
 * **Design**: each action takes a `StuckAgent` + `RecoveryContext`
 * (orchestrator service handles) + returns a `RecoveryOutcome`. The
 * dispatcher iterates a list and runs the first matching action.
 * Actions are independent — they don't call each other.
 */
import type { AgentSupervisionRecord, StuckAgent } from './heartbeat-tracker.js';
import type { SupervisionState } from './state-machine.js';

/**
 * Service handles the supervisor needs to actually act on agents.
 * Provided once at construction by the worker / orchestrator wiring.
 * All fields are OPTIONAL — when missing, the corresponding action
 * is a no-op (logged as `recovery_skipped`). This keeps Phase 2.2
 * shippable without forcing every host to wire everything.
 */
export interface RecoveryContext {
  /**
   * Subordinate lifecycle handle. Used by `forceResumeSubordinate`
   * to call `.resume(agentRunId, systemMessage)` so the subordinate
   * runner gets a fresh prompt and exits the stuck wait.
   */
  subordinates?: {
    resume(agentRunId: number, message?: string): Promise<unknown>;
    abort(agentRunId: number, reason?: string): Promise<unknown> | unknown;
  };
  /**
   * Master lifecycle handle. Used by `resurrectMasterIfOrphaned` to
   * call `.resurrect()` so the master runner is rebooted to handle
   * the subordinates that are still alive.
   */
  master?: {
    isAlive(): boolean;
    resurrect(reason: string): Promise<unknown>;
  };
  /**
   * Direct runner handle map. Used by `abortStuckTool` to inject a
   * tool_result error into the runner that's wedged on a tool call.
   * The dispatcher looks up `runner = runners.get(agentRunId)`.
   * When the map is missing OR the runner is gone (race), the action
   * downgrades to subordinates.abort().
   */
  runners?: Map<number, {
    /**
     * Inject a synthetic tool_result error for the given tool_use_id
     * so the runner can continue past the stuck call. The runner
     * MUST treat the injected result as if it came from the actual
     * tool dispatcher.
     */
    injectToolResultError?(toolUseId: string, errorMessage: string): void;
    /** Force-abort the runner. Last resort. */
    abort(reason?: string): void | Promise<void>;
  }>;
}

export type RecoveryOutcome =
  | { ok: true; action: string; detail: string }
  | { ok: false; action: string; detail: string; reason: 'skipped' | 'failed' | 'no_match' };

/**
 * Signature shared by every recovery action. Pure: receives the stuck
 * agent + context, returns an outcome. Side effects (calling runner
 * methods, etc.) happen inside the action; no implicit shared state.
 */
export type RecoveryAction = (
  stuck: StuckAgent,
  ctx: RecoveryContext,
) => Promise<RecoveryOutcome>;

// ─── Action 1: abortStuckTool ─────────────────────────────────

/**
 * STUCK_TOOL → inject a tool_result error so the runner unwedges.
 *
 * Pre:
 *   - state = STUCK_TOOL
 *   - record.currentToolUseId is set (set by `wireSupervisorToRunner`
 *     when AWAITING_TOOL is entered)
 *   - ctx.runners.get(agentRunId) provides `injectToolResultError`
 *
 * Post:
 *   - Runner receives synthetic tool_result with `is_error: true` and
 *     a structured message identifying the supervisor as the source.
 *   - Supervisor transition into RUNNING_TURN happens naturally via
 *     the runner's `tool_call_result` event (Phase 2.1 wiring).
 *
 * Fallback when `injectToolResultError` unavailable: call `runner.abort()`.
 * Worse outcome (terminates the run) but at least doesn't hang.
 */
export const abortStuckTool: RecoveryAction = async (stuck, ctx) => {
  if (stuck.toStuckState !== 'STUCK_TOOL') {
    return { ok: false, action: 'abortStuckTool', detail: 'state mismatch', reason: 'no_match' };
  }
  const record = stuck.record;
  const toolUseId = record.currentToolUseId;
  const toolName = record.currentToolName ?? 'unknown';
  if (!toolUseId) {
    return {
      ok: false,
      action: 'abortStuckTool',
      detail: 'currentToolUseId missing — observer wiring gap',
      reason: 'skipped',
    };
  }
  const runner = ctx.runners?.get(record.agentRunId);
  if (!runner) {
    return {
      ok: false,
      action: 'abortStuckTool',
      detail: 'no runner ref for agent',
      reason: 'skipped',
    };
  }
  const errorMessage =
    `[supervisor] Tool ${toolName} (id=${toolUseId}) timed out after ` +
    `${Math.round(stuck.ageMs / 1000)}s with no heartbeat. ` +
    `The supervisor aborted it so the run can continue. ` +
    `Consider a different tool / smaller scope / spawning a subagent.`;
  try {
    if (typeof runner.injectToolResultError === 'function') {
      runner.injectToolResultError(toolUseId, errorMessage);
      return {
        ok: true,
        action: 'abortStuckTool',
        detail: `injected tool_result error for ${toolName}/${toolUseId}`,
      };
    }
    // Fallback path — abort the runner entirely.
    await runner.abort(`supervisor: stuck tool ${toolName}`);
    return {
      ok: true,
      action: 'abortStuckTool',
      detail: `injectToolResultError unavailable; aborted runner (fallback)`,
    };
  } catch (e) {
    return {
      ok: false,
      action: 'abortStuckTool',
      detail: e instanceof Error ? e.message : String(e),
      reason: 'failed',
    };
  }
};

// ─── Action 2: forceResumeSubordinate ─────────────────────────

/**
 * STUCK_AWAITING_MASTER → reactivate the subordinate with a system
 * message explaining the master is unavailable. The runner exits
 * `waiting_*` and either completes the task itself or fails cleanly.
 *
 * Pre:
 *   - state = STUCK_AWAITING_MASTER
 *   - ctx.subordinates.resume available
 *   - ctx.master.isAlive() === false  (don't force-resume when master
 *     is alive — they might just be slow to answer)
 *
 * Post:
 *   - Subordinate receives a `[SYSTEM]` message about master timeout
 *   - Status transitions out of waiting_* into running
 */
export const forceResumeSubordinate: RecoveryAction = async (stuck, ctx) => {
  if (stuck.toStuckState !== 'STUCK_AWAITING_MASTER') {
    return {
      ok: false,
      action: 'forceResumeSubordinate',
      detail: 'state mismatch',
      reason: 'no_match',
    };
  }
  if (!ctx.subordinates) {
    return {
      ok: false,
      action: 'forceResumeSubordinate',
      detail: 'subordinates handle missing',
      reason: 'skipped',
    };
  }
  // Only force-resume when master is unambiguously gone. Resuming a
  // sub that's legitimately waiting for a slow human-in-the-loop
  // master would be destructive.
  if (ctx.master && ctx.master.isAlive()) {
    return {
      ok: false,
      action: 'forceResumeSubordinate',
      detail: 'master is alive — defer (master might just be slow)',
      reason: 'skipped',
    };
  }
  const minutesStuck = Math.round(stuck.ageMs / 60_000);
  const systemMessage =
    `[SYSTEM] You were waiting ${minutesStuck}min for the master to ` +
    `respond to your plan/question/tasks, but the master session is ` +
    `unavailable. The supervisor force-resumed you so you don't stay ` +
    `blocked indefinitely. Decide your next step on your own: complete ` +
    `the task with best-effort assumptions, or finish with a clear ` +
    `summary of what you couldn't do without master input.`;
  try {
    await ctx.subordinates.resume(stuck.record.agentRunId, systemMessage);
    return {
      ok: true,
      action: 'forceResumeSubordinate',
      detail: `resumed agent ${stuck.record.agentRunId} after ${minutesStuck}min stuck`,
    };
  } catch (e) {
    return {
      ok: false,
      action: 'forceResumeSubordinate',
      detail: e instanceof Error ? e.message : String(e),
      reason: 'failed',
    };
  }
};

// ─── Action 3: resurrectMasterIfOrphaned ──────────────────────

/**
 * Master is TERMINAL (ended) but subordinates are still alive —
 * resurrect the master so it can attend to them. Doesn't apply to a
 * specific stuck agent; the dispatcher calls this when ANY agent in
 * the session detects the orphan condition.
 *
 * Pre:
 *   - record.role !== 'master' (we react to subordinate stuckness,
 *     but the action targets the master)
 *   - ctx.master.isAlive() === false
 *
 * Post:
 *   - ctx.master.resurrect(reason) called
 *   - On success, master record will transition back to RUNNING_TURN
 *     via observation-layer.onMasterResurrected
 */
export const resurrectMasterIfOrphaned: RecoveryAction = async (stuck, ctx) => {
  // The stuck can be ANY subordinate state — we only need to verify
  // the master is dead AND this is a subordinate (not master itself).
  if (stuck.record.role === 'master') {
    return {
      ok: false,
      action: 'resurrectMasterIfOrphaned',
      detail: 'agent is the master — different action needed',
      reason: 'no_match',
    };
  }
  if (!ctx.master) {
    return {
      ok: false,
      action: 'resurrectMasterIfOrphaned',
      detail: 'master handle missing',
      reason: 'skipped',
    };
  }
  if (ctx.master.isAlive()) {
    return {
      ok: false,
      action: 'resurrectMasterIfOrphaned',
      detail: 'master already alive',
      reason: 'skipped',
    };
  }
  try {
    await ctx.master.resurrect(
      `supervisor: subordinate ${stuck.record.role} (run=${stuck.record.agentRunId}) ` +
        `is stuck in ${stuck.fromState} but master is gone`,
    );
    return {
      ok: true,
      action: 'resurrectMasterIfOrphaned',
      detail: `resurrected master to attend to stuck ${stuck.record.role}`,
    };
  } catch (e) {
    return {
      ok: false,
      action: 'resurrectMasterIfOrphaned',
      detail: e instanceof Error ? e.message : String(e),
      reason: 'failed',
    };
  }
};

// ─── Dispatcher ──────────────────────────────────────────────

/**
 * Maps each STUCK_* state to the action(s) that may handle it.
 * Order within the array = priority — the dispatcher tries them in
 * sequence until one returns `ok: true`.
 */
const ACTIONS_BY_STATE: Readonly<Partial<Record<SupervisionState, ReadonlyArray<RecoveryAction>>>> =
  Object.freeze({
    STUCK_TOOL: [abortStuckTool],
    STUCK_AWAITING_MASTER: [
      // Prefer to resurrect the master so the sub's wait completes
      // naturally; falls back to force-resume if resurrect can't apply
      // (master alive, or no master handle).
      resurrectMasterIfOrphaned,
      forceResumeSubordinate,
    ],
    // STUCK_TURN / STUCK_PROVIDER / STUCK_BOOT / INBOX_EXPIRED /
    // FAILED_* — no action yet. They emit `stuck_detected` incidents
    // so the user sees the pattern; Phase 2.3 / 2.4 will add actions.
  });

/**
 * Run the matching recovery actions for a single stuck agent. Returns
 * the first successful outcome OR — if all matched but failed/skipped
 * — the last attempted outcome (so the caller knows the path tried).
 *
 * The dispatcher itself doesn't change supervisor state — the
 * supervisor's tick reads the outcome and records it as an incident
 * sidecar event.
 */
export async function dispatchRecovery(
  stuck: StuckAgent,
  ctx: RecoveryContext,
): Promise<RecoveryOutcome | null> {
  const actions = ACTIONS_BY_STATE[stuck.toStuckState];
  if (!actions || actions.length === 0) return null;
  let lastOutcome: RecoveryOutcome | null = null;
  for (const action of actions) {
    const outcome = await action(stuck, ctx);
    lastOutcome = outcome;
    if (outcome.ok) return outcome;
  }
  return lastOutcome;
}

/** Test helper — list registered action names per stuck state. */
export function listRegisteredActions(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [state, actions] of Object.entries(ACTIONS_BY_STATE)) {
    out[state] = (actions ?? []).map((a) => a.name);
  }
  return out;
}

export function getActionRecord(): Readonly<Record<string, readonly RecoveryAction[]>> {
  // Build a fresh shallow copy so callers can iterate without
  // depending on the frozen reference.
  return { ...ACTIONS_BY_STATE };
}

// Re-export referenced types from heartbeat-tracker for callers that
// import recovery-actions stand-alone.
export type { AgentSupervisionRecord, StuckAgent };
