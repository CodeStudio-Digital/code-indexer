import type { Hono } from 'hono';
import type { CoderProviderName } from '../../../../../core/coder/index.js';
import type { AgentMessage } from '../../../../../core/coder/core/messages.js';
import { formatPlanResult } from '../../../../../core/coder/tools/plan.js';
import {
  formatTasksApprovedResult,
  formatTasksRejectedResult,
} from '../../../../../core/coder/tools/tasks.js';
import { formatAskUserResult } from '../../../../../core/coder/tools/interaction.js';
import { createChatProviderAsync } from '../../../../../core/providers/factory.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';

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
  tasks?: import('../../../../../core/coder/sessions/types.js').CoderTask[];
  execution_mode?: import('../../../../../core/coder/sessions/types.js').TaskExecutionMode;
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

  app.post('/api/coder/sessions/:id/abort', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const bus = activeRuns.get(id);
    if (!bus) return c.json({ error: 'no active run' }, 404);
    bus.ctrl.abort();
    bus.runner?.abort();
    return c.json({ ok: true });
  });

  app.post('/api/coder/sessions/:id/answer', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req.json<AnswerBody>();
    const answer = body.answer ?? '';
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
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req.json<PlanResponseBody>();
    const approved = !!body.approved;
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
    return c.json({ ok: true, resumed: true });
  });

  /**
   * List persisted plans for a session, newest first. Backed by the
   * coder_plans table (migration 007).
   */
  app.get('/api/coder/sessions/:id/plans', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    return c.json(sessionStore.listPlans(id));
  });

  /** Chronological trace of every todo_write call in a session. */
  app.get('/api/coder/sessions/:id/todo-history', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    return c.json(sessionStore.listTodoHistory(id));
  });

  /**
   * Get the current task list state for a session. Used by the dashboard
   * to render the TaskListReview when (a) the SSE buffer was missed or
   * (b) the user reopens the session tab.
   */
  app.get('/api/coder/sessions/:id/tasks', (c) => {
    const id = parseInt(c.req.param('id'), 10);
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
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req.json<TasksResponseBody>();
    const approved = !!body.approved;

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

  app.post('/api/coder/sessions/:id/switch', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req.json<SwitchProviderBody>();
    if (!body.provider) return c.json({ error: 'provider required' }, 400);
    const session = sessionStore.getSession(id);
    if (!session) return c.json({ error: 'Not found' }, 404);
    const newProvider = await createChatProviderAsync(body.provider, body.model);
    sessionStore.updateSessionProvider(id, body.provider, newProvider.model);
    const entry = activeRuns.get(id);
    entry?.runner?.swapProvider(newProvider);
    return c.json({ ok: true, provider: body.provider, model: newProvider.model });
  });
}
