import type { CoderRunner } from '../../../../../core/coder/core/runner.js';
import type { SessionStore } from '../../../../../core/coder/index.js';
import {
  publish,
  markEnded,
  type CoderRunBus,
} from '../../../coder-bus.js';

/**
 * Runtime state shared by every coder route file. Holds the in-flight
 * `activeRuns` map keyed by session id, along with helpers to wire a
 * `CoderRunner` to its replay bus and to walk the persisted message log
 * when the live runner is no longer in memory.
 */
export interface CoderRuntime {
  activeRuns: Map<number, CoderRunBus>;
  /** How long to keep a bus around after `done`/`error` for late reattach. */
  BUS_LINGER_MS: number;
  wireRunnerToBus(runner: CoderRunner, bus: CoderRunBus): void;
  findPendingInteraction(
    sessionId: number,
  ): { toolUseId: string; name: 'submit_plan' | 'ask_user' | 'submit_tasks' } | null;
}

export function createCoderRuntime(sessionStore: SessionStore): CoderRuntime {
  const activeRuns = new Map<number, CoderRunBus>();
  const BUS_LINGER_MS = 30_000;

  /**
   * Wire a CoderRunner's events onto the bus. Same event shape the SSE
   * handlers were emitting before the refactor — clients parse it the
   * same way.
   */
  function wireRunnerToBus(runner: CoderRunner, bus: CoderRunBus) {
    runner.on('text_delta', (text) => {
      publish(bus, 'text', { text });
    });
    runner.on('tool_call_start', (id, name, input) => {
      publish(bus, 'tool_call_start', { id, name, input });
    });
    runner.on('tool_call_result', (id, name, result, durationMs) => {
      publish(bus, 'tool_call_result', { id, name, result, duration_ms: durationMs });
    });
    runner.on('message_complete', (message, usage) => {
      publish(bus, 'message_complete', { message, usage });
    });
    runner.on('plan_posted', (block) => {
      publish(bus, 'plan', block);
    });
    runner.on('question_posted', (block) => {
      publish(bus, 'question', block);
    });
    runner.on('tasks_posted', (payload) => {
      publish(bus, 'tasks_posted', payload);
    });
    runner.on('task_started', (payload) => {
      publish(bus, 'task_started', payload);
    });
    runner.on('task_finished', (payload) => {
      publish(bus, 'task_finished', payload);
    });
    runner.on('todos_updated', (payload) => {
      publish(bus, 'todos_updated', payload);
    });
    runner.on('provider_swapped', (provider, model) => {
      publish(bus, 'provider_swapped', { provider, model });
    });
    runner.on('agents_group_start', (payload) => {
      publish(bus, 'agents_group_start', payload);
    });
    runner.on('agent_progress', (payload) => {
      publish(bus, 'agent_progress', payload);
    });
    runner.on('agents_group_end', (payload) => {
      publish(bus, 'agents_group_end', payload);
    });
    runner.on('auto_continue', (count, max) => {
      publish(bus, 'auto_continue', { count, max });
    });
    runner.on('context_status', (payload) => {
      publish(bus, 'context_status', payload);
    });
    runner.on('done', (reason, error) => {
      if (error) {
        // Surface provider/runner errors to the server log. The dashboard SSE
        // only shows "— error —" without the message, which made Gemini
        // failures (e.g. empty model id → silent 400) near-impossible to
        // diagnose without CLI reproduction.
        console.error(`[coder] session run failed (${reason}):`, error.message);
        if (error.stack) console.error(error.stack);
      }
      publish(bus, 'done', { reason, error: error?.message });
      markEnded(bus, 'done', { reason, error: error?.message });
    });
  }

  /**
   * Walk the persisted history to detect a pending interactive tool call —
   * a submit_plan/ask_user/submit_tasks tool_use whose id has no matching
   * tool_result. Used by the resume path of /answer, /plan-response and
   * /tasks-response so the dashboard can answer the prompt even after a
   * server restart, page refresh or tab close (when `activeRuns` no longer
   * holds the live runner).
   */
  function findPendingInteraction(
    sessionId: number,
  ): { toolUseId: string; name: 'submit_plan' | 'ask_user' | 'submit_tasks' } | null {
    const data = sessionStore.loadSessionWithMessages(sessionId);
    if (!data) return null;
    const seenResults = new Set<string>();
    for (const m of data.messages) {
      if (m.role === 'tool' || m.role === 'user') {
        for (const b of m.content) {
          if (b.type === 'tool_result') seenResults.add(b.tool_use_id);
        }
      }
    }
    // Walk newest → oldest assistant messages, return the first interactive
    // tool_use missing a tool_result.
    for (let i = data.messages.length - 1; i >= 0; i--) {
      const m = data.messages[i];
      if (m.role !== 'assistant') continue;
      for (const b of m.content) {
        if (b.type !== 'tool_use') continue;
        if (b.name !== 'submit_plan' && b.name !== 'ask_user' && b.name !== 'submit_tasks') continue;
        if (seenResults.has(b.id)) continue;
        return { toolUseId: b.id, name: b.name as 'submit_plan' | 'ask_user' | 'submit_tasks' };
      }
    }
    return null;
  }

  return { activeRuns, BUS_LINGER_MS, wireRunnerToBus, findPendingInteraction };
}
