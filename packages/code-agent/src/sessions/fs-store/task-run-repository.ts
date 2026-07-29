import {
  asSessionId,
  isUuid,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import {
  FsSessionEntityFiles,
  type FsEntityEnvelope,
} from './entity-files.js';
import { FsSessionDirectory } from './session-directory.js';
import type {
  FsCreateTaskRunInput,
  FsTaskRunItemRow,
  FsTaskRunRow,
  FsUpdateTaskRunPatch,
  FsUpsertTaskRunItemInput,
} from './operational-types.js';

interface TaskRunData
  extends Omit<
    FsTaskRunRow,
    'id' | 'seq' | 'revision' | 'created_at' | 'updated_at'
  > {}

interface TaskRunItemData
  extends Omit<FsTaskRunItemRow, 'id' | 'seq' | 'revision'> {
  session_id: SessionId;
}

function taskRunId(value: string): string {
  if (!isUuid(value)) {
    throw new TypeError('task run_id must be a UUID');
  }
  return value.toLowerCase();
}

function runRow(item: FsEntityEnvelope<JsonValue>): FsTaskRunRow {
  const data = item.data as unknown as TaskRunData;
  return {
    id: item.id,
    seq: item.seq,
    revision: item.revision,
    ...data,
    run_id: taskRunId(data.run_id),
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

function runItemRow(
  item: FsEntityEnvelope<JsonValue>,
): FsTaskRunItemRow {
  const data = item.data as unknown as TaskRunItemData;
  return {
    id: item.id,
    seq: item.seq,
    revision: item.revision,
    run_id: taskRunId(data.run_id),
    task_id: data.task_id,
    attempt: data.attempt,
    wave_idx: data.wave_idx,
    parallel_group: data.parallel_group,
    kind: data.kind,
    title: data.title,
    started_at: data.started_at,
    finished_at: data.finished_at,
    status: data.status,
    tool_call_count: data.tool_call_count,
    input_tokens: data.input_tokens,
    output_tokens: data.output_tokens,
    inputs_fingerprint: data.inputs_fingerprint,
    skip_reason: data.skip_reason,
    error: data.error,
    summary: data.summary,
  };
}

export class FsTaskRunRepository {
  constructor(
    private readonly directory: FsSessionDirectory,
    private readonly entities: FsSessionEntityFiles,
  ) {}

  async create(input: FsCreateTaskRunInput): Promise<void> {
    const runId = taskRunId(input.run_id);
    const operationKey = {
      action: 'create_task_run',
      run_id: runId,
      mode: input.mode,
      started_at: input.started_at,
      budget_tokens: input.budget_tokens ?? null,
      budget_usd_cents: input.budget_usd_cents ?? null,
    };
    await this.entities.create(input.session_id, 'tasks', {
      kind: 'task_run',
      data: {
        run_id: runId,
        session_id: input.session_id,
        mode: input.mode,
        started_at: input.started_at,
        finished_at: null,
        status: 'running',
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cache_read_tokens: 0,
        total_cache_creation_tokens: 0,
        budget_tokens: input.budget_tokens ?? null,
        budget_usd_cents: input.budget_usd_cents ?? null,
        reject_reason: null,
      } satisfies TaskRunData,
      operation_id: input.operation_id ?? `task-run:${runId}`,
      operation_key: operationKey,
    });
  }

  private async envelope(
    sessionId: SessionId | string,
    runId: string,
  ): Promise<FsEntityEnvelope<JsonValue> | null> {
    const normalizedRunId = taskRunId(runId);
    return (
      (await this.entities.list<JsonValue>(
        sessionId,
        'tasks',
        'task_run',
      )).find(
        (item) =>
          taskRunId((item.data as unknown as TaskRunData).run_id) ===
          normalizedRunId,
      ) ?? null
    );
  }

  async update(
    sessionId: SessionId | string,
    runId: string,
    patch: FsUpdateTaskRunPatch,
  ): Promise<void> {
    const normalizedRunId = taskRunId(runId);
    const run = await this.envelope(sessionId, normalizedRunId);
    if (!run) throw new Error(`Unknown task run ${normalizedRunId}`);
    const { operation_id: operationId, ...values } = patch;
    await this.entities.update<TaskRunData>(
      sessionId,
      'tasks',
      run.id,
      (current) => ({ ...current, ...values }),
      {
        operation_id: operationId,
        operation_key: {
          action: 'update_task_run',
          run_id: normalizedRunId,
          patch: values,
        },
      },
    );
  }

  async upsertItem(input: FsUpsertTaskRunItemInput): Promise<void> {
    const runId = taskRunId(input.run_id);
    const items = await this.entities.list<JsonValue>(
      input.session_id,
      'tasks',
      'task_run_item',
    );
    const attempt = input.attempt ?? 0;
    const existing = items.find((item) => {
      const data = item.data as unknown as TaskRunItemData;
      return (
        taskRunId(data.run_id) === runId &&
        data.task_id === input.task_id &&
        data.attempt === attempt
      );
    });
    const data: TaskRunItemData = {
      session_id: input.session_id,
      run_id: runId,
      task_id: input.task_id,
      attempt,
      wave_idx: input.wave_idx,
      parallel_group: input.parallel_group ?? null,
      kind: input.kind,
      title: input.title,
      started_at: input.started_at ?? null,
      finished_at: input.finished_at ?? null,
      status: input.status,
      tool_call_count: input.tool_call_count ?? 0,
      input_tokens: input.input_tokens ?? 0,
      output_tokens: input.output_tokens ?? 0,
      inputs_fingerprint: input.inputs_fingerprint ?? null,
      skip_reason: input.skip_reason ?? null,
      error: input.error ?? null,
      summary: input.summary ?? null,
    };
    const operationKey = {
      action: 'upsert_task_run_item',
      data,
    };
    if (existing) {
      await this.entities.update<TaskRunItemData>(
        input.session_id,
        'tasks',
        existing.id,
        (current) => ({
          ...data,
          started_at: data.started_at ?? current.started_at,
          finished_at: data.finished_at ?? current.finished_at,
          inputs_fingerprint:
            data.inputs_fingerprint ?? current.inputs_fingerprint,
          skip_reason: data.skip_reason ?? current.skip_reason,
          error: data.error ?? current.error,
          summary: data.summary ?? current.summary,
        }),
        {
          operation_id: input.operation_id,
          operation_key: operationKey,
        },
      );
      return;
    }
    await this.entities.create(input.session_id, 'tasks', {
      kind: 'task_run_item',
      data,
      operation_id:
        input.operation_id ??
        `task-item:${runId}:${input.task_id}:${attempt}`,
      operation_key: operationKey,
    });
  }

  async get(
    sessionId: SessionId | string,
    runId: string,
  ): Promise<FsTaskRunRow | null> {
    const item = await this.envelope(sessionId, runId);
    return item ? runRow(item) : null;
  }

  async list(
    sessionId: SessionId | string,
    limit = 25,
  ): Promise<FsTaskRunRow[]> {
    return (await this.entities.list<JsonValue>(
      sessionId,
      'tasks',
      'task_run',
    ))
      .map(runRow)
      .sort(
        (left, right) =>
          Date.parse(right.started_at) - Date.parse(left.started_at) ||
          right.seq - left.seq,
      )
      .slice(0, Math.max(0, limit));
  }

  async listItems(
    sessionId: SessionId | string,
    runId: string,
  ): Promise<FsTaskRunItemRow[]> {
    const normalizedRunId = taskRunId(runId);
    return (await this.entities.list<JsonValue>(
      sessionId,
      'tasks',
      'task_run_item',
    ))
      .filter(
        (item) =>
          taskRunId(
            (item.data as unknown as TaskRunItemData).run_id,
          ) === normalizedRunId,
      )
      .map(runItemRow)
      .sort(
        (left, right) =>
          left.wave_idx - right.wave_idx ||
          Date.parse(left.started_at ?? '') -
            Date.parse(right.started_at ?? '') ||
          left.attempt - right.attempt,
      );
  }

  async getWithItems(
    sessionId: SessionId | string,
    runId: string,
  ): Promise<{
    run: FsTaskRunRow;
    items: FsTaskRunItemRow[];
  } | null> {
    const run = await this.get(sessionId, runId);
    return run
      ? { run, items: await this.listItems(sessionId, runId) }
      : null;
  }

  async findLastCompletedItem(
    sessionId: SessionId | string,
    taskId: string,
  ): Promise<FsTaskRunItemRow | null> {
    return (await this.entities.list<JsonValue>(
      sessionId,
      'tasks',
      'task_run_item',
    ))
      .map(runItemRow)
      .filter(
        (item) =>
          item.task_id === taskId &&
          item.status === 'done' &&
          item.inputs_fingerprint != null,
      )
      .sort(
        (left, right) =>
          Date.parse(right.finished_at ?? '') -
          Date.parse(left.finished_at ?? ''),
      )[0] ?? null;
  }

  async recoverRunning(
    sessionId?: SessionId | string,
  ): Promise<number> {
    const sessionIds = sessionId
      ? [sessionId]
      : await this.allCoderSessionIds();
    let recovered = 0;
    for (const id of sessionIds) {
      const runs = (await this.list(id, Number.MAX_SAFE_INTEGER)).filter(
        (run) => run.status === 'running',
      );
      for (const run of runs) {
        const now = new Date().toISOString();
        await this.update(id, run.run_id, {
          status: 'aborted',
          finished_at: now,
          reject_reason: 'worker_restart',
          operation_id: `task-run-recovery:${run.run_id}`,
        });
        for (const item of await this.listItems(id, run.run_id)) {
          if (item.status !== 'running') continue;
          await this.upsertItem({
            ...item,
            session_id: asSessionId(String(id)),
            status: 'interrupted',
            finished_at: now,
            error: 'worker_restart',
            operation_id: `task-item-recovery:${item.id}`,
          });
        }
        recovered += 1;
      }
    }
    return recovered;
  }

  private async allCoderSessionIds(): Promise<SessionId[]> {
    await this.directory.ensureCatalog();
    return this.directory.catalog
      .list()
      .filter((entry) => entry.session.kind === 'coder')
      .map((entry) => entry.session.id);
  }
}
