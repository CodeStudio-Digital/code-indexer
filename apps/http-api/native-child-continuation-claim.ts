import type { ControlPlaneFileRepository } from '@mcp/session-storage';
import { hashControlPlanePayload, type ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import type { NativeChildRequest } from './native-child-admission.js';
import { parseNativeChildTranscriptRef } from './native-child-storage.js';
import { runtimeRequestId } from './runtime-attempt-ledger.js';

/** Single-consumer source reservation, before child admission/launch. A failed
 * or unacknowledged continuation can never make its older frontier reusable.
 * Called only under the session mutation queue after source authorization. */
export async function claimNativeChildContinuation(repository: ControlPlaneFileRepository, parent: ControlPlaneRunContext,
  request: NativeChildRequest, source: ControlPlaneRunContext | undefined): Promise<void> {
  if (!request.resumeFromRef) return;
  const target = parseNativeChildTranscriptRef(request.resumeFromRef);
  if (!source || source.sessionId !== parent.sessionId || target.sessionId !== source.sessionId
    || target.agentRunId !== source.agentRunId || target.attemptId !== source.attemptId) {
    throw new Error('Native child continuation source has not been authorized');
  }
  const id = runtimeRequestId(source.attemptId, 'child-continuation:claim');
  const data = { checkpointType: 'native-child-continuation-claim-v1', reference: request.resumeFromRef,
    parentAttemptId: parent.attemptId, parentAgentRunId: parent.agentRunId, commandId: parent.commandId,
    requestHash: hashControlPlanePayload(request), ownerId: parent.executorOwnerId, fencingEpoch: parent.fencingEpoch };
  const existing = await repository.get('runtimeRequest', id);
  if (existing) {
    if (hashControlPlanePayload(existing.data) !== hashControlPlanePayload(data)) {
      throw new Error('Native child continuation source is already claimed; reconcile its newer attempt');
    }
    return;
  }
  await repository.create('runtimeRequest', { id, operationId: id, relations: { session: parent.sessionId,
    command: parent.commandId, run: source.agentRunId, attempt: source.attemptId }, data });
}
