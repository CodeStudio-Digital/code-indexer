import { createHash } from 'node:crypto';
import type { RuntimeRouteCommit, RuntimeRouteRecord } from '@mcp/agent-runtime-host';
import type { ControlPlaneFileRepository } from '@mcp/session-storage';
import { hashControlPlanePayload, type ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';

export function runtimeRequestId(attemptId: string, key: string): string {
  const hex = createHash('sha256').update(`runtime-request:v1:${attemptId}:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function assertNoRuntimeCancellation(repository: ControlPlaneFileRepository, attemptId: string): Promise<void> {
  if (await repository.get('runtimeRequest', runtimeRequestId(attemptId, 'cancel'))) {
    throw new Error('Attempt has a committed cancellation request');
  }
}

/** Call only inside the owning session's mutation queue. */
export async function commitRuntimeRoute(repository: ControlPlaneFileRepository,
  context: ControlPlaneRunContext, route: RuntimeRouteRecord): Promise<RuntimeRouteCommit> {
  if (route.sessionId !== context.sessionId || route.agentRunId !== context.agentRunId
    || route.attemptId !== context.attemptId) throw new Error('Runtime route belongs to another attempt');
  const existing = await repository.get('runtimeRoute', context.attemptId);
  if (existing) return { record: existing.data.route as RuntimeRouteRecord, inserted: false };
  await repository.create('runtimeRoute', {
    id: context.attemptId, operationId: context.attemptId,
    relations: { session: context.sessionId, command: context.commandId, run: context.agentRunId, attempt: context.attemptId },
    data: { checkpointType: 'runtime-route-v1', route, ownerId: context.executorOwnerId, fencingEpoch: context.fencingEpoch },
  });
  return { record: route, inserted: true };
}

/** Persist intent before a control RPC. An existing receipt is NOT evidence
 * that an interrupted interaction RPC was delivered and may be retried. */
export async function commitRuntimeRequest(repository: ControlPlaneFileRepository,
  context: ControlPlaneRunContext, key: string, payload: unknown): Promise<boolean> {
  if (!key || key.length > 512) throw new Error('Invalid runtime request key');
  const id = runtimeRequestId(context.attemptId, key);
  const continuation = key === 'continuation:source' ? continuationProof(payload, context.attemptId) : undefined;
  // Mailbox/job receipts retain their bounded payload, not only its hash, so
  // interrupted delivery can be inspected without repeating an effect.
  const nativeTree = key.startsWith('native-tree:') ? nativeTreeReceipt(payload) : undefined;
  const data = { checkpointType: 'runtime-request-v1', key, payloadHash: hashControlPlanePayload(payload),
    ownerId: context.executorOwnerId, fencingEpoch: context.fencingEpoch,
    ...(continuation ? { continuation } : {}), ...(nativeTree ? { nativeTree } : {}) };
  const existing = await repository.get('runtimeRequest', id);
  if (existing) {
    if (hashControlPlanePayload(existing.data) !== hashControlPlanePayload(data)) {
      throw new Error('Runtime request was already committed with different input or authority');
    }
    return false;
  }
  await repository.create('runtimeRequest', { id, operationId: id,
    relations: { session: context.sessionId, command: context.commandId, run: context.agentRunId, attempt: context.attemptId }, data });
  return true;
}

function nativeTreeReceipt(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid native tree receipt');
  const data = payload as Record<string, unknown>;
  if (data.schema !== 1 || !['message', 'inbox', 'job', 'result'].includes(String(data.type))
    || Buffer.byteLength(JSON.stringify(data)) > 256 * 1024) throw new Error('Invalid or oversized native tree receipt');
  return structuredClone(data);
}

function continuationProof(payload: unknown, attemptId: string) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid continuation source proof');
  const proof = payload as Record<string, unknown>;
  if (typeof proof.sourceAttemptId !== 'string' || proof.sourceAttemptId === attemptId
    || !/^[a-f0-9-]{36}$/i.test(proof.sourceAttemptId)
    || typeof proof.sourceAgentRunId !== 'string' || !/^[a-f0-9-]{36}$/i.test(proof.sourceAgentRunId)
    || typeof proof.committedRecords !== 'string' || !/^[1-9][0-9]{0,5}$/.test(proof.committedRecords)
    || typeof proof.lastCommitSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.lastCommitSha256)
    || typeof proof.messagesSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.messagesSha256)) {
    throw new Error('Invalid continuation source proof');
  }
  return { sourceAttemptId: proof.sourceAttemptId, sourceAgentRunId: proof.sourceAgentRunId,
    committedRecords: proof.committedRecords, lastCommitSha256: proof.lastCommitSha256, messagesSha256: proof.messagesSha256 };
}
