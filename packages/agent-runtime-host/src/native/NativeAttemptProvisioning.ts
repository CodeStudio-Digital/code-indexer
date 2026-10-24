import { randomBytes, randomUUID } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Runtime, agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import { createAuthorityClock } from '../ipc/AttemptClock.js';
import { detachedMessage } from '../ipc/DetachedMessage.js';
import { semanticSha256 } from '../ipc/semantic-hash.js';
import { validateResourceBudget } from '../ipc/HostLaunchProvisionValidation.js';
import type { HostHydrationSource } from '../ipc/HostDataHydration.js';
import type { PreparedDurabilityPort } from '../driver/HostLifecycleTypes.js';
import type { DurableSupervisorFactPort } from '../driver/HostSupervisorFactTypes.js';
import type { VerifiedRuntimePackage } from '../packaging/RuntimePackageTypes.js';
import type { NativeRustHostAttemptRuntimeOptions } from './NativeRustHostAttemptRuntime.js';
import { loadNativeHostBridge } from './NativeHostBridgeLoader.js';

export interface NativeAttemptProvisioningInput {
  readonly spec: agentV1Runtime.ResolvedAttemptSpec;
  readonly runtimePackage: VerifiedRuntimePackage;
  readonly leaseExpiresAtUnixMs: bigint;
  readonly activationAuthoritySeal: agentV1Common.ActivationAuthoritySeal;
  readonly requiredContainmentLevel: agentV1Common.ContainmentLevel;
  readonly requiredEnforcedLimits: readonly agentV1Common.ResourceLimitKind[];
  readonly durability: PreparedDurabilityPort;
  readonly durableFacts: (managementConnectionId: string) => DurableSupervisorFactPort;
  readonly source: HostHydrationSource;
  readonly providerGatewayFactory: NonNullable<NativeRustHostAttemptRuntimeOptions['data']['providerGatewayFactory']>;
  readonly capabilityGatewayFactory: NonNullable<NativeRustHostAttemptRuntimeOptions['data']['capabilityGatewayFactory']>;
  readonly sessionStore: NonNullable<NativeRustHostAttemptRuntimeOptions['sessionStore']>;
  readonly sessionStoreReady?: NativeRustHostAttemptRuntimeOptions['sessionStoreReady'];
  readonly beforeSupervisorSpawn?: NativeRustHostAttemptRuntimeOptions['beforeSupervisorSpawn'];
  readonly beforeTerminalCommit?: NativeRustHostAttemptRuntimeOptions['beforeTerminalCommit'];
  /** Certification stays explicit until all product surface gates pass. */
  readonly integrationMode: 'test' | 'shadow';
}

export function nativePrepareAttempt(spec: agentV1Runtime.ResolvedAttemptSpec): agentV1Runtime.PrepareAttempt {
  const encodedSpec = toBinary(agentV1Runtime.ResolvedAttemptSpecSchema, spec);
  const snapshots = [spec.verifierPolicySnapshot, spec.capabilitySetSnapshot, spec.environmentSnapshot,
    spec.workspaceLeaseSnapshot, spec.policySnapshot, spec.presetSnapshot, spec.agentDefinitionSnapshot,
    ...(spec.codexAppServerProcessSnapshot ? [spec.codexAppServerProcessSnapshot] : []),
    ...(spec.initialConversationSnapshot ? [spec.initialConversationSnapshot] : [])];
  if (snapshots.some((snapshot) => !snapshot)) throw new Error('Native attempt is missing provenance snapshots');
  return create(agentV1Runtime.PrepareAttemptSchema, {
    identity: spec.identity, encodedSpec, specSchemaVersion: spec.schemaVersion,
    expectedSpecSha256: semanticSha256({ schemaId: 'codestudio.agent.v1.ResolvedAttemptSpec',
      schemaVersion: spec.schemaVersion, canonicalBytes: encodedSpec }),
    expectedSnapshots: snapshots as agentV1Common.SnapshotRef[], idempotencyKey: `native-prepare:${spec.identity?.attemptId}`,
  });
}

/** Builds a single-use physical launch from admitted product inputs. No
 * credentials enter the process: provider and policy ports stay in the Host. */
export function provisionNativeAttempt(input: NativeAttemptProvisioningInput): NativeRustHostAttemptRuntimeOptions {
  if (process.platform !== 'win32' || input.runtimePackage.manifest.operatingSystem !== 'windows') {
    throw new Error('Native product attempt provisioning is currently certified only for Windows shadow runs');
  }
  const spec = detachedMessage(agentV1Runtime.ResolvedAttemptSpecSchema, input.spec);
  const budget = spec.resourceBudget;
  if (!budget) throw new Error('Native attempt requires a resource budget');
  validateResourceBudget(budget);
  // DLL verification/loading can be slow on a cold Windows install. It is
  // preparation, not part of the protected process-opening window. Absolute
  // execution and lease deadlines are checked again after it returns.
  const binding = loadNativeHostBridge(input.runtimePackage);
  const clock = createAuthorityClock();
  const now = clock.now();
  if (!spec.identity || !budget || spec.deadlineAtUnixMs <= now || input.leaseExpiresAtUnixMs <= now
    || spec.deadlineAtUnixMs - now > budget.maxWallMs || input.sessionStore.sessionId !== spec.identity.sessionId) {
    throw new Error('Native attempt provisioning has divergent or expired authority');
  }
  const runtimePackage = input.runtimePackage;
  const bootstrapWindow = min(30_000n, budget.maxWallMs);
  const sequence = randomUUID();
  const secret = () => Uint8Array.from(randomBytes(32));
  const provenance = (role: 'runner' | 'supervisor') => create(agentV1Supervisor.ExpectedRuntimeProvenanceSchema, {
    buildId: runtimePackage.manifest.buildId, sourceCommit: runtimePackage.manifest.sourceCommit,
    binarySha256: Uint8Array.from(Buffer.from(runtimePackage.binaries[role].sha256, 'hex')),
    operatingSystem: runtimePackage.manifest.operatingSystem, architecture: runtimePackage.manifest.architecture,
  });
  const endpoints = ([
    [agentV1Supervisor.AttemptEndpointKind.CONTROL, 'control', 256 * 1024],
    [agentV1Supervisor.AttemptEndpointKind.DATA, 'data', 1024 * 1024],
    [agentV1Supervisor.AttemptEndpointKind.RUNNER_PULSE, 'pulse', 4 * 1024],
  ] as const).map(([kind, label, maximum]) => create(agentV1Supervisor.ProtectedAttemptEndpointSchema, {
    kind, endpointId: `native-${sequence}-${label}`, connectionId: `native:${sequence}:${label}`,
    address: String.raw`\\.\pipe\codestudio-agent-v1-${sequence}-${label}`,
    connectionToken: secret(), maxFrameBytes: BigInt(maximum),
  }));
  const launch = create(agentV1Supervisor.LaunchAttemptProcessSchema, {
    identity: spec.identity, resourceBudget: budget, authorityLeaseExpiresAtUnixMs: min(spec.deadlineAtUnixMs, input.leaseExpiresAtUnixMs),
    // Admission requires the nominal resource duration to fit after launch;
    // allow the same opening window used below, not an unrelated 10s margin.
    // The authority lease above still expires at the original spec deadline.
    hardDeadlineAtUnixMs: now + budget.maxWallMs + bootstrapWindow, launchNonce: secret(), protectedEndpoints: endpoints,
    expectedRunnerProvenance: provenance('runner'), idempotencyKey: `native-launch:${spec.identity.attemptId}`,
    requiredEnforcedLimits: [...input.requiredEnforcedLimits],
    activationAuthoritySeal: detachedMessage(agentV1Common.ActivationAuthoritySealSchema, input.activationAuthoritySeal),
  });
  const controlEndpoint = endpoints[0]!;
  const heartbeatTimeout = min(5_000n, budget.maxWallMs);
  if (heartbeatTimeout < 2n) throw new Error('Native execution budget cannot support a heartbeat');
  const hostHello = create(agentV1Runtime.HostHelloSchema, {
    selectedProtocol: { major: 1, minor: 1 }, connectionId: controlEndpoint.connectionId,
    contractVersion: runtimePackage.manifest.contractVersion, contractSchemaVersion: runtimePackage.manifest.contractSchemaVersion,
    connectionSessionToken: Uint8Array.from(controlEndpoint.connectionToken), heartbeatIntervalMs: min(1_000n, heartbeatTimeout / 2n), heartbeatTimeoutMs: heartbeatTimeout,
    frameLimits: { maxFrameBytes: 256n * 1024n, maxChunkBytes: 64n * 1024n, maxInFlightFrames: 1n,
      maxInFlightBytes: 256n * 1024n, readTimeoutMs: min(30_000n, budget.maxWallMs), writeTimeoutMs: min(30_000n, budget.maxWallMs) },
  });
  const managementConnection = `native-management:${sequence}`;
  const managementToken = secret();
  const supervisor = {
    expectedConnectionId: managementConnection, expectedManagementSessionToken: managementToken,
    expectedSupervisorLaunchNonce: secret(), nowUnixMs: () => clock.now(),
    hostHello: create(agentV1Supervisor.HostSupervisorHelloSchema, {
      selectedProtocol: { major: 1, minor: 1 }, connectionId: managementConnection,
      contractVersion: runtimePackage.manifest.contractVersion, contractSchemaVersion: runtimePackage.manifest.contractSchemaVersion,
      managementSessionToken: Uint8Array.from(managementToken), expectedSupervisorProvenance: provenance('supervisor'),
      allowedRunnerProvenance: [provenance('runner')], requiredContainmentLevel: input.requiredContainmentLevel,
      limits: { maxActiveAttempts: 1, maxPendingLaunches: 1, maxReservedMemoryBytes: budget.hardMemoryBytes,
        maxReservedProcesses: budget.maxProcesses, hostDisconnectGraceMs: min(1_000n, budget.cancelGraceMs), runnerPulseTimeoutMs: 500n },
      frameLimits: { maxFrameBytes: 64n * 1024n, maxChunkBytes: 16n * 1024n, maxInFlightFrames: 8n,
        maxInFlightBytes: 512n * 1024n, readTimeoutMs: 2_000n, writeTimeoutMs: 2_000n },
    }),
  };
  const prepare = nativePrepareAttempt(spec);
  const common = { hostHello, expectedSnapshots: prepare.expectedSnapshots,
    expectedArtifacts: [spec.task?.body.case === 'artifact' ? spec.task.body.value : undefined,
      ...(spec.task?.attachments ?? []), spec.checkpointInput, spec.transcriptInput].filter((value) => value !== undefined),
    requiredContainmentLevel: input.requiredContainmentLevel, requiredEnforcedLimits: [...input.requiredEnforcedLimits],
    specDeadlineAtUnixMs: spec.deadlineAtUnixMs };
  return {
    binding, runtimePackage, supervisor, launch,
    openDeadlineAtUnixMs: min(now + bootstrapWindow, min(spec.deadlineAtUnixMs, input.leaseExpiresAtUnixMs)), durableFacts: input.durableFacts(managementConnection),
    management: { launchResponseTimeoutMs: Number(bootstrapWindow),
      responseTimeoutMs: 2_000, maximumReplayBytes: 64 * 1024, trackedMessageIdCapacity: 4096,
      durableCommitTimeoutMs: 2_000, integrationMode: input.integrationMode },
    control: { ...common, clock, supportedProtocols: { minimum: 65_537, maximum: 65_537 }, outboundTimeoutMs: Number(min(10_000n, budget.maxWallMs)),
      durability: input.durability, validateAgentHello: (hello) => {
        if (hello.contractVersion !== runtimePackage.manifest.contractVersion
          || hello.contractSchemaVersion !== runtimePackage.manifest.contractSchemaVersion) throw new Error('Native runner contract mismatch');
      } },
    data: { ...common, source: input.source, clock, transferId: `native-hydration:${sequence}`,
      providerGatewayFactory: input.providerGatewayFactory, capabilityGatewayFactory: input.capabilityGatewayFactory },
    sessionStore: { ...input.sessionStore, nowUnixMs: () => clock.now() },
    sessionStoreReady: input.sessionStoreReady,
    beforeSupervisorSpawn: input.beforeSupervisorSpawn,
    beforeTerminalCommit: input.beforeTerminalCommit,
  };
}

function min(a: bigint, b: bigint) { return a < b ? a : b; }
