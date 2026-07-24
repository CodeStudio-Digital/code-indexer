/**
 * Goal tools — long-lived session objective tracking.
 *
 * Inspired by codex's `create_goal` / `get_goal` / `update_goal`. The goal
 * is a layer ABOVE submit_plan: a single, session-wide objective the agent
 * is working toward, set explicitly by the user or system instructions.
 * Plans describe the next concrete step; the goal answers "why are we here
 * at all". Models lose the original ask after compaction — anchoring it in
 * a structured slot they can re-read fixes that.
 *
 * Persistence: when `ctx.getGoalState` / `ctx.upsertGoalState` are wired
 * (by `runCoder` against the session store), the goal lives in
 * `coder_sessions.goal_*` columns and survives runner restarts and
 * dashboard reloads. When those callbacks are absent (tests, ephemeral
 * subagents), the tool falls back to a per-runner WeakMap so existing
 * call-sites continue to work without a database.
 */
import type {
  CoderTool,
  GoalStatus,
  ToolContext,
  ToolResult,
} from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { maybeTerse } from '@mcp/code-agent/tools/descriptions.js';

interface GoalState {
  text: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  budgetTokens: number | null;
  completionNote: string | null;
}

const GOAL_BY_RUNNER = new WeakMap<object, GoalState>();

/**
 * Per-runner burst tracker for redundant create_goal calls against the SAME
 * active objective. It is reset whenever a goal is created or closed, so
 * several legitimate objectives completed inside 90 seconds never consume
 * one another's quota.
 */
const CREATE_BURST_BY_RUNNER = new WeakMap<object, { count: number; lastAt: number }>();
const CREATE_BURST_THRESHOLD = 3;
const CREATE_BURST_WINDOW_MS = 90_000;

function readKey(ctx: ToolContext): object | null {
  return (ctx.runner as unknown as object) ?? null;
}

/**
 * Bump the create_goal call counter for this runner. Returns the new
 * count after applying the window-reset rule. Caller refuses the call
 * when the count exceeds CREATE_BURST_THRESHOLD.
 */
function bumpCreateBurst(ctx: ToolContext): { count: number; sinceMs: number } {
  const key = readKey(ctx);
  if (!key) return { count: 0, sinceMs: 0 };
  const now = Date.now();
  const prior = CREATE_BURST_BY_RUNNER.get(key);
  if (!prior || now - prior.lastAt > CREATE_BURST_WINDOW_MS) {
    CREATE_BURST_BY_RUNNER.set(key, { count: 1, lastAt: now });
    return { count: 1, sinceMs: 0 };
  }
  const next = { count: prior.count + 1, lastAt: now };
  CREATE_BURST_BY_RUNNER.set(key, next);
  return { count: next.count, sinceMs: now - prior.lastAt };
}

/** Test-only hook to reset the burst counter for a runner key. */
export function _resetCreateBurstForKey(key: object): void {
  CREATE_BURST_BY_RUNNER.delete(key);
}

function readGoal(ctx: ToolContext): GoalState | null {
  if (ctx.getGoalState) {
    const persisted = ctx.getGoalState();
    if (persisted) {
      return {
        text: persisted.text,
        status: persisted.status,
        createdAt: persisted.createdAt,
        updatedAt: persisted.updatedAt,
        budgetTokens: persisted.budgetTokens,
        completionNote: persisted.completionNote,
      };
    }
    return null;
  }
  const key = readKey(ctx);
  if (!key) return null;
  return GOAL_BY_RUNNER.get(key) ?? null;
}

async function writeGoal(
  ctx: ToolContext,
  goal: GoalState,
  toolName: 'create_goal' | 'update_goal',
): Promise<void> {
  if (ctx.upsertGoalState) {
    const toolUseId = ctx.currentToolUseId;
    if (!toolUseId) {
      throw new Error(`${toolName} requires a direct attributed tool_use id`);
    }
    await ctx.upsertGoalState({
      text: goal.text,
      status: goal.status,
      budgetTokens: goal.budgetTokens,
      completionNote: goal.completionNote,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    }, {
      toolUseId,
      toolName,
    });
    return;
  }
  const key = readKey(ctx);
  if (!key) return;
  GOAL_BY_RUNNER.set(key, goal);
}

function resetCreateBurst(ctx: ToolContext): void {
  const key = readKey(ctx);
  if (key) CREATE_BURST_BY_RUNNER.delete(key);
}

const CREATE_GOAL_DESC =
  'For non-trivial top-level work, record the session goal in the FIRST assistant tool-call batch, before substantive tools. ' +
  'Call this ONCE per objective. If a goal is already in_progress, do NOT call it again — execute the task; after an explicit user pivot, close the old goal with update_goal(status="superseded") first. ' +
  'Survives turn boundaries (and compaction) so the original ask is recoverable. ' +
  'Bootstrap in ONE turn: emit create_goal and task_list together in the same assistant tool-call batch when a checklist is useful, instead of spending a turn on each.';

const GET_GOAL_DESC =
  'Return the current session goal and its status. Use BEFORE making a non-trivial decision to confirm you are still aligned with the original objective. ' +
  'Returns "(no goal set)" when none has been created.';

const UPDATE_GOAL_DESC =
  'Close the session goal. Use status="complete" ONLY when the objective has actually been achieved AND no required follow-up work remains. ' +
  'Use status="superseded" only after the user explicitly pivots to a different objective; include a short reason and then create_goal for the new objective. ' +
  'If you are stuck, use the escalation tool available to your role (ask_user or ask_master) instead of claiming completion.';

const createGoal: CoderTool = {
  name: 'create_goal',
  description: maybeTerse(CREATE_GOAL_DESC),
  source: 'native',
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  // Session-local persistence changes the value returned by get_goal. Mark
  // the invocation mutating for cache/epoch purposes without treating it as a
  // workspace write that plan/spec permission gates should block.
  repeatPolicy: 'mutating',
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'Single-paragraph statement of the session objective. RULE: After creating a goal, do not modify it. RULE: Goals should be concise and specific.'
      },
      budget_tokens: {
        type: 'number',
        description: 'Optional soft token budget. Recorded for transparency; not enforced.',
      }
    },
    required: ['goal'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const text = String(args.goal ?? '').trim();
    if (!text) return err('goal cannot be empty');
    if (!ctx.upsertGoalState && !readKey(ctx)) {
      return err('create_goal requires runner context');
    }

    let existing: GoalState | null;
    try {
      existing = readGoal(ctx);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(`create_goal: failed to read persisted goal state: ${reason}`);
    }

    // A goal already in_progress is NOT superseded silently. `create_goal`
    // stays visible the whole run (so the tool array — and thus the prompt
    // cache prefix — is byte-stable), which means the model CAN still call it
    // redundantly; we reject firmly here instead. This is the primary loop
    // guard now that the tool is no longer hidden from the surface: re-stating
    // the goal is not progress. To genuinely pivot, the model must close the
    // current goal with update_goal(status=superseded) first.
    if (existing && existing.status === 'in_progress') {
      const burst = bumpCreateBurst(ctx);
      if (burst.count > CREATE_BURST_THRESHOLD) {
        return err(
          `Refused: create_goal has been called ${burst.count} times in the last ${Math.round(CREATE_BURST_WINDOW_MS / 1000)}s ` +
            `against the same active goal. The goal is already set — call get_goal to re-read it if needed, ` +
            `then EXECUTE the actual task (write files, run commands, edit code). ` +
            `Calling create_goal more is not progress; it is a stuck-loop signal. ` +
            `Stop revising the goal and start the work.`,
        );
      }
      const oldPreview = existing.text.length > 120 ? `${existing.text.slice(0, 120)}…` : existing.text;
      return err(
        `Refused: a goal is already in_progress ("${oldPreview}"). Do NOT call create_goal again — ` +
          `execute the actual task now. To replace the objective (a real pivot), call ` +
          `update_goal(status="superseded", note="<reason>") first, then create the new goal.`,
      );
    }

    const now = new Date().toISOString();
    const budget = typeof args.budget_tokens === 'number' && args.budget_tokens > 0 ? args.budget_tokens : null;
    try {
      await writeGoal(ctx, {
        text,
        status: 'in_progress',
        createdAt: now,
        updatedAt: now,
        budgetTokens: budget,
        completionNote: null,
      }, 'create_goal');
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(`create_goal: failed to persist goal state: ${reason}`);
    }
    resetCreateBurst(ctx);
    // Quiet success message. The redundant-call loop is handled by the
    // in_progress rejection above plus `bumpCreateBurst`, so no nudge is
    // needed in the result body (an in-body nudge paradoxically reinforced
    // the loop by keeping the tool name fresh in the model's context).
    return ok(
      `Goal set. Status: in_progress${budget ? ` (budget: ${budget} tokens)` : ''}.`,
    );
  },
};

const getGoal: CoderTool = {
  name: 'get_goal',
  description: maybeTerse(GET_GOAL_DESC),
  source: 'native',
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx): Promise<ToolResult> => {
    if (!ctx.getGoalState && !readKey(ctx)) {
      return err('get_goal requires runner context');
    }
    let g: GoalState | null;
    try {
      g = readGoal(ctx);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(`get_goal: failed to read persisted goal state: ${reason}`);
    }
    if (!g) return ok('(no goal set)');
    const lines: string[] = [
      `Status: ${g.status}`,
      `Goal: ${g.text}`,
      `Created: ${g.createdAt}`,
    ];
    if (g.budgetTokens) lines.push(`Budget: ${g.budgetTokens} tokens (soft, not enforced)`);
    if (g.completionNote) lines.push(`Completion note: ${g.completionNote}`);
    // When the goal is already complete, surface a hard "stop polling" line.
    // Without this nudge the model that doesn't know what to do next falls
    // back to re-checking the goal indefinitely (real loop seen in the
    // wild — get_goal called 30+ times after update_goal).
    if (g.status !== 'in_progress') {
      lines.push('');
      lines.push(
        g.status === 'complete'
          ? 'IMPORTANT: This goal is already marked complete. Do NOT call get_goal again — there is nothing new to read. Write your final summary to the user (or post your deliverable) and end the run.'
          : 'IMPORTANT: This goal was superseded by an explicit user pivot. Do NOT resume it; create or continue the replacement objective.',
      );
    }
    return ok(lines.join('\n'));
  },
};

const updateGoal: CoderTool = {
  name: 'update_goal',
  description: maybeTerse(UPDATE_GOAL_DESC),
  source: 'native',
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  repeatPolicy: 'mutating',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['complete', 'superseded'],
        description: 'Use "complete" only when verified; use "superseded" only for an explicit user pivot.',
      },
      note: { type: 'string', description: 'Completion note, or required reason when superseding.' },
    },
    required: ['status'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const requestedStatus = args.status;
    if (requestedStatus !== 'complete' && requestedStatus !== 'superseded') {
      return err('update_goal: status must be "complete" or "superseded"');
    }
    const suppliedNote = typeof args.note === 'string' ? args.note.trim() : '';
    if (requestedStatus === 'superseded') {
      if (ctx.goalLifecycleIntent !== 'required_pivot') {
        return err(
          'update_goal: status="superseded" requires an explicit user pivot to a fresh objective',
        );
      }
      if (!suppliedNote) {
        return err('update_goal: status="superseded" requires a short reason in note');
      }
    }
    if (!ctx.upsertGoalState && !readKey(ctx)) {
      return err('update_goal requires runner context');
    }
    let g: GoalState | null;
    try {
      g = readGoal(ctx);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(`update_goal: failed to read persisted goal state: ${reason}`);
    }
    if (!g) {
      return err(
        'No goal set. Do NOT finish with prose. In the next assistant turn call create_goal first. ' +
          'If the objective is already achieved, call update_goal(status="complete") second in the SAME assistant tool-call batch.',
      );
    }
    if (g.status !== 'in_progress') return err(`Goal is already ${g.status}.`);
    if (
      requestedStatus === 'superseded'
      && (
        ctx.goalLifecyclePivotGoalCreatedAt === undefined
        || g.createdAt !== ctx.goalLifecyclePivotGoalCreatedAt
      )
    ) {
      return err(
        'update_goal: status="superseded" may close only the inherited goal explicitly targeted by the user pivot; the current goal was created afterward',
      );
    }
    const note = suppliedNote || g.completionNote;
    const updated: GoalState = {
      ...g,
      status: requestedStatus,
      updatedAt: new Date().toISOString(),
      completionNote: note,
    };
    try {
      await writeGoal(ctx, updated, 'update_goal');
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(`update_goal: failed to persist goal state: ${reason}`);
    }
    resetCreateBurst(ctx);
    return ok(
      requestedStatus === 'complete'
        ? `Goal marked complete${updated.completionNote ? `: ${updated.completionNote}` : '.'}`
        : `Goal superseded: ${updated.completionNote}`,
    );
  },
};

export const goalTools: CoderTool[] = [createGoal, getGoal, updateGoal];

/** Test-only: clear the in-memory goal for a runner key. */
export function _resetGoalForKey(key: object): void {
  GOAL_BY_RUNNER.delete(key);
}
