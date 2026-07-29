import { randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  asAgentRunId,
  asCompanySessionId,
  atomicWriteJson,
  isUuid,
} from '@mcp/session-storage';
import type { AgentSupervisionRecord } from './heartbeat-tracker.js';
import {
  DEFAULT_STATE_TIMEOUT_MS,
  type SupervisionState,
} from './state-machine.js';
import type {
  IncidentQueryRow,
  PersistedIncident,
  SupervisionPersistence,
} from './persistence.js';

interface SupervisionRecordEnvelope {
  schemaVersion: 1;
  kind: 'company.supervisionRecord';
  id: string;
  companySessionId: string;
  updatedAt: string;
  record: AgentSupervisionRecord;
}

interface SupervisionIncidentEnvelope {
  schemaVersion: 1;
  kind: 'company.supervisionIncident';
  id: string;
  companySessionId: string;
  createdAt: string;
  resolvedAtMs: number | null;
  incident: PersistedIncident;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isSupervisionState(value: unknown): value is SupervisionState {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(DEFAULT_STATE_TIMEOUT_MS, value)
  );
}

function isNullableSupervisionState(
  value: unknown,
): value is SupervisionState | null {
  return value === null || isSupervisionState(value);
}

function ensureSafeDirectory(
  rootPath: string,
  segments: readonly string[],
): string {
  let current = resolve(rootPath);
  const rootStat = lstatSync(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Unsafe Company session bundle root ${current}`);
  }
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Unsafe Company supervision directory ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(current, { mode: 0o700 });
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Unsafe Company supervision directory ${current}`);
      }
    }
  }
  return current;
}

function readJson(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe Company supervision file ${path}`);
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parsed;
}

function parseRecord(path: string): AgentSupervisionRecord {
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

function parseIncident(path: string): IncidentQueryRow {
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

function listEntityPaths(directory: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are forbidden in Company supervision: ${path}`);
    }
    if (
      entry.isFile() &&
      entry.name.endsWith('.json') &&
      isUuid(entry.name.slice(0, -'.json'.length))
    ) {
      paths.push(path);
      continue;
    }
    if (entry.name.includes('.tmp-')) continue;
    throw new Error(`Unexpected Company supervision entry ${path}`);
  }
  return paths;
}

/**
 * Filesystem-only supervisor persistence. Every record and incident owns its
 * own atomically replaced JSON file, so the supervisor never writes SQLite
 * and never contends with another Company entity.
 */
export class FileSupervisionPersistence implements SupervisionPersistence {
  private readonly companySessionId: string;
  private readonly recordsDirectory: string;
  private readonly incidentsDirectory: string;
  private mutationTail: Promise<void> = Promise.resolve();
  private lastMutationError: unknown = null;

  constructor(input: {
    companySessionId: string;
    sessionRoot: string;
  }) {
    this.companySessionId = asCompanySessionId(input.companySessionId);
    this.recordsDirectory = ensureSafeDirectory(input.sessionRoot, [
      'company',
      'supervision',
      'records',
    ]);
    this.incidentsDirectory = ensureSafeDirectory(input.sessionRoot, [
      'company',
      'supervision',
      'incidents',
    ]);
    accessSync(this.recordsDirectory, constants.R_OK | constants.W_OK);
    accessSync(this.incidentsDirectory, constants.R_OK | constants.W_OK);
  }

  loadAll(): AgentSupervisionRecord[] {
    return listEntityPaths(this.recordsDirectory)
      .map((path) => parseRecord(path))
      .filter((record) => record.companySessionId === this.companySessionId);
  }

  async saveRecord(record: AgentSupervisionRecord): Promise<void> {
    const normalized = this.normalizeRecord(record);
    await this.enqueue(async () => {
      await atomicWriteJson(
        join(this.recordsDirectory, `${normalized.agentRunId}.json`),
        {
          schemaVersion: 1,
          kind: 'company.supervisionRecord',
          id: normalized.agentRunId,
          companySessionId: this.companySessionId,
          updatedAt: new Date().toISOString(),
          record: normalized,
        } satisfies SupervisionRecordEnvelope,
        { context: { operation_id: 'company:supervision:save-record' } },
      );
    });
  }

  async saveHeartbeats(
    records: ReadonlyArray<{ agentRunId: string; lastHeartbeatAt: number }>,
  ): Promise<void> {
    const normalized = records.map((record) => ({
      agentRunId: asAgentRunId(record.agentRunId),
      lastHeartbeatAt: record.lastHeartbeatAt,
    }));
    await this.enqueue(async () => {
      for (const heartbeat of normalized) {
        const path = join(
          this.recordsDirectory,
          `${heartbeat.agentRunId}.json`,
        );
        let current: AgentSupervisionRecord;
        try {
          current = parseRecord(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        await atomicWriteJson(
          path,
          {
            schemaVersion: 1,
            kind: 'company.supervisionRecord',
            id: current.agentRunId,
            companySessionId: this.companySessionId,
            updatedAt: new Date().toISOString(),
            record: {
              ...current,
              lastHeartbeatAt: heartbeat.lastHeartbeatAt,
            },
          } satisfies SupervisionRecordEnvelope,
          { context: { operation_id: 'company:supervision:heartbeat' } },
        );
      }
    });
  }

  async deleteRecord(agentRunId: string): Promise<void> {
    const normalized = asAgentRunId(agentRunId);
    await this.enqueue(async () => {
      const path = join(this.recordsDirectory, `${normalized}.json`);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`Unsafe Company supervision record ${path}`);
        }
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
  }

  async saveIncident(incident: PersistedIncident): Promise<void> {
    const companySessionId = asCompanySessionId(
      incident.companySessionId ?? this.companySessionId,
    );
    if (companySessionId !== this.companySessionId) {
      throw new Error(
        `Supervisor incident belongs to ${companySessionId}, expected ${this.companySessionId}`,
      );
    }
    const agentRunId =
      incident.agentRunId == null
        ? null
        : asAgentRunId(incident.agentRunId);
    const id = randomUUID();
    const normalized: PersistedIncident = {
      agentRunId,
      companySessionId,
      incidentKind: incident.incidentKind,
      fromState: incident.fromState ?? null,
      attemptedToState: incident.attemptedToState ?? null,
      detail: incident.detail,
      diagnosticJson: incident.diagnosticJson ?? null,
      recoveryAction: incident.recoveryAction ?? null,
      recoveryOutcome: incident.recoveryOutcome ?? null,
      detectedAtMs: incident.detectedAtMs,
    };
    await this.enqueue(async () => {
      await atomicWriteJson(
        join(this.incidentsDirectory, `${id}.json`),
        {
          schemaVersion: 1,
          kind: 'company.supervisionIncident',
          id,
          companySessionId,
          createdAt: new Date().toISOString(),
          resolvedAtMs: null,
          incident: normalized,
        } satisfies SupervisionIncidentEnvelope,
        { context: { operation_id: 'company:supervision:save-incident' } },
      );
    });
  }

  async resolveIncident(
    incidentId: string,
    resolvedAtMs: number,
  ): Promise<void> {
    if (!isUuid(incidentId)) {
      throw new Error(`Invalid Company supervision incident id ${incidentId}`);
    }
    const id = incidentId.toLowerCase();
    await this.enqueue(async () => {
      const path = join(this.incidentsDirectory, `${id}.json`);
      const current = parseIncident(path);
      if (current.companySessionId == null) {
        throw new Error(`Company supervision incident lost its owner ${path}`);
      }
      const companySessionId = asCompanySessionId(current.companySessionId);
      const rawEnvelope = readJson(path);
      if (
        !isObject(rawEnvelope) ||
        typeof rawEnvelope.createdAt !== 'string'
      ) {
        throw new Error(`Invalid Company supervision incident envelope ${path}`);
      }
      await atomicWriteJson(
        path,
        {
          schemaVersion: 1,
          kind: 'company.supervisionIncident',
          id: current.id,
          companySessionId,
          createdAt: rawEnvelope.createdAt,
          resolvedAtMs,
          incident: {
            agentRunId: current.agentRunId,
            companySessionId,
            incidentKind: current.incidentKind,
            fromState: current.fromState,
            attemptedToState: current.attemptedToState,
            detail: current.detail,
            diagnosticJson: current.diagnosticJson,
            recoveryAction: current.recoveryAction,
            recoveryOutcome: current.recoveryOutcome,
            detectedAtMs: current.detectedAtMs,
          },
        } satisfies SupervisionIncidentEnvelope,
        { context: { operation_id: 'company:supervision:resolve-incident' } },
      );
    });
  }

  listRecentIncidents(
    sessionId: string,
    limit: number,
  ): IncidentQueryRow[] {
    const normalizedSessionId = asCompanySessionId(sessionId);
    if (normalizedSessionId !== this.companySessionId) return [];
    const boundedLimit = Math.max(0, Math.min(Math.trunc(limit), 1_000));
    return listEntityPaths(this.incidentsDirectory)
      .map((path) => parseIncident(path))
      .filter(
        (incident) => incident.companySessionId === normalizedSessionId,
      )
      .sort(
        (left, right) =>
          right.detectedAtMs - left.detectedAtMs ||
          right.id.localeCompare(left.id),
      )
      .slice(0, boundedLimit);
  }

  async close(): Promise<void> {
    await this.mutationTail;
    if (this.lastMutationError != null) throw this.lastMutationError;
  }

  private normalizeRecord(
    record: AgentSupervisionRecord,
  ): AgentSupervisionRecord {
    const companySessionId = asCompanySessionId(record.companySessionId);
    if (companySessionId !== this.companySessionId) {
      throw new Error(
        `Supervisor record belongs to ${companySessionId}, expected ${this.companySessionId}`,
      );
    }
    return {
      ...record,
      agentRunId: asAgentRunId(record.agentRunId),
      companySessionId,
    };
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.mutationTail.then(operation, operation);
    this.mutationTail = pending.catch((error: unknown) => {
      this.lastMutationError ??= error;
    });
    return pending;
  }
}
