import { TERMINAL_RUN_STATUSES } from './app-studio-store-values.js';
import type { AppStudioWorkItemRunStatus, AppStudioWorkItemRun, CreateAppStudioWorkItemRunInput, UpdateAppStudioWorkItemRunOptions, WorkItemRunData, AppEntry } from './app-studio-store-types.js';
import { asSessionId, isUuid, type EntityRecord, type SessionId } from '@mcp/session-storage';

import { AppStudioSessionBase } from './app-studio-session-base.js';
import { AppStudioWorkItems } from './app-studio-work-items.js';
export class AppStudioRuns {
  constructor(private readonly context: AppStudioSessionBase, private readonly workItems: AppStudioWorkItems) {}

  #runRow(
    entry: AppEntry,
    record: EntityRecord<WorkItemRunData>,
  ): AppStudioWorkItemRun {
    return {
      id: record.id,
      seq: record.seq,
      app_session_id: entry.session.id,
      ...record.data,
      coder_session_id: record.data.coder_session_id == null
        ? null
        : asSessionId(String(record.data.coder_session_id)),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }

  async nextWorkItemRunAttempt(
    sessionId: SessionId | string,
    workItemId: string,
  ): Promise<number> {
    const runs = await this.listWorkItemRuns(sessionId, { workItemId });
    return runs.reduce((max, run) => Math.max(max, run.attempt), 0) + 1;
  }

  async createWorkItemRun(
    input: CreateAppStudioWorkItemRunInput,
  ): Promise<AppStudioWorkItemRun> {
    const entry = await this.context.requireEntry(input.appSessionId);
    const workItem = await this.workItems.getWorkItem(
      input.appSessionId,
      input.workItemId,
    );
    if (!workItem) {
      throw new Error(`App work item '${input.workItemId}' not found`);
    }
    return this.context.host.repository.runExclusive(entry.location, async () => {
      const repository = this.context.repo<WorkItemRunData>(
        entry,
        'work-item-runs',
        'work_item_run',
      );
      const key =
        input.idempotencyKey ??
        `app:${String(input.appSessionId)}:work:${workItem.id}:attempt:${input.attempt}`;
      const existing = (
        await repository.list({ limit: 1_000, order: 'desc' })
      ).items.find((record) => record.data.idempotency_key === key);
      if (existing) return this.#runRow(entry, existing);
      const status = input.status ?? 'claimed';
      const now = new Date().toISOString();
      const record = await repository.create({
        relations: {
          work_item: workItem.id,
          ...(input.companyAgentRunId
            ? { company_agent_run: input.companyAgentRunId }
            : {}),
          ...(input.coderSessionId
            ? { coder_session: String(input.coderSessionId) }
            : {}),
        },
        data: {
          work_item_id: workItem.id,
          attempt: input.attempt,
          role: input.role,
          company_agent_run_id: input.companyAgentRunId ?? null,
          coder_session_id:
            input.coderSessionId == null
              ? null
              : String(input.coderSessionId),
          status,
          runtime_config_hash: input.runtimeConfigHash ?? null,
          idempotency_key: key,
          status_message: null,
          started_at: ['running', 'waiting'].includes(status) ? now : null,
          completed_at: null,
        },
      });
      return this.#runRow(entry, record);
    });
  }

  async getActiveWorkItemRun(
    sessionId: SessionId | string,
    workItemId: string,
  ): Promise<AppStudioWorkItemRun | null> {
    return (
      (await this.listWorkItemRuns(sessionId, { workItemId })).find((run) =>
        ['claimed', 'running', 'waiting', 'paused'].includes(run.status),
      ) ?? null
    );
  }

  async listWorkItemRuns(
    sessionId: SessionId | string,
    options: { workItemId?: string; limit?: number } = {},
  ): Promise<AppStudioWorkItemRun[]> {
    const entry = await this.context.requireEntry(sessionId);
    const workItem = options.workItemId
      ? await this.workItems.getWorkItem(sessionId, options.workItemId)
      : null;
    if (options.workItemId && !workItem) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 250, 1_000));
    const records = (
      await this.context.repo<WorkItemRunData>(
        entry,
        'work-item-runs',
        'work_item_run',
      ).list({ limit: 1_000, order: 'desc' })
    ).items.filter(
      (record) =>
        !workItem || record.data.work_item_id === workItem.id,
    );
    return records
      .slice(0, limit)
      .map((record) => this.#runRow(entry, record));
  }

  async updateWorkItemRunStatus(
    id: string,
    status: AppStudioWorkItemRunStatus,
    options: UpdateAppStudioWorkItemRunOptions = {},
  ): Promise<AppStudioWorkItemRun> {
    if (!isUuid(id)) throw new TypeError('App work item run id must be a UUID');
    await this.context.ready();
    for (const entry of this.context.appEntries()) {
      const repository = this.context.repo<WorkItemRunData>(
        entry,
        'work-item-runs',
        'work_item_run',
      );
      const current = await repository.get(id);
      if (!current) continue;
      return this.context.host.repository.runExclusive(entry.location, async () => {
        const now = new Date().toISOString();
        const next = await repository.update(id, {
          data: {
            ...current.data,
            status,
            company_agent_run_id:
              options.companyAgentRunId ??
              current.data.company_agent_run_id,
            coder_session_id:
              options.coderSessionId === undefined
                ? current.data.coder_session_id
                : options.coderSessionId == null
                  ? null
                  : String(options.coderSessionId),
            runtime_config_hash:
              options.runtimeConfigHash ??
              current.data.runtime_config_hash,
            status_message:
              options.statusMessage ?? current.data.status_message,
            started_at:
              ['running', 'waiting'].includes(status)
                ? current.data.started_at ?? now
                : current.data.started_at,
            completed_at: TERMINAL_RUN_STATUSES.has(status)
              ? now
              : current.data.completed_at,
          },
        });
        return this.#runRow(entry, next);
      });
    }
    throw new Error(`App work item run ${id} not found`);
  }
}
