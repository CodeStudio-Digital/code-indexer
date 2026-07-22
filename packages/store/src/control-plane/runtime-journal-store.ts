import type DatabaseConstructor from 'better-sqlite3';
import {
  asAgentRunAttemptId,
  asAgentRunId,
  asCorrelationId,
  asRuntimeEventId,
  asSessionCommandId,
  asSessionId,
  asToolUseId,
  type RuntimeEventEnvelopeV1,
} from '@mcp/agent-runtime-contracts';
import { hashControlPlanePayload, parseControlPlaneJson, stableControlPlaneJson } from './codec.js';
import type { RuntimeEventAppendInput } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

interface RuntimeEventRow {
  global_seq: number;
  event_id: string;
  schema_version: 1;
  event_class: RuntimeEventEnvelopeV1['eventClass'];
  partition_key: string;
  session_id: string;
  legacy_session_id: number | null;
  command_id: string | null;
  agent_run_id: string | null;
  attempt_id: string | null;
  workflow_id: string | null;
  workflow_step_id: string | null;
  operation_id: string | null;
  tool_use_id: string | null;
  parent_event_id: string | null;
  causation_id: string | null;
  correlation_id: string;
  event_type: string;
  occurred_at: string;
  recorded_at: string;
  actor_json: string;
  payload_json: string;
  payload_hash: string;
  idempotency_key: string | null;
  redaction_json: string;
}

interface CanonicalEventInput {
  schemaVersion: number;
  eventClass: RuntimeEventEnvelopeV1['eventClass'];
  partitionKey: string;
  sessionId: string;
  legacySessionId: number | null;
  commandId: string | null;
  agentRunId: string | null;
  attemptId: string | null;
  workflowId: string | null;
  workflowStepId: string | null;
  operationId: string | null;
  toolUseId: string | null;
  parentEventId: string | null;
  causationId: string | null;
  correlationId: string;
  eventType: string;
  occurredAt: string;
  actorJson: string;
  payloadJson: string;
  payloadHash: string;
  idempotencyKey: string | null;
  redactionJson: string;
}

function hydrate<T>(row: RuntimeEventRow): RuntimeEventEnvelopeV1<T> {
  return {
    schemaVersion: row.schema_version,
    eventId: asRuntimeEventId(row.event_id),
    eventClass: row.event_class,
    partitionKey: row.partition_key,
    globalSeq: row.global_seq,
    sessionId: asSessionId(row.session_id),
    commandId: row.command_id ? asSessionCommandId(row.command_id) : undefined,
    agentRunId: row.agent_run_id ? asAgentRunId(row.agent_run_id) : undefined,
    attemptId: row.attempt_id ? asAgentRunAttemptId(row.attempt_id) : undefined,
    workflowId: row.workflow_id ? row.workflow_id as NonNullable<RuntimeEventEnvelopeV1['workflowId']> : undefined,
    workflowStepId: row.workflow_step_id ? row.workflow_step_id as NonNullable<RuntimeEventEnvelopeV1['workflowStepId']> : undefined,
    operationId: row.operation_id ? row.operation_id as NonNullable<RuntimeEventEnvelopeV1['operationId']> : undefined,
    toolUseId: row.tool_use_id ? asToolUseId(row.tool_use_id) : undefined,
    parentEventId: row.parent_event_id ? asRuntimeEventId(row.parent_event_id) : undefined,
    causationId: row.causation_id ? row.causation_id as NonNullable<RuntimeEventEnvelopeV1['causationId']> : undefined,
    correlationId: asCorrelationId(row.correlation_id),
    type: row.event_type,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    actor: parseControlPlaneJson(row.actor_json, { actorId: 'unknown', actorType: 'system', source: 'recovery' }),
    payload: parseControlPlaneJson<T>(row.payload_json, null as T),
    payloadHash: row.payload_hash,
    idempotencyKey: row.idempotency_key ?? undefined,
    redaction: parseControlPlaneJson(row.redaction_json, { policyVersion: 'unknown', fields: [], secretRefs: [] }),
  };
}

function canonicalInput<T>(input: RuntimeEventAppendInput<T>): CanonicalEventInput {
  const payloadJson = stableControlPlaneJson(input.payload);
  const payloadHash = hashControlPlanePayload(input.payload);
  if (input.payloadHash !== undefined && input.payloadHash !== payloadHash) {
    throw new RuntimeEventConflictError(input.eventId, 'provided payload hash does not match canonical payload');
  }
  return {
    schemaVersion: input.schemaVersion,
    eventClass: input.eventClass,
    partitionKey: input.partitionKey,
    sessionId: input.sessionId,
    legacySessionId: input.legacySessionId ?? null,
    commandId: input.commandId ?? null,
    agentRunId: input.agentRunId ?? null,
    attemptId: input.attemptId ?? null,
    workflowId: input.workflowId ?? null,
    workflowStepId: input.workflowStepId ?? null,
    operationId: input.operationId ?? null,
    toolUseId: input.toolUseId ?? null,
    parentEventId: input.parentEventId ?? null,
    causationId: input.causationId ?? null,
    correlationId: input.correlationId,
    eventType: input.type,
    occurredAt: input.occurredAt,
    actorJson: stableControlPlaneJson(input.actor),
    payloadJson,
    payloadHash,
    idempotencyKey: input.idempotencyKey ?? null,
    redactionJson: stableControlPlaneJson(input.redaction),
  };
}

function immutableEnvelopeMatches(row: RuntimeEventRow, expected: CanonicalEventInput, eventId: string): boolean {
  return row.event_id === eventId
    && row.schema_version === expected.schemaVersion
    && row.event_class === expected.eventClass
    && row.partition_key === expected.partitionKey
    && row.session_id === expected.sessionId
    && row.legacy_session_id === expected.legacySessionId
    && row.command_id === expected.commandId
    && row.agent_run_id === expected.agentRunId
    && row.attempt_id === expected.attemptId
    && row.workflow_id === expected.workflowId
    && row.workflow_step_id === expected.workflowStepId
    && row.operation_id === expected.operationId
    && row.tool_use_id === expected.toolUseId
    && row.parent_event_id === expected.parentEventId
    && row.causation_id === expected.causationId
    && row.correlation_id === expected.correlationId
    && row.event_type === expected.eventType
    && row.occurred_at === expected.occurredAt
    && row.actor_json === expected.actorJson
    && row.payload_json === expected.payloadJson
    && row.payload_hash === expected.payloadHash
    && row.idempotency_key === expected.idempotencyKey
    && row.redaction_json === expected.redactionJson;
}

export class RuntimeEventConflictError extends Error {
  constructor(readonly eventId: string, detail = 'immutable envelope differs from persisted event') {
    super(`Runtime event ${eventId} conflicts: ${detail}`);
    this.name = 'RuntimeEventConflictError';
  }
}

export class RuntimeJournalStore {
  constructor(private readonly db: DB) {}

  append<T>(input: RuntimeEventAppendInput<T>): RuntimeEventEnvelopeV1<T> {
    const expected = canonicalInput(input);
    const existingRow = this.getRow(input.eventId);
    if (existingRow) {
      if (!immutableEnvelopeMatches(existingRow, expected, input.eventId)) {
        throw new RuntimeEventConflictError(input.eventId);
      }
      return hydrate<T>(existingRow);
    }

    const recordedAt = input.recordedAt ?? new Date().toISOString();
    try {
      const result = this.db.prepare(`
        INSERT INTO runtime_events (
          event_id, schema_version, event_class, partition_key, session_id, legacy_session_id,
          command_id, agent_run_id, attempt_id, workflow_id, workflow_step_id, operation_id,
          tool_use_id, parent_event_id, causation_id, correlation_id, event_type,
          occurred_at, recorded_at, actor_json, payload_json, payload_hash,
          idempotency_key, redaction_json
        ) VALUES (
          @eventId, @schemaVersion, @eventClass, @partitionKey, @sessionId, @legacySessionId,
          @commandId, @agentRunId, @attemptId, @workflowId, @workflowStepId, @operationId,
          @toolUseId, @parentEventId, @causationId, @correlationId, @eventType,
          @occurredAt, @recordedAt, @actorJson, @payloadJson, @payloadHash,
          @idempotencyKey, @redactionJson
        )
      `).run({ eventId: input.eventId, recordedAt, ...expected });
      return this.getByGlobalSeq<T>(Number(result.lastInsertRowid))!;
    } catch (error) {
      if (expected.idempotencyKey) {
        const byKey = this.getRowByIdempotency(expected.partitionKey, expected.eventType, expected.idempotencyKey);
        if (byKey) {
          if (!immutableEnvelopeMatches(byKey, expected, input.eventId)) {
            throw new RuntimeEventConflictError(input.eventId, 'idempotency key is already bound to another envelope');
          }
          return hydrate<T>(byKey);
        }
      }
      throw error;
    }
  }

  private getRow(eventId: string): RuntimeEventRow | null {
    return (this.db.prepare('SELECT * FROM runtime_events WHERE event_id = ?').get(eventId) as RuntimeEventRow | undefined) ?? null;
  }

  private getRowByIdempotency(partitionKey: string, type: string, key: string): RuntimeEventRow | null {
    return (this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE partition_key = ? AND event_type = ? AND idempotency_key = ?
    `).get(partitionKey, type, key) as RuntimeEventRow | undefined) ?? null;
  }

  get<T = unknown>(eventId: string): RuntimeEventEnvelopeV1<T> | null {
    const row = this.getRow(eventId);
    return row ? hydrate<T>(row) : null;
  }

  getByGlobalSeq<T = unknown>(globalSeq: number): RuntimeEventEnvelopeV1<T> | null {
    const row = this.db.prepare('SELECT * FROM runtime_events WHERE global_seq = ?').get(globalSeq) as RuntimeEventRow | undefined;
    return row ? hydrate<T>(row) : null;
  }

  getByIdempotency<T = unknown>(partitionKey: string, type: string, key: string): RuntimeEventEnvelopeV1<T> | null {
    const row = this.getRowByIdempotency(partitionKey, type, key);
    return row ? hydrate<T>(row) : null;
  }

  listPartition<T = unknown>(partitionKey: string, afterGlobalSeq = 0, limit = 1000): RuntimeEventEnvelopeV1<T>[] {
    const safeLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    return (this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE partition_key = ? AND global_seq > ?
      ORDER BY global_seq ASC LIMIT ?
    `).all(partitionKey, afterGlobalSeq, safeLimit) as RuntimeEventRow[]).map((row) => hydrate<T>(row));
  }
}
