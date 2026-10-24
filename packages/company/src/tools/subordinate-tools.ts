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
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import type { JsonSchema } from "@mcp/provider-sdk";
import type { ToolResult } from "@mcp/agent-runtime-host/tool-result.js";
import { ok, err } from "@mcp/agent-runtime-host/tool-result.js";
import { okStructured } from '@mcp/code-agent/core/model-output.js';
import { formatAskUserResult } from '@mcp/code-agent/tools/interaction.js';
import { formatPlanResult } from '@mcp/code-agent/tools/plan.js';
import { validateTasksInput } from '@mcp/code-agent/tools/tasks.js';
import type { CoderTask, TaskExecutionMode, TasksState } from '@mcp/session-storage/session-state-types.js';
import { maybeTerse } from '@mcp/code-agent/tools/descriptions.js';
import { isUuid } from '@mcp/session-storage';
import { submitSpecificationToMaster } from './subordinate/submit-specification.js';
import { awaitMasterDecision } from './subordinate/await-master.js';

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

    const answer = await awaitMasterDecision(runner, { heartbeatAgentRunId: ctx.companyContext?.agentRunId ?? undefined });
    let parsed: { aborted?: boolean; interrupted?: boolean; answer?: string };
    try { parsed = JSON.parse(answer); } catch { parsed = { answer }; }
    if (parsed.aborted) return err('Question aborted by Master.');
    if (parsed.interrupted) {
      return err(
        'The Master did not respond in time and may be unavailable. Proceed using your best ' +
        'judgment, document any assumptions you make, and finish with a clear summary of what ' +
        'still needs the Master.',
      );
    }
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

    const raw = await awaitMasterDecision(runner, { heartbeatAgentRunId: ctx.companyContext?.agentRunId ?? undefined });
    let parsed: { approved?: boolean; feedback?: string; aborted?: boolean; interrupted?: boolean };
    try { parsed = JSON.parse(raw); } catch { parsed = { approved: false, feedback: raw }; }

    if (parsed.interrupted) {
      ctx.resolvePlan?.(id, 'aborted', 'master_unavailable');
      return err(
        'The Master did not review your plan in time and may be unavailable. If the work is ' +
        'safe and reversible, proceed with best-effort assumptions and summarize; otherwise ' +
        'finish with a clear note on what needs Master approval.',
      );
    }
    if (parsed.aborted) {
      ctx.resolvePlan?.(id, 'aborted', parsed.feedback);
      return err('Plan review aborted by Master.');
    }
    if (parsed.approved) {
      ctx.resolvePlan?.(id, 'approved', parsed.feedback);
      runner.approvePlan();
      // Iteration 2: auto plan→build after Master approval. Mirrors the
      // standalone submit_plan flow — when the subordinate was started in
      // `plan` mode, the approval implicitly means "proceed to execution".
      //
      // Reminder rides as `extraUserBlocks` on the tool result rather than
      // a direct `appendSystemReminder` push to avoid breaking strict
      // OpenAI-style providers (Kimi Code), which reject a `user` message
      // injected between an `assistant` tool_call and its `tool_result`.
      // See plan.ts for the full rationale.
      const transitioning = runner.agentId === 'plan';
      if (transitioning) {
        ctx.setSessionAgent?.('build');
      }
      const base = `Plan approved by Master.${parsed.feedback ? ` Feedback: ${parsed.feedback}` : ''}`;
      const result: ToolResult = { content: `${base} You may now proceed with mutating tools.` };
      if (transitioning) {
        result.extraUserBlocks = [
          {
            type: 'text',
            text:
              '<system-reminder>Mode transition: Plan → Build. The Master approved the plan. Now execute it per build-mode instructions: read with prepare_edit / get_symbol_body before editing, apply changes, run verify after each batch. No further plan submission needed.</system-reminder>',
          },
        ];
      }
      return result;
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

// Reuse the schema shape from the original tasks.ts. Task ids are generated
// by validateTasksInput; any `id` supplied here is only a client alias used
// to resolve depends_on inside this one submission.
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
          id: {
            type: 'string',
            description:
              'Optional client alias for depends_on within this submit_tasks_to_master call. The backend replaces it with a generated tsk_... id.',
          },
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
          depends_on: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional client aliases from this same submission. Rewritten to generated tsk_... ids.',
          },
          suggested_mode: { type: 'string', enum: ['inline', 'subagent'], description: 'Suggested execution mode' },
          estimated_complexity: { type: 'string', enum: ['small', 'medium', 'large'] },
        },
        required: ['title', 'description'],
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

    const raw = await awaitMasterDecision(runner, { heartbeatAgentRunId: ctx.companyContext?.agentRunId ?? undefined });
    let parsed: {
      approved?: boolean;
      feedback?: string;
      aborted?: boolean;
      interrupted?: boolean;
      tasks?: CoderTask[];
      execution_mode?: TaskExecutionMode;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { approved: false, feedback: raw };
    }

    if (parsed.interrupted) {
      ctx.resolveTasks?.({ approved: false });
      return err(
        'The Master did not review your task list in time and may be unavailable. Proceed on ' +
        'the safe, independent tasks with best-effort assumptions and summarize what still ' +
        'needs Master approval.',
      );
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
        'Call list_tasks if unsure, then execute_tasks once to run the approved list.',
      );
    }
    ctx.resolveTasks?.({ approved: false });
    const fb = parsed.feedback ? ` Master feedback: ${parsed.feedback}` : '';
    return ok(`Tasks rejected by Master.${fb} Revise and call submit_tasks_to_master again.`);
  },
};

// ─── send_to_agent ────────────────────────────────────────────────

const SEND_TO_AGENT_DESC =
  'Send a message to another subordinate via the persistent inbox queue.\n' +
  'When the target is busy, the message sits as `pending` and is delivered automatically when they finish their current task. ' +
  'Use kind="question" with wait=true to block until the target answers; kind="notify" with wait=false is fire-and-forget.\n' +
  "USE: when you need a peer's domain knowledge and the master would just forward you anyway.\n" +
  "DON'T: use for binary decisions — that's the master's job (ask_master).\n" +
  "DON'T: use to coordinate tasks the master already orchestrated via the kanban — comment on the card instead.";

export const sendToAgent: CoderTool = {
  name: 'send_to_agent',
  description: maybeTerse(SEND_TO_AGENT_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      target_role: {
        type: 'string',
        description: 'Recipient role (e.g. "backend"). The inbox picks the run with the smallest backlog.',
      },
      target_agent_run_id: {
        type: 'string',
        description: 'Optional: pin to a specific agent run UUID when several agents share a role.',
      },
      question: {
        type: 'string',
        description: 'Body of the message. For kind="question" frame it as a single, answerable question.',
      },
      kind: {
        type: 'string',
        enum: ['question', 'notify'],
        description: '"question" expects an answer; "notify" is fire-and-forget. Default: "question".',
      },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'urgent'],
        description: 'Delivery priority. "urgent" is claimed before queued FYIs — use it only for a real blocker. Default: "normal".',
      },
      wait: {
        type: 'boolean',
        description: 'When true (default for question), your session BLOCKS until target answers via respond_to_inbox.',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const body = String(args.question ?? '').trim();
    if (!body) return err('question cannot be empty');
    const kind = (args.kind as 'question' | 'notify' | undefined) ?? 'question';
    const wait = args.wait == null ? kind === 'question' : Boolean(args.wait);
    const priority = (args.priority as 'low' | 'normal' | 'urgent' | undefined) ?? 'normal';
    const targetRole = args.target_role as string | undefined;
    const targetAgentRunId = args.target_agent_run_id as string | undefined;

    const company = ctx.companyContext;
    if (!company) return err('send_to_agent requires a company orchestrator context');
    if (company.agentRunId == null) return err('send_to_agent requires the caller to be a registered subordinate');
    if (!targetRole && typeof targetAgentRunId !== 'string') {
      return err('Provide either target_role or target_agent_run_id');
    }

    try {
      const sent = company.orchestrator.inboxSend({
        fromAgentRunId: company.agentRunId,
        fromRole: company.agentRole,
        toRole: targetRole,
        toAgentRunId: targetAgentRunId,
        kind,
        body,
        wait,
        priority,
      });

      if (!wait || !sent.waitToken) {
        const target = targetRole ?? `run=${targetAgentRunId}`;
        return ok(
          `Message ${sent.message.id} queued for @${target} ` +
          `(${sent.deliveredImmediately ? 'delivered' : 'pending'}).`,
        );
      }

      const answer = await company.orchestrator.inboxWait(sent.waitToken);
      return ok(`@${targetRole ?? `run=${targetAgentRunId}`} answered: ${answer}`);
    } catch (e) {
      return err(`send_to_agent failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

// ─── send_to_master ──────────────────────────────────────────────

const SEND_TO_MASTER_DESC =
  'Queue a message for the Master orchestrator via the persistent master inbox.\n' +
  "Unlike ask_master (which BLOCKS your session until the master replies in the same turn), this tool persists the message even when the master's turn has ended — it will be revived/resumed automatically and process the queued message. " +
  'Use kind="notify" with wait=false for fire-and-forget status updates ("smoke tests passing", "deployment done"). ' +
  'Use kind="question" with wait=true when you need an answer but want the master to handle it asynchronously (your session blocks until the master answers via respond_to_inbox).\n' +
  "USE: when the master may be between turns and you can't wait for them to come back interactively.\n" +
  "USE: for batched status updates so multiple subordinates' messages coalesce into a single master turn instead of N resurrects.\n" +
  "DON'T: use for in-flight Q&A while the master is clearly active — ask_master is faster and lighter.";

export const sendToMaster: CoderTool = {
  name: 'send_to_master',
  description: maybeTerse(SEND_TO_MASTER_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Body of the message. For kind="question" frame it as a single, answerable question.',
      },
      kind: {
        type: 'string',
        enum: ['question', 'notify'],
        description: '"question" expects an answer; "notify" is fire-and-forget. Default: "notify".',
      },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'urgent'],
        description: 'Delivery priority. "urgent" jumps ahead of the master\'s queued FYIs — use only for a real blocker. Default: "normal".',
      },
      wait: {
        type: 'boolean',
        description:
          'When true, your session BLOCKS until the master answers via respond_to_inbox. Defaults to true for kind="question", false for kind="notify".',
      },
    },
    required: ['message'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const body = String(args.message ?? '').trim();
    if (!body) return err('message cannot be empty');
    const kind = (args.kind as 'question' | 'notify' | undefined) ?? 'notify';
    const wait = args.wait == null ? kind === 'question' : Boolean(args.wait);
    const priority = (args.priority as 'low' | 'normal' | 'urgent' | undefined) ?? 'normal';

    const company = ctx.companyContext;
    if (!company) return err('send_to_master requires a company orchestrator context');
    if (company.agentRunId == null) {
      return err('send_to_master requires the caller to be a registered subordinate');
    }

    try {
      const sent = company.orchestrator.inboxSend({
        fromAgentRunId: company.agentRunId,
        fromRole: company.agentRole,
        toRole: '__master__',
        kind,
        body,
        wait,
        priority,
      });

      if (!wait || !sent.waitToken) {
        return ok(
          `Message ${sent.message.id} queued for @master ` +
            `(${sent.deliveredImmediately ? 'delivered' : 'queued — master will pick it up'}).`,
        );
      }

      const answer = await company.orchestrator.inboxWait(sent.waitToken);
      return ok(`Master answered: ${answer}`);
    } catch (e) {
      return err(`send_to_master failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

// ─── respond_to_inbox ────────────────────────────────────────────

export const respondToInbox: CoderTool = {
  name: 'respond_to_inbox',
  description:
    'Answer an inbox message addressed to you (`message_id` is included in the prompt the inbox injected). ' +
    'Use this when a peer asked you a question via send_to_agent. The sender unblocks immediately.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: 'UUID of the inbox message to answer (printed in the [INBOX ...] header).' },
      answer: { type: 'string', description: 'Your answer. Plain text — keep it focused.' },
    },
    required: ['message_id', 'answer'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const messageId = String(args.message_id ?? '').trim();
    const answer = String(args.answer ?? '').trim();
    if (!isUuid(messageId)) return err('message_id must be a canonical UUID');
    if (!answer) return err('answer cannot be empty');
    const company = ctx.companyContext;
    if (!company) return err('respond_to_inbox requires a company orchestrator context');
    const ok2 = company.orchestrator.inboxRespond(messageId, answer);
    if (!ok2) return err(`Message ${messageId} is not answerable (not found or already terminal).`);
    return ok(`Answered inbox message ${messageId}.`);
  },
};

// ─── read_my_inbox ──────────────────────────────────────────────

export const readMyInbox: CoderTool = {
  name: 'read_my_inbox',
  // Inbox polling — even though incoming messages are usually injected
  // as prompts, manual re-reads of the same status filter return the
  // same set. That's expected "no new mail" behaviour, not a loop.
  repeatable: true,
  description:
    'List inbox messages addressed to you. Mostly a debug helper — incoming messages are normally injected as a prompt automatically.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'delivered', 'answered', 'cancelled', 'expired'],
        description: 'Filter by status.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const company = ctx.companyContext;
    if (!company) return err('read_my_inbox requires a company orchestrator context');
    if (company.agentRunId == null) return err('read_my_inbox requires the caller to be a registered subordinate');
    const status = args.status as
      | 'pending'
      | 'delivered'
      | 'answered'
      | 'cancelled'
      | 'expired'
      | undefined;
    const messages = company.orchestrator.inboxList({
      toAgentRunId: company.agentRunId,
      status,
      limit: 50,
    });
    if (messages.length === 0) return ok('Inbox is empty.');
    const compact = messages.map((m) => ({
      id: m.id,
      from: `@${m.from_role}`,
      kind: m.kind,
      status: m.status,
      preview: m.body.slice(0, 160),
      created_at: m.created_at,
    }));
    return okStructured(compact);
  },
};

// ─── check_inbox_answer ──────────────────────────────────────────
//
// C9 (Sprint 3.5) — poll-style status check for a message previously
// sent with `wait=false`. Returns the current status + answer (if any)
// without blocking. The sender pattern is:
//   1. `send_to_agent({ kind: 'question', wait: false })` → returns
//      a message id immediately.
//   2. Continue doing other work in subsequent turns.
//   3. Periodically `check_inbox_answer({ message_id })` to see if
//      the target has responded.
//
// This is the async-friendly counterpart to `wait=true` — caller stays
// productive instead of blocking until timeout.

const CHECK_INBOX_ANSWER_DESC =
  'Poll the status of an inbox message you sent with `wait=false`. Returns the current status + answer (if any).\n' +
  'Status values: `pending` (queued, target busy), `delivered` (target picked it up), `answered` (target replied — see "answer"), `expired` (timed out), `cancelled`.\n' +
  "USE: after `send_to_agent({ wait: false })` to check if the answer arrived without blocking your session.\n" +
  "DON'T: poll in a tight loop — give the target time to respond. Once per turn is plenty.";

export const checkInboxAnswer: CoderTool = {
  name: 'check_inbox_answer',
  description: maybeTerse(CHECK_INBOX_ANSWER_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      message_id: {
        type: 'string',
        description: 'The message UUID returned by `send_to_agent` (printed in the tool result as `Message <id>`).',
      },
    },
    required: ['message_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const messageId = String(args.message_id ?? '').trim();
    if (!isUuid(messageId)) {
      return err('message_id must be a canonical UUID');
    }
    const company = ctx.companyContext;
    if (!company) return err('check_inbox_answer requires a company orchestrator context');

    const snap = company.orchestrator.inboxStatus(messageId);
    if (!snap) return err(`Message ${messageId} not found`);

    const lines: string[] = [`message_id: ${messageId}`, `status: ${snap.status}`];
    if (snap.deliveredAt) lines.push(`delivered_at: ${snap.deliveredAt}`);
    if (snap.answeredAt) lines.push(`answered_at: ${snap.answeredAt}`);
    if (snap.answer) {
      lines.push(`answer: ${snap.answer}`);
    } else if (snap.status === 'pending' || snap.status === 'delivered') {
      lines.push('answer: (not yet — check again on a later turn)');
    }
    return ok(lines.join('\n'));
  },
};

// ─── Export ───────────────────────────────────────────────────────

/**
 * Build the subordinate communication tools array.
 * These replace ask_user, submit_plan, submit_tasks for company subordinates.
 */
export function buildSubordinateTools(): CoderTool[] {
  return [
    askMaster,
    submitPlanToMaster,
    submitSpecificationToMaster,
    submitTasksToMaster,
    sendToAgent,
    sendToMaster,
    respondToInbox,
    readMyInbox,
    checkInboxAnswer,
  ];
}
