import { lstatSync, readFileSync } from 'node:fs';
import { asAgentRunId, asCompanySessionId } from '@mcp/session-storage';
import type { AgentSupervisionRecord } from './heartbeat-tracker.js';
import { DEFAULT_STATE_TIMEOUT_MS, type SupervisionState } from './state-machine.js';
import type { IncidentQueryRow, PersistedIncident } from './persistence.js';
export interface SupervisionRecordEnvelope {
  schemaVersion: 1;
  kind: 'company.supervisionRecord';
  id: string;
  companySessionId: string;
  updatedAt: string;
  record: AgentSupervisionRecord;
}

export interface SupervisionIncidentEnvelope {
  schemaVersion: 1;
  kind: 'company.supervisionIncident';
  id: string;
  companySessionId: string;
  createdAt: string;
  resolvedAtMs: number | null;
  incident: PersistedIncident;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isSafeNonnegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function isSupervisionState(value: unknown): value is SupervisionState {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(DEFAULT_STATE_TIMEOUT_MS, value)
  );
}

export function isNullableSupervisionState(
  value: unknown,
): value is SupervisionState | null {
  return value === null || isSupervisionState(value);
}

export function readJson(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe Company supervision file ${path}`);
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parsed;
}

export function parseRecord(path: string): AgentSupervisionRecord {
  const envelope = readJson(path);
  if (
    !isObject(envelope) ||
    envelope.schemaVersion !== 1 ||
    envelope.kind !== 'company.supervisionRecord' ||
    typeof envelope.id !== 'string' ||
    typeof envelope.companySessionId !== 'string' ||
    typeof envelope.updatedAt !== 'string' ||
    !isObject(envelope.record)
  ) {
    throw new Error(`Invalid Company supervision record envelope ${path}`);
  }
  const record = envelope.record;
  const agentRunId =
    typeof record.agentRunId === 'string'
      ? asAgentRunId(record.agentRunId)
      : null;
  const companySessionId =
    typeof record.companySessionId === 'string'
      ? asCompanySessionId(record.companySessionId)
      : null;
  if (
    agentRunId == null ||
    companySessionId == null ||
    envelope.id !== agentRunId ||
    envelope.companySessionId !== companySessionId ||
    typeof record.role !== 'string' ||
    !isSupervisionState(record.state) ||
    !isFiniteNumber(record.enteredAt) ||
    !isFiniteNumber(record.lastHeartbeatAt) ||
    !isNullableString(record.currentToolUseId) ||
    !isNullableString(record.currentToolName) ||
    !(
      record.stateTimeoutMsOverride === null ||
      isFiniteNumber(record.stateTimeoutMsOverride)
    ) ||
    !isSafeNonnegativeInteger(record.recoveryAttempts) ||
    !isSafeNonnegativeInteger(record.incidentCount)
  ) {
    throw new Error(`Invalid Company supervision record ${path}`);
  }
  return {
    agentRunId,
    companySessionId,
    role: record.role,
    state: record.state,
    enteredAt: record.enteredAt,
    lastHeartbeatAt: record.lastHeartbeatAt,
    currentToolUseId: record.currentToolUseId,
    currentToolName: record.currentToolName,
    stateTimeoutMsOverride: record.stateTimeoutMsOverride,
    recoveryAttempts: record.recoveryAttempts,
    incidentCount: record.incidentCount,
  };
}

export function parseIncident(path: string): IncidentQueryRow {
  const envelope = readJson(path);
  if (
    !isObject(envelope) ||
    envelope.schemaVersion !== 1 ||
    envelope.kind !== 'company.supervisionIncident' ||
    typeof envelope.id !== 'string' ||
    typeof envelope.companySessionId !== 'string' ||
    typeof envelope.createdAt !== 'string' ||
    !(
      envelope.resolvedAtMs === null ||
      isFiniteNumber(envelope.resolvedAtMs)
    ) ||
    !isObject(envelope.incident)
  ) {
    throw new Error(`Invalid Company supervision incident envelope ${path}`);
  }
  const incident = envelope.incident;
  const companySessionId =
    typeof incident.companySessionId === 'string'
      ? asCompanySessionId(incident.companySessionId)
      : null;
  const agentRunId =
    typeof incident.agentRunId === 'string'
      ? asAgentRunId(incident.agentRunId)
      : null;
  if (
    companySessionId == null ||
    envelope.companySessionId !== companySessionId ||
    typeof incident.incidentKind !== 'string' ||
    !isNullableSupervisionState(incident.fromState) ||
    !isNullableSupervisionState(incident.attemptedToState) ||
    typeof incident.detail !== 'string' ||
    !isFiniteNumber(incident.detectedAtMs) ||
    !isNullableString(incident.diagnosticJson) ||
    !isNullableString(incident.recoveryAction) ||
    !(
      incident.recoveryOutcome === null ||
      incident.recoveryOutcome === 'success' ||
      incident.recoveryOutcome === 'failed' ||
      incident.recoveryOutcome === 'queued'
    )
  ) {
    throw new Error(`Invalid Company supervision incident ${path}`);
  }
  return {
    id: envelope.id,
    agentRunId,
    companySessionId,
    incidentKind: incident.incidentKind,
    fromState: incident.fromState,
    attemptedToState: incident.attemptedToState,
    detail: incident.detail,
    diagnosticJson: incident.diagnosticJson,
    recoveryAction: incident.recoveryAction,
    recoveryOutcome: incident.recoveryOutcome,
    detectedAtMs: incident.detectedAtMs,
    resolvedAtMs: envelope.resolvedAtMs,
  };
}
