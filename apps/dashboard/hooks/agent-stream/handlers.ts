import type {
  AgentStatus,
  AgentsGroup,
  PendingToolApproval,
  PipelineNodeRuntimeStatus,
  PipelineRuntimeState,
  ResearchDepth,
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
  UpdateSession,
  Usage,
} from './types.js';
import {
  applyAgentProgress,
  applyAgentsGroupEnd,
  type AgentProgressPayload,
} from './agents-blocks.js';
import {
  AGENT_WRAPPER_TOOLS,
  removeActiveProcesses,
  replaceActiveProcesses,
  retainBackgroundProcesses,
  upsertActiveProcess,
  type ActiveProcessPatch,
} from './active-processes.js';
import {
  activityPatchFromOperation,
  activityPatchFromProviderCall,
  activityPatchFromToolProgress,
  clearProviderActivities,
  finishActivity,
  removeActivity,
  upsertActivity,
  type ActivityPatch,
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
  const providerProcessIds = new Set<string>();
  const upsertProcess = (patch: ActiveProcessPatch) => {
    updateSession(sid, (state) => ({
      activeProcesses: upsertActiveProcess(state.activeProcesses, patch),
    }));
  };
  const patchProcess = (
    id: string,
    patch: Partial<Pick<ActiveProcessPatch, 'status' | 'phase' | 'note' | 'elapsedMs'>>,
  ) => {
    updateSession(sid, (state) => ({
      activeProcesses: state.activeProcesses.map((process) => process.id === id
        ? { ...process, ...patch, updatedAt: Date.now() }
        : process),
    }));
  };
  const removeProcesses = (predicate: Parameters<typeof removeActiveProcesses>[1]) => {
    updateSession(sid, (state) => ({
      activeProcesses: removeActiveProcesses(state.activeProcesses, predicate),
    }));
  };
  const removeProcess = (id: string) => removeProcesses((process) => process.id === id);
  const clearProviderProcesses = () => {
    if (providerProcessIds.size === 0) return;
    const ids = new Set(providerProcessIds);
    providerProcessIds.clear();
    removeProcesses((process) => ids.has(process.id));
  };

  return {
    text: (data) => {
      const t = String((data as { text?: string }).text ?? '');
      if (!t) return;
      if (clearProviderActivities(blocks)) rebuildToolIndex(blocks, toolIndex);
      clearProviderProcesses();
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
      clearProviderProcesses();
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'thinking') {
        last.text += t;
      } else {
        blocks.push({ type: 'thinking', text: t });
      }
      flush();
    },

    tool_call_start: (data) => {
      const d = data as { id: string; name: string; input?: Record<string, unknown> };
      if (clearProviderActivities(blocks) || removeActivity(blocks, `tool:${d.id}`)) {
        rebuildToolIndex(blocks, toolIndex);
      }
      clearProviderProcesses();
      const call: ToolCallEvent = {
        id: d.id,
        name: d.name,
        input: d.input,
        status: 'running',
        startedAt: Date.now(),
      };
      toolIndex.set(d.id, blocks.length);
      blocks.push({ type: 'tool', call });
      upsertProcess({
        id: `tool:${d.id}`,
        source: 'tool',
        kind: d.name === 'execute_tasks'
          ? 'task'
          : AGENT_WRAPPER_TOOLS.has(d.name) ? 'spawn_agent' : 'tool',
        label: d.name,
        status: 'running',
        startedAt: call.startedAt,
      });
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
      removeProcess(`tool:${d.id}`);
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
        input?: Record<string, unknown>;
        riskClass?: 'write' | 'execute' | 'admin';
        approvalKind?: 'standard' | 'database_write';
        nested?: boolean;
      };
      if (!d.toolUseId) return;
      const approval: PendingToolApproval = {
        toolUseId: d.toolUseId,
        parentToolUseId: d.parentToolUseId,
        toolName: String(d.toolName ?? ''),
        argsSummary: String(d.argsSummary ?? ''),
        input: d.input,
        riskClass: d.riskClass ?? 'write',
        approvalKind: d.approvalKind ?? 'standard',
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
      patchProcess(`tool:${anchor}`, { status: 'waiting', phase: 'awaiting_approval' });
      flush();
    },

    /** A pending approval was resolved (user / interrupt / abort). */
    tool_approval_resolved: (data) => {
      const d = data as { toolUseId: string };
      if (!d.toolUseId) return;
      let resolvedAnchor = d.toolUseId;
      let resolvedStatus: ActiveProcessPatch['status'] = 'running';
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
        resolvedAnchor = block.call.id;
        resolvedStatus = remaining.length > 0 ? 'waiting' : 'running';
        break;
      }
      updateSession(sid, (s) => ({
        pendingApprovals: s.pendingApprovals.filter((a) => a.toolUseId !== d.toolUseId),
      }));
      patchProcess(`tool:${resolvedAnchor}`, {
        status: resolvedStatus,
        phase: resolvedStatus === 'waiting' ? 'awaiting_approval' : 'running',
      });
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
        const activity = activityPatchFromToolProgress(d);
        upsertActivity(blocks, activity);
        upsertProcess(processPatchFromActivity(activity, 'activity'));
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
      patchProcess(`tool:${d.id}`, {
        elapsedMs: d.elapsedMs,
        ...(d.note !== undefined ? { note: d.note } : {}),
      });
      flush();
    },

    provider_call: (data) => {
      const activity = activityPatchFromProviderCall(data as ProviderCallPayload);
      upsertActivity(blocks, activity);
      providerProcessIds.add(activity.id);
      upsertProcess(processPatchFromActivity(activity, 'provider'));
      flush();
    },

    operation_started: (data) => {
      const d = data as OperationPayload;
      if (isCoveredToolOperation(d, toolIndex)) return;
      const activity = activityPatchFromOperation(d);
      upsertActivity(blocks, activity);
      upsertProcess(processPatchFromActivity(activity, 'activity'));
      flush();
    },

    operation_progress: (data) => {
      const d = data as OperationPayload;
      if (isCoveredToolOperation(d, toolIndex)) return;
      const activity = activityPatchFromOperation(d);
      upsertActivity(blocks, activity);
      upsertProcess(processPatchFromActivity(activity, 'activity'));
      flush();
    },

    operation_finished: (data) => {
      const d = data as OperationPayload;
      if (isCoveredToolOperation(d, toolIndex)) return;
      const activity = activityPatchFromOperation(d);
      removeProcess(activity.id);
      if (finishActivity(blocks, activity)) flush();
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
        header?: string;
        options?: Array<{ label: string; value: string }>;
        allowFreeform?: boolean;
      };
      blocks.push({
        type: 'question',
        question: { id: d.id, question: d.question, header: d.header, options: d.options, allowFreeform: d.allowFreeform },
      });
      flush();
    },

    decision: (data) => {
      const d = data as {
        id: string;
        header?: string;
        questions: Array<{
          id: string;
          header?: string;
          question: string;
          multiSelect?: boolean;
          options: Array<{ label: string; value: string; summary?: string; tradeoffs?: string }>;
        }>;
        allowFreeform?: boolean;
      };
      blocks.push({
        type: 'decision',
        decision: { id: d.id, header: d.header, questions: d.questions, allowFreeform: d.allowFreeform },
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
      // immediately, instead of waiting for the per-turn refresh. Also bump the
      // tasks tick so the persisted TaskListReview card refetches the new list
      // (the previous coder_tasks_state row is now stale).
      updateSession(sid, (cur) => ({
        sidebarRefreshTick: cur.sidebarRefreshTick + 1,
        tasksRefreshTick: cur.tasksRefreshTick + 1,
      }));
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
      removeProcesses((process) => process.source === 'tool' && process.label === 'execute_tasks');
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
      const parsedStartedAt = Date.parse(d.started_at);
      upsertProcess({
        id: taskProcessId(d.run_id, d.task_id),
        source: 'task',
        kind: d.mode === 'subagent' ? 'subagent' : 'task',
        label: d.title,
        status: 'running',
        groupId: d.run_id,
        phase: d.kind,
        ...(Number.isFinite(parsedStartedAt) ? { startedAt: parsedStartedAt } : {}),
      });
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
      patchProcess(taskProcessId(d.run_id, d.task_id), {
        ...(d.note ? { note: d.note } : {}),
        ...(d.phase ? { phase: d.phase } : {}),
        ...(d.elapsed_ms != null ? { elapsedMs: d.elapsed_ms } : {}),
      });
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
      removeProcess(taskProcessId(d.run_id, d.task_id));
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
      removeProcesses((process) => process.source === 'task' && process.groupId === d.run_id);
      flush();
    },

    agents_group_start: (data) => {
      const d = data as {
        groupId: string;
        provider?: string;
        model?: string;
        background?: boolean;
        jobId?: string;
        resumed?: boolean;
        agents: Array<{
          index: number;
          label: string;
          provider?: string;
          model?: string;
          task?: string;
          status?: AgentStatus;
          attempt?: number;
          researchDepth?: ResearchDepth;
          softToolTarget?: number;
          softTimeTargetMs?: number;
        }>;
      };
      // Upsert by groupId — a resume (resume_agent) or a cross-run re-emit of a
      // still-running background job MERGES into the existing block (rows flip
      // back to running) instead of pushing a duplicate. `message_complete`
      // clears live blocks, so a later re-emit re-materializes the group here.
      const existing = blocks.findIndex((b) => b.type === 'agents' && b.group.groupId === d.groupId);
      const prior = existing >= 0 && blocks[existing].type === 'agents' ? blocks[existing].group : null;
      const priorByIndex = new Map(prior?.agents.map((a) => [a.index, a]) ?? []);
      const group: AgentsGroup = {
        groupId: d.groupId,
        status: 'running',
        provider: d.provider ?? prior?.provider,
        model: d.model ?? prior?.model,
        background: d.background ?? prior?.background,
        jobId: d.jobId ?? prior?.jobId,
        agents: d.agents.map((a) => {
          // Preserve a previously-completed agent's data (summary/usage/tools)
          // on a resume re-emit — only the payload's fresh status/attempt win,
          // so non-resumed rows don't blank out. New agents start clean.
          const was = priorByIndex.get(a.index);
          return {
            ...was,
            index: a.index,
            label: a.label,
            status: a.status ?? ('pending' as AgentStatus),
            toolCallCount: was?.toolCallCount ?? 0,
            provider: a.provider ?? d.provider ?? was?.provider,
            model: a.model ?? d.model ?? was?.model,
            task: a.task ?? was?.task,
            attempt: a.attempt ?? was?.attempt,
            researchDepth: a.researchDepth ?? was?.researchDepth,
            softToolTarget: a.softToolTarget ?? was?.softToolTarget,
            softTimeTargetMs: a.softTimeTargetMs ?? was?.softTimeTargetMs,
          };
        }),
      };
      if (existing >= 0) blocks[existing] = { type: 'agents', group };
      else blocks.push({ type: 'agents', group });
      const processPatches: ActiveProcessPatch[] = (isTaskWaveGroup(group.groupId) ? [] : group.agents)
        .filter((agent) => agent.status === 'pending' || agent.status === 'running')
        .map((agent) => ({
          id: agentProcessId(group.groupId, agent.index),
          source: 'agent',
          kind: 'subagent',
          label: agent.label,
          status: 'running',
          groupId: group.groupId,
          phase: agent.status === 'pending' ? 'queued' : agent.phase,
          note: agent.progressNote,
          elapsedMs: agent.elapsedMs,
          background: group.background === true,
        }));
      updateSession(sid, (state) => ({
        activeProcesses: replaceActiveProcesses(
          state.activeProcesses,
          (process) => (
            (process.source === 'agent' && process.groupId === group.groupId)
            || (process.source === 'tool' && AGENT_WRAPPER_TOOLS.has(process.label))
          ),
          processPatches,
        ),
      }));
      flush();
    },

    agent_progress: (data) => {
      const d = data as AgentProgressPayload;
      const processId = agentProcessId(d.groupId, d.agentIndex);
      // execute_tasks already owns a user-friendly task process row. Its
      // internal tasks-wave agent group is the same work, not another row.
      if (!isTaskWaveGroup(d.groupId)) {
        if (d.event === 'completed' || d.event === 'partial' || d.event === 'error' || d.event === 'timed_out' || d.event === 'aborted') {
          removeProcess(processId);
        } else {
          upsertProcess({
            id: processId,
            source: 'agent',
            kind: 'subagent',
            label: d.label,
            status: 'running',
            groupId: d.groupId,
            ...(d.phase ? { phase: d.phase } : {}),
            ...(d.note ? { note: d.note } : {}),
            ...(d.elapsedMs != null ? { elapsedMs: d.elapsedMs } : {}),
          });
        }
      }
      if (applyAgentProgress(blocks, d)) flush();
    },

    agents_group_end: (data) => {
      const d = data as { groupId: string; totalUsage?: Usage; jobId?: string; status?: string; agentCount?: number; successCount?: number };
      removeProcesses((process) => process.source === 'agent' && process.groupId === d.groupId);
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
        turn: number;
        prompt_tokens: number;
        source: 'usage' | 'estimate';
        context_window: number;
        ratio: number;
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

    diagram_changed: (data) => {
      // Agent created/updated a .drawio diagram. Bridge to a DOM event so
      // AgentChat auto-opens the Diagram panel and the embedded editor
      // reloads the new XML (the .drawio file is the durable source).
      if (typeof window === 'undefined') return;
      const d = data as { path?: string; xml?: string };
      try {
        window.dispatchEvent(
          new CustomEvent('coder:diagram_changed', {
            detail: { sessionId: sid, path: d.path, xml: d.xml },
          }),
        );
      } catch {
        /* defensive */
      }
    },

    diagram_export_request: (data) => {
      // diagram_export asked the live editor to render + persist an image.
      if (typeof window === 'undefined') return;
      const d = data as { path?: string; format?: string };
      try {
        window.dispatchEvent(
          new CustomEvent('coder:diagram_export', {
            detail: { sessionId: sid, path: d.path, format: d.format },
          }),
        );
      } catch {
        /* defensive */
      }
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
      // Commit the final live buffer before notifying the caller, then clear
      // only the local buffer for the next assistant turn. Keeping currentTurn
      // rendered until the refetch proves it exists in history avoids a blank
      // gap where the final answer disappears at the SSE boundary.
      flushNow();
      blocks.length = 0;
      toolIndex.clear();
      // Bump the tasks tick too: the turn just persisted may have approved the
      // list (or run a task), so the persisted TaskListReview card must refetch
      // the row to pick up `approved`/runtime status instead of waiting for the
      // whole run to end.
      updateSession(sid, (cur) => ({
        tasksRefreshTick: cur.tasksRefreshTick + 1,
        activeProcesses: retainBackgroundProcesses(cur.activeProcesses),
      }));
      providerProcessIds.clear();
      onMessageComplete?.();
    },

    done: (data) => {
      // The server bundles the error message inside the `done` event (see
      // src/api/server.ts coder runner listener), not as a separate `error`
      // event — so the hook has to pull both fields from this payload or the
      // UI stays silent.
      const d = data as { reason?: string; error?: string };
      if (blocks.length > 0) flushNow();
      // Run ended → the pool closes the agent's preview window, so restore the
      // in-project iframe.
      dispatchAgentPreview(sid, false);
      updateSession(sid, {
        doneReason: String(d.reason ?? 'completed'),
        ...(d.error ? { error: d.error } : {}),
        // No run → no resolvable approvals (abort/interrupt denied them).
        pendingApprovals: [],
        activeProcesses: [],
      });
      providerProcessIds.clear();
    },

    error: (data) => {
      const message = String((data as { message?: string }).message ?? 'unknown');
      markInFlightBlocksFailed(blocks, message);
      flushNow();
      dispatchAgentPreview(sid, false);
      updateSession(sid, { error: message, activeProcesses: [] });
      providerProcessIds.clear();
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

function processPatchFromActivity(
  patch: ActivityPatch,
  source: ActiveProcessPatch['source'],
): ActiveProcessPatch {
  return {
    id: patch.id,
    source,
    kind: patch.kind ?? 'operation',
    label: patch.label ?? patch.id,
    status: 'running',
    ...(patch.startedAt != null ? { startedAt: patch.startedAt } : {}),
    ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(patch.elapsedMs !== undefined ? { elapsedMs: patch.elapsedMs } : {}),
    ...(patch.parentOpId !== undefined ? { parentId: patch.parentOpId } : {}),
  };
}

function taskProcessId(runId: string, taskId: string): string {
  return `task:${runId}:${taskId}`;
}

function agentProcessId(groupId: string, index: number): string {
  return `agent:${groupId}:${index}`;
}

function isTaskWaveGroup(groupId: string): boolean {
  return groupId.startsWith('tasks-wave-');
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
