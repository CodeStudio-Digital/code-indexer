import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { create, toBinary } from '@bufbuild/protobuf';
import {
  agentV1Capability,
  agentV1Common,
  agentV1Runtime,
  agentV1SessionStore,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import type { ChatRequest } from '@mcp/provider-sdk/adapter.js';
import {
  createNativeReadCapabilityGatewayFactory,
} from '../capability-gateway/NativeReadCapabilityPolicy.js';
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
import { ProviderGateway } from '../provider-gateway/ProviderGateway.js';
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
  readonly sessionRoot?: string;
  readonly workspaceRoot?: string;
  readonly expectedReadContent?: string;
  readonly observed: {
    runnerProcessId?: number;
    exitCause?: agentV1Supervisor.PhysicalExitCause;
    sourceCloseCause?: unknown;
    providerGatewayCreated?: boolean;
    providerRunStarted?: boolean;
    providerResolved?: boolean;
    providerRunCount: number;
    toolResultObserved?: boolean;
    readCount: number;
  };
}

export async function processRealFixture(
  corruptHydration = false,
  productiveEngine = true,
): Promise<ProcessRealFixture> {
  const runtimePackage = await installedRuntimePackage();
  const nativeBinding = loadNativeHostBridge(runtimePackage);
  const sequence = randomUUID();
  const sessionRoot = productiveEngine
    ? await mkdtemp(join(tmpdir(), 'codestudio-rust-session-'))
    : undefined;
  const workspaceRoot = sessionRoot && join(sessionRoot, 'workspace');
  const expectedReadContent = productiveEngine
    ? `native read payload:${sequence}`
    : undefined;
  if (workspaceRoot) {
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, 'sample.txt'), expectedReadContent!, 'utf8');
  }
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
  const capabilityGatewayFactory = productiveEngine
    ? createNativeReadCapabilityGatewayFactory({
      rootPath: workspaceRoot!,
      capabilitySetSha256: hydration.snapshots[1]!.contentSha256,
      environmentId: 'environment/process-real',
      environmentVersion: 1n,
      workspaceLease: {
        id: 'workspace-lease/process-real',
        version: 1n,
        fencingEpoch: 7n,
      },
      resourceBindingId: 'workspace-root/process-real',
      policyVersion: 'native-read/process-real/v1',
      grantTtlMs: 5_000n,
      maxReadBytes: 64n * 1024n,
      maxOutputBytes: 72n * 1024n,
      requireUtf8: true,
    })
    : undefined;
  const durableFacts: DurableSupervisorFactPort = {
    async commit(fact, _binding, control) {
      control.signal.throwIfAborted();
      committedFacts.push(fact.case);
      if (fact.case === 'attemptProcessSpawned') {
        observed.runnerProcessId = fact.value.runnerProvenance?.pid;
      }
      if (fact.case === 'attemptProcessExited') {
        observed.exitCause = fact.value.cause;
      }
    },
  };
  return {
    prepare,
    committedFacts,
    sessionRoot,
    workspaceRoot,
    expectedReadContent,
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
        ...(productiveEngine ? {
          providerGatewayFactory: (context, clock) =>
            (observed.providerGatewayCreated = true, new ProcessRealProviderGateway({
              runtimeInstanceId: context.runtimeInstanceId,
              resolver: {
                resolve: () => {
                  observed.providerResolved = true;
                  return processRealProvider(observed, expectedReadContent!);
                },
              },
              now: () => Number(clock.now()),
            }, observed)),
          capabilityGatewayFactory: (context, clock) =>
            capabilityGatewayFactory!(context, clock),
        } : {}),
      },
      ...(productiveEngine ? {
        sessionStore: {
          instanceId: `session-bridge:${sequence}`,
          rootId: 'process-real',
          rootPath: sessionRoot!,
          maximumFrameBytes: 256 * 1024,
          sessionId: launch.identity!.sessionId,
          authority: create(agentV1SessionStore.SessionStoreAuthoritySchema, {
            storageGeneration: agentV1SessionStore.StorageGeneration.RUST_FS_V1,
            leaseEpoch: 1n,
            writerId: randomUUID(),
          }),
          limits: create(agentV1SessionStore.SessionStoreLimitsSchema, {
            maxRecords: 64n,
            maxPayloadBytes: 1024n * 1024n,
            maxAuthorityTransitions: 8n,
          }),
          openIdempotencyKey: `process-real-open:${sequence}`,
          nowUnixMs: () => BigInt(Date.now()),
          timeoutMs: 10_000n,
        },
      } : {}),
    },
  };
}

function processRealProvider(
  observed: ProcessRealFixture['observed'],
  expectedReadContent: string,
) {
  return {
    name: 'openai',
    model: 'gpt-5',
    setModel(model: string) { this.model = model; },
    async *chat(request: ChatRequest) {
      observed.providerRunCount += 1;
      if (observed.providerRunCount === 1) {
        if (!request.tools?.some((tool) => tool.name === 'read_file')) {
          throw new Error('native read descriptor did not reach provider');
        }
        yield {
          type: 'response_id' as const,
          id: 'response/process-real/tool',
          messageCount: 1,
        };
        yield {
          type: 'tool_call_start' as const,
          id: 'tool/process-real/read',
          name: 'read_file',
        };
        yield {
          type: 'tool_call_args' as const,
          id: 'tool/process-real/read',
          partial_json: '{"path":"sample.txt"}',
        };
        yield {
          type: 'tool_call_end' as const,
          id: 'tool/process-real/read',
          name: 'read_file',
          input: { path: 'sample.txt' },
        };
        yield { type: 'done' as const };
        return;
      }
      const result = request.messages
        .flatMap((message) => message.content)
        .find((block) => block.type === 'tool_result');
      if (!result || result.type !== 'tool_result') {
        throw new Error('native read result did not reach provider follow-up');
      }
      const payload = JSON.parse(result.content) as { content?: string };
      observed.toolResultObserved = payload.content === expectedReadContent;
      if (!observed.toolResultObserved) {
        throw new Error('native read result content diverged');
      }
      yield {
        type: 'response_id' as const,
        id: 'response/process-real/final',
        messageCount: 3,
      };
      yield {
        type: 'text_delta' as const,
        text: 'native process-real read completed',
        phase: 'final_answer' as const,
      };
      yield {
        type: 'thinking_delta' as const,
        text: 'bounded native reasoning',
      };
      yield { type: 'done' as const };
    },
  };
}

class ProcessRealProviderGateway extends ProviderGateway {
  constructor(
    dependencies: ConstructorParameters<typeof ProviderGateway>[0],
    private readonly observed: ProcessRealFixture['observed'],
  ) {
    super(dependencies);
  }

  override run(...args: Parameters<ProviderGateway['run']>) {
    this.observed.providerRunStarted = true;
    return super.run(...args);
  }
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
  const readSchema = Buffer.from(
    '{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}',
  );
  bodies[1] = Buffer.from(toBinary(
    agentV1Runtime.CapabilitySetSnapshotV1Schema,
    create(agentV1Runtime.CapabilitySetSnapshotV1Schema, {
      schemaVersion: 1,
      tools: [create(agentV1Runtime.ProviderToolDescriptorSchema, {
        capabilityName: 'read_file',
        description: 'Read one UTF-8 file from the authorized workspace root.',
        encodedJsonSchema: readSchema,
        schemaSha256: createHash('sha256').update(readSchema).digest(),
        capabilityId: 'native.read_file',
        capabilityVersion: '1',
        executionClass: agentV1Capability.CapabilityExecutionClass.NATIVE_READ,
        mutates: false,
      })],
    }),
  ));
  bodies[5] = Buffer.from(toBinary(
    agentV1Runtime.ProviderPresetSnapshotV1Schema,
    create(agentV1Runtime.ProviderPresetSnapshotV1Schema, { schemaVersion: 1 }),
  ));
  bodies[6] = Buffer.from(toBinary(
    agentV1Runtime.AgentDefinitionSnapshotV1Schema,
    create(agentV1Runtime.AgentDefinitionSnapshotV1Schema, {
      schemaVersion: 1,
      agentDefinitionId: 'rust.process-real-e2e',
      systemPromptUtf8: 'Validate the native Rust runtime.',
    }),
  ));
  const schemaIds: Partial<Record<string, string>> = {
    capabilities: 'codestudio.agent.v1.CapabilitySetSnapshotV1',
    preset: 'codestudio.agent.v1.ProviderPresetSnapshotV1',
    'agent-definition': 'codestudio.agent.v1.AgentDefinitionSnapshotV1',
  };
  const snapshots = labels.map((label, index) => create(
    agentV1Common.SnapshotRefSchema,
    {
      ref: `snapshot:${label}:${sequence}`,
      version: 1n,
      contentSha256: Uint8Array.from(
        createHash('sha256').update(bodies[index]!).digest(),
      ),
      origin: 'process-real-e2e',
      schemaId: schemaIds[label] ?? `test.${label}`,
      schemaVersion: 1,
    },
  ));
  const observed: ProcessRealFixture['observed'] = {
    providerRunCount: 0,
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
