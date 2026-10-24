import { createHash } from 'node:crypto';
import { toBinary } from '@bufbuild/protobuf';
import { agentV1Runtime, type AgentRun, type AgentRunAttempt } from '@mcp/agent-runtime-contracts';
import type { ControlPlaneFileRepository } from '@mcp/session-storage';
import { hashControlPlanePayload, type ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import { nativeParentAncestry, nativeTreeId, type NativeParentState, type NativeTreeData } from './native-child-admission.js';

/** Child cleanup may record facts after root cancellation, but no active read,
 * preparation, renewal or effect may use an orphaned reservation. */
export async function assertNativeChildCurrent(repository: ControlPlaneFileRepository,
  context: ControlPlaneRunContext, state: NativeParentState) {
  const parent = state.run.parentAgentRunId
    ? (await repository.get('run', state.run.parentAgentRunId))?.data.run as AgentRun | undefined : undefined;
  const attempt = parent?.activeAttemptId
    ? (await repository.get('attempt', parent.activeAttemptId))?.data.attempt as AgentRunAttempt | undefined : undefined;
  if (!parent || !attempt) throw new Error('Native child has no current parent');
  const ancestry = await nativeParentAncestry(repository, context, { command: state.command, run: parent, attempt });
  const data = (await repository.get('nativeTree', nativeTreeId(ancestry.root.attempt.attemptId)))?.data as unknown as NativeTreeData | undefined;
  if (data?.checkpointType !== 'native-tree-v1' || data.rootAgentRunId !== ancestry.root.run.agentRunId
    || data.rootAttemptId !== ancestry.root.attempt.attemptId || !Array.isArray(data.children) || data.children.length > 255) {
    throw new Error('Native child has no durable tree reservation');
  }
  const receipt = data.children.find(child => child.context.attemptId === context.attemptId);
  if (!receipt || receipt.parentAttemptId !== parent.activeAttemptId
    || hashControlPlanePayload(receipt.context) !== hashControlPlanePayload(context)
    || receipt.requestHash !== hashControlPlanePayload(receipt.request)
    || receipt.run.parentAgentRunId !== parent.agentRunId || receipt.run.ownerAgentRunId !== ancestry.root.run.agentRunId
    || receipt.run.spawnDepth !== parent.spawnDepth + 1 || state.run.spawnDepth !== receipt.run.spawnDepth
    || state.run.ownerAgentRunId !== receipt.run.ownerAgentRunId
    || state.run.role !== receipt.request.role || state.attempt.ordinal !== receipt.attempt.ordinal
    || Date.parse(state.attempt.executorLease.expiresAt) > receipt.request.deadlineAtUnixMs) {
    throw new Error('Native child differs from its durable reservation');
  }
  return receipt;
}

export async function assertNativeChildPreparation(repository: ControlPlaneFileRepository,
  context: ControlPlaneRunContext, state: NativeParentState, spec: agentV1Runtime.ResolvedAttemptSpec): Promise<void> {
  const { request } = await assertNativeChildCurrent(repository, context, state);
  if (!spec.task || request.taskSha256 !== createHash('sha256').update(toBinary(agentV1Runtime.TaskInputSchema, spec.task)).digest('hex')
    || spec.providerBinding?.effectiveProvider !== request.provider || spec.providerBinding.effectiveModel !== request.model
    || spec.agentDefinitionId !== request.agentDefinitionId || spec.role !== request.role
    || spec.deadlineAtUnixMs > BigInt(request.deadlineAtUnixMs)) {
    throw new Error('Native child preparation differs from its reserved task, model or deadline');
  }
}
