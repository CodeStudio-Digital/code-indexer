import type DatabaseConstructor from 'better-sqlite3';
import {
  asAgentRunId,
  asCorrelationId,
  asSessionCommandId,
  asSessionId,
  type SessionCommand,
  type SessionCommandStatus,
} from '@mcp/agent-runtime-contracts';
import { parseControlPlaneJson, stableControlPlaneJson } from './codec.js';
import type { PersistedSessionCommand } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

interface CommandRow {
  command_id: string;
  schema_version: 1;
  session_id: string;
  legacy_session_id: number | null;
  idempotency_key: string;
  kind: SessionCommand['kind'];
  payload_hash: string;
  status: SessionCommandStatus;
  actor_json: string;
  expected_session_version: number | null;
  session_version: number;
  correlation_id: string;
  agent_run_id: string | null;
  reason_code: string | null;
  error_ref: string | null;
  result_json: string | null;
  requested_at: string;
  deadline_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

const TERMINAL_COMMAND_STATUSES = new Set<SessionCommandStatus>([
  'succeeded', 'rejected', 'cancelled', 'failed',
]);

export class CommandStateConflictError extends Error {
  constructor(commandId: string, detail: string) {
    super(`Command ${commandId} state conflict: ${detail}`);
    this.name = 'CommandStateConflictError';
  }
}

function hydrate(row: CommandRow): PersistedSessionCommand {
  return {
    commandId: asSessionCommandId(row.command_id),
    schemaVersion: row.schema_version,
    sessionId: asSessionId(row.session_id),
    legacySessionId: row.legacy_session_id ?? undefined,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    payloadHash: row.payload_hash,
    status: row.status,
    actor: parseControlPlaneJson(row.actor_json, { actorId: 'unknown', actorType: 'system', source: 'recovery' }),
    expectedSessionVersion: row.expected_session_version ?? undefined,
    sessionVersion: row.session_version,
    correlationId: asCorrelationId(row.correlation_id),
    agentRunId: row.agent_run_id ? asAgentRunId(row.agent_run_id) : undefined,
    reasonCode: row.reason_code ?? undefined,
    errorRef: row.error_ref ?? undefined,
    result: row.result_json == null ? undefined : parseControlPlaneJson(row.result_json, undefined),
    requestedAt: row.requested_at,
    deadlineAt: row.deadline_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CommandLedgerStore {
  constructor(private readonly db: DB) {}

  get(commandId: string): PersistedSessionCommand | null {
    const row = this.db.prepare('SELECT * FROM session_commands WHERE command_id = ?').get(commandId) as CommandRow | undefined;
    return row ? hydrate(row) : null;
  }

  findByIdempotency(sessionId: string, kind: SessionCommand['kind'], key: string): PersistedSessionCommand | null {
    const row = this.db.prepare(`
      SELECT * FROM session_commands
      WHERE session_id = ? AND kind = ? AND idempotency_key = ?
    `).get(sessionId, kind, key) as CommandRow | undefined;
    return row ? hydrate(row) : null;
  }

  insertAccepted<T>(
    command: SessionCommand<T>,
    payloadHash: string,
    sessionVersion: number,
    legacySessionId?: number,
    agentRunId?: string,
  ): PersistedSessionCommand {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO session_commands (
        command_id, schema_version, session_id, legacy_session_id, idempotency_key, kind,
        payload_hash, status, actor_json, expected_session_version, session_version,
        correlation_id, agent_run_id, requested_at, deadline_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      command.commandId, command.schemaVersion, command.sessionId, legacySessionId ?? null,
      command.idempotencyKey, command.kind, payloadHash, stableControlPlaneJson(command.actor),
      command.expectedSessionVersion ?? null, sessionVersion, command.correlationId,
      agentRunId ?? null, command.requestedAt, command.deadlineAt ?? null, now, now,
    );
    return this.get(command.commandId)!;
  }

  linkAgentRun(commandId: string, agentRunId: string, updatedAt = new Date().toISOString()): void {
    const current = this.get(commandId);
    if (!current) throw new CommandStateConflictError(commandId, 'not found');
    if (current.agentRunId === agentRunId) return;
    if (current.agentRunId) {
      throw new CommandStateConflictError(commandId, `already linked to ${current.agentRunId}`);
    }
    const result = this.db.prepare(`
      UPDATE session_commands SET agent_run_id = ?, updated_at = ?
      WHERE command_id = ? AND agent_run_id IS NULL
    `).run(agentRunId, updatedAt, commandId);
    if (result.changes !== 1) throw new CommandStateConflictError(commandId, 'link changed concurrently');
  }

  markRunning(commandId: string, updatedAt = new Date().toISOString()): PersistedSessionCommand {
    const current = this.get(commandId);
    if (!current) throw new CommandStateConflictError(commandId, 'not found');
    if (current.status === 'running') return current;
    if (current.status !== 'accepted') {
      throw new CommandStateConflictError(commandId, `cannot transition ${current.status} -> running`);
    }
    const result = this.db.prepare(`
      UPDATE session_commands SET status = 'running', updated_at = ?
      WHERE command_id = ? AND status = 'accepted'
    `).run(updatedAt, commandId);
    if (result.changes !== 1) throw new CommandStateConflictError(commandId, 'start changed concurrently');
    return this.get(commandId)!;
  }

  markTerminal(
    commandId: string,
    status: Extract<SessionCommandStatus, 'succeeded' | 'failed' | 'cancelled'>,
    patch: { reasonCode?: string; errorRef?: string; result?: unknown; completedAt?: string } = {},
  ): PersistedSessionCommand {
    const current = this.get(commandId);
    if (!current) throw new CommandStateConflictError(commandId, 'not found');
    if (TERMINAL_COMMAND_STATUSES.has(current.status) && current.status !== status) {
      throw new CommandStateConflictError(commandId, `already terminal as ${current.status}`);
    }
    if (patch.reasonCode !== undefined && current.reasonCode !== undefined && current.reasonCode !== patch.reasonCode) {
      throw new CommandStateConflictError(commandId, 'reason code differs from persisted terminal');
    }
    if (patch.errorRef !== undefined && current.errorRef !== undefined && current.errorRef !== patch.errorRef) {
      throw new CommandStateConflictError(commandId, 'error ref differs from persisted terminal');
    }
    const resultJson = patch.result === undefined ? null : stableControlPlaneJson(patch.result);
    if (resultJson !== null && current.result !== undefined && stableControlPlaneJson(current.result) !== resultJson) {
      throw new CommandStateConflictError(commandId, 'result differs from persisted terminal');
    }
    const completedAt = current.completedAt ?? patch.completedAt ?? new Date().toISOString();
    const update = this.db.prepare(`
      UPDATE session_commands SET
        status = ?, reason_code = COALESCE(reason_code, ?), error_ref = COALESCE(error_ref, ?),
        result_json = COALESCE(result_json, ?), completed_at = COALESCE(completed_at, ?), updated_at = ?
      WHERE command_id = ? AND status IN ('accepted', 'running', ?)
    `).run(
      status, patch.reasonCode ?? null, patch.errorRef ?? null, resultJson,
      completedAt, completedAt, commandId, status,
    );
    if (update.changes !== 1) throw new CommandStateConflictError(commandId, 'terminal update changed concurrently');
    return this.get(commandId)!;
  }
}
