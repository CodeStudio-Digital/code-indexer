import {
  asSessionId,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import {
  FsSessionEntityFiles,
  type FsEntityEnvelope,
} from './entity-files.js';
import type {
  CoderTask,
  FsRecordTasksInput,
  FsTasksRow,
  TaskExecutionMode,
  TasksState,
} from './operational-types.js';

interface TaskBoardData {
  tool_use_id: string;
  state: TasksState;
}

interface TaskEntityData {
  board_id: string;
  task_id: string;
  task: CoderTask;
}

function boardRow(
  sessionId: SessionId,
  item: FsEntityEnvelope<JsonValue>,
): FsTasksRow {
  const data = item.data as unknown as TaskBoardData;
  return {
    id: item.id,
    seq: item.seq,
    revision: item.revision,
    session_id: sessionId,
    tool_use_id: data.tool_use_id,
    state: data.state,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

function mergedTasks(
  incoming: TasksState,
  previous: TasksState | null,
): TasksState {
  if (
    incoming.gate === 'track' ||
    !previous ||
    previous.tasks.length === 0
  ) {
    return incoming;
  }
  const prior = new Map(previous.tasks.map((task) => [task.id, task]));
  const tasks = incoming.tasks.map((task) => {
    const existing = prior.get(task.id);
    return existing
      ? {
          ...task,
          status: existing.status,
          mode_used: existing.mode_used,
          started_at: existing.started_at,
          finished_at: existing.finished_at,
          result: existing.result,
        }
      : task;
  });
  return {
    ...incoming,
    tasks,
    current_task_id:
      previous.current_task_id &&
      tasks.some((task) => task.id === previous.current_task_id)
        ? previous.current_task_id
        : null,
  };
}

export class FsTaskRepository {
  constructor(private readonly entities: FsSessionEntityFiles,
    private readonly nativeState?: (id: string) => Promise<TasksState | null | undefined>) {}

  private async board(
    sessionId: SessionId | string,
  ): Promise<FsEntityEnvelope<JsonValue> | null> {
    return (
      (await this.entities.list<JsonValue>(
        sessionId,
        'tasks',
        'task_board',
      )).at(-1) ?? null
    );
  }

  private async mirrorTasks(
    sessionId: SessionId | string,
    boardId: string,
    state: TasksState,
    operationPrefix: string,
  ): Promise<void> {
    const records = (await this.entities.list<JsonValue>(
      sessionId,
      'tasks',
      'task',
    )).filter(
      (item) =>
        (item.data as unknown as TaskEntityData).board_id === boardId,
    );
    const existing = new Map(
      records.map((item) => [
        (item.data as unknown as TaskEntityData).task_id,
        item,
      ]),
    );
    for (const task of state.tasks) {
      const found = existing.get(task.id);
      if (found) {
        await this.entities.update<TaskEntityData>(
          sessionId,
          'tasks',
          found.id,
          (current) => ({ ...current, task }),
          {
            operation_id: `${operationPrefix}:task:${task.id}`,
            operation_key: {
              action: 'mirror_task',
              board_id: boardId,
              task,
            },
          },
        );
        existing.delete(task.id);
      } else {
        await this.entities.create(sessionId, 'tasks', {
          kind: 'task',
          data: { board_id: boardId, task_id: task.id, task },
          operation_id: `${operationPrefix}:task:${task.id}`,
          operation_key: {
            action: 'mirror_task',
            board_id: boardId,
            task,
          },
        });
      }
    }
    for (const removed of existing.values()) {
      await this.entities.update(
        sessionId,
        'tasks',
        removed.id,
        (data) => data,
        {
          delete: true,
          operation_id: `${operationPrefix}:remove:${removed.id}`,
          operation_key: {
            action: 'remove_mirrored_task',
            task_entity_id: removed.id,
          },
        },
      );
    }
  }

  async record(input: FsRecordTasksInput): Promise<FsTasksRow> {
    const currentBoard = await this.board(input.session_id);
    const previous = currentBoard
      ? (currentBoard.data as unknown as TaskBoardData).state
      : null;
    const state = mergedTasks(input.state, previous);
    const operation =
      input.operation_id ?? `task-board:${input.tool_use_id}`;
    const operationKey = {
      action: 'record_tasks',
      tool_use_id: input.tool_use_id,
      state: input.state,
    };
    const replayed = currentBoard?.operation_history.some(
      (item) => item.operation_id === operation,
    ) === true;
    const written = currentBoard
      ? await this.entities.update<TaskBoardData>(
          input.session_id,
          'tasks',
          currentBoard.id,
          () => ({ tool_use_id: input.tool_use_id, state }),
          {
            operation_id: operation,
            operation_key: operationKey,
          },
        )
      : await this.entities.create(input.session_id, 'tasks', {
          kind: 'task_board',
          data: { tool_use_id: input.tool_use_id, state },
          operation_id: operation,
          operation_key: operationKey,
        });
    if (!replayed) {
      await this.mirrorTasks(
        input.session_id,
        written!.id,
        state,
        operation,
      );
    }
    return boardRow(input.session_id, written!);
  }

  async getState(
    sessionId: SessionId | string,
  ): Promise<TasksState | null> {
    const native = await this.nativeState?.(String(sessionId));
    if (native !== undefined) return native;
    const current = await this.board(sessionId);
    return current
      ? (current.data as unknown as TaskBoardData).state
      : null;
  }

  async getRow(
    sessionId: SessionId | string,
  ): Promise<FsTasksRow | null> {
    const current = await this.board(sessionId);
    return current
      ? boardRow(asSessionId(String(sessionId)), current)
      : null;
  }

  private async replaceState(
    sessionId: SessionId | string,
    state: TasksState,
    operationId: string,
    operationKey: unknown,
  ): Promise<TasksState | null> {
    const board = await this.board(sessionId);
    if (!board) return null;
    const replayed = board.operation_history.some(
      (item) => item.operation_id === operationId,
    );
    const updated = await this.entities.update<TaskBoardData>(
      sessionId,
      'tasks',
      board.id,
      (current) => ({ ...current, state }),
      {
        operation_id: operationId,
        operation_key: operationKey,
      },
    );
    if (!replayed) {
      await this.mirrorTasks(sessionId, board.id, state, operationId);
    }
    return (updated!.data as unknown as TaskBoardData).state;
  }

  async resolve(
    sessionId: SessionId | string,
    verdict: {
      approved: boolean;
      tasks?: CoderTask[];
      execution_mode?: TaskExecutionMode | null;
    },
    operationId = `task-verdict:${Date.now()}`,
  ): Promise<TasksState | null> {
    const current = await this.getState(sessionId);
    return current
      ? this.replaceState(
          sessionId,
          {
            ...current,
            tasks: verdict.tasks ?? current.tasks,
            execution_mode:
              verdict.execution_mode ?? current.execution_mode,
            approved: verdict.approved,
          },
          operationId,
          { action: 'resolve_tasks', verdict },
        )
      : null;
  }

  async updateStatus(
    sessionId: SessionId | string,
    taskId: string,
    patch: Partial<CoderTask>,
    operationId = `task-status:${taskId}:${Date.now()}`,
  ): Promise<TasksState | null> {
    const current = await this.getState(sessionId);
    if (!current) return null;
    const index = current.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return null;
    const task = { ...current.tasks[index], ...patch };
    const terminal = ['done', 'failed', 'skipped'].includes(
      patch.status ?? '',
    );
    return this.replaceState(
      sessionId,
      {
        ...current,
        tasks: current.tasks.map((item, itemIndex) =>
          itemIndex === index ? task : item,
        ),
        current_task_id:
          patch.status === 'running'
            ? taskId
            : terminal && current.current_task_id === taskId
              ? null
              : current.current_task_id,
      },
      operationId,
      { action: 'update_task_status', task_id: taskId, patch },
    );
  }

  async clear(
    sessionId: SessionId | string,
    operationId = `task-clear:${Date.now()}`,
  ): Promise<boolean> {
    const board = await this.board(sessionId);
    if (!board) return false;
    await this.entities.update(
      sessionId,
      'tasks',
      board.id,
      (data) => data,
      {
        delete: true,
        operation_id: operationId,
        operation_key: { action: 'clear_tasks_state' },
      },
    );
    const tasks = (await this.entities.list<JsonValue>(
      sessionId,
      'tasks',
      'task',
    )).filter(
      (item) =>
        (item.data as unknown as TaskEntityData).board_id === board.id,
    );
    for (const task of tasks) {
      await this.entities.update(
        sessionId,
        'tasks',
        task.id,
        (data) => data,
        {
          delete: true,
          operation_id: `${operationId}:${task.id}`,
          operation_key: {
            action: 'clear_task',
            task_entity_id: task.id,
          },
        },
      );
    }
    return true;
  }

  async recoverStale(
    sessionId: SessionId | string,
  ): Promise<number> {
    const state = await this.getState(sessionId);
    if (!state || (state.gate ?? 'approve') === 'track') return 0;
    let recovered = 0;
    const now = new Date().toISOString();
    const tasks = state.tasks.map((task) => {
      if (task.status !== 'running') return task;
      recovered += 1;
      return {
        ...task,
        status: 'interrupted' as const,
        finished_at: now,
      };
    });
    if (recovered === 0) return 0;
    await this.replaceState(
      sessionId,
      { ...state, tasks, current_task_id: null },
      `task-recovery:${now}`,
      { action: 'recover_stale_tasks', recovered_at: now },
    );
    return recovered;
  }

}
