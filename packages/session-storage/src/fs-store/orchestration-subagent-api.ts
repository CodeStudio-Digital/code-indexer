import type { SessionId } from '@mcp/session-storage';
import type { AgentMessage } from '@mcp/provider-sdk';
import { FsSessionEntityFiles } from './entity-files.js';
import {
  FsOrchestrationCheckpointRepository,
  type FsOrchestrationCheckpointKind,
  type FsOrchestrationCheckpointRow,
  type FsSaveOrchestrationCheckpointInput,
} from './orchestration-checkpoint-repository.js';
import { FsSessionDirectory } from './session-directory.js';
import {
  FsSubagentRepository,
  type FsCompleteSubagentRunInput,
  type FsStartSubagentRunInput,
  type FsSubagentRunFence,
  type FsSubagentRunPage,
  type FsSubagentToolCallInput,
  type FsWorkflowStepRunReconciliation,
} from './subagent-repository.js';

class FsOrchestrationSubagentOperations {
  readonly #orchestration: FsOrchestrationCheckpointRepository;
  readonly #subagents: FsSubagentRepository;

  constructor(
    directory: FsSessionDirectory,
    entities: FsSessionEntityFiles,
  ) {
    this.#orchestration = new FsOrchestrationCheckpointRepository(
      directory,
      entities,
    );
    this.#subagents = new FsSubagentRepository(directory, entities);
  }

  saveOrchestrationCheckpoint = (
    input: FsSaveOrchestrationCheckpointInput,
  ): Promise<boolean> => this.#orchestration.save(input);

  loadOrchestrationCheckpoint = (
    id: SessionId | string,
    kind: FsOrchestrationCheckpointKind,
    scopeId: string,
  ): Promise<FsOrchestrationCheckpointRow | null> =>
    this.#orchestration.load(id, kind, scopeId);

  listOrchestrationCheckpoints = (
    id: SessionId | string,
    kind: FsOrchestrationCheckpointKind,
    limit?: number,
  ): Promise<FsOrchestrationCheckpointRow[]> =>
    this.#orchestration.list(id, kind, limit);

  removeOrchestrationCheckpoint = (
    id: SessionId | string,
    kind: FsOrchestrationCheckpointKind,
    scopeId: string,
    leaseToken?: string,
  ): Promise<void> =>
    this.#orchestration.remove(id, kind, scopeId, leaseToken);

  /** Read-only history. Never use these records to authorize a resume lease. */
  loadOrchestrationCheckpointForAudit = (
    id: SessionId | string,
    kind: FsOrchestrationCheckpointKind,
    scopeId: string,
  ): Promise<FsOrchestrationCheckpointRow | null> =>
    this.#orchestration.load(id, kind, scopeId, true);

  listOrchestrationCheckpointsForAudit = (
    id: SessionId | string,
    kind: FsOrchestrationCheckpointKind,
    limit?: number,
  ): Promise<FsOrchestrationCheckpointRow[]> =>
    this.#orchestration.list(id, kind, limit, true);

  tryAcquireOrchestrationCheckpoint = (
    id: SessionId | string,
    kind: FsOrchestrationCheckpointKind,
    scopeId: string,
    durationMs?: number,
  ): Promise<string | null> =>
    this.#orchestration.tryAcquire(id, kind, scopeId, durationMs);

  renewOrchestrationCheckpoint = (
    id: SessionId | string,
    kind: FsOrchestrationCheckpointKind,
    scopeId: string,
    leaseToken: string,
    durationMs?: number,
  ): Promise<boolean> =>
    this.#orchestration.renew(
      id,
      kind,
      scopeId,
      leaseToken,
      durationMs,
    );

  releaseOrchestrationCheckpoint = (
    id: SessionId | string,
    kind: FsOrchestrationCheckpointKind,
    scopeId: string,
    leaseToken: string,
  ): Promise<void> =>
    this.#orchestration.release(id, kind, scopeId, leaseToken);

  startSubagentRun = (
    input: FsStartSubagentRunInput,
  ): Promise<FsSubagentRunFence> => this.#subagents.start(input);

  assertSubagentRunFence = (
    fence: FsSubagentRunFence,
  ): Promise<void> => this.#subagents.assertFence(fence);

  heartbeatSubagentRun = (
    runId: string,
    fence: FsSubagentRunFence,
  ): Promise<void> => this.#subagents.heartbeat(runId, fence);

  recordSubagentToolCall = (
    input: FsSubagentToolCallInput,
  ): Promise<void> => this.#subagents.recordToolCall(input);

  completeSubagentRun = (
    input: FsCompleteSubagentRunInput,
  ): Promise<void> => this.#subagents.complete(input);

  reconcileWorkflowStepRun = (
    id: SessionId | string,
    groupId: string,
    stepId: string,
  ): Promise<FsWorkflowStepRunReconciliation> =>
    this.#subagents.reconcileWorkflowStepRun(id, groupId, stepId);

  writeSubagentTranscript = (
    id: SessionId | string,
    spawnId: string,
    agentIndex: number,
    transcript: AgentMessage[],
  ): Promise<string | null> =>
    this.#subagents.writeTranscript(id, spawnId, agentIndex, transcript);

  findSubagentTranscript = (
    id: SessionId | string,
    spawnId: string,
    agentIndex: number,
  ): Promise<string | null> =>
    this.#subagents.findTranscript(id, spawnId, agentIndex);

  recoverOrphanedSubagentRuns = (): Promise<number> =>
    this.#subagents.recoverOrphaned();

  listSubagentRuns = (
    id: SessionId | string,
    offset: number,
    limit: number,
  ): Promise<FsSubagentRunPage> =>
    this.#subagents.listPage(id, offset, limit);
}

export type FsOrchestrationSubagentApi = Pick<
  FsOrchestrationSubagentOperations,
  keyof FsOrchestrationSubagentOperations
>;

export function installOrchestrationSubagentApi(
  target: object,
  directory: FsSessionDirectory,
  entities: FsSessionEntityFiles,
): void {
  const operations = new FsOrchestrationSubagentOperations(
    directory,
    entities,
  );
  for (const name of Object.keys(operations)) {
    if (name.startsWith('#')) continue;
    Object.defineProperty(target, name, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: operations[name as keyof FsOrchestrationSubagentOperations],
    });
  }
}
