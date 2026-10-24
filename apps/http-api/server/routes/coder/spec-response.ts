import type { Hono } from 'hono';
import type { AgentMessage } from "@mcp/provider-sdk";
import { formatSpecResult } from '@mcp/code-agent/tools/spec/index.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import { parseSessionIdParam } from '../_helpers.js';
import { getCoderWorkerPool } from '../../../sse/coderWorkerPoolSingleton.js';
import { emitWorkerLog } from '../../../coder-bus.js';
import { resolveAgentSelection } from '../../../custom-agents.js';
import { resolveNativeInteraction } from './native-interaction-response.js';

interface SpecResponseBody {
  approved: boolean;
  requested_changes?: string;
  spec_path?: string;
  interaction_id?: string;
}

/**
 * SDD mode counterpart of `/plan-response`. Routes the human verdict on a
 * `submit_spec` (or `submit_specification_to_master`) submission back to the
 * paused runner. Mirrors the worker / persisted-resume sequence used by
 * `/plan-response`.
 *
 * Kept as a sibling route file instead of inflating `interaction.ts`.
 */
export function mountCoderSpecResponseRoute(
  app: Hono,
  deps: ServerDeps,
  runtime: CoderRuntime,
): void {
  const { sessionStore } = deps;
  const { findPendingInteraction } = runtime;
  const workerPool = getCoderWorkerPool();

  app.post('/api/coder/sessions/:id/spec-response', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await c.req.json<SpecResponseBody>();
    if (typeof body.approved !== 'boolean' || (body.requested_changes !== undefined
      && (typeof body.requested_changes !== 'string' || body.requested_changes.length > 64 * 1024))) {
      return c.json({ error: 'Invalid specification response' }, 400);
    }
    const approved = !!body.approved;
    const requested = body.requested_changes;
    const bus = workerPool.getBus(id);
    emitWorkerLog(bus, 'info', 'route', `POST /spec-response`, {
      approved,
      has_feedback: !!requested,
    });

    const payload = JSON.stringify({ approved, requested_changes: requested });
    const native = await resolveNativeInteraction({ pool: workerPool, sessions: sessionStore,
      sessionId: id, interactionId: body.interaction_id, prefix: 'native-tool:', value: payload });
    if (native) return c.json(native.body, native.status);

    try {
      const ok = await workerPool.provideUserInput(id, payload);
      if (ok) return c.json({ ok: true });
    } catch (err) {
      console.warn(
        `[coder] worker provideUserInput failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const pending = await findPendingInteraction(id);
    if (!pending || (pending.name !== 'submit_spec' && pending.name !== 'submit_specification_to_master')) {
      return c.json({ error: 'no pending spec' }, 404);
    }

    const specPath = body.spec_path ?? '.mcp/specs/<unknown>.md';
    const toolMsg: AgentMessage = {
      role: 'tool',
      content: [{
        type: 'tool_result',
        tool_use_id: pending.toolUseId,
        content: formatSpecResult(approved, specPath, requested),
      }],
    };
    await sessionStore.appendMessage({
      session_id: id,
      operation_id: `interaction:spec-response:${pending.toolUseId}`,
      message: toolMsg,
    });

    if (approved) {
      const session = await sessionStore.getSession(id);
      if (resolveAgentSelection(deps.providerStore, session?.agent)?.baseAgentId === 'spec') {
        try {
          await sessionStore.setSessionAgent(id, 'build');
          const reminder: AgentMessage = {
            role: 'user',
            content: [{
              type: 'text',
              text:
                `<system-reminder>Mode transition: Spec → Build. The spec at ${specPath} was approved. ` +
                `Derive tasks from its "## Implementation Plan" via submit_tasks, then execute each per task scope.</system-reminder>`,
            }],
          };
          await sessionStore.appendMessage({
            session_id: id,
            operation_id:
              `interaction:spec-build-reminder:${pending.toolUseId}`,
            message: reminder,
          });
        } catch (e) {
          console.warn(
            `[coder] spec→build transition (offline path) failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    return c.json({ ok: true, resumed_via_worker: true });
  });
}
