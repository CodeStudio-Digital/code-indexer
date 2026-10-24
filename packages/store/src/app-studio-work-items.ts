import { parseStringArray } from './app-studio-store-values.js';
import type { AppStudioWorkItemStatus, AppStudioWorkItem, UpsertAppStudioWorkItemInput, WorkItemData, AppEntry } from './app-studio-store-types.js';
import { isUuid, newSessionId, type EntityRecord, type SessionId } from '@mcp/session-storage';

import { AppStudioSessionBase } from './app-studio-session-base.js';
import { AppStudioPlans } from './app-studio-plans.js';
export class AppStudioWorkItems {
  constructor(private readonly context: AppStudioSessionBase, private readonly plans: AppStudioPlans) {}

  #workRow(
    entry: AppEntry,
    record: EntityRecord<WorkItemData>,
  ): AppStudioWorkItem {
    return {
      app_session_id: entry.session.id,
      id: record.id,
      seq: record.seq,
      ...record.data,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }

  async listWorkItems(
    sessionId: SessionId | string,
  ): Promise<AppStudioWorkItem[]> {
    const entry = await this.context.requireEntry(sessionId);
    const records = (
      await this.context.repo<WorkItemData>(
        entry,
        'work-items',
        'work_item',
      ).list({ limit: 1_000 })
    ).items;
    return records
      .map((record) => this.#workRow(entry, record))
      .sort(
        (left, right) =>
          left.sort_order - right.sort_order ||
          right.priority - left.priority ||
          left.seq - right.seq,
      );
  }

  async getWorkItem(
    sessionId: SessionId | string,
    id: string,
  ): Promise<AppStudioWorkItem | null> {
    const entry = await this.context.requireEntry(sessionId);
    const repository = this.context.repo<WorkItemData>(
      entry,
      'work-items',
      'work_item',
    );
    const direct = isUuid(id) ? await repository.get(id) : null;
    const record =
      direct ??
      (
        await repository.list({ limit: 1_000 })
      ).items.find((candidate) => candidate.data.source_id === id);
    return record ? this.#workRow(entry, record) : null;
  }

  async upsertWorkItems(
    items: UpsertAppStudioWorkItemInput[],
  ): Promise<AppStudioWorkItem[]> {
    if (items.length === 0) return [];
    const sessionId = String(items[0].app_session_id);
    if (items.some((item) => String(item.app_session_id) !== sessionId)) {
      throw new TypeError('App work item batches cannot cross sessions');
    }
    const entry = await this.context.requireEntry(sessionId);
    return this.context.host.repository.runExclusive(entry.location, async () => {
      const repository = this.context.repo<WorkItemData>(
        entry,
        'work-items',
        'work_item',
      );
      const existing = (
        await repository.list({ limit: 1_000 })
      ).items;
      const bySource = new Map(
        existing.map((record) => [record.data.source_id, record]),
      );
      const publicIds = new Map<string, string>();
      for (const item of items) {
        publicIds.set(
          item.id,
          bySource.get(item.id)?.id ??
            (isUuid(item.id) && existing.some((record) => record.id === item.id)
              ? item.id
              : String(newSessionId())),
        );
      }
      const output: AppStudioWorkItem[] = [];
      for (const input of items) {
        const previous =
          bySource.get(input.id) ??
          existing.find((record) => record.id === input.id);
        const dependencies = parseStringArray(
          input.depends_on_json ?? '[]',
          'depends_on_json',
        ).map((dependency) => publicIds.get(dependency) ?? dependency);
        if (dependencies.some((dependency) => !isUuid(dependency))) {
          throw new TypeError(
            `Unknown App work item dependency in '${input.id}'`,
          );
        }
        const data: WorkItemData = {
          source_id: previous?.data.source_id ?? input.id,
          plan_revision_id: input.plan_revision_id,
          slice_id: input.slice_id ?? null,
          title: input.title,
          outcome: input.outcome ?? '',
          kind: input.kind,
          owner_role: input.owner_role,
          priority: input.priority ?? 0,
          status: input.status ?? 'backlog',
          sort_order: input.sort_order ?? 0,
          depends_on_json: JSON.stringify(dependencies),
          source_ids_json: input.source_ids_json ?? '[]',
          acceptance_json: input.acceptance_json ?? '[]',
          evidence_json: input.evidence_json ?? '[]',
          file_scope_json: input.file_scope_json ?? '[]',
          blocked_reason: input.blocked_reason ?? null,
        };
        JSON.parse(data.source_ids_json);
        JSON.parse(data.acceptance_json);
        JSON.parse(data.evidence_json);
        JSON.parse(data.file_scope_json);
        const record = previous
          ? await repository.update(previous.id, { data })
          : await repository.create({
              id: publicIds.get(input.id),
              relations: { plan_revision: input.plan_revision_id },
              data,
            });
        output.push(this.#workRow(entry, record));
      }
      return output;
    });
  }

  async setWorkItemStatus(
    sessionId: SessionId | string,
    id: string,
    status: AppStudioWorkItemStatus,
    options: {
      blockedReason?: string | null;
      evidenceJson?: string;
    } = {},
  ): Promise<AppStudioWorkItem> {
    const entry = await this.context.requireEntry(sessionId);
    return this.context.host.repository.runExclusive(entry.location, async () => {
      const current = await this.getWorkItem(sessionId, id);
      if (!current) throw new Error(`App work item '${id}' not found`);
      if (options.evidenceJson != null) JSON.parse(options.evidenceJson);
      const repository = this.context.repo<WorkItemData>(
        entry,
        'work-items',
        'work_item',
      );
      const record = await repository.update(current.id, {
        data: {
          source_id: current.source_id,
          plan_revision_id: current.plan_revision_id,
          slice_id: current.slice_id,
          title: current.title,
          outcome: current.outcome,
          kind: current.kind,
          owner_role: current.owner_role,
          priority: current.priority,
          status,
          sort_order: current.sort_order,
          depends_on_json: current.depends_on_json,
          source_ids_json: current.source_ids_json,
          acceptance_json: current.acceptance_json,
          evidence_json: options.evidenceJson ?? current.evidence_json,
          file_scope_json: current.file_scope_json,
          blocked_reason:
            options.blockedReason === undefined
              ? current.blocked_reason
              : options.blockedReason,
        },
      });
      await this.context.appendEventRecord(
        entry,
        'work.status',
        'work_item',
        current.id,
        JSON.stringify({
          status,
          blocked_reason: options.blockedReason ?? null,
        }),
        null,
      );
      return this.#workRow(entry, record);
    });
  }

  async markWorkItemsStale(
    sessionId: SessionId | string,
    ids: string[],
    reason: string,
  ): Promise<number> {
    const entry = await this.context.requireEntry(sessionId);
    return this.context.host.repository.runExclusive(entry.location, async () => {
      let changed = 0;
      const repository = this.context.repo<WorkItemData>(
        entry,
        'work-items',
        'work_item',
      );
      for (const id of ids) {
        const current = await this.getWorkItem(sessionId, id);
        if (!current || current.status === 'cancelled') continue;
        const record = await repository.require(current.id);
        await repository.update(record.id, {
          data: {
            ...record.data,
            status: 'stale',
            blocked_reason: reason,
          },
        });
        changed += 1;
      }
      return changed;
    });
  }

  async refreshReadyWorkItems(
    sessionId: SessionId | string,
  ): Promise<AppStudioWorkItem[]> {
    const entry = await this.context.requireEntry(sessionId);
    const approved = await this.plans.getLatestApprovedPlanRevision(sessionId);
    if (!approved) return this.listWorkItems(sessionId);
    await this.context.host.repository.runExclusive(entry.location, async () => {
      const items = await this.listWorkItems(sessionId);
      const done = new Set(
        items.filter((item) => item.status === 'done').map((item) => item.id),
      );
      const review = new Set(
        items.filter((item) => item.status === 'review').map((item) => item.id),
      );
      const repository = this.context.repo<WorkItemData>(
        entry,
        'work-items',
        'work_item',
      );
      for (const item of items) {
        if (
          item.plan_revision_id !== approved.id ||
          item.status !== 'backlog'
        ) {
          continue;
        }
        const dependencies = parseStringArray(
          item.depends_on_json,
          'depends_on_json',
        );
        const ready =
          item.kind === 'verify'
            ? dependencies.every(
                (dependency) =>
                  done.has(dependency) || review.has(dependency),
              )
            : dependencies.every((dependency) => done.has(dependency));
        if (!ready) continue;
        const record = await repository.require(item.id);
        await repository.update(record.id, {
          data: { ...record.data, status: 'ready' },
        });
      }
    });
    return this.listWorkItems(sessionId);
  }
}
