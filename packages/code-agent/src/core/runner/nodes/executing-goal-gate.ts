/**
 * Runtime-owned goal lifecycle gate for text-only finishes.
 *
 * Goal tools are model-facing, but whether a run performed real work is not a
 * prose/heuristic question. The shared ToolCallLedger records direct and
 * nested calls, and the registry owns each tool's execution metadata. This
 * gate uses those two authoritative sources so a greeting or factual answer
 * can still finish normally while a run that actually investigated, executed,
 * or mutated cannot silently bypass the goal lifecycle.
 */
import {
  logicalOperationId,
  type ToolCallLedgerEntry,
} from '@mcp/code-agent/core/tool-call-ledger.js';
import {
  resolveToolInvocationMetadata,
  resolveToolMetadata,
} from '@mcp/code-agent/core/policy.js';
import type { RunContext } from '../machine/types.js';

const GOAL_TOOL_NAMES = new Set(['create_goal', 'get_goal', 'update_goal']);
const HIGH_SIGNAL_ORCHESTRATION_TOOLS = new Set([
  'spawn_agent',
  'resume_agent',
  'collect_agents',
  'execute_tasks',
  'task_list',
  'workflow',
]);

export type GoalLifecyclePhase = 'missing' | 'in_progress' | 'unavailable';

export type GoalLifecycleFinishDecision =
  | {
      kind: 'nudge';
      phase: GoalLifecyclePhase;
      text: string;
    }
  | {
      kind: 'violation';
      phase: GoalLifecyclePhase;
      message: string;
    };

export interface GoalLifecycleGateOptions {
  maxNudgesPerPhase?: number;
  /** Exact post-filter tool surface offered to the model on this turn. */
  effectiveToolNames?: ReadonlySet<string>;
}

function requiresFreshObjective(ctx: RunContext): boolean {
  return ctx.opts.goalLifecycleIntent === 'required_fresh'
    || ctx.opts.goalLifecycleIntent === 'required_pivot';
}

function hasUsableGoalTools(
  ctx: RunContext,
  effectiveTools?: ReadonlySet<string>,
): boolean {
  return !(
    (effectiveTools && (
      !effectiveTools.has('create_goal')
      || !effectiveTools.has('update_goal')
    ))
    || ctx.opts.globalDisabledTools?.has('create_goal')
    || ctx.opts.globalDisabledTools?.has('update_goal')
    || ctx.opts.sessionDisabledTools?.has('create_goal')
    || ctx.opts.sessionDisabledTools?.has('update_goal')
    || !ctx.opts.registry.get?.('create_goal')
    || !ctx.opts.registry.get?.('update_goal')
  );
}

function maxNudgesFromEnv(): number {
  const parsed = Number.parseInt(process.env.CODER_GOAL_LIFECYCLE_MAX_NUDGES ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
}

function currentRunEntries(ctx: RunContext): ToolCallLedgerEntry[] {
  return ctx.opts.toolContext.toolCallLedger?.snapshot(ctx.goalLifecycle.ledgerStartSeq) ?? [];
}

function createdGoalInCurrentRun(
  ctx: RunContext,
  entries: readonly ToolCallLedgerEntry[],
): boolean {
  if (ctx.goalLifecycle.createdGoalInRun) return true;
  const created = entries.some(
    (entry) => entry.name === 'create_goal' && entry.outcome === 'success',
  );
  if (created) ctx.goalLifecycle.createdGoalInRun = true;
  return created;
}

/**
 * Writes and executions count even when they fail: attempting those operations
 * is still substantive work and must not be followed by a false clean finish.
 * Read-only productivity is aggregated separately so one factual lookup does
 * not turn an otherwise conversational response into a lifecycle obligation.
 */
function isHighSignalSubstantiveEntry(ctx: RunContext, entry: ToolCallLedgerEntry): boolean {
  if (GOAL_TOOL_NAMES.has(entry.name)) return false;
  if (HIGH_SIGNAL_ORCHESTRATION_TOOLS.has(entry.name)) return true;
  if (entry.validationSignal) return true;

  const tool = ctx.opts.registry.get?.(entry.name);
  if (!tool) return false;
  const metadata = resolveToolMetadata(tool);
  const mutates = entry.mutates ?? metadata.mutates;
  const executionClass = entry.executionClass ?? metadata.executionClass;
  const riskLevel = entry.riskLevel ?? metadata.riskLevel;
  return mutates
    || executionClass === 'write'
    // Read-risk wrappers such as code_exec record their nested calls in the
    // same ledger. Let those concrete effects decide instead of treating one
    // read-only wrapper lookup as substantive merely because it executes JS.
    || (executionClass === 'execute' && riskLevel !== 'read')
    || riskLevel === 'write'
    || riskLevel === 'execute'
    || riskLevel === 'admin';
}

function countsTowardReadThreshold(ctx: RunContext, entry: ToolCallLedgerEntry): boolean {
  if (GOAL_TOOL_NAMES.has(entry.name) || !entry.productive) return false;
  const tool = ctx.opts.registry.get?.(entry.name);
  if (!tool) return true;
  const metadata = resolveToolMetadata(tool);
  const executionClass = entry.executionClass ?? metadata.executionClass;
  const riskLevel = entry.riskLevel ?? metadata.riskLevel;
  // Read-risk execution wrappers (notably code_exec) summarize their nested
  // calls into one parent result. The nested leaves are already in the shared
  // ledger, so counting the wrapper would turn search+read into three calls.
  return !(executionClass === 'execute' && riskLevel === 'read');
}

function hasSubstantiveWork(ctx: RunContext, entries: ToolCallLedgerEntry[]): boolean {
  const productiveNonGoalCalls = entries.filter(
    (entry) => countsTowardReadThreshold(ctx, entry),
  ).length;
  return entries.some((entry) => isHighSignalSubstantiveEntry(ctx, entry))
    || productiveNonGoalCalls >= 3;
}

function unresolvedPreDispatchOperations(
  ctx: RunContext,
  entries: ToolCallLedgerEntry[],
): string[] {
  return [...ctx.goalLifecycle.preDispatchPending].filter(
    ([operationId, afterSeq]) =>
      !entries.some(
        (entry) =>
          entry.outcome === 'success'
          && entry.seq > afterSeq
          && (
            entry.logicalOperationId === operationId
            || entry.goalLifecycleResolution === 'supersede_previous_goal'
          ),
      ),
  ).map(([operationId]) => operationId);
}

function isWriteEffectEntry(ctx: RunContext, entry: ToolCallLedgerEntry): boolean {
  const tool = ctx.opts.registry.get?.(entry.name);
  const metadata = tool ? resolveToolMetadata(tool) : null;
  const executionClass = entry.executionClass ?? metadata?.executionClass;
  const riskLevel = entry.riskLevel ?? metadata?.riskLevel;
  return executionClass === 'write' || riskLevel === 'write';
}

function unresolvedSubstantiveFailures(
  ctx: RunContext,
  entries: ToolCallLedgerEntry[],
): ToolCallLedgerEntry[] {
  return entries.filter((failed, index) => {
    if (failed.outcome === 'success' || !isHighSignalSubstantiveEntry(ctx, failed)) {
      return false;
    }
    return !entries.slice(index + 1).some((later) => {
      if (later.outcome !== 'success') return false;
      if (later.goalLifecycleResolution === 'supersede_previous_goal') {
        return true;
      }
      if (failed.validationSignal) {
        return (
          later.validationSignal === failed.validationSignal
          && later.logicalOperationId === failed.logicalOperationId
        )
          || later.goalLifecycleResolution === 'accept_out_of_scope_validation';
      }
      if (failed.recoveryOperationId) {
        return later.recoveryOperationId === failed.recoveryOperationId
          || later.logicalOperationId === failed.logicalOperationId;
      }
      // Editors expose different capability names for equivalent repairs
      // (`edit_file`, `apply_patch`, `multi_edit`). A productive later write is
      // therefore authoritative recovery evidence for an earlier write
      // failure. Execute-class failures and validations remain exact.
      if (
        isWriteEffectEntry(ctx, failed)
        && later.productive
        && isWriteEffectEntry(ctx, later)
      ) {
        return true;
      }
      // Input validation for orchestration can fail before a spawn/workflow id
      // exists. In that pre-identity phase, a later success from the same
      // capability is the only safe recovery signal; a different
      // orchestration tool must not clear it.
      if (
        HIGH_SIGNAL_ORCHESTRATION_TOOLS.has(failed.name)
        && later.name === failed.name
      ) {
        return true;
      }
      return later.logicalOperationId === failed.logicalOperationId;
    });
  });
}

/**
 * Refuse the first high-signal call when no active goal exists. Because
 * dispatchTools is sequential, a batch ordered as create_goal → work passes:
 * the staged lifecycle state is visible before this check runs for the next
 * call, then the host's turn barrier makes the whole turn durable before any
 * later provider turn. The same callback is also used by code_exec's nested
 * preflight, preventing a read-risk wrapper from hiding a mutation.
 */
export function goalLifecycleRefusalBeforeTool(
  ctx: RunContext,
  toolName: string,
  toolInput: unknown,
  options: Pick<GoalLifecycleGateOptions, 'effectiveToolNames'> = {},
): string | null {
  if (!hasUsableGoalTools(ctx, options.effectiveToolNames)) return null;
  const entries = currentRunEntries(ctx);
  const createdThisRun = createdGoalInCurrentRun(ctx, entries);
  if (toolName === 'update_goal') {
    const requestedStatus =
      toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
        ? (toolInput as Record<string, unknown>).status
        : undefined;
    if (
      requestedStatus === 'complete'
      && (
        ctx.bridge?.backgroundJobs?.hasActive()
        || ctx.bridge?.backgroundJobs?.hasUncollectedTerminal()
      )
    ) {
      return (
        '[goal-lifecycle] Refused `update_goal(status="complete")`: background agent outcomes ' +
        'are still running or have not been collected in full. Call `collect_agents` to fetch ' +
        'and review every completion/failure before marking the goal complete.'
      );
    }
    if (requestedStatus === 'superseded') {
      if (ctx.opts.goalLifecycleIntent !== 'required_pivot') {
        return (
          '[goal-lifecycle] Refused `update_goal(status="superseded")`: ' +
          'superseding an active goal requires an explicit user pivot to a fresh objective.'
        );
      }
      if (createdThisRun) {
        return (
          '[goal-lifecycle] Refused `update_goal(status="superseded")`: the explicit pivot ' +
          'may close only the inherited goal, never a replacement created in this run.'
        );
      }
      const targetCreatedAt = ctx.opts.toolContext.goalLifecyclePivotGoalCreatedAt;
      try {
        const goal = ctx.opts.toolContext.getGoalState?.() ?? null;
        if (targetCreatedAt === undefined || goal?.createdAt !== targetCreatedAt) {
          return (
            '[goal-lifecycle] Refused `update_goal(status="superseded")`: the active goal ' +
            'is not the inherited goal authorized by this explicit user pivot.'
          );
        }
      } catch {
        // The goal tool owns the precise persistence failure.
      }
      return null;
    }
    if (requiresFreshObjective(ctx) && !createdThisRun) {
      const getGoal = ctx.opts.toolContext.getGoalState;
      try {
        // A fresh objective may inherit an unfinished goal only in recovered
        // or partially-cleared state. Allow closing that old goal before the
        // new objective establishes its own lifecycle.
        if (getGoal?.()?.status === 'in_progress') return null;
      } catch {
        // Let the normal persistence-aware branch below surface the refusal.
      }
    }
    const pending = unresolvedPreDispatchOperations(ctx, entries);
    const failed = unresolvedSubstantiveFailures(ctx, entries);
    if (pending.length > 0 || failed.length > 0) {
      const names = [
        ...pending.map((operationId) => operationId.split(':', 1)[0] ?? 'operation'),
        ...failed.map((entry) => entry.name),
      ];
      return (
        '[goal-lifecycle] Refused `update_goal`: required work is still unresolved ' +
        `(${[...new Set(names)].join(', ')}). Retry the refused/failed operation successfully ` +
        'and rerun any failed validation before marking the goal complete.'
      );
    }
    return null;
  }
  if (GOAL_TOOL_NAMES.has(toolName)) return null;

  const tool = ctx.opts.registry.get?.(toolName);
  if (!tool) return null;
  const metadata = resolveToolInvocationMetadata(tool, toolInput);
  const highSignal = HIGH_SIGNAL_ORCHESTRATION_TOOLS.has(toolName)
    || metadata.mutates
    || metadata.executionClass === 'write'
    || (metadata.executionClass === 'execute' && metadata.riskLevel !== 'read')
    || metadata.riskLevel === 'write'
    || metadata.riskLevel === 'execute'
    || metadata.riskLevel === 'admin';
  const productiveNonGoalCalls = currentRunEntries(ctx).filter(
    (entry) => countsTowardReadThreshold(ctx, entry),
  ).length;
  const crossesReadOnlyThreshold =
    !metadata.interactive
    && metadata.riskLevel === 'read'
    && productiveNonGoalCalls >= 2;
  if (!highSignal && !crossesReadOnlyThreshold) return null;

  const getGoal = ctx.opts.toolContext.getGoalState;
  if (!getGoal) return null;
  let goal: ReturnType<NonNullable<typeof getGoal>>;
  try {
    goal = getGoal();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.goalLifecycle.preDispatchPending.set(
      logicalOperationId(toolName, toolInput),
      ctx.opts.toolContext.toolCallLedger?.lastSeq ?? 0,
    );
    return `[goal-lifecycle] Refused \`${toolName}\`: persisted goal state is unavailable (${reason}).`;
  }
  if (goal?.status === 'in_progress') {
    if (!requiresFreshObjective(ctx) || createdThisRun) {
      return null;
    }
    ctx.goalLifecycle.preDispatchPending.set(
      logicalOperationId(toolName, toolInput),
      ctx.opts.toolContext.toolCallLedger?.lastSeq ?? 0,
    );
    return (
      `[goal-lifecycle] Refused \`${toolName}\` before execution: the active goal belongs to an earlier objective. ` +
      'For an explicit replacement, call `update_goal(status="superseded", note="<reason>")`; ' +
      'use status="complete" only if that inherited objective was actually achieved. ' +
      'Then call `create_goal` for the new objective and retry the refused work.'
    );
  }
  ctx.goalLifecycle.preDispatchPending.set(
    logicalOperationId(toolName, toolInput),
    ctx.opts.toolContext.toolCallLedger?.lastSeq ?? 0,
  );
  return (
    `[goal-lifecycle] Refused \`${toolName}\` before execution: no active goal exists for this objective. ` +
    'Call `create_goal` first, then retry the refused work.'
  );
}

function nudgeOrViolation(
  ctx: RunContext,
  phase: Exclude<GoalLifecyclePhase, 'unavailable'>,
  text: string,
  maxNudges: number,
): GoalLifecycleFinishDecision {
  const key = phase === 'missing' ? 'missingNudges' : 'inProgressNudges';
  if (ctx.goalLifecycle[key] < maxNudges) {
    ctx.goalLifecycle[key] += 1;
    return { kind: 'nudge', phase, text };
  }
  return {
    kind: 'violation',
    phase,
    message:
      phase === 'missing'
        ? 'goal_lifecycle_violation: objective finished without creating its required session goal'
        : 'goal_lifecycle_violation: substantive work finished while the session goal remained in_progress',
  };
}

/**
 * Evaluate a would-be text-only finish.
 *
 * Returns null for conversational turns with no current-run work evidence.
 * A non-null nudge re-enters Executing; a violation is terminal after the
 * bounded retry budget, but is deliberately not a CleanFinish.
 */
export function evaluateGoalLifecycleAtFinish(
  ctx: RunContext,
  options: GoalLifecycleGateOptions = {},
): GoalLifecycleFinishDecision | null {
  // Some role-filtered runtimes (for example Company master) intentionally do
  // not expose goal tools. A finish gate must never demand an uncallable tool.
  const effectiveTools = options.effectiveToolNames;
  if (!hasUsableGoalTools(ctx, effectiveTools)) return null;
  const getGoal = ctx.opts.toolContext.getGoalState;
  if (!getGoal) return null;

  const entries = currentRunEntries(ctx);
  const failedLifecycleCall = entries.some(
    (entry) => GOAL_TOOL_NAMES.has(entry.name) && entry.isError,
  );
  const createdThisRun = createdGoalInCurrentRun(ctx, entries);
  const pendingPreDispatch = unresolvedPreDispatchOperations(ctx, entries);
  const pendingFailures = unresolvedSubstantiveFailures(ctx, entries);
  const substantiveWork =
    pendingPreDispatch.length > 0
    || pendingFailures.length > 0
    || hasSubstantiveWork(ctx, entries);
  const intentRequiresGoal = ctx.opts.goalLifecycleIntent !== undefined
    && ctx.opts.goalLifecycleIntent !== 'ledger';
  const intentRequiresFreshGoal = requiresFreshObjective(ctx);
  const completedThisRun = entries.some(
    (entry) =>
      entry.name === 'update_goal'
      && entry.outcome === 'success'
      && entry.goalLifecycleResolution !== 'supersede_previous_goal',
  );
  if (
    !intentRequiresGoal
    && !substantiveWork
    && !failedLifecycleCall
    && !createdThisRun
    && !completedThisRun
  ) {
    return null;
  }

  let goal: ReturnType<NonNullable<typeof getGoal>>;
  try {
    goal = getGoal();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: 'violation',
      phase: 'unavailable',
      message: `goal_lifecycle_unavailable: failed to read persisted session goal: ${reason}`,
    };
  }

  const maxNudges = options.maxNudgesPerPhase ?? maxNudgesFromEnv();

  const lastCompletedSeq = entries.reduce(
    (latest, entry) =>
      entry.name === 'update_goal' && entry.outcome === 'success'
        && entry.goalLifecycleResolution !== 'supersede_previous_goal'
        ? Math.max(latest, entry.seq)
        : latest,
    0,
  );
  const entriesAfterCompletion = lastCompletedSeq > 0
    ? entries.filter((entry) => entry.seq > lastCompletedSeq)
    : entries;
  const needsActiveGoal = !goal
    ? intentRequiresGoal || substantiveWork || failedLifecycleCall
    : goal.status !== 'in_progress'
      ? (
        intentRequiresFreshGoal
          ? !createdThisRun || !completedThisRun
          : intentRequiresGoal && !completedThisRun
      )
        || pendingPreDispatch.length > 0
        || pendingFailures.length > 0
        || hasSubstantiveWork(ctx, entriesAfterCompletion)
        || entriesAfterCompletion.some(
          (entry) => GOAL_TOOL_NAMES.has(entry.name) && entry.isError,
        )
      : false;

  // A completed goal only authorizes the work that the successful update_goal
  // actually closed in this run. An inherited completion (or substantive work
  // after completion) belongs to a new objective and needs a fresh goal.
  if (needsActiveGoal) {
    return nudgeOrViolation(
      ctx,
      'missing',
      '<system-reminder>This objective requires a goal lifecycle, but no active session goal exists for it. ' +
        'Do not end with prose. Call `create_goal` now using the user\'s full objective. ' +
        'If the objective is already achieved, emit `create_goal` first and ' +
        '`update_goal(status="complete")` second in the SAME assistant tool-call batch; ' +
        'otherwise create the goal and continue working.</system-reminder>',
      maxNudges,
    );
  }

  if (!goal) return null;
  if (goal.status !== 'in_progress') return null;
  if (!intentRequiresGoal && !substantiveWork && !failedLifecycleCall && !createdThisRun) {
    return null;
  }

  const escalationTool = effectiveTools?.has('ask_user')
    ? 'ask_user'
    : effectiveTools?.has('ask_master')
      ? 'ask_master'
      : null;
  const blockedInstruction = escalationTool
    ? `If required input or authority is missing, call \`${escalationTool}\`.`
      : 'If required input or authority is missing, state the blocker; this run must stop as an error rather than falsely complete.';
  if (
    ctx.opts.goalLifecycleIntent === 'required_pivot'
    && !createdThisRun
  ) {
    return nudgeOrViolation(
      ctx,
      'in_progress',
      '<system-reminder>The active session goal belongs to the objective the user explicitly replaced. ' +
        'Do not continue or falsely complete it. Call `update_goal(status="superseded", note="<reason>")`, ' +
        'then call `create_goal` for the replacement objective before doing its work. ' +
        `${blockedInstruction}</system-reminder>`,
      maxNudges,
    );
  }

  return nudgeOrViolation(
    ctx,
    'in_progress',
    '<system-reminder>The session goal is still in_progress, so this cannot be a clean final response. ' +
      'If the full objective is achieved and verified, call `update_goal(status="complete")`. ' +
      `${blockedInstruction} Otherwise continue the work. ` +
      'Do not end with prose while the goal remains active.</system-reminder>',
    maxNudges,
  );
}
