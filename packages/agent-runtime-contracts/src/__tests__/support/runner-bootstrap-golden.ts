import { Buffer } from 'node:buffer';
import { create } from '@bufbuild/protobuf';
import {
  ContainmentLevel,
  ResourceLimitKind,
} from '../../generated/v1/codestudio/agent/v1/common_pb.js';
import {
  RunnerEndpointProvisioning,
  RunnerEndpointsReadySchema,
  RunnerExpectedPeerRole,
  RunnerLaunchHandoffSchema,
  RunnerListenerSlot,
} from '../../generated/v1/codestudio/agent/v1/runner_bootstrap_pb.js';
import { AttemptEndpointKind } from '../../generated/v1/codestudio/agent/v1/supervisor_pb.js';

const endpointCases = [
  {
    kind: AttemptEndpointKind.CONTROL,
    name: 'control',
    cap: 256n * 1024n,
    role: RunnerExpectedPeerRole.HOST,
    slot: RunnerListenerSlot.CONTROL,
    token: 0x11,
  },
  {
    kind: AttemptEndpointKind.DATA,
    name: 'data',
    cap: 1024n * 1024n,
    role: RunnerExpectedPeerRole.HOST,
    slot: RunnerListenerSlot.DATA,
    token: 0x22,
  },
  {
    kind: AttemptEndpointKind.RUNNER_PULSE,
    name: 'pulse',
    cap: 4n * 1024n,
    role: RunnerExpectedPeerRole.SUPERVISOR,
    slot: RunnerListenerSlot.RUNNER_PULSE,
    token: 0x33,
  },
] as const;

export function goldenRunnerLaunchHandoff() {
  return goldenRunnerLaunchHandoffForPlatform(false);
}

export function goldenUnixRunnerLaunchHandoff() {
  return goldenRunnerLaunchHandoffForPlatform(true);
}

export function goldenRunnerEndpointsReady() {
  const handoff = goldenRunnerLaunchHandoff();
  return create(RunnerEndpointsReadySchema, {
    schemaVersion: handoff.schemaVersion,
    identity: handoff.identity,
    runtimeInstanceId: handoff.runtimeInstanceId,
    runnerProcessId: handoff.runnerProcessId,
    acknowledgedHandoffSha256: Buffer.from(
      '807193088d6ac318c4ab3c76790b1417fbcb5ba931330cabb2163ec110aebb6b',
      'hex',
    ),
    endpoints: handoff.endpoints.map(
      ({ kind, endpointId, address, connectionId }) => ({
        kind,
        endpointId,
        address,
        connectionId,
      }),
    ),
  });
}

function goldenRunnerLaunchHandoffForPlatform(unix: boolean) {
  return create(RunnerLaunchHandoffSchema, {
    schemaVersion: 1,
    identity: {
      sessionId: '11111111-1111-4111-8111-111111111111',
      commandId: '22222222-2222-4222-8222-222222222222',
      agentRunId: '33333333-3333-4333-8333-333333333333',
      attemptId: '44444444-4444-4444-8444-444444444444',
      executorOwnerId: 'host:desktop',
      fencingEpoch: 9_007_199_254_740_993n,
      correlationId: '55555555-5555-4555-8555-555555555555',
      rootAgentRunId: '33333333-3333-4333-8333-333333333333',
      ownerAgentRunId: '77777777-7777-4777-8777-777777777777',
    },
    runtimeInstanceId: 'runtime:opaque/7',
    runnerProcessId: 303,
    endpoints: endpointCases.map(({ kind, name, cap, role, slot, token }) => ({
      kind,
      endpointId: `endpoint:${name}`,
      address: unix ? `unix:slot/${name}/7` : `\\\\.\\pipe\\${name}-7`,
      connectionId: `connection:${name}/7`,
      connectionToken: Uint8Array.from({ length: 16 }, () => token),
      maxFrameBytes: cap,
      provisioning: unix
        ? RunnerEndpointProvisioning.UNIX_RECEIVE_BOUND_SOCKET
        : RunnerEndpointProvisioning.WINDOWS_CREATE_NAMED_PIPE,
      listenerSlot: unix ? slot : RunnerListenerSlot.UNSPECIFIED,
      expectedPeerRole: role,
    })),
    launchNonce: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    hardDeadlineAtUnixMs: 1_784_894_460_123n,
    reservedResourceBudget: {
      softMemoryBytes: 268_435_456n,
      hardMemoryBytes: 536_870_912n,
      cpuTimeMs: 120_000n,
      maxWallMs: 180_000n,
      maxProcesses: 8,
      maxThreads: 32,
      maxOpenHandles: 512,
      maxHotTranscriptBytes: 4_194_304n,
      maxIpcFrames: 128,
      maxIpcBytes: 8_388_608n,
      maxSpoolBytes: 67_108_864n,
      maxArtifactBytes: 16_777_216n,
      maxConcurrentTools: 4,
      maxBlockingTasks: 4,
      cancelGraceMs: 5_000n,
    },
    effectiveContainment: {
      level: ContainmentLevel.HARD_AGGREGATE,
      enforcedLimits: [
        ResourceLimitKind.MEMORY,
        ResourceLimitKind.CPU_TIME,
        ResourceLimitKind.WALL_TIME,
        ResourceLimitKind.PROCESSES,
      ],
      unsupportedLimits: [
        ResourceLimitKind.THREADS,
        ResourceLimitKind.OPEN_HANDLES,
        ResourceLimitKind.SCRATCH_BYTES,
      ],
      capabilities: {
        processTree: true,
        memoryLimit: true,
        cpuLimit: true,
        processCountLimit: true,
      },
    },
    launchManagementPayloadSha256: Uint8Array.from(
      { length: 32 },
      (_, index) => index + 32,
    ),
    expectedHostPeer: {
      processId: 101,
      unixUserId: unix ? 1_000 : undefined,
    },
    expectedSupervisorPeer: {
      processId: 202,
      unixUserId: unix ? 1_000 : undefined,
    },
    activationAuthoritySeal: {
      agentRunVersion: 8n,
      attemptVersion: 5n,
      activationNonceSha256: Uint8Array.from(
        { length: 32 },
        (_, index) => index + 64,
      ),
    },
  });
}
