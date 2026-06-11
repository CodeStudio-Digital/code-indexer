import type {
  AgentStatus,
  AgentsGroup,
  PendingToolApproval,
  PipelineNodeRuntimeStatus,
  PipelineRuntimeState,
  StreamBlock,
  StreamTask,
  StreamTaskMode,
  StreamTaskStatus,
  TaskRunMode,
  TaskRunState,
  TaskRunTask,
  TaskRunTaskStatus,
  TodoItem,
  ToolCallEvent,
  ToolLoopIntervention,
  UpdateSession,
  Usage,
} from './types.js';
import {
  applyAgentProgress,
  applyAgentsGroupEnd,
  type AgentProgressPayload,
} from './agents-blocks.js';
import {
  activityPatchFromOperation,
  activityPatchFromProviderCall,
  activityPatchFromToolProgress,
  clearProviderActivities,
  finishActivity,
  removeActivity,
  upsertActivity,
  type OperationPayload,
  type ProviderCallPayload,
} from './activity-blocks.js';

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
      if (clearProviderActivities(blocks)) rebuildToolIndex(blocks, toolIndex);
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
      if (clearProviderActivities(blocks)) rebuildToolIndex(blocks, toolIndex);
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
      if (clearProviderActivities(blocks) || removeActivity(blocks, `tool:${d.id}`)) {
        rebuildToolIndex(blocks, toolIndex);
      }
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
      // Tell the in-project preview pane the agent owns a dedicated CDP window
      // now → it swaps to a placeholder + pauses its iframe (frees the process),
      // mirroring the user pop-out. Cleared on preview_close / run end.
      if (d.name === 'preview_open') dispatchAgentPreview(sid, true);
      else if (d.name === 'preview_close') dispatchAgentPreview(sid, false);
    },

    tool_call_result: (data) => {
      const d = data as {
        id: string;
        result: { content: string; isError?: boolean; image?: { mediaType: string; base64: string } };
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
            // The result seals the block — any stale approval card dies here.
            approvals: undefined,
          };
        }
      }
      if (removeActivity(blocks, `tool:${d.id}`)) rebuildToolIndex(blocks, toolIndex);
      flush();
    },

    /**
     * PermissionGate paused a tool call awaiting the user's verdict. Anchor
     * the approval card to the chat-visible block: the call's own block, or
     * — for nested requests (code_exec scripts, subagent runs) — the parent
     * wrapper block. Always mirrored into `pendingApprovals` so the banner
     * above the message list can act even when the block scrolled away.
     */
    tool_approval_request: (data) => {
      const d = data as {
        toolUseId: string;
        parentToolUseId?: string;
        toolName: string;
        argsSummary?: string;
        riskClass?: 'write' | 'execute' | 'admin';
        nested?: boolean;
      };
      if (!d.toolUseId) return;
      const approval: PendingToolApproval = {
        toolUseId: d.toolUseId,
        parentToolUseId: d.parentToolUseId,
        toolName: String(d.toolName ?? ''),
        argsSummary: String(d.argsSummary ?? ''),
        riskClass: d.riskClass ?? 'write',
        nested: !!d.nested,
        receivedAt: Date.now(),
      };
      const anchor = d.parentToolUseId ?? d.toolUseId;
      const idx = toolIndex.get(anchor);
      if (idx !== undefined) {
        const block = blocks[idx];
        if (block && block.type === 'tool' && (block.call.status === 'running' || block.call.status === 'awaiting_approval')) {
          block.call = {
            ...block.call,
            status: 'awaiting_approval',
            approvals: [...(block.call.approvals ?? []), approval],
          };
        }
      }
      updateSession(sid, (s) => ({
        pendingApprovals: [...s.pendingApprovals.filter((a) => a.toolUseId !== d.toolUseId), approval],
      }));
      flush();
    },

    /** A pending approval was resolved (user / interrupt / abort). */
    tool_approval_resolved: (data) => {
      const d = data as { toolUseId: string };
      if (!d.toolUseId) return;
      // The resolved payload has no anchor hint — scan newest-first for the
      // block holding this approval (cheap: blocks is one turn's worth).
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block.type !== 'tool' || !block.call.approvals?.length) continue;
        if (!block.call.approvals.some((a) => a.toolUseId === d.toolUseId)) continue;
        const remaining = block.call.approvals.filter((a) => a.toolUseId !== d.toolUseId);
        block.call = {
          ...block.call,
          approvals: remaining.length > 0 ? remaining : undefined,
          // Approved → back to running while the tool executes; denied →
          // the synthesized error result lands right after and seals it.
          status: remaining.length === 0 && block.call.status === 'awaiting_approval'
            ? 'running'
            : block.call.status,
        };
        break;
      }
      updateSession(sid, (s) => ({
        pendingApprovals: s.pendingApprovals.filter((a) => a.toolUseId !== d.toolUseId),
      }));
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
      if (idx === undefined) {
        if (isSubagentToolProgress(d)) return;
        upsertActivity(blocks, activityPatchFromToolProgress(d));
        flush();
        return;
      }
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

    provider_call: (data) => {
      upsertActivity(blocks, activityPatchFromProviderCall(data as ProviderCallPayload));
      flush();
    },

    operation_started: (data) => {
      const d = data as OperationPayload;
      if (isCoveredToolOperation(d, toolIndex)) return;
      upsertActivity(blocks, activityPatchFromOperation(d));
      flush();
    },

    operation_progress: (data) => {
      const d = data as OperationPayload;
      if (isCoveredToolOperation(d, toolIndex)) return;
      upsertActivity(blocks, activityPatchFromOperation(d));
      flush();
    },

    operation_finished: (data) => {
      const d = data as OperationPayload;
      if (isCoveredToolOperation(d, toolIndex)) return;
      if (finishActivity(blocks, activityPatchFromOperation(d))) flush();
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

    task_run_started: (data) => {
      const d = data as {
        run_id: string;
        mode: TaskRunMode;
        total_tasks: number;
        waves: Array<{
          index: number;
          tasks: Array<{
            id: string;
            title: string;
            kind: TaskRunTask['kind'];
            mode: StreamTaskMode;
          }>;
        }>;
      };
      removeLiveExecuteTasksToolBlock(blocks, toolIndex);
      const tasks: TaskRunTask[] = [];
      const waves = d.waves.map((wave) => {
        const taskIds: string[] = [];
        for (const task of wave.tasks) {
          taskIds.push(task.id);
          tasks.push({
            id: task.id,
            title: task.title,
            kind: task.kind,
            wave: wave.index,
            mode: task.mode,
            status: 'pending',
            toolCallCount: 0,
          });
        }
        return { index: wave.index, taskIds };
      });
      blocks.push({
        type: 'task_run',
        run: {
          runId: d.run_id,
          mode: d.mode,
          status: 'running',
          totalTasks: d.total_tasks,
          waves,
          tasks,
          startedAt: new Date().toISOString(),
        },
      });
      flush();
    },

    task_run_task_started: (data) => {
      const d = data as {
        run_id: string;
        task_id: string;
        title: string;
        kind: TaskRunTask['kind'];
        wave: number;
        mode: StreamTaskMode;
        started_at: string;
      };
      patchTaskRun(blocks, d.run_id, d.task_id, (task) => ({
        ...task,
        title: d.title,
        kind: d.kind,
        wave: d.wave,
        mode: d.mode,
        status: 'running',
        startedAt: d.started_at,
      }));
      updateSession(sid, (cur) => ({ sidebarRefreshTick: cur.sidebarRefreshTick + 1 }));
      flush();
    },

    task_run_task_progress: (data) => {
      const d = data as {
        run_id: string;
        task_id: string;
        tool_call_count: number;
        note?: string;
        phase?: string;
        last_tool_name?: string;
        turn?: number;
        limit?: TaskRunTask['limit'];
        elapsed_ms?: number;
        stall_ms?: number;
      };
      patchTaskRun(blocks, d.run_id, d.task_id, (task) => ({
        ...task,
        toolCallCount: d.tool_call_count,
        ...(d.note ? { progressNote: d.note } : {}),
        ...(d.phase ? { phase: d.phase } : {}),
        ...(d.last_tool_name ? { lastToolName: d.last_tool_name } : {}),
        ...(d.turn != null ? { turn: d.turn } : {}),
        ...(d.limit ? { limit: d.limit } : {}),
        ...(d.elapsed_ms != null ? { elapsedMs: d.elapsed_ms } : {}),
        ...(d.stall_ms != null ? { stallMs: d.stall_ms } : {}),
      }));
      flush();
    },

    task_run_task_finished: (data) => {
      const d = data as {
        run_id: string;
        task_id: string;
        status: TaskRunTaskStatus;
        summary: string;
        error?: string;
        usage?: Usage;
        tool_call_count?: number;
        finished_at: string;
      };
      patchTaskRun(blocks, d.run_id, d.task_id, (task) => ({
        ...task,
        status: d.status,
        summary: d.summary,
        ...(d.error ? { error: d.error } : {}),
        ...(d.usage ? { usage: d.usage } : {}),
        ...(d.tool_call_count != null ? { toolCallCount: d.tool_call_count } : {}),
        finishedAt: d.finished_at,
      }));
      updateSession(sid, (cur) => ({ sidebarRefreshTick: cur.sidebarRefreshTick + 1 }));
      flush();
    },

    task_run_finished: (data) => {
      const d = data as {
        run_id: string;
        status: 'completed' | 'failed' | 'aborted';
        total_usage?: Usage;
        finished_at: string;
      };
      const run = findTaskRun(blocks, d.run_id);
      if (run) {
        run.status = d.status;
        run.totalUsage = d.total_usage;
        run.finishedAt = d.finished_at;
      }
      flush();
    },

    agents_group_start: (data) => {
      const d = data as {
        groupId: string;
        provider?: string;
        model?: string;
        agents: Array<{ index: number; label: string; provider?: string; model?: string; task?: string }>;
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
          task: a.task,
        })),
      };
      blocks.push({ type: 'agents', group });
      flush();
    },

    agent_progress: (data) => {
      if (applyAgentProgress(blocks, data as AgentProgressPayload)) flush();
    },

    agents_group_end: (data) => {
      const d = data as { groupId: string; totalUsage?: Usage };
      if (applyAgentsGroupEnd(blocks, d)) flush();
    },

    auto_continue: (data) => {
      const d = data as { count: number; max: number };
      blocks.push({
        type: 'text',
        text: `\n---\n**Auto-continuando — orçamento de turnos estendido (${d.count}/${d.max})**\n---\n`,
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

    /**
     * Mid-run agent transition (plan→build after submit_plan approval,
     * spec→build after submit_spec, manual switches via dashboard).
     * AgentChat.tsx subscribes to the DOM CustomEvent and updates its
     * picker state without a manual `/sessions/:id` refetch.
     *
     * Bridged through a DOM event because `agent` is held as local
     * useState in AgentChat rather than in this stream store — avoids
     * a broader refactor while still closing the loop.
     */
    session_agent_changed: (data) => {
      const d = data as { agent?: string };
      if (typeof window === 'undefined' || !d.agent) return;
      try {
        window.dispatchEvent(
          new CustomEvent('coder:session_agent_changed', {
            detail: { sessionId: sid, agent: d.agent },
          }),
        );
      } catch {
        /* defensive — never let an event bridge crash the stream */
      }
    },

    session_drive_changed: (data) => {
      // Agent wrote to the Session Drive (a `remember` note or an
      // auto-captured investigation). Bridge to a DOM event so the Drive
      // panel refetches live instead of polling.
      if (typeof window === 'undefined') return;
      const d = data as { kind?: string };
      try {
        window.dispatchEvent(
          new CustomEvent('coder:drive_changed', {
            detail: { sessionId: sid, kind: d.kind },
          }),
        );
      } catch {
        /* defensive */
      }
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
      // Run ended → the pool closes the agent's preview window, so restore the
      // in-project iframe.
      dispatchAgentPreview(sid, false);
      updateSession(sid, {
        doneReason: String(d.reason ?? 'completed'),
        ...(d.error ? { error: d.error } : {}),
        // No run → no resolvable approvals (abort/interrupt denied them).
        pendingApprovals: [],
      });
    },

    error: (data) => {
      const message = String((data as { message?: string }).message ?? 'unknown');
      markInFlightBlocksFailed(blocks, message);
      flushNow();
      dispatchAgentPreview(sid, false);
      updateSession(sid, { error: message });
    },
  };
}

/**
 * Notify the in-project preview pane that the agent's dedicated CDP preview
 * window opened/closed for this session. The pane (ProjectPreview) listens and
 * swaps to a placeholder while open. Window-level CustomEvent — same bridge
 * pattern as `coder:session_agent_changed`. Defensive: never crash the stream.
 */
function dispatchAgentPreview(sessionId: number, open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('coder:agent_preview', { detail: { sessionId, open } }));
  } catch {
    /* defensive */
  }
}

function isSubagentToolProgress(d: { id: string; name: string; note?: string }): boolean {
  return (
    d.name.startsWith('subagent:') ||
    d.id.startsWith('subagent-') ||
    d.note?.startsWith('[subagent]') === true
  );
}

function isCoveredToolOperation(d: OperationPayload, toolIndex: Map<string, number>): boolean {
  if (d.kind !== 'tool' || typeof d.opId !== 'string') return false;
  const toolUseId = d.opId.startsWith('tool:') ? d.opId.slice('tool:'.length) : d.opId;
  return toolIndex.has(toolUseId);
}

function rebuildToolIndex(blocks: StreamBlock[], toolIndex: Map<string, number>): void {
  toolIndex.clear();
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === 'tool') toolIndex.set(block.call.id, i);
  }
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


function removeLiveExecuteTasksToolBlock(
  blocks: StreamBlock[],
  toolIndex: Map<string, number>,
): void {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.type !== 'tool') continue;
    if (block.call.name !== 'execute_tasks') continue;
    if (block.call.status !== 'running') continue;
    toolIndex.delete(block.call.id);
    blocks.splice(i, 1);
  }
  toolIndex.clear();
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === 'tool') toolIndex.set(block.call.id, i);
  }
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

function findTaskRun(blocks: StreamBlock[], runId: string): TaskRunState | null {
  for (const block of blocks) {
    if (block.type === 'task_run' && block.run.runId === runId) return block.run;
  }
  return null;
}

function patchTaskRun(
  blocks: StreamBlock[],
  runId: string,
  taskId: string,
  patch: (task: TaskRunTask) => TaskRunTask,
): void {
  const run = findTaskRun(blocks, runId);
  if (!run) return;
  const idx = run.tasks.findIndex((task) => task.id === taskId);
  if (idx < 0) return;
  run.tasks[idx] = patch(run.tasks[idx]);
}

function markInFlightBlocksFailed(blocks: StreamBlock[], message: string): void {
  const finishedAt = new Date().toISOString();
  for (const block of blocks) {
    if (block.type === 'tool' && block.call.status === 'running') {
      block.call = {
        ...block.call,
        status: 'error',
        result: { content: message, isError: true },
        durationMs: block.call.startedAt ? Date.now() - block.call.startedAt : block.call.durationMs,
        elapsedMs: undefined,
        progressNote: undefined,
      };
      continue;
    }
    if (block.type !== 'task_run' || block.run.status !== 'running') continue;
    block.run.status = 'failed';
    block.run.finishedAt = finishedAt;
    for (let i = 0; i < block.run.tasks.length; i++) {
      const task = block.run.tasks[i];
      if (
        task.status === 'done' ||
        task.status === 'failed' ||
        task.status === 'skipped' ||
        task.status === 'interrupted'
      ) continue;
      block.run.tasks[i] = {
        ...task,
        status: task.status === 'pending' ? 'skipped' : 'interrupted',
        finishedAt,
        error: task.status === 'pending' ? undefined : message,
      };
    }
  }
}
