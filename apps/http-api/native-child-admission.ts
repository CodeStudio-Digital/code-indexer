import { createHash, randomUUID } from 'node:crypto';
import { fromBinary } from '@bufbuild/protobuf';
import { nativePrepareAttempt } from '@mcp/agent-runtime-host';
import { agentV1Runtime, asAgentRunId, asAgentRunAttemptId,
  type AgentRun, type AgentRunAttempt } from '@mcp/agent-runtime-contracts';
import type { ControlPlaneFileRepository } from '@mcp/session-storage';
import { hashControlPlanePayload, type ControlPlaneRunContext,
  type PersistedSessionCommand } from '@mcp/store/control-plane/index.js';
import { nativeRecordId, type NativePreparationRecord } from './native-attempt-preparation.js';
import { assertNoRuntimeCancellation } from './runtime-attempt-ledger.js';
import { parseNativeChildTranscriptRef } from './native-child-storage.js';
import { claimNativeChildContinuation } from './native-child-continuation-claim.js';

export interface NativeChildRequest {
  readonly idempotencyKey: string;
  readonly role: string;
  readonly agentDefinitionId: string;
  readonly taskSha256: string;
  readonly provider: string;
  readonly model: string;
  readonly deadlineAtUnixMs: number;
  readonly resumeFromRef?: string;
  /** New explicit work may reuse a completed child's verified transcript. */
  readonly continuationPurpose?: 'followup';
}
export interface NativeChildAdmission {
  readonly kind: 'reserved' | 'existing';
  readonly context: ControlPlaneRunContext;
  readonly rootAgentRunId: string;
  readonly parentAgentRunId: string;
  readonly spawnDepth: number;
}
export type NativeParentState = { command: PersistedSessionCommand; run: AgentRun; attempt: AgentRunAttempt };
export interface NativeChildReceipt {
  key: string;
  requestHash: string;
  request: NativeChildRequest;
  parentAttemptId: string;
  context: ControlPlaneRunContext;
  run: AgentRun;
  attempt: AgentRunAttempt;
}
export interface NativeTreeData {
  checkpointType: 'native-tree-v1';
  rootAgentRunId: string;
  rootAttemptId: string;
  children: NativeChildReceipt[];
}

export function nativeTreeId(attemptId: string): string {
  const hex = createHash('sha256').update(`native-tree:v1:${attemptId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Called under the owning session mutation queue. One durable record reserves
 * the identity and fan-out slot before either run projection is created. A lost
 * ACK returns "existing", which is never permission to launch again. This is
 * admission only: the executor must separately reserve shared consumption and
 * workspace authority before provisioning a child process. */
export async function admitNativeChild(repository: ControlPlaneFileRepository, parent: ControlPlaneRunContext,
  request: NativeChildRequest, assertParent: () => Promise<NativeParentState>, continuationSource?: ControlPlaneRunContext): Promise<NativeChildAdmission> {
  validateRequest(request);
  const state = await assertParent();
  const ancestry = await nativeParentAncestry(repository, parent, state);
  const { root, spec } = ancestry;
  const budget = spec.runTreeBudget;
  const depth = state.run.spawnDepth + 1;
  if (!budget?.maxAgents || budget.maxAgents > 256 || !budget.maxDepth || budget.maxDepth > 32
    || depth > budget.maxDepth) throw new Error('Native child exceeds its sealed tree depth or agent bound');
  if (request.deadlineAtUnixMs > Number(spec.executionDeadlineAtUnixMs || spec.deadlineAtUnixMs)
    || request.deadlineAtUnixMs > Date.parse(state.attempt.executorLease.expiresAt)
    || request.deadlineAtUnixMs > Date.parse(root.attempt.executorLease.expiresAt)) {
    throw new Error('Native child deadline exceeds its ancestor authority');
  }
  const id = nativeTreeId(root.attempt.attemptId);
  const record = await repository.get('nativeTree', id);
  const data = record?.data as unknown as NativeTreeData | undefined;
  if (data && (data.checkpointType !== 'native-tree-v1' || data.rootAgentRunId !== root.run.agentRunId
    || data.rootAttemptId !== root.attempt.attemptId || !Array.isArray(data.children)
    || data.children.length >= budget.maxAgents)) throw new Error('Native tree reservation is corrupt');
  const requestHash = hashControlPlanePayload(request);
  let receipt = data?.children.find(child => child.parentAttemptId === parent.attemptId && child.key === request.idempotencyKey);
  const kind = receipt ? 'existing' : 'reserved';
  if (receipt && (receipt.requestHash !== requestHash || hashControlPlanePayload(receipt.context.actor) !== hashControlPlanePayload(parent.actor))) {
    throw new Error('Native child idempotency input diverged');
  }
  if (!receipt) {
    if ((data?.children.length ?? 0) + 1 >= budget.maxAgents) throw new Error('Native tree agent budget is exhausted');
    await claimNativeChildContinuation(repository, parent, request, continuationSource);
    const now = new Date().toISOString();
    const context = { ...parent, agentRunId: asAgentRunId(randomUUID()), attemptId: asAgentRunAttemptId(randomUUID()), fencingEpoch: 1 };
    receipt = { key: request.idempotencyKey, requestHash, request, parentAttemptId: parent.attemptId, context,
      run: { agentRunId: context.agentRunId, specVersion: 1, sessionId: context.sessionId, commandId: context.commandId,
        ownerAgentRunId: root.run.agentRunId, parentAgentRunId: parent.agentRunId, spawnDepth: depth,
        role: request.role, status: 'starting', effectiveProvider: request.provider, effectiveModel: request.model,
        effectivePreset: request.agentDefinitionId, downgradeReasons: [], activeAttemptId: context.attemptId,
        createdAt: now, version: 1 },
      attempt: { attemptId: context.attemptId, agentRunId: context.agentRunId, ordinal: 1, trigger: 'initial',
        executorLease: { ownerId: parent.executorOwnerId, fencingEpoch: 1, status: 'active', acquiredAt: now,
          heartbeatAt: now, expiresAt: new Date(request.deadlineAtUnixMs).toISOString() },
        status: 'starting', providerRequestRefs: [], startedAt: now, version: 1 },
    };
    const next: NativeTreeData = { checkpointType: 'native-tree-v1', rootAgentRunId: root.run.agentRunId,
      rootAttemptId: root.attempt.attemptId, children: [...data?.children ?? [], receipt] };
    await assertParent();
    const value = { operationId: randomUUID(), relations: { session: parent.sessionId, run: root.run.agentRunId,
      attempt: root.attempt.attemptId }, data: { ...next } };
    if (record) await repository.update('nativeTree', id, value);
    else await repository.create('nativeTree', { id, ...value });
  }
  // Projection repair never rewinds an existing attempt, including terminals.
  if (!await repository.get('run', receipt.context.agentRunId)) await repository.createRun({ id: receipt.context.agentRunId,
    operationId: receipt.context.agentRunId, createdAt: receipt.run.createdAt, relations: { session: parent.sessionId,
      command: parent.commandId, parent: parent.agentRunId }, data: { status: receipt.run.status, run: receipt.run } });
  if (!await repository.get('attempt', receipt.context.attemptId)) await repository.createAttempt({ id: receipt.context.attemptId,
    operationId: receipt.context.attemptId, createdAt: receipt.attempt.startedAt, relations: { session: parent.sessionId,
      run: receipt.context.agentRunId }, data: { status: receipt.attempt.status, ordinal: 1, attempt: receipt.attempt } });
  await assertParent();
  return { kind, context: structuredClone(receipt.context), rootAgentRunId: root.run.agentRunId,
    parentAgentRunId: parent.agentRunId, spawnDepth: receipt.run.spawnDepth };
}

/** Every ancestor must remain in this command, current, uncancelled and Rust.
 * Following the actual parent chain also detects cycles and stale descendants. */
export async function nativeParentAncestry(repository: ControlPlaneFileRepository, context: ControlPlaneRunContext,
  state: NativeParentState) {
  const seen = new Set<string>();
  let current = state;
  let expectedDepth = state.run.spawnDepth;
  for (;;) {
    const { run, attempt } = current;
    if (seen.has(run.agentRunId) || seen.size >= 33 || run.spawnDepth !== expectedDepth
      || run.sessionId !== context.sessionId || run.commandId !== context.commandId
      || run.activeAttemptId !== attempt.attemptId || attempt.agentRunId !== run.agentRunId
      || run.status !== 'running' || attempt.status !== 'running' || attempt.executorLease.status !== 'active'
      || !Number.isFinite(Date.parse(attempt.executorLease.expiresAt)) || Date.parse(attempt.executorLease.expiresAt) <= Date.now()
      || current.command.status !== 'running') throw new Error('Native ancestor is fenced, inactive or malformed');
    seen.add(run.agentRunId);
    await assertNoRuntimeCancellation(repository, attempt.attemptId);
    const route = (await repository.get('runtimeRoute', attempt.attemptId))?.data.route as { runtimeGeneration?: string } | undefined;
    if (route?.runtimeGeneration !== 'rust_v1') throw new Error('Native tree cannot include a legacy or unrouted ancestor');
    if (run.agentRunId === state.command.agentRunId) {
      if (run.parentAgentRunId || run.ownerAgentRunId || run.spawnDepth !== 0) throw new Error('Native root identity is malformed');
      const data = (await repository.get('nativePreparation', nativeRecordId(attempt.attemptId, 'prepare')))?.data as unknown as NativePreparationRecord;
      if (data?.checkpointType !== 'native-preparation-v1' || typeof data.encodedPrepare !== 'string'
        || data.encodedPrepare.length > 12 * 1024 * 1024) throw new Error('Native root lacks sealed preparation');
      const prepared = fromBinary(agentV1Runtime.PrepareAttemptSchema, Buffer.from(data.encodedPrepare, 'base64'));
      const spec = fromBinary(agentV1Runtime.ResolvedAttemptSpecSchema, prepared.encodedSpec);
      if (spec.identity?.attemptId !== attempt.attemptId || spec.identity?.agentRunId !== run.agentRunId
        || !Buffer.from(nativePrepareAttempt(spec).expectedSpecSha256).equals(prepared.expectedSpecSha256)) {
        throw new Error('Native tree preparation identity differs');
      }
      return { root: current, spec };
    }
    if (!run.parentAgentRunId || run.ownerAgentRunId !== state.command.agentRunId || expectedDepth <= 0) {
      throw new Error('Native child belongs to another tree');
    }
    const parent = (await repository.get('run', run.parentAgentRunId))?.data.run as AgentRun | undefined;
    const parentAttempt = parent?.activeAttemptId
      ? (await repository.get('attempt', parent.activeAttemptId))?.data.attempt as AgentRunAttempt | undefined : undefined;
    if (!parent || !parentAttempt) throw new Error('Native child has a missing ancestor');
    current = { command: state.command, run: parent, attempt: parentAttempt }; expectedDepth--;
  }
}

function validateRequest(request: NativeChildRequest) {
  if (request.continuationPurpose !== undefined && (request.continuationPurpose !== 'followup' || !request.resumeFromRef)) {
    throw new Error('Invalid native child continuation purpose');
  }
  if (request.resumeFromRef !== undefined) parseNativeChildTranscriptRef(request.resumeFromRef);
  for (const key of ['idempotencyKey', 'role', 'agentDefinitionId', 'provider', 'model'] as const) {
    if (typeof request[key] !== 'string' || !request[key].trim() || request[key].length > 256) throw new Error(`Invalid native child ${key}`);
  }
  if (!/^[a-f0-9]{64}$/.test(request.taskSha256) || !Number.isSafeInteger(request.deadlineAtUnixMs)
    || request.deadlineAtUnixMs <= Date.now()) throw new Error('Invalid native child task or deadline');
}
