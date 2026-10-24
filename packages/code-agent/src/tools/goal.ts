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
 * (by `runCoder` against the filesystem session store), the goal lives in the
 * bundle state projection and survives runner restarts and dashboard reloads.
 * When those callbacks are absent (tests, ephemeral subagents), the tool falls
 * back to a per-runner WeakMap.
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

function readKey(ctx: ToolContext): object | null {
  return (ctx.runner as unknown as object) ?? null;
}

async function readGoal(ctx: ToolContext): Promise<GoalState | null> {
  if (ctx.getGoalState) {
    const persisted = await ctx.getGoalState();
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

/**
 * Idempotent success path: the call is durable evidence of a goal tool that
 * deliberately staged no mutation. The runtime pairs successful goal rows with
 * staged mutations, so an unannounced no-op reads as a dropped write and fails
 * the turn's persistence.
 */
function noteGoalUnchanged(
  ctx: ToolContext,
  toolName: 'create_goal' | 'update_goal',
): void {
  const toolUseId = ctx.currentToolUseId;
  if (!ctx.noteGoalUnchanged || !toolUseId) return;
  ctx.noteGoalUnchanged({ toolUseId, toolName });
}

const CREATE_GOAL_DESC =
  'Optionally record a durable session objective for continuity, telemetry, and recovery after compaction. ' +
  'Goal tracking never authorizes tools or blocks a final response. If a goal is already in_progress, this call succeeds idempotently without replacing it. ' +
  'After an explicit user pivot, close the old goal with update_goal(status="superseded") before recording a replacement.';

const GET_GOAL_DESC =
  'Return the optional durable session goal and its status when that context is useful. ' +
  'Returns "(no goal set)" when none has been created.';

const UPDATE_GOAL_DESC =
  'Persist a terminal session-goal state immediately. Completion evidence is reported afterward as verified, unverified, or completed_with_warnings; it never refuses or revokes completion. ' +
  'Use status="complete" when the objective has been achieved. ' +
  'Use status="superseded" only after the user explicitly pivots to a different objective; include a short reason and then create_goal for the new objective. ' +
  'Schema, attribution, transition, and persistence errors still fail.';

const createGoal: CoderTool = {
  name: 'create_goal',
  executionClass: 'control',
  effectBoundary: 'control',
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
    ctx.signal?.throwIfAborted();
    const text = typeof args.goal === 'string' ? args.goal.trim() : '';
    if (!text) return err('goal cannot be empty');
    if (text.length > 8_192) return err('goal exceeds 8192 characters');
    if (args.budget_tokens !== undefined && (!Number.isSafeInteger(args.budget_tokens) || (args.budget_tokens as number) < 1)) {
      return err('budget_tokens must be a positive safe integer');
    }
    if (!ctx.upsertGoalState && !readKey(ctx)) {
      return err('create_goal requires runner context');
    }

    let existing: GoalState | null;
    try {
      existing = await readGoal(ctx);
      ctx.signal?.throwIfAborted();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(`create_goal: failed to read persisted goal state: ${reason}`);
    }

    // Never replace an active objective implicitly. A redundant create is an
    // idempotent state read, not an execution failure.
    if (existing && existing.status === 'in_progress') {
      const oldPreview = existing.text.length > 120 ? `${existing.text.slice(0, 120)}…` : existing.text;
      noteGoalUnchanged(ctx, 'create_goal');
      return ok(
        `Goal already in_progress and left unchanged ("${oldPreview}"). ` +
          'Goal tracking is advisory; continue the task normally.',
      );
    }

    // createdAt also identifies the inherited objective for explicit pivots.
    // Two terminal/create transitions in one clock tick need distinct identities.
    const previousCreatedAt = existing ? Date.parse(existing.createdAt) : 0;
    const now = new Date(Math.max(Date.now(), Number.isFinite(previousCreatedAt) ? previousCreatedAt + 1 : 0)).toISOString();
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
    ctx.signal?.throwIfAborted();
    if (!ctx.getGoalState && !readKey(ctx)) {
      return err('get_goal requires runner context');
    }
    let g: GoalState | null;
    try {
      g = await readGoal(ctx);
      ctx.signal?.throwIfAborted();
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
  executionClass: 'control',
  effectBoundary: 'control',
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
        description: 'Use "complete" when achieved; verification health is advisory. Use "superseded" only for an explicit user pivot.',
      },
      note: { type: 'string', description: 'Completion note, or required reason when superseding.' },
    },
    required: ['status'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    ctx.signal?.throwIfAborted();
    const requestedStatus = args.status;
    if (requestedStatus !== 'complete' && requestedStatus !== 'superseded') {
      return err('update_goal: status must be "complete" or "superseded"');
    }
    const suppliedNote = typeof args.note === 'string' ? args.note.trim() : '';
    if (args.note !== undefined && typeof args.note !== 'string') return err('note must be a string');
    if (suppliedNote.length > 8_192) return err('note exceeds 8192 characters');
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
      g = await readGoal(ctx);
      ctx.signal?.throwIfAborted();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(`update_goal: failed to read persisted goal state: ${reason}`);
    }
    if (!g) {
      return err(
        'No goal set. Call create_goal first if you want to track this objective.',
      );
    }
    if (g.status === requestedStatus) {
      noteGoalUnchanged(ctx, 'update_goal');
      return ok(`Goal is already ${g.status}; no state change was needed.`);
    }
    if (g.status !== 'in_progress') {
      return err(`Cannot change a ${g.status} goal to ${requestedStatus}.`);
    }
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
