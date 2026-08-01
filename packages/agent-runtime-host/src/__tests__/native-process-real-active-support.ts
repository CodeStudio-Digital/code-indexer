import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { create, toBinary } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import type {
  DurableSupervisorFactPort,
} from '../driver/HostSupervisorFactTypes.js';
import type { HostHydrationSource } from '../ipc/HostDataHydration.js';
import { createAuthorityClock } from '../ipc/AttemptClock.js';
import { semanticSha256 } from '../ipc/semantic-hash.js';
import {
  loadNativeHostBridge,
} from '../native/NativeHostBridgeLoader.js';
import type {
  NativeRustHostAttemptRuntimeOptions,
} from '../native/NativeRustHostAttemptRuntime.js';
import {
  parseRuntimePackageAnchor,
} from '../packaging/RuntimePackageManifest.js';
import {
  verifyRuntimePackage,
} from '../packaging/RuntimePackageVerifier.js';
import type {
  VerifiedRuntimeBinary,
  VerifiedRuntimePackage,
} from '../packaging/RuntimePackageTypes.js';
import { resourceBudget } from './attempt-channel-support.js';
import {
  ACTIVATION_NONCE,
  activationAuthoritySeal,
} from './activation-authority-support.js';
import { grantForFacts } from './host-lifecycle-driver-support.js';
import {
  hostSupervisorHello,
  launchAttempt,
} from './host-supervisor-bootstrap-support.js';
import { hostHello } from './attempt-channel-support.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const TARGET = 'x86_64-pc-windows-msvc';
const SPEC_SCHEMA = 'codestudio.agent.v1.ResolvedAttemptSpec';

export interface ProcessRealFixture {
  readonly options: NativeRustHostAttemptRuntimeOptions;
  readonly prepare: agentV1Runtime.PrepareAttempt;
  readonly committedFacts: string[];
  readonly observed: {
    runnerProcessId?: number;
    sourceCloseCause?: unknown;
    readCount: number;
  };
}

export async function processRealFixture(
  corruptHydration = false,
): Promise<ProcessRealFixture> {
  const runtimePackage = await installedRuntimePackage();
  const nativeBinding = loadNativeHostBridge(runtimePackage);
  const sequence = randomUUID();
  const now = BigInt(Date.now());
  const hardDeadline = now + 120_000n;
  const specDeadline = now + 90_000n;
  const budget = resourceBudget();
  const runner = expectedProvenance(runtimePackage, 'runner');
  const supervisor = expectedProvenance(runtimePackage, 'supervisor');
  const launch = launchAttempt({
    resourceBudget: budget,
    hardDeadlineAtUnixMs: hardDeadline,
    authorityLeaseExpiresAtUnixMs: now + 110_000n,
    launchNonce: secretBytes(),
    expectedRunnerProvenance: runner,
    idempotencyKey: `process-real:${sequence}`,
    requiredEnforcedLimits: [agentV1Common.ResourceLimitKind.MEMORY],
    activationAuthoritySeal: activationAuthoritySeal(),
  });
  launch.identity!.rootAgentRunId = launch.identity!.agentRunId;
  launch.identity!.ownerAgentRunId = undefined;
  launch.identity!.parentAgentRunId = undefined;
  for (const endpoint of launch.protectedEndpoints) {
    const label = agentV1Supervisor.AttemptEndpointKind[endpoint.kind]
      .toLowerCase().replaceAll('_', '-');
    endpoint.endpointId = `process-real-${sequence}-${label}`;
    endpoint.connectionId = `process-real:${sequence}:${label}`;
    endpoint.connectionToken = secretBytes();
    endpoint.address = String.raw`\\.\pipe\codestudio-agent-v1-${sequence}-${label}`;
  }

  const hydration = hydrationFixture(sequence, corruptHydration);
  const prepare = resolvedPrepare(
    launch,
    hydration.snapshots,
    specDeadline,
    sequence,
  );
  const controlEndpoint = launch.protectedEndpoints.find((endpoint) =>
    endpoint.kind === agentV1Supervisor.AttemptEndpointKind.CONTROL
  )!;
  const controlHello = hostHello({
    connectionId: controlEndpoint.connectionId,
    contractVersion: runtimePackage.manifest.contractVersion,
    contractSchemaVersion: runtimePackage.manifest.contractSchemaVersion,
    connectionSessionToken: Uint8Array.from(controlEndpoint.connectionToken),
    allowedFeatureBits: 0n,
    requiredFeatureBits: 0n,
  });
  const managementConnection = `management:${sequence}`;
  const managementToken = secretBytes();
  const supervisorNonce = secretBytes();
  const supervisorHostHello = hostSupervisorHello();
  supervisorHostHello.connectionId = managementConnection;
  supervisorHostHello.contractVersion = runtimePackage.manifest.contractVersion;
  supervisorHostHello.contractSchemaVersion =
    runtimePackage.manifest.contractSchemaVersion;
  supervisorHostHello.expectedSupervisorProvenance = supervisor;
  supervisorHostHello.allowedRunnerProvenance = [runner];
  supervisorHostHello.managementSessionToken = Uint8Array.from(managementToken);
  supervisorHostHello.requiredContainmentLevel =
    agentV1Common.ContainmentLevel.HARD_AGGREGATE;
  Object.assign(supervisorHostHello.limits!, {
    maxActiveAttempts: 4,
    maxPendingLaunches: 4,
    maxReservedMemoryBytes: 1024n * 1024n * 1024n,
    maxReservedProcesses: 16,
    hostDisconnectGraceMs: 1_000n,
    runnerPulseTimeoutMs: 500n,
  });
  Object.assign(supervisorHostHello.frameLimits!, {
    maxInFlightFrames: 8n,
    maxInFlightBytes: 512n * 1024n,
    readTimeoutMs: 2_000n,
    writeTimeoutMs: 2_000n,
  });

  const committedFacts: string[] = [];
  const observed = hydration.observed;
  const durableFacts: DurableSupervisorFactPort = {
    async commit(fact, _binding, control) {
      control.signal.throwIfAborted();
      committedFacts.push(fact.case);
      if (fact.case === 'attemptProcessSpawned') {
        observed.runnerProcessId = fact.value.runnerProvenance?.pid;
      }
    },
  };
  return {
    prepare,
    committedFacts,
    observed,
    options: {
      binding: nativeBinding,
      runtimePackage,
      supervisor: {
        expectedConnectionId: managementConnection,
        expectedManagementSessionToken: managementToken,
        expectedSupervisorLaunchNonce: supervisorNonce,
        hostHello: supervisorHostHello,
        nowUnixMs: () => BigInt(Date.now()),
      },
      launch,
      openDeadlineAtUnixMs: now + 60_000n,
      durableFacts,
      management: {
        responseTimeoutMs: 2_000,
        maximumReplayBytes: 64 * 1024,
        trackedMessageIdCapacity: 16,
        durableCommitTimeoutMs: 2_000,
        integrationMode: 'shadow',
      },
      control: {
        hostHello: controlHello,
        supportedProtocols: { minimum: 65_537, maximum: 65_537 },
        expectedSnapshots: hydration.snapshots,
        expectedArtifacts: [],
        requiredContainmentLevel:
          agentV1Common.ContainmentLevel.HARD_PROCESS,
        requiredEnforcedLimits: [agentV1Common.ResourceLimitKind.MEMORY],
        specDeadlineAtUnixMs: specDeadline,
        outboundTimeoutMs: 10_000,
        durability: {
          async commitPrepared(facts) {
            const grant = grantForFacts(facts);
            grant.activate.identity = facts.prepare.identity;
            grant.activate.deadlineAtUnixMs = specDeadline;
            grant.activate.activationNonce = ACTIVATION_NONCE.slice();
            return grant;
          },
        },
        validateAgentHello: () => undefined,
      },
      data: {
        hostHello: controlHello,
        expectedSnapshots: hydration.snapshots,
        expectedArtifacts: [],
        requiredContainmentLevel:
          agentV1Common.ContainmentLevel.HARD_PROCESS,
        requiredEnforcedLimits: [agentV1Common.ResourceLimitKind.MEMORY],
        specDeadlineAtUnixMs: specDeadline,
        transferId: `process-real-hydration:${sequence}`,
        source: hydration.source,
        clock: createAuthorityClock(),
      },
    },
  };
}

function resolvedPrepare(
  launch: agentV1Supervisor.LaunchAttemptProcess,
  snapshots: readonly agentV1Common.SnapshotRef[],
  deadlineAtUnixMs: bigint,
  sequence: string,
): agentV1Runtime.PrepareAttempt {
  const [verifier, capabilities, environment, lease, policy, preset, definition]
    = snapshots;
  const spec = create(agentV1Runtime.ResolvedAttemptSpecSchema, {
    schemaVersion: 1,
    specVersion: 1n,
    identity: launch.identity,
    ordinal: 1,
    trigger: agentV1Runtime.AttemptTrigger.INITIAL,
    role: 'coder',
    agentDefinitionId: 'rust.process-real-e2e',
    task: { body: { case: 'inlineUtf8', value: 'Validate the Rust runtime' } },
    providerBinding: {
      requestedProvider: 'openai',
      requestedModel: 'gpt-5',
      effectiveProvider: 'openai',
      effectiveModel: 'gpt-5',
    },
    waitMode: agentV1Runtime.AgentRunWaitMode.FOREGROUND,
    runTreeBudget: { maxWallMs: 120_000n, maxAgents: 1, maxDepth: 1 },
    verifierPolicySnapshot: verifier,
    capabilitySetSnapshot: capabilities,
    environmentSnapshot: environment,
    workspaceLeaseSnapshot: lease,
    workspaceLeaseFencingEpoch: 7n,
    policySnapshot: policy,
    presetSnapshot: preset,
    resourceBudget: launch.resourceBudget,
    deadlineAtUnixMs,
    agentDefinitionSnapshot: definition,
  });
  const encodedSpec = toBinary(agentV1Runtime.ResolvedAttemptSpecSchema, spec);
  return create(agentV1Runtime.PrepareAttemptSchema, {
    identity: launch.identity,
    encodedSpec,
    expectedSpecSha256: semanticSha256({
      schemaId: SPEC_SCHEMA,
      schemaVersion: spec.schemaVersion,
      canonicalBytes: encodedSpec,
    }),
    expectedSnapshots: [...snapshots],
    idempotencyKey: `process-real-prepare:${sequence}`,
    specSchemaVersion: spec.schemaVersion,
  });
}

function hydrationFixture(sequence: string, corrupt: boolean) {
  const labels = [
    'verifier', 'capabilities', 'environment', 'workspace-lease',
    'policy', 'preset', 'agent-definition',
  ];
  const bodies = labels.map((label) => Buffer.from(`${label}:${sequence}`));
  const snapshots = labels.map((label, index) => create(
    agentV1Common.SnapshotRefSchema,
    {
      ref: `snapshot:${label}:${sequence}`,
      version: 1n,
      contentSha256: Uint8Array.from(
        createHash('sha256').update(bodies[index]!).digest(),
      ),
      origin: 'process-real-e2e',
      schemaId: `test.${label}`,
      schemaVersion: 1,
    },
  ));
  const observed: ProcessRealFixture['observed'] = {
    readCount: 0,
  };
  const source: HostHydrationSource = {
    items: snapshots.map((snapshot, index) => ({
      reference: { case: 'snapshot', value: snapshot },
      byteLength: BigInt(bodies[index]!.byteLength),
    })),
    async readExact(ordinal, offset, length, signal) {
      signal?.throwIfAborted();
      observed.readCount += 1;
      const value = Uint8Array.from(bodies[ordinal]!.subarray(
        Number(offset), Number(offset) + length,
      ));
      if (corrupt && ordinal === bodies.length - 1) value[0]! ^= 0xff;
      return value;
    },
    close(cause) {
      observed.sourceCloseCause = cause;
    },
  };
  return { source, snapshots, observed };
}

function expectedProvenance(
  runtimePackage: VerifiedRuntimePackage,
  role: 'runner' | 'supervisor',
): agentV1Supervisor.ExpectedRuntimeProvenance {
  const binary: VerifiedRuntimeBinary = runtimePackage.binaries[role];
  return create(agentV1Supervisor.ExpectedRuntimeProvenanceSchema, {
    buildId: runtimePackage.manifest.buildId,
    sourceCommit: runtimePackage.manifest.sourceCommit,
    binarySha256: Uint8Array.from(Buffer.from(binary.sha256, 'hex')),
    operatingSystem: runtimePackage.manifest.operatingSystem,
    architecture: runtimePackage.manifest.architecture,
  });
}

function secretBytes(): Uint8Array {
  return Uint8Array.from(randomBytes(32));
}

async function installedRuntimePackage(): Promise<VerifiedRuntimePackage> {
  const anchor = parseRuntimePackageAnchor(await readFile(resolve(
    ROOT,
    'dist/apps/electron/native-agent-runtime-integrity.json',
  )));
  return verifyRuntimePackage(
    resolve(ROOT, 'dist/native-agent-runtime', TARGET),
    anchor,
  );
}
