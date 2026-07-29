import { createHash } from 'node:crypto';
import {
  asSessionId,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import {
  FsSessionEntityFiles,
  type FsEntityEnvelope,
} from './entity-files.js';
import { toJsonValue } from './conversation-codec.js';
import type {
  CoderPlanStatus,
  FsPlanRow,
  FsRecordPlanInput,
  FsRecordSessionInput,
  FsSessionInputRow,
} from './operational-types.js';

interface PlanData {
  tool_use_id: string;
  message_seq: number | null;
  plan_text: string;
  status: CoderPlanStatus;
  feedback: string | null;
  resolved_at: string | null;
}

interface InputData {
  kind: FsRecordSessionInput['kind'];
  source_label: string;
  content: string;
  content_hash: string;
  meta: Readonly<Record<string, JsonValue>> | null;
}

function planRow(
  sessionId: SessionId,
  envelope: FsEntityEnvelope<JsonValue>,
): FsPlanRow {
  const data = envelope.data as unknown as PlanData;
  return {
    id: envelope.id,
    seq: envelope.seq,
    revision: envelope.revision,
    session_id: sessionId,
    tool_use_id: data.tool_use_id,
    message_seq: data.message_seq,
    plan_text: data.plan_text,
    status: data.status,
    feedback: data.feedback,
    created_at: envelope.created_at,
    resolved_at: data.resolved_at,
  };
}

function inputRow(
  sessionId: SessionId,
  envelope: FsEntityEnvelope<JsonValue>,
): FsSessionInputRow {
  const data = envelope.data as unknown as InputData;
  return {
    id: envelope.id,
    seq: envelope.seq,
    session_id: sessionId,
    kind: data.kind,
    source_label: data.source_label,
    content: data.content,
    content_hash: data.content_hash,
    meta: data.meta,
    created_at: envelope.created_at,
  };
}

export class FsPlanningRepository {
  constructor(private readonly entities: FsSessionEntityFiles) {}

  async recordPlan(input: FsRecordPlanInput): Promise<FsPlanRow> {
    const records = await this.entities.list<JsonValue>(
      input.session_id,
      'plans',
      'plan',
    );
    const existing = records.find(
      (candidate) =>
        (candidate.data as unknown as PlanData).tool_use_id ===
        input.tool_use_id,
    );
    const data: PlanData = {
      tool_use_id: input.tool_use_id,
      message_seq: input.message_seq ?? null,
      plan_text: input.plan_text,
      status: existing
        ? (existing.data as unknown as PlanData).status
        : 'pending',
      feedback: existing
        ? (existing.data as unknown as PlanData).feedback
        : null,
      resolved_at: existing
        ? (existing.data as unknown as PlanData).resolved_at
        : null,
    };
    const operationKey = {
      action: 'record_plan',
      tool_use_id: input.tool_use_id,
      message_seq: input.message_seq ?? null,
      plan_text: input.plan_text,
    };
    const written = existing
      ? await this.entities.update<PlanData>(
          input.session_id,
          'plans',
          existing.id,
          () => data,
          {
            operation_id: input.operation_id,
            operation_key: operationKey,
          },
        )
      : await this.entities.create(input.session_id, 'plans', {
          kind: 'plan',
          data,
          operation_id: input.operation_id,
          operation_key: operationKey,
        });
    return planRow(input.session_id, written!);
  }

  async listPlans(id: SessionId | string): Promise<FsPlanRow[]> {
    const records = await this.entities.list<JsonValue>(id, 'plans', 'plan');
    const sessionId = records.length > 0
      ? (await this.sessionId(id))
      : asSessionId(String(id));
    return records
      .map((item) => planRow(sessionId, item))
      .sort((left, right) => right.seq - left.seq);
  }

  private async sessionId(id: SessionId | string): Promise<SessionId> {
    return asSessionId(String(id));
  }

  async getPlan(
    sessionId: SessionId | string,
    planId: string,
  ): Promise<FsPlanRow | null> {
    const item = await this.entities.get<JsonValue>(
      sessionId,
      'plans',
      planId,
    );
    return item ? planRow(asSessionId(String(sessionId)), item) : null;
  }

  async resolvePlan(
    sessionId: SessionId | string,
    toolUseId: string,
    status: CoderPlanStatus,
    feedback?: string,
    operationId?: string,
  ): Promise<boolean> {
    const plans = await this.entities.list<JsonValue>(
      sessionId,
      'plans',
      'plan',
    );
    const found = plans.find(
      (item) =>
        (item.data as unknown as PlanData).tool_use_id === toolUseId,
    );
    if (!found) return false;
    await this.entities.update<PlanData>(
      sessionId,
      'plans',
      found.id,
      (current) => ({
        ...current,
        status,
        feedback: feedback ?? null,
        resolved_at: new Date().toISOString(),
      }),
      {
        operation_id: operationId,
        operation_key: {
          action: 'resolve_plan',
          tool_use_id: toolUseId,
          status,
          feedback: feedback ?? null,
        },
      },
    );
    return true;
  }

  async resolveLatestPendingPlan(
    sessionId: SessionId | string,
    status: CoderPlanStatus,
    feedback?: string,
    operationId?: string,
  ): Promise<boolean> {
    const pending = (await this.entities.list<JsonValue>(
      sessionId,
      'plans',
      'plan',
    ))
      .filter(
        (item) =>
          (item.data as unknown as PlanData).status === 'pending',
      )
      .sort((left, right) => right.seq - left.seq)[0];
    return pending
      ? this.resolvePlan(
          sessionId,
          (pending.data as unknown as PlanData).tool_use_id,
          status,
          feedback,
          operationId,
        )
      : false;
  }

  async clearPlansFrom(
    sessionId: SessionId | string,
    sinceMessageSeq: number,
  ): Promise<number> {
    const records = await this.entities.list<JsonValue>(
      sessionId,
      'plans',
      'plan',
    );
    const targets = records.filter((item) => {
      const seq = (item.data as unknown as PlanData).message_seq;
      return seq == null || seq >= sinceMessageSeq;
    });
    await Promise.all(
      targets.map((item) =>
        this.entities.update(
          sessionId,
          'plans',
          item.id,
          (data) => data,
          { delete: true },
        ),
      ),
    );
    return targets.length;
  }

  async recordInput(
    input: FsRecordSessionInput,
  ): Promise<FsSessionInputRow | null> {
    const hash = createHash('sha1').update(input.content).digest('hex');
    const records = await this.entities.list<JsonValue>(
      input.session_id,
      'inputs',
      'session_input',
    );
    const latest = records
      .filter(
        (item) =>
          (item.data as unknown as InputData).kind === input.kind,
      )
      .at(-1);
    if (
      latest &&
      (latest.data as unknown as InputData).content_hash === hash
    ) {
      return null;
    }
    const created = await this.entities.create(
      input.session_id,
      'inputs',
      {
        kind: 'session_input',
        data: {
          kind: input.kind,
          source_label: input.source_label,
          content: input.content,
          content_hash: hash,
          meta:
            input.meta == null
              ? null
              : (toJsonValue(input.meta) as Readonly<
                  Record<string, JsonValue>
                >),
        } satisfies InputData,
        operation_id: input.operation_id,
      },
    );
    return inputRow(input.session_id, created);
  }

  async listInputs(
    sessionId: SessionId | string,
  ): Promise<FsSessionInputRow[]> {
    return (await this.entities.list<JsonValue>(
      sessionId,
      'inputs',
      'session_input',
    ))
      .map((item) => inputRow(asSessionId(String(sessionId)), item))
      .sort((left, right) => right.seq - left.seq);
  }
}
