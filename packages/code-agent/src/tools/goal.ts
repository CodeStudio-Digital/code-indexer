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
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { maybeTerse } from '@mcp/code-agent/tools/descriptions.js';

interface GoalState {
  text: string;
  status: 'in_progress' | 'complete';
  createdAt: string;
  updatedAt: string;
  budgetTokens: number | null;
  completionNote: string | null;
}

const GOAL_BY_RUNNER = new WeakMap<object, GoalState>();

/**
 * Per-runner burst tracker for create_goal. Resets when the gap between
 * calls exceeds CREATE_BURST_WINDOW_MS. After CREATE_BURST_THRESHOLD
 * supersedes inside the window we stop accepting further create_goal
 * calls and return a hard "STOP, execute" error. Catches the failure
 * mode where a model — instead of writing code — keeps re-stating the
 * goal in slightly different wording (observed in session 656: 26
 * consecutive create_goal calls across multiple "Continue" messages
 * with no intervening real work). The runner-level fuzzy doom-loop
 * guard misses this because each user message restarts the runner
 * with fresh signature state; the burst tracker is keyed on the runner
 * instance so it survives intra-run loops, and the timestamp window
 * lets it forgive legitimate pivots when separated by actual work.
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
  'Record the session goal at the start of a run when the user explicitly states one. ' +
  'Hidden from the tool surface on subsequent turns once a goal is in_progress — use update_goal to mark complete first if you need to set a new one. ' +
  'Survives turn boundaries (and compaction) so the original ask is recoverable. ' +
  'Bootstrap in ONE turn: emit create_goal and todo_write together in the same assistant turn (parallel tool calls are supported) instead of spending a turn on each.';

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

    // Burst-loop guard: if the agent calls create_goal more than
    // CREATE_BURST_THRESHOLD times inside CREATE_BURST_WINDOW_MS, refuse
    // hard. This is the failure mode where a model that doesn't know what
    // to do next keeps re-wording the goal instead of executing —
    // observed in session 656 (26 calls in a row across multiple user
    // "Continue" messages with no intervening real work). The runner's
    // fuzzy doom-loop guard misses this because each user message restarts
    // the runner with fresh signature state.
    const burst = bumpCreateBurst(ctx);
    if (burst.count > CREATE_BURST_THRESHOLD) {
      return err(
        `Refused: create_goal has been called ${burst.count} times in the last ${Math.round(CREATE_BURST_WINDOW_MS / 1000)}s ` +
          `with no intervening real work. The goal is already set — call get_goal to re-read it if needed, ` +
          `then EXECUTE the actual task (write files, run commands, edit code). ` +
          `Calling create_goal more is not progress; it is a stuck-loop signal. ` +
          `Stop revising the goal and start the work.`,
      );
    }

    const existing = readGoal(ctx);
    let supersededNote = '';
    if (existing && existing.status !== 'complete') {
      const supersededAt = new Date().toISOString();
      const newPreview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
      const note = `Superseded by new goal: "${newPreview}"`;
      writeGoal(ctx, {
        ...existing,
        status: 'complete',
        updatedAt: supersededAt,
        completionNote: note,
      });
      const oldPreview = existing.text.length > 120 ? `${existing.text.slice(0, 120)}…` : existing.text;
      supersededNote = `Previous goal "${oldPreview}" auto-completed (superseded). `;
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
    // Quiet success message. Earlier we appended an action nudge ("DO NOT
    // call create_goal again — execute the task now") on burst.count >= 2,
    // but that paradoxically reinforced the loop by keeping the tool name
    // in the model's context. The runner-level filter (filterGoalToolsByState
    // in runner.ts) now removes create_goal from the tool surface entirely
    // once a goal is in_progress, so the model can't see it on the next
    // turn anyway — no nudge needed in the result body.
    return ok(
      `${supersededNote}Goal set. Status: in_progress${budget ? ` (budget: ${budget} tokens)` : ''}.`,
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
