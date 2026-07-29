import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
  agentV1Runtime,
  type AgentRunAttempt,
  type AgentRunAttemptId,
  type AgentRunId,
  type AgentRunSpec,
  type ResolvedAgentRun,
  type SessionCommandId,
  type SessionId,
} from '@mcp/agent-runtime-contracts';
import {
  AgentRunHandle,
  AgentRuntimeFacade,
  AgentRuntimeHostError,
  RuntimeRouter,
  type AgentControlPlanePort,
  type AgentRunSnapshot,
  type AgentRuntimeAdapterPort,
  type AttemptStartFailure,
  type CancelReason,
  type CanonicalAgentEvent,
  type EventCursor,
  type InteractionResponse,
  type PreparedAgentAttempt,
  type ResumeAgentCommand,
  type RuntimeEligibilityPort,
  type RuntimeRouteCommit,
  type RuntimeRouteRecord,
  type RuntimeRouteStorePort,
  type StartAgentCommand,
} from '../index.js';
import { semanticSha256 } from '../ipc/semantic-hash.js';

const sessionId =
  '11111111-1111-4111-8111-111111111111' as SessionId;
const commandId =
  '22222222-2222-4222-8222-222222222222' as SessionCommandId;
const agentRunId =
  '33333333-3333-4333-8333-333333333333' as AgentRunId;
const attemptId =
  '44444444-4444-4444-8444-444444444444' as AgentRunAttemptId;

function spec(): AgentRunSpec {
  return {
    schemaVersion: 1,
    sessionId,
    commandId,
    spawnDepth: 0,
    role: 'coder',
    agentDefinitionId: 'coder.default',
    task: { text: 'Inspect the workspace' },
    requestedCapabilityProfile: 'coder.default',
    requestedEnvironment: {
      kind: 'worktree',
      projectId: 'project:1',
      access: 'exclusive_write',
      retention: 'retain_on_failure',
    },
    waitMode: 'foreground',
    budget: { maxWallMs: 60_000 },
    idempotencyKey: 'start:1',
  };
}

function run(): ResolvedAgentRun {
  return {
    agentRunId,
    specVersion: 1,
    sessionId,
    commandId,
    spawnDepth: 0,
    role: 'coder',
    status: 'starting',
    effectiveProvider: 'openai',
    effectiveModel: 'gpt-5',
    downgradeReasons: [],
    capabilitySetRef: 'capability-set:1',
    environmentId: 'environment:1' as never,
    presetResolutionRef: 'preset:1',
    policySnapshotRef: 'policy:1',
    activeAttemptId: attemptId,
    createdAt: '2026-07-24T12:00:00.000Z',
    version: 1,
  };
}

function attempt(): AgentRunAttempt {
  return {
    attemptId,
    agentRunId,
    ordinal: 1,
    trigger: 'initial',
    executorLease: {
      ownerId: 'host:1',
      fencingEpoch: 1,
      status: 'active',
      acquiredAt: '2026-07-24T12:00:00.000Z',
      heartbeatAt: '2026-07-24T12:00:00.000Z',
      expiresAt: '2026-07-24T12:01:00.000Z',
    },
    status: 'starting',
    providerRequestRefs: [],
    startedAt: '2026-07-24T12:00:00.000Z',
    version: 1,
  };
}

function prepared(
  preference: PreparedAgentAttempt['routing']['preference'] = 'rust_required',
): PreparedAgentAttempt {
  const authority = {
    sessionId,
    commandId,
    agentRunId,
    attemptId,
    executorOwnerId: 'host:1',
    fencingEpoch: 1n,
    correlationId: '55555555-5555-4555-8555-555555555555',
    rootAgentRunId: agentRunId,
    leaseExpiresAtUnixMs: 1_784_894_460_000n,
    deadlineAtUnixMs: 1_784_894_520_000n,
  };
  const snapshot = (name: string) => ({
    ref: `${name}:1`,
    version: 1n,
    contentSha256: new Uint8Array(32).fill(1),
    origin: 'control-plane',
    schemaId: name,
    schemaVersion: 1,
  });
  const wireSpec = create(agentV1Runtime.ResolvedAttemptSpecSchema, {
    schemaVersion: 1,
    specVersion: 1n,
    identity: {
      sessionId,
      commandId,
      agentRunId,
      attemptId,
      executorOwnerId: authority.executorOwnerId,
      fencingEpoch: authority.fencingEpoch,
      correlationId: authority.correlationId,
      rootAgentRunId: authority.rootAgentRunId,
    },
    ordinal: 1,
    trigger: agentV1Runtime.AttemptTrigger.INITIAL,
    spawnDepth: 0,
    role: 'coder',
    agentDefinitionId: 'coder.default',
    task: { body: { case: 'inlineUtf8', value: 'Inspect the workspace' } },
    providerBinding: {
      effectiveProvider: 'openai',
      effectiveModel: 'gpt-5',
    },
    waitMode: agentV1Runtime.AgentRunWaitMode.FOREGROUND,
    runTreeBudget: { maxWallMs: 60_000n },
    verifierPolicySnapshot: snapshot('verifier-policy'),
    capabilitySetSnapshot: snapshot('capability-set'),
    environmentSnapshot: snapshot('environment'),
    workspaceLeaseSnapshot: snapshot('workspace-lease'),
    workspaceLeaseFencingEpoch: 1n,
    policySnapshot: snapshot('policy'),
    presetSnapshot: snapshot('preset'),
    resourceBudget: {
      softMemoryBytes: 256n * 1024n * 1024n,
      hardMemoryBytes: 512n * 1024n * 1024n,
      cpuTimeMs: 60_000n,
      maxWallMs: 120_000n,
      maxProcesses: 16,
      maxThreads: 32,
      maxOpenHandles: 256,
      maxHotTranscriptBytes: 8n * 1024n * 1024n,
      maxIpcFrames: 256,
      maxIpcBytes: 16n * 1024n * 1024n,
      maxSpoolBytes: 64n * 1024n * 1024n,
      maxArtifactBytes: 16n * 1024n * 1024n,
      maxConcurrentTools: 4,
      maxBlockingTasks: 2,
      cancelGraceMs: 2_000n,
    },
    deadlineAtUnixMs: authority.deadlineAtUnixMs,
    agentDefinitionSnapshot: snapshot('agent-definition'),
  });
  const expectedSpecSha256 = semanticSha256({
    schemaId: 'codestudio.agent.v1.ResolvedAttemptSpec',
    schemaVersion: wireSpec.schemaVersion,
    canonicalBytes: toBinary(agentV1Runtime.ResolvedAttemptSpecSchema, wireSpec),
  });
  return {
    spec: spec(),
    run: run(),
    attempt: attempt(),
    authority,
    wireSpec,
    expectedSpecSha256,
    routing: {
      sessionId,
      agentRunId,
      attemptId,
      preference,
      cohort: 'internal',
      eligibility: {
        surface: 'coder.interactive',
        platform: 'win32-x64',
        environmentKind: 'worktree',
        provider: 'openai',
        capabilityProfile: 'coder.default',
        capabilityCatalogVersion: 'catalog-v1',
        capabilityIds: ['fs.read'],
        engineVersion: 'agentd-v1',
        runtimeBuildId: 'agentd-v1.0.0+build.7',
        runtimeBinarySha256: 'a'.repeat(64),
        protocolVersion: '1.0',
        requiredContainmentLevel: 'hard_aggregate',
      },
    },
  };
}

function startCommand(
  preference: StartAgentCommand['payload']['runtimePreference'] = 'rust_required',
): StartAgentCommand {
  return {
    schemaVersion: 1,
    commandId,
    idempotencyKey: 'command:1',
    kind: 'start',
    sessionId,
    actor: {
      actorId: 'user:1',
      actorType: 'user',
      source: 'dashboard',
    },
    requestedAt: '2026-07-24T12:00:00.000Z',
    correlationId: '55555555-5555-4555-8555-555555555555' as never,
    payload: {
      spec: spec(),
      surface: 'coder.interactive',
      runtimePreference: preference,
    },
  };
}

class TestRouteStore implements RuntimeRouteStorePort {
  readonly records = new Map<string, RuntimeRouteRecord>();

  constructor(private readonly log: string[]) {}

  async getByAttemptId(): Promise<RuntimeRouteRecord | undefined> {
    return this.records.get(attemptId);
  }

  async commitIfAbsent(candidate: RuntimeRouteRecord): Promise<RuntimeRouteCommit> {
    this.log.push('route.commit');
    const existing = this.records.get(candidate.attemptId);
    if (existing) return { record: existing, inserted: false };
    this.records.set(candidate.attemptId, candidate);
    return { record: candidate, inserted: true };
  }
}

class TestControlPlane implements AgentControlPlanePort {
  readonly failures: AttemptStartFailure[] = [];
  readonly resolvedInteractions: string[] = [];
  readonly snapshot: AgentRunSnapshot = {
    run: run(),
    activeAttempt: attempt(),
    runtimeGeneration: 'rust_v1',
    lastGlobalSeq: 7,
  };

  constructor(
    private readonly preparedAttempt: PreparedAgentAttempt,
    private readonly log: string[],
  ) {}

  async prepareStart(): Promise<PreparedAgentAttempt> {
    this.log.push('control.prepareStart');
    return this.preparedAttempt;
  }

  async prepareResume(): Promise<PreparedAgentAttempt> {
    this.log.push('control.prepareResume');
    return this.preparedAttempt;
  }

  async commitAttemptStartFailure(failure: AttemptStartFailure): Promise<void> {
    this.log.push(`control.startFailure:${failure.phase}`);
    this.failures.push(failure);
  }

  async commitCancelRequest(
    _authority: PreparedAgentAttempt['authority'],
    _reason: CancelReason,
  ): Promise<void> {
    this.log.push('control.cancel');
  }

  async resolveInteraction(
    _authority: PreparedAgentAttempt['authority'],
    interactionId: string,
    _response: InteractionResponse,
  ): Promise<void> {
    this.log.push('control.interaction');
    this.resolvedInteractions.push(interactionId);
  }

  async getSnapshot(): Promise<AgentRunSnapshot> {
    this.log.push('control.snapshot');
    return this.snapshot;
  }

  subscribeEvents(
    _agentRunId: AgentRunId,
    _cursor?: EventCursor,
  ): AsyncIterable<CanonicalAgentEvent> {
    this.log.push('control.subscribe');
    return (async function* emptyEvents() {})();
  }
}

class TestAdapter implements AgentRuntimeAdapterPort {
  launchCount = 0;
  cancelCount = 0;

  constructor(
    readonly generation: AgentRuntimeAdapterPort['generation'],
    private readonly log: string[],
  ) {}

  async launch(): Promise<void> {
    this.log.push(`${this.generation}.launch`);
    this.launchCount += 1;
  }

  async cancel(): Promise<void> {
    this.log.push(`${this.generation}.cancel`);
    this.cancelCount += 1;
  }
}

function buildFacade(options?: {
  preference?: PreparedAgentAttempt['routing']['preference'];
  eligible?: boolean;
  adapters?: AgentRuntimeAdapterPort[];
}) {
  const log: string[] = [];
  const preference = options?.preference ?? 'rust_required';
  const preparedAttempt = prepared(preference);
  const store = new TestRouteStore(log);
  const eligibility: RuntimeEligibilityPort = {
    evaluate: async () => options?.eligible === false
      ? {
          eligible: false,
          reasons: [{ code: 'rust_disabled', dimension: 'runtime' }],
        }
      : { eligible: true, reasons: [] },
  };
  const router = new RuntimeRouter(
    store,
    eligibility,
    { now: () => new Date('2026-07-24T12:00:00.000Z') },
  );
  const controlPlane = new TestControlPlane(preparedAttempt, log);
  const rustAdapter = new TestAdapter('rust_v1', log);
  const legacyAdapter = new TestAdapter('legacy_ts', log);
  const facade = new AgentRuntimeFacade({
    controlPlane,
    router,
    runtimeAdapters: options?.adapters ?? [rustAdapter, legacyAdapter],
    clock: { now: () => new Date('2026-07-24T12:00:00.000Z') },
  });
  return {
    facade,
    controlPlane,
    rustAdapter,
    legacyAdapter,
    store,
    log,
  };
}

describe('AgentRuntimeFacade', () => {
  it('persists the route before launching and returns a neutral handle', async () => {
    const context = buildFacade();

    const handle = await context.facade.start(startCommand());

    expect(handle).toBeInstanceOf(AgentRunHandle);
    expect(handle).toMatchObject({
      agentRunId,
      attemptId,
      runtimeGeneration: 'rust_v1',
    });
    expect(context.log).toEqual([
      'control.prepareStart',
      'route.commit',
      'rust_v1.launch',
    ]);
  });

  it('uses the committed generation for cancellation after recording the request', async () => {
    const context = buildFacade();
    const handle = await context.facade.start(startCommand());
    context.log.length = 0;

    await handle.cancel({ code: 'user_cancelled' });

    expect(context.log).toEqual(['control.cancel', 'rust_v1.cancel']);
    expect(context.rustAdapter.cancelCount).toBe(1);
    expect(context.legacyAdapter.cancelCount).toBe(0);
  });

  it('routes host-owned snapshots, events, and interactions without a runner object', async () => {
    const context = buildFacade();
    const handle = await context.facade.start(startCommand());
    context.log.length = 0;

    await expect(handle.getSnapshot()).resolves.toBe(context.controlPlane.snapshot);
    handle.subscribeEvents({ afterGlobalSeq: 7 });
    await handle.resolveInteraction('interaction:1', {
      value: 'approved',
      idempotencyKey: 'interaction:1',
    });

    expect(context.log).toEqual([
      'control.snapshot',
      'control.subscribe',
      'control.interaction',
    ]);
    expect(context.controlPlane.resolvedInteractions).toEqual(['interaction:1']);
  });

  it('does not reinterpret handle disposal as run cancellation', async () => {
    const context = buildFacade();
    const handle = await context.facade.start(startCommand());
    context.log.length = 0;

    handle.dispose();

    expect(() => handle.getSnapshot()).toThrow(
      expect.objectContaining<Partial<AgentRuntimeHostError>>({
        code: 'handle_disposed',
      }),
    );
    expect(context.rustAdapter.cancelCount).toBe(0);
    expect(context.log).toEqual([]);
  });

  it('records a routing failure and never launches legacy for rust_required', async () => {
    const context = buildFacade({ eligible: false });

    await expect(context.facade.start(startCommand())).rejects.toMatchObject({
      code: 'runtime_ineligible',
    });

    expect(context.rustAdapter.launchCount).toBe(0);
    expect(context.legacyAdapter.launchCount).toBe(0);
    expect(context.store.records.size).toBe(0);
    expect(context.controlPlane.failures).toEqual([
      expect.objectContaining({
        phase: 'routing',
        code: 'runtime_ineligible',
      }),
    ]);
  });

  it('commits legacy routing only before launch when Rust is preferred but ineligible', async () => {
    const context = buildFacade({
      preference: 'rust_preferred',
      eligible: false,
    });

    const handle = await context.facade.start(startCommand('rust_preferred'));

    expect(handle.runtimeGeneration).toBe('legacy_ts');
    expect(context.log).toEqual([
      'control.prepareStart',
      'route.commit',
      'legacy_ts.launch',
    ]);
    expect(context.rustAdapter.launchCount).toBe(0);
    expect(context.legacyAdapter.launchCount).toBe(1);
  });

  it('fails closed and records the failure when the selected adapter is unavailable', async () => {
    const context = buildFacade({ adapters: [] });

    await expect(context.facade.start(startCommand())).rejects.toMatchObject({
      code: 'runtime_adapter_unavailable',
    });

    expect(context.controlPlane.failures).toEqual([
      expect.objectContaining({
        phase: 'adapter_lookup',
        code: 'runtime_adapter_unavailable',
      }),
    ]);
    expect(context.store.records.get(attemptId)?.runtimeGeneration).toBe('rust_v1');
  });

  it('rejects inconsistent prepared identities before routing or launch', async () => {
    const context = buildFacade();
    context.controlPlane['preparedAttempt'].routing.attemptId =
      '66666666-6666-4666-8666-666666666666' as AgentRunAttemptId;

    await expect(context.facade.start(startCommand())).rejects.toMatchObject({
      code: 'prepared_attempt_mismatch',
    });

    expect(context.store.records.size).toBe(0);
    expect(context.rustAdapter.launchCount).toBe(0);
    expect(context.controlPlane.failures).toEqual([
      expect.objectContaining({
        phase: 'routing',
        code: 'prepared_attempt_mismatch',
      }),
    ]);
  });

  it('rejects an expired authority before route commit or launch', async () => {
    const context = buildFacade();
    context.controlPlane['preparedAttempt'].authority.leaseExpiresAtUnixMs = 1n;

    await expect(context.facade.start(startCommand())).rejects.toMatchObject({
      code: 'prepared_attempt_mismatch',
    });

    expect(context.store.records.size).toBe(0);
    expect(context.rustAdapter.launchCount).toBe(0);
  });

  it('rejects a wire spec whose hash no longer matches', async () => {
    const context = buildFacade();
    context.controlPlane['preparedAttempt'].wireSpec.agentDefinitionId = 'mutated';

    await expect(context.facade.start(startCommand())).rejects.toMatchObject({
      code: 'prepared_attempt_mismatch',
    });

    expect(context.store.records.size).toBe(0);
    expect(context.rustAdapter.launchCount).toBe(0);
  });

  it('supports resume through the same route and launch boundary', async () => {
    const context = buildFacade();
    const command: ResumeAgentCommand = {
      ...startCommand(),
      kind: 'resume',
      payload: {
        agentRunId,
        surface: 'coder.interactive',
        runtimePreference: 'rust_required',
        checkpointRef: 'checkpoint:1',
      },
    };

    const handle = await context.facade.resume(command);

    expect(handle.attemptId).toBe(attemptId);
    expect(context.log).toEqual([
      'control.prepareResume',
      'route.commit',
      'rust_v1.launch',
    ]);
  });
});
