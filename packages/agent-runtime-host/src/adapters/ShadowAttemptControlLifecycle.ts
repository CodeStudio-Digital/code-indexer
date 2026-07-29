import { HostAttemptLifecycleDriver } from '../driver/HostAttemptLifecycleDriver.js';
import {
  HostLifecycleLaunchAuthority,
  type HostLifecycleLaunchProvision,
} from '../driver/HostLifecycleLaunchAuthority.js';
import { AttemptControlAdapterError } from './AttemptControlAdapterError.js';
import type { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import type {
  BoundDurableAttemptControlLaunch,
} from './DurableAttemptControlBinding.js';
import {
  assertCleanupDisposition,
  type AuthenticatedAttemptControlConnection,
} from './ProtectedAttemptControlEndpoint.js';
import type {
  ShadowAttemptControlPlan,
} from './ShadowAttemptControlPlan.js';

const CONTROL_MAXIMUM_FRAME_BYTES = 256 * 1024;

export function createBoundAttemptLifecycle(
  transport: DelimitedByteChannel,
  plan: ShadowAttemptControlPlan,
  bound: BoundDurableAttemptControlLaunch,
): HostAttemptLifecycleDriver {
  const actual = bound.runnerProvenance;
  const provision: HostLifecycleLaunchProvision = {
    transport,
    expectedIdentity: plan.identity,
    expectedConnectionId: plan.connectionId,
    expectedConnectionSessionToken:
      plan.hostHello.connectionSessionToken,
    expectedLaunchNonce: plan.launchNonce,
    expectedRuntimeInstanceId: bound.runtimeInstanceId,
    expectedContractVersion: plan.hostHello.contractVersion,
    expectedContractSchemaVersion: plan.hostHello.contractSchemaVersion,
    expectedProvenance: {
      buildId: actual.buildId,
      sourceCommit: actual.sourceCommit,
      binarySha256: actual.binarySha256,
      pid: actual.pid,
      operatingSystem: actual.operatingSystem,
      architecture: actual.architecture,
    },
    supportedProtocols: plan.supportedProtocols,
    resourceBudget: plan.resourceBudget,
    hardDeadlineAtUnixMs: plan.hardDeadlineAtUnixMs,
    heartbeatPolicy: {
      intervalMs: plan.hostHello.heartbeatIntervalMs,
      timeoutMs: plan.hostHello.heartbeatTimeoutMs,
    },
    featurePolicy: {
      allowedFeatureBits: plan.hostHello.allowedFeatureBits,
      requiredFeatureBits: plan.hostHello.requiredFeatureBits,
    },
    validateAgentHello: plan.validateAgentHello,
    expectedSnapshots: plan.expectedSnapshots,
    expectedArtifacts: plan.expectedArtifacts,
    requiredContainmentLevel: plan.requiredContainmentLevel,
    requiredEnforcedLimits: plan.requiredEnforcedLimits,
    specDeadlineAtUnixMs: plan.specDeadlineAtUnixMs,
    activationAuthoritySeal: plan.activationAuthoritySeal,
  };
  const launch = HostLifecycleLaunchAuthority.provision(provision);
  return new HostAttemptLifecycleDriver({
    launch,
    hostHello: plan.hostHello,
    durability: plan.durability,
    outboundTimeoutMs: plan.outboundTimeoutMs,
  });
}

export function handoffPhysicalAttemptControlTransport(
  connection: AuthenticatedAttemptControlConnection,
): DelimitedByteChannel {
  const expected = connection.transport;
  const transferred = connection.handoffTransport();
  if (transferred !== expected) {
    bestEffort(() => transferred.fail(
      new AttemptControlAdapterError(
        'invalid_connection',
        'physical control handoff substituted its verified transport',
      ),
    ));
    throw new AttemptControlAdapterError(
      'invalid_connection',
      'physical control handoff substituted its verified transport',
    );
  }
  return transferred;
}

export function assertPhysicalAttemptControlConnection(
  connection: AuthenticatedAttemptControlConnection,
  plan: ShadowAttemptControlPlan,
  bound: BoundDurableAttemptControlLaunch,
): void {
  const limits = plan.hostHello.frameLimits;
  if (
    connection.endpointId !== plan.endpointId
    || connection.connectionId !== plan.connectionId
    || connection.peerPid !== bound.runnerProvenance.pid
    || connection.transport.maximumFrameBytes
      !== CONTROL_MAXIMUM_FRAME_BYTES
    || !limits
    || connection.transport.maximumTransportChunkBytes
      !== Number(limits.maxChunkBytes)
    || connection.transport.readTimeoutMs !== Number(limits.readTimeoutMs)
    || connection.transport.writeTimeoutMs !== Number(limits.writeTimeoutMs)
  ) {
    throw new AttemptControlAdapterError(
      'invalid_connection',
      'physical control connection diverges from durable launch authority',
    );
  }
}

export function revokePhysicalAttemptControlConnection(
  connection: AuthenticatedAttemptControlConnection,
  cause: unknown,
): void {
  bestEffort(() => assertCleanupDisposition(
    connection.revokeBeforeHandoff(cause),
  ));
  bestEffort(() => connection.transport.fail(cause));
}

function bestEffort(operation: () => void): void {
  try {
    operation();
  } catch {
    // The first protocol failure remains authoritative.
  }
}
