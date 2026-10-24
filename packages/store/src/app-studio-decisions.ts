
import type { AppStudioDecision, DecisionData, AppEntry } from './app-studio-store-types.js';
import { type EntityRecord, type SessionId } from '@mcp/session-storage';

import { AppStudioSessionBase } from './app-studio-session-base.js';

export class AppStudioDecisions {
  constructor(private readonly context: AppStudioSessionBase) {}

  #decisionRow(
    entry: AppEntry,
    record: EntityRecord<DecisionData>,
  ): AppStudioDecision {
    return {
      id: record.id,
      seq: record.seq,
      app_session_id: entry.session.id,
      ...record.data,
    };
  }

  async listDecisions(
    sessionId: SessionId | string,
  ): Promise<AppStudioDecision[]> {
    const entry = await this.context.requireEntry(sessionId);
    const records = (
      await this.context.repo<DecisionData>(
        entry,
        'decisions',
        'decision',
      ).list({ limit: 1_000, order: 'desc' })
    ).items;
    return records.map((record) => this.#decisionRow(entry, record));
  }

  async createDecision(input: {
    sessionId: SessionId | string;
    planRevisionId: string;
    question: string;
    optionsJson?: string;
    blockedWorkItemIdsJson?: string;
  }): Promise<AppStudioDecision> {
    const entry = await this.context.requireEntry(input.sessionId);
    const optionsJson = input.optionsJson ?? '[]';
    const blockedJson = input.blockedWorkItemIdsJson ?? '[]';
    JSON.parse(optionsJson);
    JSON.parse(blockedJson);
    return this.context.host.repository.runExclusive(entry.location, async () => {
      const requested = new Date().toISOString();
      const record = await this.context.repo<DecisionData>(
        entry,
        'decisions',
        'decision',
      ).create({
        relations: { plan_revision: input.planRevisionId },
        data: {
          plan_revision_id: input.planRevisionId,
          question: input.question,
          options_json: optionsJson,
          blocked_work_item_ids_json: blockedJson,
          status: 'open',
          answer: null,
          requested_at: requested,
          resolved_at: null,
        },
      });
      await this.context.appendEventRecord(
        entry,
        'decision.requested',
        'decision',
        record.id,
        JSON.stringify({ question: input.question }),
        null,
      );
      return this.#decisionRow(entry, record);
    });
  }

  async resolveDecision(
    sessionId: SessionId | string,
    id: string,
    answer: string,
  ): Promise<AppStudioDecision> {
    const entry = await this.context.requireEntry(sessionId);
    return this.context.host.repository.runExclusive(entry.location, async () => {
      const repository = this.context.repo<DecisionData>(
        entry,
        'decisions',
        'decision',
      );
      const current = await repository.get(id);
      if (!current) throw new Error('App decision not found');
      const next = await repository.update(id, {
        data: {
          ...current.data,
          status: 'resolved',
          answer,
          resolved_at: new Date().toISOString(),
        },
      });
      await this.context.appendEventRecord(
        entry,
        'decision.resolved',
        'decision',
        id,
        JSON.stringify({ answer }),
        null,
      );
      return this.#decisionRow(entry, next);
    });
  }
}
