import {
asRuntimeEventId,
type AgentRun,
type AgentRunAttempt,
type CoderAttemptAdmissionV1,
type CoderAttemptPreparationV1,
type SessionCommandStatus,
type SessionId
} from '@mcp/agent-runtime-contracts';
import type { RuntimeRouteCommit,RuntimeRouteRecord } from '@mcp/agent-runtime-host';
import {
type ControlPlaneEntityDataMap,
type EntityRecord
} from '@mcp/session-storage';
import type {
AcceptCommandInput,
AcceptCommandResult,
ControlPlaneCommandContext,
ControlPlaneRunContext,
PersistedSessionCommand,
RuntimeEventAppendInput,
TerminalizeRunInput,
} from '@mcp/store/control-plane/index.js';
import { createHash } from 'node:crypto';

export interface FileControlPlaneAuthority {
  readonly journalEnabled: boolean;
  getAttemptState(context: ControlPlaneRunContext, requireActiveLease?: boolean): Promise<{
    command: PersistedSessionCommand; run: AgentRun; attempt: AgentRunAttempt;
  }>;
  getRuntimeRoute(sessionId: SessionId, attemptId: string): Promise<RuntimeRouteRecord | null>;
  commitRuntimeRoute(context: ControlPlaneRunContext, route: RuntimeRouteRecord): Promise<RuntimeRouteCommit>;
  commitRuntimeRequest(context: ControlPlaneRunContext, key: string, payload: unknown): Promise<boolean>;
  admitCoderAttempt(context: ControlPlaneRunContext, preparation: CoderAttemptPreparationV1): Promise<CoderAttemptAdmissionV1>;
  acceptCommand<T>(input: AcceptCommandInput<T>): Promise<AcceptCommandResult>;
  bindCommandExecution(
    context: ControlPlaneCommandContext,
    busId: string,
    occurredAt?: string,
  ): Promise<void>;
  terminalizeCommand(input: {
    context: ControlPlaneCommandContext;
    status: Extract<SessionCommandStatus, 'succeeded' | 'failed' | 'cancelled'>;
    reason: string;
    errorRef?: string;
    result?: unknown;
    occurredAt?: string;
    /** HTTP observer only: an already committed worker terminal wins. */
    preserveExistingTerminal?: boolean;
  }): Promise<void>;
  markRunStarted(
    context: ControlPlaneRunContext,
    runnerRunId?: string,
    requestedAt?: string,
  ): Promise<void>;
  renewAttemptLease(
    context: ControlPlaneRunContext,
    expiresAt: string,
    heartbeatAt?: string,
  ): Promise<void>;
  appendToolBoundary(input: {
    context: ControlPlaneRunContext;
    toolUseId: string;
    toolName: string;
    phase: 'started' | 'completed';
    occurredAt?: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
  appendRuntimeEvent<T>(input: RuntimeEventAppendInput<T>): Promise<void>;
  terminalizeRun(input: TerminalizeRunInput): Promise<void>;
  interruptRun(input: TerminalizeRunInput): Promise<void>;
  getCommand(
    sessionId: SessionId,
    commandId: string,
  ): Promise<PersistedSessionCommand | null>;
  getRun(
    sessionId: SessionId,
    agentRunId: string,
  ): Promise<AgentRun | null>;
  recordDivergences(
    context: Pick<
      ControlPlaneRunContext,
      | 'sessionId'
      | 'commandId'
      | 'agentRunId'
      | 'correlationId'
      | 'actor'
    >,
    divergences: readonly unknown[],
  ): Promise<void>;
  recoverInterruptedRuns(
    reason?: string,
    occurredAt?: string,
  ): Promise<number>;
}

interface StoredCommandData extends Record<string, unknown> {
  commandType: string;
  status: string;
  inputHash?: string;
  command: PersistedSessionCommand;
}

interface StoredRunData extends Record<string, unknown> {
  status: string;
  run: AgentRun;
}

interface StoredAttemptData extends Record<string, unknown> {
  ordinal: number;
  status: string;
  attempt: AgentRunAttempt;
}

export const TERMINAL_COMMAND_STATUSES = new Set<SessionCommandStatus>([
  'succeeded',
  'rejected',
  'cancelled',
  'failed',
]);

export const TERMINAL_RUN_STATUSES = new Set<AgentRun['status']>([
  'completed',
  'failed',
  'aborted',
  'interrupted',
]);

export function cleanJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(
    createHash('sha256').update(value).digest('hex').slice(0, 32),
    'hex',
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function eventId(...parts: string[]): ReturnType<typeof asRuntimeEventId> {
  return asRuntimeEventId(deterministicUuid(parts.join('\0')));
}

export function commandData(
  command: PersistedSessionCommand,
): ControlPlaneEntityDataMap['command'] {
  return cleanJson({
    commandType: command.kind,
    status: command.status,
    inputHash: command.payloadHash,
    command,
  } satisfies StoredCommandData);
}

export function runData(run: AgentRun): ControlPlaneEntityDataMap['run'] {
  return cleanJson({
    status: run.status,
    run,
  } satisfies StoredRunData);
}

export function attemptData(
  attempt: AgentRunAttempt,
): ControlPlaneEntityDataMap['attempt'] {
  return cleanJson({
    ordinal: attempt.ordinal,
    status: attempt.status,
    attempt,
  } satisfies StoredAttemptData);
}

export function persistedCommand(
  record: EntityRecord<ControlPlaneEntityDataMap['command']> | null,
): PersistedSessionCommand | null {
  if (!record) return null;
  const command = (record.data as unknown as StoredCommandData).command;
  return command ? cleanJson(command) : null;
}

export function persistedRun(
  record: EntityRecord<ControlPlaneEntityDataMap['run']> | null,
): AgentRun | null {
  if (!record) return null;
  const run = (record.data as unknown as StoredRunData).run;
  return run ? cleanJson(run) : null;
}

export function persistedAttempt(
  record: EntityRecord<ControlPlaneEntityDataMap['attempt']> | null,
): AgentRunAttempt | null {
  if (!record) return null;
  const attempt = (record.data as unknown as StoredAttemptData).attempt;
  return attempt ? cleanJson(attempt) : null;
}

export function iso(value = new Date().toISOString()): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`Invalid control-plane timestamp ${value}`);
  }
  return parsed.toISOString();
}

export function leaseExpired(expiresAt: string, at: string): boolean {
  return Date.parse(expiresAt) <= Date.parse(at);
}

export type ControlPlaneAuthority = FileControlPlaneAuthority;
