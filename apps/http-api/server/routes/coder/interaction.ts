import type { Hono } from 'hono';
import type { CoderProviderName } from '@mcp/code-agent/index.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { formatPlanResult } from '@mcp/code-agent/tools/plan.js';
import {
  formatTasksApprovedResult,
  formatTasksRejectedResult,
} from '@mcp/code-agent/tools/tasks.js';
import { formatAskUserResult } from '@mcp/code-agent/tools/interaction.js';
import { createChatProviderAsync } from '@mcp/services/providers/factory.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import { parseIdParam, notFound } from '../_helpers.js';
import {
  coderWorkerEnabled,
  getCoderWorkerPool,
} from '../../../sse/coderWorkerPoolSingleton.js';

interface AnswerBody {
  answer: string;
}

interface PlanResponseBody {
  approved: boolean;
  feedback?: string;
}

interface TasksResponseBody {
  approved: boolean;
  feedback?: string;
  tasks?: import('@mcp/code-agent/sessions/types.js').CoderTask[];
  execution_mode?: import('@mcp/code-agent/sessions/types.js').TaskExecutionMode;
}

interface SwitchProviderBody {
  provider: CoderProviderName;
  model?: string;
}

export function mountCoderInteractionRoutes(
  app: Hono,
  deps: ServerDeps,
  runtime: CoderRuntime,
): void {
  const { sessionStore } = deps;
  const { activeRuns, findPendingInteraction } = runtime;

  app.post('/api/coder/sessions/:id/abort', async (c) => {
    const id = parseIdParam(c);
    // P17 — abort the worker's runner first if it's the active path.
    // The proxy bus on main has no `.runner`, so the legacy branch
    // below would no-op silently.
    if (coderWorkerEnabled()) {
      try {
        await getCoderWorkerPool().abort(id);
        return c.json({ ok: true });
      } catch (err) {
        console.warn(
          `[coder] worker abort failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const bus = activeRuns.get(id);
    if (!bus) return c.json({ error: 'no active run' }, 404);
    bus.ctrl.abort();
    bus.runner?.abort();
    return c.json({ ok: true });
  });

  app.post('/api/coder/sessions/:id/answer', async (c) => {
    const id = parseIdParam(c);
    const body = await c.req.json<AnswerBody>();
    const answer = body.answer ?? '';
    // P17 — worker mode: the runner lives in a worker_thread, so we
    // can't read `entry.runner` directly. Push the answer via the
    // pool's `provideUserInput` RPC; the worker resolves the pending
    // `waitForUserInput()` and the runner proceeds normally.
    if (coderWorkerEnabled()) {
      try {
        const ok = await getCoderWorkerPool().provideUserInput(
          id,
          JSON.stringify({ answer }),
        );
        if (ok) return c.json({ ok: true });
      } catch (err) {
        console.warn(
          `[coder] worker provideUserInput failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Fall through to the resume path so the user's answer still
        // lands in the DB and the next /messages can replay it.
      }
    }
    const entry = activeRuns.get(id);
    if (entry?.runner) {
      const ok = entry.runner.provideUserInput(JSON.stringify({ answer }));
      if (ok) return c.json({ ok });
      // Runner exists but isn't waiting — fall through to resume path.
    }
    const pending = findPendingInteraction(id);
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
    sessionStore.appendMessage(id, toolMsg);
    return c.json({ ok: true, resumed: true });
  });

  app.post('/api/coder/sessions/:id/plan-response', async (c) => {
    const id = parseIdParam(c);
    const body = await c.req.json<PlanResponseBody>();
    const approved = !!body.approved;
    // P17 — worker mode: forward the verdict via the pool RPC so the
    // worker-side runner unblocks. See `/answer` for the rationale.
    if (coderWorkerEnabled()) {
      try {
        const ok = await getCoderWorkerPool().provideUserInput(
          id,
          JSON.stringify({ approved, feedback: body.feedback }),
        );
        if (ok) return c.json({ ok: true });
      } catch (err) {
        console.warn(
          `[coder] worker provideUserInput failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const entry = activeRuns.get(id);
    if (entry?.runner) {
      const ok = entry.runner.provideUserInput(
        JSON.stringify({ approved, feedback: body.feedback }),
      );
      if (ok) return c.json({ ok });
    }
    const pending = findPendingInteraction(id);
    if (!pending || pending.name !== 'submit_plan') {
      return c.json({ error: 'no pending plan' }, 404);
    }
    const toolMsg: AgentMessage = {
      role: 'tool',
      content: [{
        type: 'tool_result',
        tool_use_id: pending.toolUseId,
        content: formatPlanResult(approved, body.feedback),
      }],
    };
    sessionStore.appendMessage(id, toolMsg);
    // Mirror the verdict into coder_plans so the Plans tab reflects the
    // resolved status even when the live runner was no longer in memory.
    sessionStore.resolvePlan(
      pending.toolUseId,
      approved ? 'approved' : 'rejected',
      body.feedback,
    );
    // Iteration 2: auto plan→build after approval. Mirrors the in-runner
    // path (plan.ts) for the case where no live runner consumed the
    // approval — the next /continue or POST /messages picks up the new
    // agent's defaults via the AGENTS lookup in runCoder.
    if (approved) {
      const session = sessionStore.getSession(id);
      if (session?.agent === 'plan') {
        try {
          sessionStore.setSessionAgent(id, 'build');
          const reminder: AgentMessage = {
            role: 'user',
            content: [{
              type: 'text',
              text: '<system-reminder>Mode transition: Plan → Build. The plan was approved. Now execute it per build-mode instructions: read with prepare_edit / get_symbol_body before editing, apply changes, run verify after each batch. No further plan submission needed.</system-reminder>',
            }],
          };
          sessionStore.appendMessage(id, reminder);
        } catch (e) {
          console.warn(
            `[coder] mode transition (offline path) failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
    return c.json({ ok: true, resumed: true });
  });

  /**
   * List persisted plans for a session, newest first. Backed by the
   * coder_plans table (migration 007).
   */
  app.get('/api/coder/sessions/:id/plans', (c) => {
    const id = parseIdParam(c);
    return c.json(sessionStore.listPlans(id));
  });

  /** Chronological trace of every todo_write call in a session. */
  app.get('/api/coder/sessions/:id/todo-history', (c) => {
    const id = parseIdParam(c);
    return c.json(sessionStore.listTodoHistory(id));
  });

  /**
   * Hidden-prompt log for a session — system prompt at run-start, skill
   * bodies fetched mid-conversation, runtime system-reminders, and
   * sub-agent system prompts. Powers the Input tab in the details modal.
   */
  app.get('/api/coder/sessions/:id/inputs', (c) => {
    const id = parseIdParam(c);
    return c.json(sessionStore.listSessionInputs(id));
  });

  /**
   * Get the current task list state for a session. Used by the dashboard
   * to render the TaskListReview when (a) the SSE buffer was missed or
   * (b) the user reopens the session tab.
   */
  app.get('/api/coder/sessions/:id/tasks', (c) => {
    const id = parseIdParam(c);
    const state = sessionStore.getTasksState(id);
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
    const id = parseIdParam(c);
    const body = await c.req.json<TasksResponseBody>();
    const approved = !!body.approved;

    // P17 — worker mode: forward the verdict via the pool RPC. The
    // worker's `submit_tasks` is blocked in `waitForUserInput()`; this
    // pushes the JSON it expects and unblocks the tool with the right
    // approve/reject branch. Without this path, the rest of the
    // handler would write a synthesized tool_result to the DB while
    // the worker stays blocked, leaving session state inconsistent
    // (UI shows "rejected" even when user clicked approve, because
    // `resolveTasks(approved:false)` runs on the worker side too).
    if (coderWorkerEnabled()) {
      try {
        const ok = await getCoderWorkerPool().provideUserInput(
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
    }

    const entry = activeRuns.get(id);
    if (entry?.runner) {
      const ok = entry.runner.provideUserInput(
        JSON.stringify({
          approved,
          feedback: body.feedback,
          tasks: body.tasks,
          execution_mode: body.execution_mode,
        }),
      );
      if (ok) return c.json({ ok });
    }

    // Resume path — runner is gone. Find the pending submit_tasks tool_use
    // in the message history and inject its tool_result.
    const pending = findPendingInteraction(id);
    if (!pending || pending.name !== 'submit_tasks') {
      return c.json({ error: 'no pending tasks' }, 404);
    }
    sessionStore.resolveTasks(id, {
      approved,
      tasks: body.tasks,
      execution_mode: body.execution_mode ?? null,
    });
    const newState = sessionStore.getTasksState(id);
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
    sessionStore.appendMessage(id, toolMsg);
    return c.json({ ok: true, resumed: true });
  });

  // Set/clear fallback provider+model for a session
  app.patch('/api/coder/sessions/:id/fallback', async (c) => {
    const id = parseIdParam(c);
    const session = sessionStore.getSession(id);
    if (!session) return notFound(c);
    const body = await c.req.json<{ provider: string | null; model: string | null }>();
    sessionStore.setSessionFallback(id, body.provider ?? null, body.model ?? null);
    return c.json({ ok: true, fallback_provider: body.provider, fallback_model: body.model });
  });

  // Get session fallback config
  app.get('/api/coder/sessions/:id/fallback', (c) => {
    const id = parseIdParam(c);
    const session = sessionStore.getSession(id);
    if (!session) return notFound(c);
    const fb = sessionStore.getSessionFallback(id);
    return c.json({ fallback_provider: fb?.provider ?? null, fallback_model: fb?.model ?? null });
  });

  app.post('/api/coder/sessions/:id/switch', async (c) => {
    const id = parseIdParam(c);
    const body = await c.req.json<SwitchProviderBody>();
    if (!body.provider) return c.json({ error: 'provider required' }, 400);
    const session = sessionStore.getSession(id);
    if (!session) return notFound(c);
    const newProvider = await createChatProviderAsync(body.provider, body.model);
    sessionStore.updateSessionProvider(id, body.provider, newProvider.model);
    const entry = activeRuns.get(id);
    entry?.runner?.swapProvider(newProvider);
    return c.json({ ok: true, provider: body.provider, model: newProvider.model });
  });
}
