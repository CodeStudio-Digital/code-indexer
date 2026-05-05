import type {
  AgentStatus,
  AgentsGroup,
  StreamBlock,
  StreamTask,
  StreamTaskMode,
  StreamTaskStatus,
  TodoItem,
  ToolCallEvent,
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

    tool_call_start: (data) => {
      const d = data as { id: string; name: string; input?: Record<string, unknown> };
      const call: ToolCallEvent = { id: d.id, name: d.name, input: d.input, status: 'running' };
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
          };
        }
      }
      flush();
    },

    plan: (data) => {
      const d = data as { id: string; plan: string; kind?: 'informational' | 'mutating' };
      blocks.push({ type: 'plan', plan: { id: d.id, plan: d.plan, kind: d.kind } });
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
      flush();
    },

    task_started: (data, eventName) => patchTask(blocks, flush, data, eventName),
    task_finished: (data, eventName) => patchTask(blocks, flush, data, eventName),

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

    todos_updated: (data) => {
      const d = data as { todos?: TodoItem[] };
      const todos = Array.isArray(d.todos) ? d.todos : [];
      updateSession(sid, { todos });
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
