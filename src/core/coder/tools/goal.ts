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
 * Persistence: in-memory per-runner only. The goal vanishes on runner
 * restart. A future migration can persist it on `coder_sessions` if the
 * session-resume case proves to need it.
 */
import type { CoderTool, ToolContext, ToolResult } from '../core/tool.js';
import { ok, err } from '../core/tool.js';
import { maybeTerse } from './descriptions.js';

interface GoalState {
  text: string;
  status: 'in_progress' | 'complete';
  createdAt: string;
  updatedAt: string;
  budgetTokens?: number;
  completionNote?: string;
}

const GOAL_BY_RUNNER = new WeakMap<object, GoalState>();

function readKey(ctx: ToolContext): object | null {
  return (ctx.runner as unknown as object) ?? null;
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
    const key = readKey(ctx);
    if (!key) return err('create_goal requires runner context');
    const existing = GOAL_BY_RUNNER.get(key);
    if (existing && existing.status !== 'complete') {
      return err(
        `A goal is already active: "${existing.text.slice(0, 120)}${existing.text.length > 120 ? '…' : ''}". ` +
          `Mark it complete with update_goal first, or call get_goal to re-read it.`,
      );
    }
    const now = new Date().toISOString();
    const budget = typeof args.budget_tokens === 'number' && args.budget_tokens > 0 ? args.budget_tokens : undefined;
    GOAL_BY_RUNNER.set(key, {
      text,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
      budgetTokens: budget,
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
    const key = readKey(ctx);
    if (!key) return err('get_goal requires runner context');
    const g = GOAL_BY_RUNNER.get(key);
    if (!g) return ok('(no goal set)');
    const lines: string[] = [
      `Status: ${g.status}`,
      `Goal: ${g.text}`,
      `Created: ${g.createdAt}`,
    ];
    if (g.budgetTokens) lines.push(`Budget: ${g.budgetTokens} tokens (soft, not enforced)`);
    if (g.completionNote) lines.push(`Completion note: ${g.completionNote}`);
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
    const key = readKey(ctx);
    if (!key) return err('update_goal requires runner context');
    const g = GOAL_BY_RUNNER.get(key);
    if (!g) return err('No goal set. Call create_goal first.');
    if (g.status === 'complete') return err('Goal is already complete.');
    g.status = 'complete';
    g.updatedAt = new Date().toISOString();
    if (typeof args.note === 'string' && args.note.trim()) g.completionNote = args.note.trim();
    return ok(`Goal marked complete${g.completionNote ? `: ${g.completionNote}` : '.'}`);
  },
};

export const goalTools: CoderTool[] = [createGoal, getGoal, updateGoal];

/** Test-only: clear the in-memory goal for a runner key. */
export function _resetGoalForKey(key: object): void {
  GOAL_BY_RUNNER.delete(key);
}
