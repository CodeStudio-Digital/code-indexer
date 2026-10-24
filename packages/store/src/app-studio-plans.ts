
import type { AppStudioPlanRevision, SaveAppStudioPlanRevisionInput, PlanRevisionData, WorkItemData, AppEntry } from './app-studio-store-types.js';
import { isUuid, type EntityRecord, type SessionId } from '@mcp/session-storage';
import type { AppFitnessReport } from '@mcp/app-studio/plan/types.js';
import { AppStudioSessionBase } from './app-studio-session-base.js';

export class AppStudioPlans {
  constructor(private readonly context: AppStudioSessionBase) {}

  #planRow(
    entry: AppEntry,
    record: EntityRecord<PlanRevisionData>,
  ): AppStudioPlanRevision {
    return {
      id: record.id,
      seq: record.seq,
      app_session_id: entry.session.id,
      ...record.data,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }

  async listPlanRevisions(
    sessionId: SessionId | string,
  ): Promise<AppStudioPlanRevision[]> {
    const entry = await this.context.requireEntry(sessionId);
    const page = await this.context.repo<PlanRevisionData>(
      entry,
      'plan-revisions',
      'plan_revision',
    ).list({ limit: 1_000, order: 'desc' });
    return page.items.map((record) => this.#planRow(entry, record));
  }

  async getPlanRevision(id: string): Promise<AppStudioPlanRevision | null> {
    if (!isUuid(id)) return null;
    await this.context.ready();
    for (const entry of this.context.appEntries()) {
      const record = await this.context.repo<PlanRevisionData>(
        entry,
        'plan-revisions',
        'plan_revision',
      ).get(id);
      if (record) return this.#planRow(entry, record);
    }
    return null;
  }

  async getLatestPlanRevision(
    sessionId: SessionId | string,
  ): Promise<AppStudioPlanRevision | null> {
    return (await this.listPlanRevisions(sessionId))[0] ?? null;
  }

  async getLatestApprovedPlanRevision(
    sessionId: SessionId | string,
  ): Promise<AppStudioPlanRevision | null> {
    return (
      (await this.listPlanRevisions(sessionId)).find(
        (revision) => revision.status === 'approved',
      ) ?? null
    );
  }

  async savePlanRevision(
    input: SaveAppStudioPlanRevisionInput,
  ): Promise<AppStudioPlanRevision> {
    const entry = await this.context.requireEntry(input.app_session_id);
    return this.context.host.repository.runExclusive(entry.location, async () => {
      const plans = this.context.repo<PlanRevisionData>(
        entry,
        'plan-revisions',
        'plan_revision',
      );
      const revisions = (
        await plans.list({ limit: 1_000, order: 'desc' })
      ).items;
      const latest = revisions[0];
      if (
        input.expected_revision_number != null &&
        latest?.data.revision_number !== input.expected_revision_number
      ) {
        throw new Error(
          `App plan changed (expected r${input.expected_revision_number}, current r${latest?.data.revision_number ?? 0})`,
        );
      }
      for (const revision of revisions) {
        if (revision.data.status !== 'draft') continue;
        await plans.update(revision.id, {
          data: { ...revision.data, status: 'superseded' },
        });
      }
      const work = this.context.repo<WorkItemData>(
        entry,
        'work-items',
        'work_item',
      );
      for (const item of (
        await work.list({ limit: 1_000 })
      ).items) {
        if (['cancelled', 'stale'].includes(item.data.status)) continue;
        await work.update(item.id, {
          data: {
            ...item.data,
            status: 'stale',
            blocked_reason:
              'The App plan changed; regenerate this card from the current revision.',
          },
        });
      }
      const next = (latest?.data.revision_number ?? 0) + 1;
      const created = await plans.create({
        data: {
          revision_number: next,
          status: 'draft',
          plan_json: JSON.stringify(input.plan),
          fitness_json: JSON.stringify(input.fitness),
          created_by: input.created_by ?? 'app_orchestrator',
          approved_at: null,
        },
      });
      await this.context.appendEventRecord(
        entry,
        'plan.revised',
        'plan_revision',
        created.id,
        JSON.stringify({
          revision_number: next,
          fitness: input.fitness.status,
        }),
        null,
      );
      return this.#planRow(entry, created);
    });
  }

  async approvePlanRevision(
    sessionId: SessionId | string,
    revisionId: string,
  ): Promise<AppStudioPlanRevision> {
    const entry = await this.context.requireEntry(sessionId);
    return this.context.host.repository.runExclusive(entry.location, async () => {
      const repository = this.context.repo<PlanRevisionData>(
        entry,
        'plan-revisions',
        'plan_revision',
      );
      const revision = await repository.get(revisionId);
      if (!revision) throw new Error('App plan revision not found');
      const fitness = JSON.parse(
        revision.data.fitness_json,
      ) as AppFitnessReport;
      if (fitness.status !== 'ready') {
        throw new Error('Only a ready App plan can be approved');
      }
      for (const item of (
        await repository.list({ limit: 1_000 })
      ).items) {
        if (item.data.status !== 'approved') continue;
        await repository.update(item.id, {
          data: { ...item.data, status: 'superseded' },
        });
      }
      const now = new Date().toISOString();
      const approved = await repository.update(revision.id, {
        data: {
          ...revision.data,
          status: 'approved',
          approved_at: now,
        },
      });
      await this.context.appendEventRecord(
        entry,
        'plan.approved',
        'plan_revision',
        revision.id,
        JSON.stringify({ revision_number: revision.data.revision_number }),
        `plan-approved:${revision.id}`,
      );
      return this.#planRow(entry, approved);
    });
  }
}
