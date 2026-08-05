import type {
  BoundDurableAttemptLaunch,
} from './DurableAttemptControlBinding.js';
import type { AuthorityClock } from '../ipc/AttemptClock.js';
import type { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import {
  createHostPendingDataAttemptChannel,
  type HostPendingDataAttemptChannel,
} from '../ipc/HostDataAttemptChannel.js';
import { AttemptControlAdapterError } from './AttemptControlAdapterError.js';
import {
  type AuthenticatedAttemptDataConnection,
  assertDataCleanupDisposition,
} from './ProtectedAttemptDataEndpoint.js';
import type {
  ShadowAttemptDataPlan,
} from './ShadowAttemptDataPlan.js';

export function createPendingHostDataChannel(
  transport: DelimitedByteChannel,
  plan: ShadowAttemptDataPlan,
  bound: BoundDurableAttemptLaunch,
  clock: AuthorityClock,
): HostPendingDataAttemptChannel {
  return createHostPendingDataAttemptChannel({
    transport,
    identity: plan.identity,
    runtimeInstanceId: bound.runtimeInstanceId,
    connectionId: plan.connectionId,
    connectionSessionToken: plan.connectionToken,
    protocolVersion: plan.protocolVersion,
    effectiveLimits: plan.effectiveLimits,
    maxIpcFrames: plan.resourceBudget.maxIpcFrames,
    hardDeadlineAtUnixMs: plan.hardDeadlineAtUnixMs,
    clock,
  });
}

export function assertPhysicalAttemptDataConnection(
  connection: AuthenticatedAttemptDataConnection,
  plan: ShadowAttemptDataPlan,
  bound: BoundDurableAttemptLaunch,
): void {
  const limits = plan.effectiveLimits;
  if (
    connection.endpointId !== plan.endpointId
    || connection.connectionId !== plan.connectionId
    || connection.peerPid !== bound.runnerProvenance.pid
    || connection.transport.maximumFrameBytes
      !== Number(limits.maxFrameBytes)
    || connection.transport.maximumTransportChunkBytes <= 0
    || connection.transport.maximumTransportChunkBytes
      > Number(limits.maxChunkBytes)
    || connection.transport.readTimeoutMs
      !== Number(limits.readTimeoutMs)
    || connection.transport.writeTimeoutMs
      !== Number(limits.writeTimeoutMs)
  ) throw invalidConnection(
    'physical data connection diverges from durable launch authority',
  );
}

export function handoffPhysicalAttemptDataTransport(
  connection: AuthenticatedAttemptDataConnection,
): DelimitedByteChannel {
  const expected = connection.transport;
  const transferred = connection.handoffTransport();
  if (transferred !== expected) {
    bestEffort(() => transferred.fail(invalidConnection(
      'physical data handoff substituted its verified transport',
    )));
    throw invalidConnection(
      'physical data handoff substituted its verified transport',
    );
  }
  return transferred;
}

export function revokePhysicalAttemptDataConnection(
  connection: AuthenticatedAttemptDataConnection,
  cause: unknown,
): void {
  bestEffort(() => assertDataCleanupDisposition(
    connection.revokeBeforeHandoff(cause),
  ));
  bestEffort(() => connection.transport.fail(cause));
}

function invalidConnection(message: string): AttemptControlAdapterError {
  return new AttemptControlAdapterError('invalid_connection', message);
}

export function bestEffort(operation: () => void): void {
  try {
    operation();
  } catch {
    // The first protocol failure remains authoritative.
  }
}
