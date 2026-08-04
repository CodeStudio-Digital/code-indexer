import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/index.js';
import type { SessionId } from '@mcp/agent-runtime-contracts';
import type { CoderRunBus } from '../../../coder-bus.js';
import { getCoderWorkerPool } from '../../../sse/coderWorkerPoolSingleton.js';
import { RecentMessageKeys } from '../recent-message-keys.js';

/**
 * Runtime state shared by every coder route file. Exposes the worker pool's
 * in-flight buses through the `activeRuns` compatibility facade and walks the
 * persisted message log when a worker runner is no longer alive.
 *
 */
export interface CoderRuntime {
  activeRuns: Map<SessionId, CoderRunBus>;
  findPendingInteraction(
    sessionId: SessionId,
  ): Promise<{
    toolUseId: string;
    name: 'submit_plan' | 'ask_user' | 'submit_tasks' | 'task_list' | 'submit_spec' | 'submit_specification_to_master' | 'decision_gate';
    /** Original tool_use input — the decision_gate resume path needs the questions. */
    input?: Record<string, unknown>;
  } | null>;
  /** Dangling tool_use lookup by id (any tool name) — POST /tool-approval dead-runner fallback. */
  findDanglingToolUse(
    sessionId: SessionId,
    toolUseId: string,
  ): Promise<{ toolUseId: string; name: string } | null>;
  /**
   * Idempotency store for streaming POSTs (/messages, /continue). A retry that
   * re-sends the same `client_msg_id` is answered by replaying the original
   * run's bus instead of re-running its side effects. See `recent-message-keys.ts`.
   */
  recentMessageKeys: RecentMessageKeys;
}

export function createCoderRuntime(sessionStore: FsSessionStore): CoderRuntime {
  const recentMessageKeys = new RecentMessageKeys();

  // Compatibility Map facade for route consumers. Its state is exclusively
  // owned by CoderWorkerPool: production code cannot install a local runner or
  // bus and therefore cannot reintroduce in-process execution accidentally.
  const workerRuns = new Map<SessionId, CoderRunBus>();
  const activeRuns: Map<SessionId, CoderRunBus> = new Proxy(workerRuns, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return (id: SessionId): CoderRunBus | undefined => getCoderWorkerPool().getBus(id) ?? undefined;
      }
      if (prop === 'has') {
        return (id: SessionId): boolean => getCoderWorkerPool().has(id);
      }
      if (prop === 'set') {
        return (): never => {
          throw new Error('CoderRuntime is worker-only; local active runs are not supported.');
        };
      }
      if (prop === 'delete') {
        return (id: SessionId): boolean => {
          const had = getCoderWorkerPool().has(id);
          void getCoderWorkerPool().evict(id);
          return had;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  /**
   * Walk the persisted history to detect a pending interactive tool call —
   * a submit_plan/ask_user/submit_tasks tool_use whose id has no matching
   * tool_result. Used by the resume path of /answer, /plan-response and
   * /tasks-response so the dashboard can answer the prompt even after a
   * server restart, page refresh or tab close (when `activeRuns` no longer
   * holds the live runner).
   */
  async function findPendingInteraction(
    sessionId: SessionId,
  ): Promise<{
    toolUseId: string;
    name: 'submit_plan' | 'ask_user' | 'submit_tasks' | 'task_list' | 'submit_spec' | 'submit_specification_to_master' | 'decision_gate';
    input?: Record<string, unknown>;
  } | null> {
    const data = await sessionStore.loadSessionWithMessages(sessionId);
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
        if (
          b.name !== 'submit_plan'
          && b.name !== 'ask_user'
          && b.name !== 'submit_tasks'
          && b.name !== 'task_list'
          && b.name !== 'submit_spec'
          && b.name !== 'submit_specification_to_master'
          && b.name !== 'decision_gate'
        ) continue;
        if (seenResults.has(b.id)) continue;
        return {
          toolUseId: b.id,
          name: b.name as 'submit_plan' | 'ask_user' | 'submit_tasks' | 'task_list' | 'submit_spec' | 'submit_specification_to_master' | 'decision_gate',
          // decision_gate's resume path needs the original questions (carried
          // in the tool_use input) to map chosen values back to labels.
          input: b.input as Record<string, unknown> | undefined,
        };
      }
    }
    return null;
  }

  /**
   * Locate a specific dangling tool_use (no matching tool_result) by id —
   * the dead-runner fallback of POST /tool-approval. Unlike
   * `findPendingInteraction` it matches ANY tool name: a PermissionGate
   * pause can sit on write_file/run_command/etc. Only finds calls whose
   * turn was already flushed to the bundle journal (compaction/restart edge); an
   * unflushed pause simply 404s and the model re-decides on the next run.
   */
  async function findDanglingToolUse(
    sessionId: SessionId,
    toolUseId: string,
  ): Promise<{ toolUseId: string; name: string } | null> {
    const data = await sessionStore.loadSessionWithMessages(sessionId);
    if (!data) return null;
    for (const m of data.messages) {
      if (m.role === 'tool' || m.role === 'user') {
        for (const b of m.content) {
          if (b.type === 'tool_result' && b.tool_use_id === toolUseId) return null;
        }
      }
    }
    for (let i = data.messages.length - 1; i >= 0; i--) {
      const m = data.messages[i];
      if (m.role !== 'assistant') continue;
      for (const b of m.content) {
        if (b.type === 'tool_use' && b.id === toolUseId) {
          return { toolUseId: b.id, name: b.name };
        }
      }
    }
    return null;
  }

  return {
    activeRuns,
    findPendingInteraction,
    findDanglingToolUse,
    recentMessageKeys,
  };
}
