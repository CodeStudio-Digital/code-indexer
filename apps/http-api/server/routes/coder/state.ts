import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import type { SessionStore } from '@mcp/code-agent/index.js';
import type { CoderRunBus } from '../../../coder-bus.js';
import { wireRunnerEventsToBus } from '../../../sse/runnerWiring.js';
import {
  coderWorkerEnabled,
  getCoderWorkerPool,
} from '../../../sse/coderWorkerPoolSingleton.js';
import { CoderPipelineRegistry } from './pipelines-state.js';

/**
 * Runtime state shared by every coder route file. Holds the in-flight
 * `activeRuns` map keyed by session id, along with helpers to wire a
 * `CoderRunner` to its replay bus and to walk the persisted message log
 * when the live runner is no longer in memory.
 *
 * `coderPipelineRegistry` holds chat-pipeline executors that outlive a
 * single chat turn. See `pipelines-state.ts`.
 */
export interface CoderRuntime {
  activeRuns: Map<number, CoderRunBus>;
  /** How long to keep a bus around after `done`/`error` for late reattach. */
  BUS_LINGER_MS: number;
  wireRunnerToBus(runner: CoderRunner, bus: CoderRunBus): void;
  findPendingInteraction(
    sessionId: number,
  ): { toolUseId: string; name: 'submit_plan' | 'ask_user' | 'submit_tasks' | 'submit_spec' | 'submit_specification_to_master' } | null;
  /** Dangling tool_use lookup by id (any tool name) — POST /tool-approval dead-runner fallback. */
  findDanglingToolUse(
    sessionId: number,
    toolUseId: string,
  ): { toolUseId: string; name: string } | null;
  coderPipelineRegistry: CoderPipelineRegistry;
}

export function createCoderRuntime(sessionStore: SessionStore): CoderRuntime {
  const localRuns = new Map<number, CoderRunBus>();
  const BUS_LINGER_MS = 30_000;
  const coderPipelineRegistry = new CoderPipelineRegistry();

  // `activeRuns` is presented to consumers as a `Map<number, CoderRunBus>`
  // — but its `.get()` / `.has()` fall through to the worker pool when
  // `MCP_CODER_WORKER=1`. This keeps every existing route file
  // (interaction.ts, snapshot.ts, ws upgrade, etc.) working unchanged
  // while the coder path opt-in workers are live. Routes that NEED to
  // route by bus (e.g. ws.ts mirror) still see a single CoderRunBus per
  // session — the worker-mirrored one when the flag is on.
  const activeRuns: Map<number, CoderRunBus> = new Proxy(localRuns, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return (id: number): CoderRunBus | undefined => {
          const local = target.get(id);
          if (local) return local;
          if (coderWorkerEnabled()) {
            const fromPool = getCoderWorkerPool().getBus(id);
            if (fromPool) return fromPool;
          }
          return undefined;
        };
      }
      if (prop === 'has') {
        return (id: number): boolean => {
          if (target.has(id)) return true;
          if (coderWorkerEnabled()) {
            return getCoderWorkerPool().has(id);
          }
          return false;
        };
      }
      // `delete` clears both — the pool's evict is async fire-and-forget.
      if (prop === 'delete') {
        return (id: number): boolean => {
          const had = target.delete(id);
          if (coderWorkerEnabled()) {
            void getCoderWorkerPool().evict(id);
          }
          return had;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  /**
   * Wire a CoderRunner's events onto the bus. Delegates to the shared
   * `wireRunnerEventsToBus` helper so the in-process path and the
   * P17 worker (`coder-worker.ts`) emit identical event shapes.
   */
  function wireRunnerToBus(runner: CoderRunner, bus: CoderRunBus): void {
    wireRunnerEventsToBus(runner, bus);
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
  ): { toolUseId: string; name: 'submit_plan' | 'ask_user' | 'submit_tasks' | 'submit_spec' | 'submit_specification_to_master' } | null {
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
        if (
          b.name !== 'submit_plan'
          && b.name !== 'ask_user'
          && b.name !== 'submit_tasks'
          && b.name !== 'submit_spec'
          && b.name !== 'submit_specification_to_master'
        ) continue;
        if (seenResults.has(b.id)) continue;
        return {
          toolUseId: b.id,
          name: b.name as 'submit_plan' | 'ask_user' | 'submit_tasks' | 'submit_spec' | 'submit_specification_to_master',
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
   * turn was already flushed to the DB (compaction/restart edge); an
   * unflushed pause simply 404s and the model re-decides on the next run.
   */
  function findDanglingToolUse(
    sessionId: number,
    toolUseId: string,
  ): { toolUseId: string; name: string } | null {
    const data = sessionStore.loadSessionWithMessages(sessionId);
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
    BUS_LINGER_MS,
    wireRunnerToBus,
    findPendingInteraction,
    findDanglingToolUse,
    coderPipelineRegistry,
  };
}
