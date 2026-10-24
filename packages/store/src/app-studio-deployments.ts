
import type { AppStudioDeployment, DeploymentData, AppEntry } from './app-studio-store-types.js';
import { type EntityRecord, type SessionId } from '@mcp/session-storage';

import { AppStudioSessionBase } from './app-studio-session-base.js';

export class AppStudioDeployments {
  constructor(private readonly context: AppStudioSessionBase) {}

  #deploymentRow(
    entry: AppEntry,
    record: EntityRecord<DeploymentData>,
  ): AppStudioDeployment {
    return {
      id: record.id,
      seq: record.seq,
      app_session_id: entry.session.id,
      ...record.data,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }

  async saveDeployment(input: {
    sessionId: SessionId | string;
    planRevisionId: string;
    status: AppStudioDeployment['status'];
    url?: string | null;
    account?: string | null;
    databaseId?: string | null;
    healthOk?: boolean;
    detailsJson?: string;
  }): Promise<AppStudioDeployment> {
    const entry = await this.context.requireEntry(input.sessionId);
    const details = input.detailsJson ?? '{}';
    JSON.parse(details);
    return this.context.host.repository.runExclusive(entry.location, async () => {
      const record = await this.context.repo<DeploymentData>(
        entry,
        'deployments',
        'deployment',
      ).create({
        relations: { plan_revision: input.planRevisionId },
        data: {
          plan_revision_id: input.planRevisionId,
          status: input.status,
          url: input.url ?? null,
          account: input.account ?? null,
          database_id: input.databaseId ?? null,
          health_ok: input.healthOk ? 1 : 0,
          details_json: details,
        },
      });
      const deployment = this.#deploymentRow(entry, record);
      await this.context.appendEventRecord(
        entry,
        `deployment.${input.status}`,
        'deployment',
        deployment.id,
        JSON.stringify({
          url: deployment.url,
          health_ok: !!deployment.health_ok,
        }),
        null,
      );
      return deployment;
    });
  }

  async getLatestDeployment(
    sessionId: SessionId | string,
  ): Promise<AppStudioDeployment | null> {
    const entry = await this.context.requireEntry(sessionId);
    const record = (
      await this.context.repo<DeploymentData>(
        entry,
        'deployments',
        'deployment',
      ).list({ limit: 1, order: 'desc' })
    ).items[0];
    return record ? this.#deploymentRow(entry, record) : null;
  }
}
