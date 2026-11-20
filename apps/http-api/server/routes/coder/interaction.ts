import { ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import { randomUUID } from 'node:crypto';
import type { HttpRouter } from '@mcp/shared/http/router.js';
import { bodyLimit } from '@mcp/shared/http/middleware.js';
import type { CoderProviderName } from '@mcp/code-agent/index.js';
import type { AgentMessage } from "@mcp/provider-sdk";
import type { SessionId } from '@mcp/agent-runtime-contracts';
import { DEFAULT_ATTACHMENT_PROMPT, MAX_ATTACHMENT_REQUEST_BYTES } from '@mcp/shared';
import { formatPlanResult, PLAN_APPROVAL_REMINDER } from '@mcp/code-agent/tools/plan.js';
import {
  formatTasksApprovedResult,
  formatTasksRejectedResult,
} from '@mcp/code-agent/tools/tasks.js';
import { formatAskUserResult, formatDecisionGateResult } from '@mcp/code-agent/tools/interaction.js';
import { approvalAskId, buildUserDeniedText } from '@mcp/code-agent/core/permission-gate.js';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import { parseSessionIdParam, notFound } from '../_helpers.js';
import { getCoderWorkerPool } from '../../../sse/coderWorkerPoolSingleton.js';
import { emitWorkerLog } from '../../../coder-bus.js';
import { resolveAgentSelection } from '../../../custom-agents.js';
import { withSessionLock } from './sessionLock.js';
import { stopChildAgentsOf } from './child-agent-cascade.js';
import {
  authorizeQueuedAttachmentReferences,
  prepareQueuedAttachments,
} from './queued-attachments.js';

interface AnswerBody {
  answer: string;
  interaction_id?: string;
}

interface DecideBody {
  interaction_id?: string;
  /** Chosen option values + optional free-form note, keyed by question id. */
  answers: Record<string, { selected?: string[]; freeform?: string }>;
}

interface PlanResponseBody {
  interaction_id?: string;
  approved: boolean;
  feedback?: string;
  /**
   * "Recusar" — end the planning run. Maps to the submit_plan tool's `aborted`
   * branch (resolvePlan 'aborted', no plan→build transition). The user can
   * still send a new message afterwards.
   */
  aborted?: boolean;
}

interface TasksResponseBody {
  interaction_id?: string;
  approved: boolean;
  feedback?: string;
  tasks?: import('@mcp/session-storage/session-state-types.js').CoderTask[];
  execution_mode?: import('@mcp/session-storage/session-state-types.js').TaskExecutionMode;
}

interface SwitchProviderBody {
  provider: CoderProviderName;
  model?: string;
}

interface ToolApprovalBody {
  tool_use_id: string;
  approved: boolean;
  note?: string;
  always_allow?: boolean;
  recovery_reviewed?: boolean;
  recovery_fingerprint?: string;
}

const queuedAttachmentBodyLimit = bodyLimit({
  maxSize: MAX_ATTACHMENT_REQUEST_BYTES,
  onError: (c) => c.json(
    { error: 'request body is too large', code: 'ATTACHMENT_REQUEST_TOO_LARGE' },
    413,
  ),
});

export function mountCoderInteractionRoutes(
  app: HttpRouter,
  deps: ServerDeps,
  runtime: CoderRuntime,
): void {
  const { sessionStore } = deps;
  const { findPendingInteraction, findDanglingToolUse } = runtime;
  const workerPool = getCoderWorkerPool();

  /**
   * Emit a route-level `worker_log` event so the dashboard's
   * WorkerLogPanel shows endpoint hits alongside runner events. Picks
   * the bus from the mandatory worker pool. When no run is live, the log is
   * silently dropped because no client is subscribed to receive it.
   */
  const logRouteHit = (sessionId: SessionId, endpoint: string, preview: unknown): void => {
    const bus = workerPool.getBus(sessionId);
    emitWorkerLog(bus, 'info', 'route', `POST ${endpoint}`, preview);
  };

  app.post('/api/coder/sessions/:id/abort', async (c) => {
    const id = parseSessionIdParam(c);
    try {
      // The user's Stop reaches every child agent below this session first, so none starts after it.
      await stopChildAgentsOf(id, 'stopped_by_user');
      const mailbox = new ChatCollaborationStore(deps.sessionStore.locator.dataDir);
      await mailbox.init(); await mailbox.stopSession(id);
      await workerPool.abort(id);
      return c.json({ ok: true });
    } catch (err) {
      console.warn(
        `[coder] worker abort failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ error: 'worker abort failed' }, 503);
    }
  });

  /**
   * P1 (ultra-agent parity): abort ONE running subagent row — spawn_agent
   * single/parallel or a workflow step — leaving the parent run alive.
   * `agent` is the 0-based index (number) or the label (string), matching
   * the identity carried by agents_group_start/agent_progress.
   */
  app.post('/api/coder/sessions/:id/agents/abort', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await c.req.json().catch(() => null) as
      { group_id?: string; agent?: number | string } | null;
    const groupId = typeof body?.group_id === 'string' ? body.group_id.trim() : '';
    if (!groupId || body?.agent == null) {
      return c.json({ error: 'group_id and agent are required' }, 400);
    }
    logRouteHit(id, `/agents/abort ${groupId}#${body.agent}`, body);
    try {
      const result = await workerPool.abortAgent(id, groupId, body.agent);
      return c.json(result, result.ok ? 200 : 404);
    } catch (err) {
      console.warn(
        `[coder] agent abort failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ ok: false, error: 'agent abort failed' }, 503);
    }
  });

  /**
   * P1 (ultra-agent parity): retained transcript digest of a finished
   * subagent (resume registry, worker realm). Query: spawn_id (required),
   * agent (label or 1-based index; optional for single-agent groups),
   * max_chars. An evicted worker is recreated for reading only; missing
   * retained state returns 404. This never starts a model or resumes an agent.
   */
  app.get('/api/coder/sessions/:id/agents/transcript', async (c) => {
    const id = parseSessionIdParam(c);
    const spawnId = (c.req.query('spawn_id') ?? '').trim();
    if (!spawnId) return c.json({ error: 'spawn_id is required' }, 400);
    const agentRaw = c.req.query('agent');
    const agentRef = agentRaw == null || agentRaw === ''
      ? undefined
      : (/^\d+$/.test(agentRaw) ? Number.parseInt(agentRaw, 10) : agentRaw);
    const maxCharsRaw = Number.parseInt(c.req.query('max_chars') ?? '', 10);
    try {
      const result = await workerPool.readAgentTranscript(
        id,
        spawnId,
        agentRef,
        Number.isFinite(maxCharsRaw) ? maxCharsRaw : undefined,
      );
      return c.json(result, result.ok ? 200 : 404);
    } catch (err) {
      console.warn(
        `[coder] agent transcript fetch failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ ok: false, error: 'transcript fetch failed' }, 503);
    }
  });

  /**
   * Inject a follow-up user message into a LIVE run WITHOUT opening a new SSE
   * stream. Persists the message + pushes it onto the runner's
   * `pendingUserMessages` (drained at the next turn). The caller's ALREADY-OPEN
   * stream renders the agent's processing of it — the session bus is fan-out,
   * so a second connection is neither needed nor wanted (opening one would
   * abort the live stream and wipe the in-flight turn). Powers the composer's
   * "inject on next turn" queue.
   *
   * Returns JSON (never a stream):
   *   { injected: true }    — enqueued into the live runner.
   *   { noActiveRun: true } — no live run; caller falls back to POST /messages
   *                           (which starts a fresh, streamed run).
   *   { waiting: true }     — runner is blocked on an interactive tool and
   *                           `interject` was not set (caller decides).
   */
  app.post('/api/coder/sessions/:id/inject', queuedAttachmentBodyLimit, async (c) => {
    const id = parseSessionIdParam(c);
    const body = await c.req.json<{
      content?: string;
      interject?: boolean;
      attachments?: unknown;
      describe_images?: boolean;
      selected_skill_ids?: string[];
    }>();
    const prepared = await prepareQueuedAttachments(
      deps,
      id,
      body.attachments,
      body.describe_images === true,
    );
    if (!prepared.ok) {
      return c.json(
        { error: prepared.error, code: prepared.code },
        prepared.status,
      );
    }
    const attachments = prepared.value;
    const content = typeof body.content === 'string' && body.content.trim()
      ? body.content
      : attachments?.length
        ? DEFAULT_ATTACHMENT_PROMPT
        : '';
    if (!content.trim()) return c.json({ error: 'content required' }, 400);
    const interject = !!body.interject;
    const skillIds = body.selected_skill_ids && body.selected_skill_ids.length > 0
      ? body.selected_skill_ids
      : undefined;
    logRouteHit(id, '/inject', {
      content_preview: content.slice(0, 80),
      interject,
      attachment_count: attachments?.length ?? 0,
    });
    const bus = workerPool.getBus(id);
    if (!bus || bus.ended) return c.json({ noActiveRun: true });
    const referenceError = await authorizeQueuedAttachmentReferences(deps, id, attachments);
    if (referenceError) {
      return c.json({
        error: referenceError,
        code: 'ATTACHMENT_REFERENCE_NOT_AUTHORIZED',
      }, 409);
    }
    const waiting = await workerPool.isWaitingForInput(id).catch(() => false);
    if (waiting) {
      if (!interject) return c.json({ waiting: true });
    }
    const operationId = `interaction:inject:${randomUUID()}`;
    if (attachments?.length) {
      await workerPool.pushUserMessage(id, content, skillIds, operationId, attachments);
    } else {
      await workerPool.pushUserMessage(id, content, skillIds, operationId);
    }
    if (waiting && interject) await workerPool.interruptWait(id);
    return c.json({ injected: true });
  });

  app.post('/api/coder/sessions/:id/answer', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await c.req.json<AnswerBody>();
    const answer = body.answer ?? '';
    logRouteHit(id, '/answer', { answer_preview: answer.slice(0, 80) });
    try {
      const ok = await workerPool.provideUserInput(id, JSON.stringify({ answer }));
      if (ok) return c.json({ ok: true });
    } catch (err) {
      console.warn(
        `[coder] worker provideUserInput failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const pending = await findPendingInteraction(id);
    if (!pending || pending.name !== 'ask_user') {
      return c.json({ error: 'no pending question' }, 404);
    }
    const toolMsg: AgentMessage = {
      role: 'tool',
      content: [{
        type: 'tool_result',
        tool_use_id: pending.toolUseId,
        content: formatAskUserResult(answer),
      }],
    };
    await sessionStore.appendMessage({
      session_id: id,
      operation_id: `interaction:answer:${pending.toolUseId}`,
      message: toolMsg,
    });
    return c.json({ ok: true, resumed_via_worker: true });
  });

  /**
   * Resolve a pending `decision_gate` questionnaire — the user picked among the
   * alternative approaches. Mirrors /answer: live path resolves the runner's
   * pending `waitForUserInput()`; dead-runner path reconstructs the tool_result
   * from the persisted tool_use input (the original questions) so a restart
   * mid-questionnaire still resumes.
   */
  app.post('/api/coder/sessions/:id/decide', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await c.req.json<DecideBody>();
    const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};
    logRouteHit(id, '/decide', { questions: Object.keys(answers).length });
    const payload = JSON.stringify({ answers });
    try {
      const ok = await workerPool.provideUserInput(id, payload);
      if (ok) return c.json({ ok: true });
    } catch (err) {
      console.warn(
        `[coder] worker provideUserInput(decide) failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const pending = await findPendingInteraction(id);
    if (!pending || pending.name !== 'decision_gate') {
      return c.json({ error: 'no pending decision' }, 404);
    }
    const rawQuestions = (pending.input as { questions?: unknown } | undefined)?.questions;
    const questions = Array.isArray(rawQuestions)
      ? (rawQuestions as Array<{
          id: string;
          header?: string;
          question: string;
          options: Array<{ label: string; value: string }>;
        }>)
      : [];
    const toolMsg: AgentMessage = {
      role: 'tool',
      content: [{
        type: 'tool_result',
        tool_use_id: pending.toolUseId,
        content: formatDecisionGateResult(questions, answers),
      }],
    };
    await sessionStore.appendMessage({
      session_id: id,
      operation_id: `interaction:decision:${pending.toolUseId}`,
      message: toolMsg,
    });
    return c.json({ ok: true, resumed_via_worker: true });
  });

  /**
   * Resolve a pending PermissionGate approval — a write/execute/admin tool
   * call paused BEFORE execution (modes 'ask'/'auto'). Live path: resolves
   * the keyed wait slot `tool_approval:<tool_use_id>`. A dead runner is not
   * proof that an earlier approval was never delivered. Preserve uncertainty
   * for the dangling invocation and never instruct an automatic replay.
   */
  app.post('/api/coder/sessions/:id/tool-approval', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await c.req.json<ToolApprovalBody>();
    const toolUseId = typeof body.tool_use_id === 'string' ? body.tool_use_id.trim() : '';
    if (!toolUseId) return c.json({ error: 'tool_use_id required' }, 400);
    const approved = body.approved === true;
    logRouteHit(id, '/tool-approval', {
      tool_use_id: toolUseId,
      approved,
      always_allow: body.always_allow === true,
    });
    const payload = JSON.stringify({
      approved,
      note: body.note,
      alwaysAllow: body.always_allow === true,
      recoveryReviewed: body.recovery_reviewed === true,
      recoveryFingerprint: typeof body.recovery_fingerprint === 'string' ? body.recovery_fingerprint : undefined,
    });
    const askId = approvalAskId(toolUseId);
    try {
      const ok = await workerPool.provideUserInput(id, payload, askId);
      if (ok) return c.json({ ok: true });
    } catch (err) {
      console.warn(
        `[coder] worker provideUserInput(tool-approval) failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // An ACK can be lost after approval already released a mutating tool.
      // Never synthesize "not executed" and invite the model to repeat it.
      return c.json({ error: 'tool approval delivery could not be confirmed', code: 'INTERACTION_DELIVERY_UNCONFIRMED' }, 503);
    }
    const dangling = await findDanglingToolUse(id, toolUseId);
    if (!dangling) return c.json({ error: 'no pending tool approval' }, 404);
    const toolMsg: AgentMessage = {
      role: 'tool',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: approved
          ? '[approval-after-restart: não há runner ativo para receber esta aprovação. Uma entrega anterior pode ter iniciado a operação; seu resultado não foi confirmado. Inspecione o estado atual antes de qualquer nova tentativa.]'
          : `${buildUserDeniedText(dangling.name, body.note)} Uma entrega anterior pode ter iniciado a operação; negar agora não confirma seu término nem desfaz seus efeitos.`,
        effect_outcome: 'unknown',
        is_error: true,
      }],
    };
    await sessionStore.appendMessage({
      session_id: id,
      operation_id: `interaction:approval:${toolUseId}`,
      message: toolMsg,
    });
    return c.json({ ok: true, resumed_via_worker: true });
  });

  app.post('/api/coder/sessions/:id/plan-response', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await c.req.json<PlanResponseBody>();
    const aborted = !!body.aborted;
    // "Recusar" wins over approved: an abort verdict ends the planning run.
    const approved = !aborted && !!body.approved;
    logRouteHit(id, '/plan-response', { approved, aborted, has_feedback: !!body.feedback });
    const envelope = JSON.stringify({ approved, feedback: body.feedback, aborted });
    try {
      const ok = await workerPool.provideUserInput(id, envelope);
      if (ok) return c.json({ ok: true });
    } catch (err) {
      console.warn(
        `[coder] worker provideUserInput failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const pending = await findPendingInteraction(id);
    if (!pending || pending.name !== 'submit_plan') {
      return c.json({ error: 'no pending plan' }, 404);
    }
    const resultText = aborted
      ? `Plan rejected by user.${body.feedback ? ` Feedback: ${body.feedback}` : ''} Planning review ended.`
      : formatPlanResult(approved, body.feedback);
    const toolMsg: AgentMessage = {
      role: 'tool',
      content: [{
        type: 'tool_result',
        tool_use_id: pending.toolUseId,
        content: resultText,
        // Rejection ends the review and is error-shaped in the live tool path.
        // Persist the same bit so history reconstruction can distinguish it
        // from the legacy non-error Revise result.
        ...(aborted ? { is_error: true } : {}),
      }],
    };
    await sessionStore.appendMessage({
      session_id: id,
      operation_id: `interaction:plan-response:${pending.toolUseId}`,
      message: toolMsg,
    });
    // Mirror the verdict into the session's plan record so the Plans tab reflects the
    // resolved status even when the live runner was no longer in memory.
    await sessionStore.resolveLatestPendingPlan(
      id,
      aborted ? 'aborted' : approved ? 'approved' : 'rejected',
      body.feedback,
      `interaction:plan-state:${pending.toolUseId}`,
    );
    // Iteration 2: auto plan→build after approval. Mirrors the in-runner
    // path (plan.ts) for the case where no live runner consumed the
    // approval — the next /continue or POST /messages picks up the new
    // agent's defaults via the AGENTS lookup in runCoder.
    if (approved) {
      const session = await sessionStore.getSession(id);
      if (resolveAgentSelection(deps.providerStore, session?.agent)?.baseAgentId === 'plan') {
        try {
          await sessionStore.setSessionAgent(id, 'build');
          const reminder: AgentMessage = {
            role: 'user',
            content: [{
              type: 'text',
              text: PLAN_APPROVAL_REMINDER,
            }],
          };
          await sessionStore.appendMessage({
            session_id: id,
            operation_id:
              `interaction:plan-build-reminder:${pending.toolUseId}`,
            message: reminder,
          });
        } catch (e) {
          console.warn(
            `[coder] mode transition (offline path) failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
    return c.json({ ok: true, resumed_via_worker: true });
  });

  /**
   * List persisted plans for a session, newest first. Backed by the
   * session bundle's independent plan records.
   */
  app.get('/api/coder/sessions/:id/plans', async (c) => {
    const id = parseSessionIdParam(c);
    return c.json(await sessionStore.listPlans(id));
  });

  /**
   * Hidden-prompt log for a session — system prompt at run-start, skill
   * bodies fetched mid-conversation, runtime system-reminders, and
   * sub-agent system prompts. Powers the Input tab in the details modal.
   */
  app.get('/api/coder/sessions/:id/inputs', async (c) => {
    const id = parseSessionIdParam(c);
    return c.json(await sessionStore.listSessionInputs(id));
  });

  /**
   * Get the current task list state for a session. Used by the dashboard
   * to render the TaskListReview when (a) the SSE buffer was missed or
   * (b) the user reopens the session tab.
   */
  app.get('/api/coder/sessions/:id/tasks', async (c) => {
    const id = parseSessionIdParam(c);
    const state = await sessionStore.getTasksState(id);
    if (!state) return c.json(null);
    return c.json(state);
  });

  /**
   * Receive the user's verdict on a submit_tasks call. Mirrors /plan-response:
   * if the runner is live we resolve the pending tool call directly; otherwise
   * we inject the tool_result into the message log so the next runCoder()
   * picks up where we left off.
   */
  app.post('/api/coder/sessions/:id/tasks-response', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await c.req.json<TasksResponseBody>();
    const approved = !!body.approved;
    logRouteHit(id, '/tasks-response', {
      approved,
      task_count: body.tasks?.length ?? 0,
      execution_mode: body.execution_mode ?? null,
    });
    // Forward the verdict via worker RPC. The
    // worker's `submit_tasks` is blocked in `waitForUserInput()`; this
    // pushes the JSON it expects and unblocks the tool with the right
    // approve/reject branch. Without this path, the rest of the
    // handler would write a synthesized tool_result to the bundle while
    // the worker stays blocked, leaving session state inconsistent
    // (UI shows "rejected" even when user clicked approve, because
    // `resolveTasks(approved:false)` runs on the worker side too).
    try {
      const ok = await workerPool.provideUserInput(
        id,
        JSON.stringify({
          approved,
          feedback: body.feedback,
          tasks: body.tasks,
          execution_mode: body.execution_mode,
        }),
      );
      if (ok) return c.json({ ok: true });
    } catch (err) {
      console.warn(
        `[coder] worker provideUserInput failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Resume path — runner is gone. Find the pending submit_tasks / task_list
    // (approve) tool_use in the message history and inject its tool_result.
    const pending = await findPendingInteraction(id);
    if (!pending || (pending.name !== 'submit_tasks' && pending.name !== 'task_list')) {
      return c.json({ error: 'no pending tasks' }, 404);
    }
    await sessionStore.resolveTasks(
      id,
      {
        approved,
        tasks: body.tasks,
        execution_mode: body.execution_mode ?? null,
      },
      `interaction:tasks-state:${pending.toolUseId}`,
    );
    const newState = await sessionStore.getTasksState(id);
    const resultText = approved
      ? newState
        ? formatTasksApprovedResult(newState, body.feedback)
        : `Task list approved by user.${body.feedback ? ` Feedback: ${body.feedback}` : ''}`
      : formatTasksRejectedResult(body.feedback);
    const toolMsg: AgentMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          tool_use_id: pending.toolUseId,
          content: resultText,
        },
      ],
    };
    await sessionStore.appendMessage({
      session_id: id,
      operation_id: `interaction:tasks-response:${pending.toolUseId}`,
      message: toolMsg,
    });
    return c.json({ ok: true, resumed_via_worker: true });
  });

  app.post('/api/coder/sessions/:id/switch', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await c.req.json<SwitchProviderBody>();
    if (!body.provider) return c.json({ error: 'provider required' }, 400);
    const newProvider = await createCoderProvider(body.provider, body.model);
    const updated = await withSessionLock(id, async () => {
      const session = await sessionStore.getSession(id);
      if (!session) return false;
      const persistedByWorker = await workerPool.swapProvider(
        id,
        body.provider,
        newProvider.model,
      );
      if (!persistedByWorker) {
        await sessionStore.updateSessionProvider(
          id,
          body.provider,
          newProvider.model,
        );
      }
      return true;
    });
    if (!updated) return notFound(c);
    void deps.coderPreferences
      ?.setLastSelectedModel(body.provider, newProvider.model)
      .catch((error) => {
        console.warn(
          `[coder-preferences] could not persist switched model: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    return c.json({ ok: true, provider: body.provider, model: newProvider.model });
  });
}
