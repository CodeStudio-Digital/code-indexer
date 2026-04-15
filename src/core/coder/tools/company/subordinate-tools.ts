/**
 * Subordinate-specific communication tools.
 *
 * When an agent runs as a company subordinate, its human-interaction tools
 * (ask_user, submit_plan, submit_tasks) are replaced by these master-directed
 * variants. The tools emit the same runner events (question_posted, plan_posted,
 * tasks_posted) so the orchestrator interception wiring works unchanged.
 *
 * Benefits:
 * - Tool names explicitly say "master" → LLM never confuses who it's talking to
 * - Descriptions are tailored to the subordinate's role
 * - No risk of the subordinate thinking it can talk directly to a human
 */
import type { CoderTool, ToolResult, JsonSchema } from '../../core/tool.js';
import { ok, err } from '../../core/tool.js';
import { formatAskUserResult } from '../interaction.js';
import { formatPlanResult } from '../plan.js';
import { validateTasksInput } from '../tasks.js';
import type { CoderTask, TaskExecutionMode, TasksState } from '../../sessions/types.js';
import { maybeTerse } from '../descriptions.js';

// ─── ask_master ───────────────────────────────────────────────────

const ASK_MASTER_DESC =
  'Ask the Master orchestrator a question. Your session is BLOCKED until the Master responds.\n' +
  'The Master may answer directly or escalate to the human user if needed.\n' +
  "USE: when you need a decision, clarification, or approval that only the Master can provide.\n" +
  "USE: when you're stuck and need guidance on the task approach.\n" +
  "DON'T: ask things you can verify yourself (file existence, type signatures, config values — READ them).\n" +
  "DON'T: ask for confirmation of obvious next steps. Just do it.";

export const askMaster: CoderTool = {
  name: 'ask_master',
  description: maybeTerse(ASK_MASTER_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the Master orchestrator.' },
      options: {
        type: 'array',
        description: 'Optional list of pre-defined answer options.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['label', 'value'],
        },
      },
      allow_freeform: {
        type: 'boolean',
        description: 'When true and options are given, also allow a free-form answer.',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const question = String(args.question ?? '').trim();
    if (!question) return err('question cannot be empty');
    const runner = ctx.runner;
    if (!runner) return err('ask_master tool requires runner context');

    const optsRaw = Array.isArray(args.options) ? args.options : undefined;
    const options = optsRaw?.map((o) => {
      const obj = o as { label?: unknown; value?: unknown };
      return { label: String(obj.label ?? ''), value: String(obj.value ?? '') };
    });
    const allowFreeform = Boolean(args.allow_freeform);

    const id = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    // Emit the same event that ask_user does — the orchestrator intercepts it
    runner.emit('question_posted', {
      type: 'question',
      id,
      question,
      options,
      allowFreeform,
    });

    const answer = await runner.waitForUserInput();
    let parsed: { aborted?: boolean; answer?: string };
    try { parsed = JSON.parse(answer); } catch { parsed = { answer }; }
    if (parsed.aborted) return err('Question aborted by Master.');
    // Reformat as "Master answered:" for clarity in the subordinate's context
    return ok(`Master answered: ${parsed.answer ?? answer}`);
  },
};

// ─── submit_plan_to_master ────────────────────────────────────────

const SUBMIT_PLAN_TO_MASTER_DESC =
  'Submit an implementation plan to the Master orchestrator for review. Returns the verdict (approved/rejected) and optional feedback.\n' +
  'The Master approves or rejects your plan. If rejected, revise and resubmit.\n' +
  "USE: in plan mode, BEFORE any mutating tool. No exceptions.\n" +
  "USE: for linear, single-action work. For 2+ independent items use submit_tasks_to_master instead.\n" +
  "DON'T: submit a plan that reads 'I will look at the code and decide' — explore FIRST, then submit a concrete plan.";

export const submitPlanToMaster: CoderTool = {
  name: 'submit_plan_to_master',
  description: maybeTerse(SUBMIT_PLAN_TO_MASTER_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description:
          'Numbered, concise plan of the next concrete steps you intend to take. ' +
          'The Master orchestrator will review and approve or reject.',
      },
    },
    required: ['plan'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const plan = String(args.plan ?? '').trim();
    if (!plan) return err('plan cannot be empty');
    const runner = ctx.runner;
    if (!runner) return err('submit_plan_to_master tool requires runner context');

    const id = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    ctx.recordPlan?.(id, plan);
    // Emit the same event as submit_plan — orchestrator intercepts it
    runner.emit('plan_posted', { type: 'plan', id, plan });

    const raw = await runner.waitForUserInput();
    let parsed: { approved?: boolean; feedback?: string; aborted?: boolean };
    try { parsed = JSON.parse(raw); } catch { parsed = { approved: false, feedback: raw }; }

    if (parsed.aborted) {
      ctx.resolvePlan?.(id, 'aborted', parsed.feedback);
      return err('Plan review aborted by Master.');
    }
    if (parsed.approved) {
      ctx.resolvePlan?.(id, 'approved', parsed.feedback);
      runner.approvePlan();
      const base = `Plan approved by Master.${parsed.feedback ? ` Feedback: ${parsed.feedback}` : ''}`;
      return ok(`${base} You may now proceed with mutating tools.`);
    }
    ctx.resolvePlan?.(id, 'rejected', parsed.feedback);
    const base = `Plan rejected by Master.${parsed.feedback ? ` Feedback: ${parsed.feedback}` : ''}`;
    return ok(`${base} Revise the plan and call submit_plan_to_master again before mutating tools.`);
  },
};

// ─── submit_tasks_to_master ───────────────────────────────────────

const SUBMIT_TASKS_TO_MASTER_DESC =
  'Submit a STRUCTURED task list to the Master orchestrator for approval. Returns the (possibly-edited) tasks and chosen execution mode.\n' +
  "USE: when the work decomposes into 2+ independent items.\n" +
  "USE: when per-task context curation pays off — each task declares its files, references, and dependencies.\n" +
  "DON'T: use for linear single-action work. Use submit_plan_to_master — it's lighter.";

// Reuse the schema shape from the original tasks.ts
const submitTasksToMasterSchema: JsonSchema = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'High-level summary of the overall goal.',
    },
    tasks: {
      type: 'array',
      description: 'Ordered list of tasks to submit to the Master for approval.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique task ID (e.g. "task_1")' },
          title: { type: 'string', description: 'Short task title' },
          description: { type: 'string', description: 'Detailed description of what to do' },
          files: { type: 'array', items: { type: 'string' }, description: 'File paths this task touches' },
          references: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file_path: { type: 'string' },
                symbol: { type: 'string' },
                line: { type: 'number' },
                context: { type: 'string' },
              },
              required: ['file_path'],
            },
            description: 'Code references relevant to this task',
          },
          depends_on: { type: 'array', items: { type: 'string' }, description: 'IDs of tasks this depends on' },
          suggested_mode: { type: 'string', enum: ['inline', 'subagent'], description: 'Suggested execution mode' },
          estimated_complexity: { type: 'string', enum: ['small', 'medium', 'large'] },
        },
        required: ['id', 'title', 'description'],
      },
    },
  },
  required: ['summary', 'tasks'],
} as unknown as JsonSchema;

export const submitTasksToMaster: CoderTool = {
  name: 'submit_tasks_to_master',
  description: maybeTerse(SUBMIT_TASKS_TO_MASTER_DESC),
  source: 'native',
  parameters: submitTasksToMasterSchema,
  handler: async (args, ctx): Promise<ToolResult> => {
    const validated = validateTasksInput(args as unknown);
    if (typeof validated === 'string') return err(`submit_tasks_to_master validation failed: ${validated}`);

    const runner = ctx.runner;
    if (!runner) return err('submit_tasks_to_master requires runner context');

    const toolUseId = `tasks_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const initialState: TasksState = {
      summary: validated.summary,
      tasks: validated.tasks,
      execution_mode: null,
      approved: false,
      current_task_id: null,
    };
    ctx.recordTasks?.(toolUseId, initialState);
    // Emit the same event as submit_tasks — orchestrator intercepts it
    runner.emit('tasks_posted', {
      tool_use_id: toolUseId,
      summary: initialState.summary,
      tasks: initialState.tasks,
      version: 1,
    });

    const raw = await runner.waitForUserInput();
    let parsed: {
      approved?: boolean;
      feedback?: string;
      aborted?: boolean;
      tasks?: CoderTask[];
      execution_mode?: TaskExecutionMode;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { approved: false, feedback: raw };
    }

    if (parsed.aborted) {
      ctx.resolveTasks?.({ approved: false });
      return err('Task list review aborted by Master.');
    }
    if (parsed.approved) {
      ctx.resolveTasks?.({
        approved: true,
        tasks: parsed.tasks,
        execution_mode: parsed.execution_mode ?? 'inline',
      });
      runner.markTasksApproved();
      const finalTasks = parsed.tasks ?? initialState.tasks;
      const mode = parsed.execution_mode ?? 'inline';
      const fb = parsed.feedback ? ` Master feedback: ${parsed.feedback}` : '';
      return ok(
        `Tasks approved by Master. Execution mode: ${mode}. ${finalTasks.length} task(s) ready.${fb}\n` +
        'Call execute_task for each task in dependency order.',
      );
    }
    ctx.resolveTasks?.({ approved: false });
    const fb = parsed.feedback ? ` Master feedback: ${parsed.feedback}` : '';
    return ok(`Tasks rejected by Master.${fb} Revise and call submit_tasks_to_master again.`);
  },
};

// ─── Export ───────────────────────────────────────────────────────

/**
 * Build the subordinate communication tools array.
 * These replace ask_user, submit_plan, submit_tasks for company subordinates.
 */
export function buildSubordinateTools(): CoderTool[] {
  return [askMaster, submitPlanToMaster, submitTasksToMaster];
}
