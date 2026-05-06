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
import type { CoderTool, ToolContext, ToolResult } from '../core/tool.js';
import { ok, err } from '../core/tool.js';
import { maybeTerse } from './descriptions.js';

interface GoalState {
  text: string;
  status: 'in_progress' | 'complete';
  createdAt: string;
  updatedAt: string;
  budgetTokens: number | null;
  completionNote: string | null;
}

const GOAL_BY_RUNNER = new WeakMap<object, GoalState>();

function readKey(ctx: ToolContext): object | null {
  return (ctx.runner as unknown as object) ?? null;
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

function writeGoal(ctx: ToolContext, goal: GoalState): void {
  if (ctx.upsertGoalState) {
    ctx.upsertGoalState({
      text: goal.text,
      status: goal.status,
      budgetTokens: goal.budgetTokens,
      completionNote: goal.completionNote,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    });
    return;
  }
  const key = readKey(ctx);
  if (!key) return;
  GOAL_BY_RUNNER.set(key, goal);
}

const CREATE_GOAL_DESC =
  'Record the session goal — the single objective driving this run. Call ONLY when the user or system instructions explicitly state a goal; ' +
  'do not infer one from ordinary tasks. Survives turn boundaries (and compaction) so you can re-anchor on the original ask.';

const GET_GOAL_DESC =
  'Return the current session goal and its status. Use BEFORE making a non-trivial decision to confirm you are still aligned with the original objective. ' +
  'Returns "(no goal set)" when none has been created.';

const UPDATE_GOAL_DESC =
  'Mark the session goal complete. Use ONLY when the objective has actually been achieved AND no required follow-up work remains. ' +
  'If you are tempted to mark complete because you are stuck, call ask_user instead.';

const createGoal: CoderTool = {
  name: 'create_goal',
  description: maybeTerse(CREATE_GOAL_DESC),
  source: 'native',
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'Single-paragraph statement of the session objective.' },
      budget_tokens: {
        type: 'number',
        description: 'Optional soft token budget. Recorded for transparency; not enforced.',
      },
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
    const existing = readGoal(ctx);
    if (existing && existing.status !== 'complete') {
      return err(
        `A goal is already active: "${existing.text.slice(0, 120)}${existing.text.length > 120 ? '…' : ''}". ` +
          `Mark it complete with update_goal first, or call get_goal to re-read it.`,
      );
    }
    const now = new Date().toISOString();
    const budget = typeof args.budget_tokens === 'number' && args.budget_tokens > 0 ? args.budget_tokens : null;
    writeGoal(ctx, {
      text,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
      budgetTokens: budget,
      completionNote: null,
    });
    return ok(`Goal set. Status: in_progress${budget ? ` (budget: ${budget} tokens)` : ''}.`);
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
    const g = readGoal(ctx);
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
    if (g.status === 'complete') {
      lines.push('');
      lines.push('IMPORTANT: This goal is already marked complete. Do NOT call get_goal again — there is nothing new to read. Write your final summary to the user (or post your deliverable) and end the run.');
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
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['complete'], description: 'Only "complete" is valid — goals start in_progress and end complete.' },
      note: { type: 'string', description: 'Optional 1-2 sentence completion note.' },
    },
    required: ['status'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    if (args.status !== 'complete') return err('update_goal: only status="complete" is allowed');
    if (!ctx.upsertGoalState && !readKey(ctx)) {
      return err('update_goal requires runner context');
    }
    const g = readGoal(ctx);
    if (!g) return err('No goal set. Call create_goal first.');
    if (g.status === 'complete') return err('Goal is already complete.');
    const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : g.completionNote;
    const updated: GoalState = {
      ...g,
      status: 'complete',
      updatedAt: new Date().toISOString(),
      completionNote: note,
    };
    writeGoal(ctx, updated);
    return ok(`Goal marked complete${updated.completionNote ? `: ${updated.completionNote}` : '.'}`);
  },
};

export const goalTools: CoderTool[] = [createGoal, getGoal, updateGoal];

/** Test-only: clear the in-memory goal for a runner key. */
export function _resetGoalForKey(key: object): void {
  GOAL_BY_RUNNER.delete(key);
}
