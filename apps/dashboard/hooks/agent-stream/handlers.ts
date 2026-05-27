import type {
  AgentStatus,
  AgentsGroup,
  PipelineNodeRuntimeStatus,
  PipelineRuntimeState,
  StreamBlock,
  StreamTask,
  StreamTaskMode,
  StreamTaskStatus,
  TodoItem,
  ToolCallEvent,
  ToolLoopIntervention,
  UpdateSession,
  Usage,
} from './types.js';

interface HandlerContext {
  sid: number;
  blocks: StreamBlock[];
  toolIndex: Map<string, number>;
  flush: () => void;
  /** Synchronous flush — used on terminal events where we must commit state
   *  before clearing buffers or resolving `onMessageComplete`. */
  flushNow: () => void;
  updateSession: UpdateSession;
  onMessageComplete?: () => void;
}

export type EventHandler = (data: Record<string, unknown>, eventName: string) => void;

export function createEventHandlers(ctx: HandlerContext): Record<string, EventHandler> {
  const { sid, blocks, toolIndex, flush, flushNow, updateSession, onMessageComplete } = ctx;

  return {
    text: (data) => {
      const t = String((data as { text?: string }).text ?? '');
      if (!t) return;
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'text') {
        last.text += t;
      } else {
        blocks.push({ type: 'text', text: t });
      }
      flush();
    },

    thinking: (data) => {
      const t = String((data as { text?: string }).text ?? '');
      if (!t) return;
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'thinking') {
        last.text += t;
      } else {
        blocks.push({ type: 'thinking', text: t });
      }
      flush();
    },

    // ── deepThink (simulated) — auxiliary cheap model pre-thought ──────
    // Lifecycle: started → (delta*) → completed | failed. The runner emits
    // these BEFORE the main provider.chat() call of each main-model turn.
    // We render a distinct emerald block (vs the purple native thinking)
    // with the aux model name as a badge.
    pre_think_started: (data) => {
      const d = data as { model?: string; provider?: string };
      blocks.push({
        type: 'pre_think',
        text: '',
        model: String(d.model ?? 'auxiliary'),
        provider: String(d.provider ?? '?'),
        status: 'streaming',
      });
      flush();
    },

    pre_think_delta: (data) => {
      const t = String((data as { text?: string }).text ?? '');
      if (!t) return;
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'pre_think') {
        last.text += t;
      } else {
        // Defensive: delta arrived before started (or after another block
        // already closed) — synthesize a stub so the chunk isn't lost.
        blocks.push({
          type: 'pre_think',
          text: t,
          model: 'auxiliary',
          provider: '?',
          status: 'streaming',
        });
      }
      flush();
    },

    pre_think_completed: (data) => {
      const d = data as { text?: string };
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'pre_think') {
        // Trust the final aggregated text — covers any chunk we missed.
        if (typeof d.text === 'string' && d.text.length > 0) last.text = d.text;
        last.status = 'done';
        flush();
      }
    },

    pre_think_failed: (data) => {
      const d = data as { error?: string };
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'pre_think') {
        last.status = 'failed';
        last.error = String(d.error ?? 'unknown error');
        flush();
      } else {
        // Failed before any delta — push an empty failed block so the user
        // sees WHY deepThink degraded (rather than nothing at all).
        blocks.push({
          type: 'pre_think',
          text: '',
          model: 'auxiliary',
          provider: '?',
          status: 'failed',
          error: String(d.error ?? 'unknown error'),
        });
        flush();
      }
    },

    tool_call_start: (data) => {
      const d = data as { id: string; name: string; input?: Record<string, unknown> };
      const call: ToolCallEvent = {
        id: d.id,
        name: d.name,
        input: d.input,
        status: 'running',
        startedAt: Date.now(),
      };
      toolIndex.set(d.id, blocks.length);
      blocks.push({ type: 'tool', call });
      flush();
    },

    tool_call_result: (data) => {
      const d = data as {
        id: string;
        result: { content: string; isError?: boolean };
        duration_ms: number;
      };
      const idx = toolIndex.get(d.id);
      if (idx !== undefined) {
        const block = blocks[idx];
        if (block && block.type === 'tool') {
          block.call = {
            ...block.call,
            result: d.result,
            durationMs: d.duration_ms,
            status: d.result.isError ? 'error' : 'done',
            // Clear progress hints — the result is the new source of truth
            // for elapsed/status; carrying elapsedMs further would confuse
            // the "running Xs" renderer into showing it on a finished tool.
            elapsedMs: undefined,
            progressNote: undefined,
          };
        }
      }
      flush();
    },

    /**
     * Heartbeat (and explicit progress notes) emitted by the runner while a
     * tool is in flight. Updates the matching block's `elapsedMs` and
     * (optionally) `progressNote`, then triggers a flush so the "running Xs"
     * counter ticks live. No-op for unknown ids — safe against late events
     * landing after a `tool_call_result` cleared the block's transient state.
     */
    tool_progress: (data) => {
      const d = data as { id: string; name: string; elapsedMs: number; note?: string };
      const idx = toolIndex.get(d.id);
      if (idx === undefined) return;
      const block = blocks[idx];
      if (!block || block.type !== 'tool') return;
      // Don't reanimate a finished tool — if a heartbeat slips in after
      // the result event, ignore it. `status === 'running'` is the gate.
      if (block.call.status !== 'running') return;
      block.call = {
        ...block.call,
        elapsedMs: d.elapsedMs,
        ...(d.note !== undefined ? { progressNote: d.note } : {}),
      };
      flush();
    },

    plan: (data) => {
      const d = data as { id: string; plan: string; kind?: 'informational' | 'mutating' };
      blocks.push({ type: 'plan', plan: { id: d.id, plan: d.plan, kind: d.kind } });
      flush();
    },

    spec: (data) => {
      const d = data as {
        id: string;
        name: string;
        body: string;
        spec_path: string;
        parent_id?: string;
        drive_path?: string;
      };
      blocks.push({
        type: 'spec',
        spec: {
          id: d.id,
          name: d.name,
          body: d.body,
          spec_path: d.spec_path,
          parent_id: d.parent_id,
          drive_path: d.drive_path,
        },
      });
      flush();
    },

    question: (data) => {
      const d = data as {
        id: string;
        question: string;
        options?: Array<{ label: string; value: string }>;
        allowFreeform?: boolean;
      };
      blocks.push({
        type: 'question',
        question: { id: d.id, question: d.question, options: d.options, allowFreeform: d.allowFreeform },
      });
      flush();
    },

    tasks_posted: (data) => {
      const d = data as { tool_use_id: string; summary: string; tasks: StreamTask[]; version: number };
      blocks.push({
        type: 'tasks',
        tasks: { tool_use_id: d.tool_use_id, summary: d.summary, tasks: d.tasks, version: d.version },
      });
      // Bump the sidebar tick so the SessionStateSidebar refetches state-summary
      // immediately, instead of waiting for the per-turn refresh.
      updateSession(sid, (cur) => ({ sidebarRefreshTick: cur.sidebarRefreshTick + 1 }));
      flush();
    },

    task_started: (data, eventName) => {
      patchTask(blocks, flush, data, eventName);
      updateSession(sid, (cur) => ({ sidebarRefreshTick: cur.sidebarRefreshTick + 1 }));
    },
    task_finished: (data, eventName) => {
      patchTask(blocks, flush, data, eventName);
      updateSession(sid, (cur) => ({ sidebarRefreshTick: cur.sidebarRefreshTick + 1 }));
    },
    task_updated: () => {
      // Surgical patch via update_task tool — sidebar must refetch so the
      // user sees status/files/title changes immediately, not at turn end.
      updateSession(sid, (cur) => ({ sidebarRefreshTick: cur.sidebarRefreshTick + 1 }));
    },

    agents_group_start: (data) => {
      const d = data as {
        groupId: string;
        provider?: string;
        model?: string;
        agents: Array<{ index: number; label: string; provider?: string; model?: string }>;
      };
      const group: AgentsGroup = {
        groupId: d.groupId,
        status: 'running',
        provider: d.provider,
        model: d.model,
        agents: d.agents.map((a) => ({
          index: a.index,
          label: a.label,
          status: 'pending' as AgentStatus,
          toolCallCount: 0,
          provider: a.provider ?? d.provider,
          model: a.model ?? d.model,
        })),
      };
      blocks.push({ type: 'agents', group });
      flush();
    },

    agent_progress: (data) => {
      const d = data as {
        groupId: string;
        agentIndex: number;
        label: string;
        event: 'spawned' | 'tool_call' | 'completed' | 'error';
        provider?: string;
        model?: string;
        toolCallCount?: number;
        usage?: Usage;
        summary?: string;
        error?: string;
      };
      for (const b of blocks) {
        if (b.type !== 'agents' || b.group.groupId !== d.groupId) continue;
        const agent = b.group.agents[d.agentIndex];
        if (!agent) continue;
        if (d.provider) agent.provider = d.provider;
        if (d.model) agent.model = d.model;
        switch (d.event) {
          case 'spawned':
            agent.status = 'running';
            break;
          case 'tool_call':
            agent.toolCallCount = d.toolCallCount ?? agent.toolCallCount + 1;
            break;
          case 'completed':
            agent.status = 'completed';
            agent.usage = d.usage;
            agent.summary = d.summary;
            break;
          case 'error':
            agent.status = 'error';
            agent.error = d.error;
            break;
        }
        break;
      }
      flush();
    },

    agents_group_end: (data) => {
      const d = data as { groupId: string; totalUsage?: Usage };
      for (const b of blocks) {
        if (b.type !== 'agents' || b.group.groupId !== d.groupId) continue;
        b.group.status = 'completed';
        b.group.totalUsage = d.totalUsage;
        break;
      }
      flush();
    },

    auto_continue: (data) => {
      const d = data as { count: number; max: number };
      blocks.push({
        type: 'text',
        text: `\n---\n**Context compacted. Auto-continuing... (${d.count}/${d.max})**\n---\n`,
      });
      flush();
    },

    context_status: (data) => {
      const d = data as {
        history_chars: number;
        turn: number;
        max_turns: number;
        auto_continue_count: number;
        auto_continue_max: number;
        last_turn_input_tokens: number;
        context_window: number | null;
      };
      updateSession(sid, { contextStatus: d });
    },

    index_status: (data) => {
      const d = data as { isIndexed: boolean; mcpAvailable: boolean };
      updateSession(sid, { indexStatus: d });
    },

    /**
     * Bumped whenever the SnapshotRecorder captures a new baseline or
     * appends to an existing one. The Snapshots panel keys its refetch on
     * this counter so the diff list updates as the agent writes files.
     */
    session_snapshot_changed: () => {
      updateSession(sid, (cur) => ({ snapshotTick: cur.snapshotTick + 1 }));
    },

    todos_updated: (data) => {
      const d = data as { todos?: TodoItem[] };
      const todos = Array.isArray(d.todos) ? d.todos : [];
      // Bump the sidebar tick alongside the todos patch so consumers that key
      // off refreshKey (state-summary fetch, banners) update in lockstep with
      // the prop-driven todo render.
      updateSession(sid, (cur) => ({ todos, sidebarRefreshTick: cur.sidebarRefreshTick + 1 }));
    },

    tool_loop_intervention: (data) => {
      // Server-emitted when any of the four loop-detection guards fired.
      // Prepend so the most recent intervention shows first; cap at 5 to
      // avoid an unbounded banner stack on pathological sessions.
      const event = { ...(data as ToolLoopIntervention), receivedAt: Date.now() };
      updateSession(sid, (cur) => ({
        toolLoopInterventions: [event, ...cur.toolLoopInterventions].slice(0, 5),
      }));
    },

    message_complete: (data) => {
      const u = (data as { usage?: Usage }).usage;
      if (u) {
        const last: Usage = {
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        };
        updateSession(sid, (cur) => ({
          lastUsage: last,
          runDelta: {
            input_tokens: cur.runDelta.input_tokens + last.input_tokens,
            output_tokens: cur.runDelta.output_tokens + last.output_tokens,
            cache_read_input_tokens:
              cur.runDelta.cache_read_input_tokens + (last.cache_read_input_tokens ?? 0),
            cache_creation_input_tokens:
              cur.runDelta.cache_creation_input_tokens + (last.cache_creation_input_tokens ?? 0),
          },
        }));
      }
      // Reset live buffer BEFORE notifying the caller. If the refetchSession()
      // triggered by onMessageComplete resolves before React applies the
      // currentTurn clear, sessionData would briefly contain the just-persisted
      // turn while currentTurn still shows the same blocks — causing a visible
      // "duplicated layout" during the stream.
      blocks.length = 0;
      toolIndex.clear();
      // Cancel any pending rAF flush and commit the cleared state synchronously
      // so the UI transition is atomic with onMessageComplete.
      flushNow();
      updateSession(sid, { currentTurn: { blocks: [] } });
      onMessageComplete?.();
    },

    done: (data) => {
      // The server bundles the error message inside the `done` event (see
      // src/api/server.ts coder runner listener), not as a separate `error`
      // event — so the hook has to pull both fields from this payload or the
      // UI stays silent.
      const d = data as { reason?: string; error?: string };
      flushNow();
      updateSession(sid, {
        doneReason: String(d.reason ?? 'completed'),
        ...(d.error ? { error: d.error } : {}),
      });
    },

    error: (data) => {
      flushNow();
      updateSession(sid, { error: String((data as { message?: string }).message ?? 'unknown') });
    },
  };
}

// ─── Chat pipeline events (PR-3) ─────────────────────────────────
// Kept separately exported so the dedicated `usePipelineStream` hook
// can wire them into a long-lived SSE connection without entangling
// chat-turn state.

interface PipelineHandlerContext {
  sid: number;
  updateSession: UpdateSession;
}

export function createPipelineEventHandlers(
  ctx: PipelineHandlerContext,
): Record<string, EventHandler> {
  const { sid, updateSession } = ctx;
  return {
    pipeline_started: (data) => {
      const d = data as { executionId: number; pipelineId: number; startNodeId?: string };
      updateSession(sid, {
        pipelineRuntime: {
          executionId: d.executionId,
          pipelineId: d.pipelineId,
          status: 'running',
          currentNodeId: d.startNodeId ?? null,
          nodes: d.startNodeId ? { [d.startNodeId]: { status: 'pending' } } : {},
          error: null,
        },
      });
    },

    pipeline_node_started: (data) => {
      const d = data as {
        executionId: number;
        nodeId: string;
        nodeLabel?: string;
        kind?: 'agent' | 'validate';
      };
      updateSession(sid, (cur) => {
        const cur_runtime = cur.pipelineRuntime;
        if (!cur_runtime || cur_runtime.executionId !== d.executionId) return {};
        return {
          pipelineRuntime: {
            ...cur_runtime,
            currentNodeId: d.nodeId,
            nodes: {
              ...cur_runtime.nodes,
              [d.nodeId]: {
                ...(cur_runtime.nodes[d.nodeId] ?? {}),
                status: 'running' as PipelineNodeRuntimeStatus,
                label: d.nodeLabel ?? cur_runtime.nodes[d.nodeId]?.label,
                kind: d.kind ?? cur_runtime.nodes[d.nodeId]?.kind,
              },
            },
          } satisfies PipelineRuntimeState,
        };
      });
    },

    pipeline_node_completed: (data) => {
      const d = data as {
        executionId: number;
        nodeId: string;
        outcome?: string | null;
        verdict?: 'pass' | 'fail' | 'review' | null;
        outputPreview?: string;
      };
      updateSession(sid, (cur) => {
        const cur_runtime = cur.pipelineRuntime;
        if (!cur_runtime || cur_runtime.executionId !== d.executionId) return {};
        return {
          pipelineRuntime: {
            ...cur_runtime,
            nodes: {
              ...cur_runtime.nodes,
              [d.nodeId]: {
                ...(cur_runtime.nodes[d.nodeId] ?? {}),
                status: 'completed',
                verdict: d.verdict ?? null,
                outcome: d.outcome ?? null,
                outputPreview: d.outputPreview,
              },
            },
          } satisfies PipelineRuntimeState,
        };
      });
    },

    pipeline_node_failed: (data) => {
      const d = data as { executionId: number; nodeId: string; error?: string };
      updateSession(sid, (cur) => {
        const cur_runtime = cur.pipelineRuntime;
        if (!cur_runtime || cur_runtime.executionId !== d.executionId) return {};
        return {
          pipelineRuntime: {
            ...cur_runtime,
            nodes: {
              ...cur_runtime.nodes,
              [d.nodeId]: {
                ...(cur_runtime.nodes[d.nodeId] ?? {}),
                status: 'failed',
                error: d.error,
              },
            },
          } satisfies PipelineRuntimeState,
        };
      });
    },

    pipeline_paused: (data) => {
      const d = data as { executionId: number; nodeId?: string | null };
      updateSession(sid, (cur) => {
        const cur_runtime = cur.pipelineRuntime;
        if (!cur_runtime || cur_runtime.executionId !== d.executionId) return {};
        return {
          pipelineRuntime: {
            ...cur_runtime,
            status: 'paused',
            currentNodeId: d.nodeId ?? cur_runtime.currentNodeId,
          },
        };
      });
    },

    pipeline_resumed: (data) => {
      const d = data as { executionId: number; nodeId?: string };
      updateSession(sid, (cur) => {
        const cur_runtime = cur.pipelineRuntime;
        if (!cur_runtime || cur_runtime.executionId !== d.executionId) return {};
        return {
          pipelineRuntime: {
            ...cur_runtime,
            status: 'running',
            currentNodeId: d.nodeId ?? cur_runtime.currentNodeId,
          },
        };
      });
    },

    pipeline_completed: (data) => {
      const d = data as { executionId: number };
      updateSession(sid, (cur) => {
        const cur_runtime = cur.pipelineRuntime;
        if (!cur_runtime || cur_runtime.executionId !== d.executionId) return {};
        return {
          pipelineRuntime: {
            ...cur_runtime,
            status: 'completed',
            currentNodeId: null,
          },
        };
      });
    },

    pipeline_aborted: (data) => {
      const d = data as { executionId: number; reason?: string | null };
      updateSession(sid, (cur) => {
        const cur_runtime = cur.pipelineRuntime;
        if (!cur_runtime || cur_runtime.executionId !== d.executionId) return {};
        return {
          pipelineRuntime: {
            ...cur_runtime,
            status: 'aborted',
            currentNodeId: null,
            error: d.reason ?? null,
          },
        };
      });
    },

    pipeline_failed: (data) => {
      const d = data as { executionId: number; error?: string };
      updateSession(sid, (cur) => {
        const cur_runtime = cur.pipelineRuntime;
        if (!cur_runtime || cur_runtime.executionId !== d.executionId) return {};
        return {
          pipelineRuntime: {
            ...cur_runtime,
            status: 'failed',
            currentNodeId: null,
            error: d.error ?? null,
          },
        };
      });
    },
  };
}


function patchTask(
  blocks: StreamBlock[],
  flush: () => void,
  data: Record<string, unknown>,
  eventName: string,
) {
  // Patch the matching task inside any existing tasks block in the current
  // turn. We don't add a new block — task lifecycle events are mutations,
  // not new content.
  const d = data as { task_id: string } & Record<string, unknown>;
  let mutated = false;
  for (const b of blocks) {
    if (b.type !== 'tasks') continue;
    const idx = b.tasks.tasks.findIndex((t) => t.id === d.task_id);
    if (idx < 0) continue;
    const task = b.tasks.tasks[idx];
    if (eventName === 'task_started') {
      b.tasks.tasks[idx] = {
        ...task,
        status: 'running',
        mode_used: (d as { mode?: StreamTaskMode }).mode,
        started_at: (d as { started_at?: string }).started_at,
      };
    } else {
      const fin = d as {
        status: StreamTaskStatus;
        result: StreamTask['result'] | null;
        finished_at: string;
      };
      b.tasks.tasks[idx] = {
        ...task,
        status: fin.status,
        result: fin.result ?? undefined,
        finished_at: fin.finished_at,
      };
    }
    mutated = true;
  }
  if (mutated) flush();
}
