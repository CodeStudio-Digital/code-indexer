import { toMasterPrompt } from './company-session-file-codecs.js';
import { nullableString, promptDeliveryStatus } from './company-session-file-values.js';
import type { CreateCompanyMasterPromptFileInput, ResolveCompanyMasterPromptFileInput, CompanyMasterPromptDeliveryClaim } from './company-session-file-types.js';
import { type EntityRecord } from '@mcp/session-storage';

import type { MasterPrompt, MasterPromptKind } from '@mcp/company/types.js';
import { CompanySessionFileBase } from './company-session-file-base.js';

export class CompanyMasterPromptFiles {
  constructor(private readonly context: CompanySessionFileBase) {}

  private masterPromptMutationTail: Promise<void> = Promise.resolve();

  private enqueueMasterPromptMutation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const pending = this.masterPromptMutationTail.then(operation, operation);
    this.masterPromptMutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async createMasterPrompt(
    input: CreateCompanyMasterPromptFileInput,
  ): Promise<MasterPrompt> {
    const record = await this.context.entities.createMasterPrompt({
      relations: {
        ...(input.agent_run_id
          ? { agent_run_id: input.agent_run_id }
          : {}),
      },
      data: {
        kind: input.kind,
        status: 'pending',
        agent_run_id: input.agent_run_id,
        runner_block_id: input.runner_block_id ?? null,
        body: input.body,
        options: input.options ?? null,
        allow_freeform: input.allow_freeform !== false,
        answer: null,
        approved: null,
        feedback: null,
        resolved_at: null,
        delivery_status: 'pending',
        delivery_token: null,
        delivery_payload_hash: null,
        delivery_started_at: null,
        delivery_completed_at: null,
      },
    });
    return toMasterPrompt(
      this.context.companySessionId,
      record as EntityRecord<Record<string, unknown>>,
    );
  }

  async getMasterPrompt(id: string): Promise<MasterPrompt | null> {
    const record = await this.context.entities.get('masterPrompt', id);
    return record ? toMasterPrompt(this.context.companySessionId, record) : null;
  }

  async getPendingMasterPrompt(
    kind?: MasterPromptKind,
  ): Promise<MasterPrompt | null> {
    const page = await this.context.entities.list('masterPrompt', {
      limit: 1_000,
      order: 'desc',
    });
    const record = page.items.find(
      (candidate) =>
        candidate.data.status === 'pending' &&
        (kind == null || candidate.data.kind === kind),
    );
    return record
      ? toMasterPrompt(
          this.context.companySessionId,
          record as EntityRecord<Record<string, unknown>>,
        )
      : null;
  }

  async claimMasterPromptDelivery(
    id: string,
    kind: MasterPromptKind,
    token: string,
    payloadHash: string,
    opts?: { retryOutcomeUnknown?: boolean },
  ): Promise<CompanyMasterPromptDeliveryClaim> {
    return this.enqueueMasterPromptMutation(async () => {
      const record = await this.context.entities.get('masterPrompt', id);
      const prompt = record
        ? toMasterPrompt(
            this.context.companySessionId,
            record as EntityRecord<Record<string, unknown>>,
          )
        : null;
      if (!record || prompt?.kind !== kind || prompt.status !== 'pending') {
        return { kind: 'not_pending', prompt };
      }
      const currentStatus = promptDeliveryStatus(
        record.data.delivery_status,
      );
      const currentHash = nullableString(
        record.data.delivery_payload_hash,
      );
      const canRetry =
        opts?.retryOutcomeUnknown === true &&
        (
          currentStatus === 'outcome_unknown' ||
          currentStatus === 'delivering'
        );
      if (currentStatus !== 'pending' && !canRetry) {
        return {
          kind:
            currentStatus === 'delivering'
              ? 'delivery_in_progress'
              : 'outcome_unknown',
          prompt,
        };
      }
      if (canRetry && currentHash !== payloadHash) {
        return { kind: 'payload_conflict', prompt };
      }
      const updated = await this.context.entities.update('masterPrompt', id, {
        data: {
          ...record.data,
          delivery_status: 'delivering',
          delivery_token: token,
          delivery_payload_hash: payloadHash,
          delivery_started_at: new Date().toISOString(),
          delivery_completed_at: null,
        },
      });
      return {
        kind: 'claimed',
        prompt: toMasterPrompt(
          this.context.companySessionId,
          updated as EntityRecord<Record<string, unknown>>,
        ),
        token,
      };
    });
  }

  async releaseMasterPromptDelivery(
    id: string,
    token: string,
  ): Promise<boolean> {
    return this.enqueueMasterPromptMutation(async () => {
      const record = await this.context.entities.get('masterPrompt', id);
      if (
        !record ||
        record.data.status !== 'pending' ||
        record.data.delivery_status !== 'delivering' ||
        record.data.delivery_token !== token
      ) {
        return false;
      }
      await this.context.entities.update('masterPrompt', id, {
        data: {
          ...record.data,
          delivery_status: 'pending',
          delivery_token: null,
          delivery_payload_hash: null,
          delivery_started_at: null,
          delivery_completed_at: null,
        },
      });
      return true;
    });
  }

  async markMasterPromptDeliveryOutcomeUnknown(
    id: string,
    token: string,
  ): Promise<boolean> {
    return this.enqueueMasterPromptMutation(async () => {
      const record = await this.context.entities.get('masterPrompt', id);
      if (
        !record ||
        record.data.status !== 'pending' ||
        record.data.delivery_status !== 'delivering' ||
        record.data.delivery_token !== token
      ) {
        return false;
      }
      await this.context.entities.update('masterPrompt', id, {
        data: {
          ...record.data,
          delivery_status: 'outcome_unknown',
          delivery_completed_at: new Date().toISOString(),
        },
      });
      return true;
    });
  }

  async completeMasterPromptDelivery(
    id: string,
    token: string,
    resolution: ResolveCompanyMasterPromptFileInput,
  ): Promise<MasterPrompt | null> {
    return this.enqueueMasterPromptMutation(async () => {
      const record = await this.context.entities.get('masterPrompt', id);
      if (
        !record ||
        record.data.kind !== resolution.kind ||
        record.data.status !== 'pending' ||
        record.data.delivery_status !== 'delivering' ||
        record.data.delivery_token !== token
      ) {
        return null;
      }
      const resolvedAt = new Date().toISOString();
      const updated = await this.context.entities.update('masterPrompt', id, {
        data: {
          ...record.data,
          status: 'answered',
          answer:
            resolution.kind === 'question' ? resolution.answer : null,
          approved:
            resolution.kind === 'plan' ? resolution.approved : null,
          feedback:
            resolution.kind === 'plan'
              ? resolution.feedback ?? null
              : null,
          resolved_at: resolvedAt,
          delivery_status: 'delivered',
          delivery_completed_at: resolvedAt,
        },
      });
      return toMasterPrompt(
        this.context.companySessionId,
        updated as EntityRecord<Record<string, unknown>>,
      );
    });
  }

  async cancelPendingMasterPrompts(): Promise<MasterPrompt[]> {
    return this.enqueueMasterPromptMutation(async () => {
      const page = await this.context.entities.list('masterPrompt', {
        limit: 1_000,
        order: 'asc',
      });
      const cancelled: MasterPrompt[] = [];
      for (const record of page.items) {
        if (record.data.status !== 'pending') continue;
        const resolvedAt = new Date().toISOString();
        const updated = await this.context.entities.update(
          'masterPrompt',
          record.id,
          {
            data: {
              ...record.data,
              status: 'cancelled',
              resolved_at: resolvedAt,
            },
          },
        );
        cancelled.push(
          toMasterPrompt(
            this.context.companySessionId,
            updated as EntityRecord<Record<string, unknown>>,
          ),
        );
      }
      return cancelled;
    });
  }
}
