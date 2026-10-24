import { describe, expect, it } from 'vitest';
import {
  type AgentRunAttempt,
  type AgentRunAttemptId,
  type AgentRunId,
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
  type PreparedLegacyAgentAttempt,
  type ResumeAgentCommand,
  type RuntimeRouteCommit,
  type RuntimeRouteRecord,
  type RuntimeRouteStorePort,
  type StartAgentCommand,
} from '../index.js';
import { legacyPreparationDigest } from '../facade/legacy-prepared-validation.js';
import type { CoderAttemptPreparationV1 } from '@mcp/agent-runtime-contracts';

const sessionId =
  '11111111-1111-4111-8111-111111111111' as SessionId;
const commandId =
  '22222222-2222-4222-8222-222222222222' as SessionCommandId;
const agentRunId =
  '33333333-3333-4333-8333-333333333333' as AgentRunId;
const attemptId =
  '44444444-4444-4444-8444-444444444444' as AgentRunAttemptId;

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

function prepared(): PreparedLegacyAgentAttempt {
  const authority = {
    sessionId, commandId, agentRunId, attemptId, executorOwnerId: 'host:1', fencingEpoch: 1n,
    correlationId: '55555555-5555-4555-8555-555555555555', rootAgentRunId: agentRunId,
    leaseExpiresAtUnixMs: BigInt(Date.parse(attempt().executorLease.expiresAt)),
    deadlineAtUnixMs: BigInt(Date.parse('2026-07-24T12:02:00.000Z')),
  };
  const capabilityHash = legacyPreparationDigest([]);
  const preparation: CoderAttemptPreparationV1 = {
    schemaVersion: 1, sessionId, agentRunId, runnerRunId: 'worker-run', provider: 'openai', model: 'gpt-5',
    agentDefinitionId: 'coder.default', systemPromptSha256: 'a'.repeat(64), capabilityProfile: 'coder.default',
    capabilityDescriptors: [], capabilitySet: {
      ref: 'capset:' + capabilityHash, hash: capabilityHash, catalogVersion: 'catalog-v1', agentRunId,
      registered: [], visible: [], eligible: [], disabled: [],
      providerDescriptorsRef: 'provider:1', promptSummaryRef: 'prompt:1', resolvedAt: '2026-07-24T12:00:00.000Z',
    },
    environment: { kind: 'worktree', cwd: 'D:/owned' },
    policy: { permissionMode: 'default', planMode: false, specMode: false },
  };
  const preparationRef = 'events/attempt-preparations/66666666-6666-4666-8666-666666666666.json';
  const preparationSha256 = legacyPreparationDigest(preparation);
  return {
    run: { ...run(), effectivePreset: preparation.agentDefinitionId,
      capabilitySetRef: preparation.capabilitySet.ref,
      environmentId: ('environment:' + legacyPreparationDigest(preparation.environment)) as never,
      policySnapshotRef: preparationRef + '#policy', presetResolutionRef: preparationRef + '#agentDefinitionId',
    },
    attempt: attempt(), authority, preparation,
    admission: { schemaVersion: 1, sessionId, agentRunId, attemptId, executorOwnerId: authority.executorOwnerId,
      fencingEpoch: 1, runtimeGeneration: 'legacy_ts', preparationSha256, preparationRef },
    expectedSpecSha256: Buffer.from(preparationSha256, 'hex'),
    routing: { sessionId, agentRunId, attemptId, preference: 'legacy_required', cohort: 'internal',
      eligibility: { surface: 'coder.interactive', platform: 'win32-x64', environmentKind: 'worktree',
        provider: 'openai', capabilityProfile: preparation.capabilityProfile,
        capabilityCatalogVersion: preparation.capabilitySet.catalogVersion, capabilityIds: [],
        engineVersion: 'coder-worker-v1', runtimeBuildId: 'worker-build:1', runtimeBinarySha256: 'a'.repeat(64),
        protocolVersion: 'coder-attempt-admission-v1', requiredContainmentLevel: 'monitored' },
    },
  };
}

function startCommand(
  preference: StartAgentCommand['payload']['runtimePreference'] = 'legacy_required',
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
      admittedPreparationRef: prepared().admission.preparationRef,
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
    runtimeGeneration: 'legacy_ts',
    lastGlobalSeq: 7,
  };

  constructor(
    private readonly preparedAttempt: PreparedLegacyAgentAttempt,
    private readonly log: string[],
  ) {}

  async prepareStart(): Promise<PreparedLegacyAgentAttempt> {
    this.log.push('control.prepareStart');
    return this.preparedAttempt;
  }

  async prepareResume(): Promise<PreparedLegacyAgentAttempt> {
    this.log.push('control.prepareResume');
    return this.preparedAttempt;
  }

  async commitAttemptStartFailure(failure: AttemptStartFailure): Promise<void> {
    this.log.push(`control.startFailure:${failure.phase}`);
    this.failures.push(failure);
  }

  async commitCancelRequest(
    _authority: PreparedLegacyAgentAttempt['authority'],
    _reason: CancelReason,
  ): Promise<void> {
    this.log.push('control.cancel');
  }

  async resolveInteraction(
    _authority: PreparedLegacyAgentAttempt['authority'],
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
  adapters?: AgentRuntimeAdapterPort[];
}) {
  const log: string[] = [];
  const preparedAttempt = prepared();
  const store = new TestRouteStore(log);
  const router = new RuntimeRouter(
    store,
    { now: () => new Date('2026-07-24T12:00:00.000Z') },
  );
  const controlPlane = new TestControlPlane(preparedAttempt, log);
  const legacyAdapter = new TestAdapter('legacy_ts', log);
  const facade = new AgentRuntimeFacade({
    controlPlane,
    router,
    runtimeAdapters: options?.adapters ?? [legacyAdapter],
    clock: { now: () => new Date('2026-07-24T12:00:00.000Z') },
  });
  return {
    facade,
    controlPlane,
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
      runtimeGeneration: 'legacy_ts',
    });
    expect(context.log).toEqual([
      'control.prepareStart',
      'route.commit',
      'legacy_ts.launch',
    ]);
  });

  it('uses the committed generation for cancellation after recording the request', async () => {
    const context = buildFacade();
    const handle = await context.facade.start(startCommand());
    context.log.length = 0;

    await handle.cancel({ code: 'user_cancelled' });

    expect(context.log).toEqual(['control.cancel', 'legacy_ts.cancel']);
    expect(context.legacyAdapter.cancelCount).toBe(1);
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
    expect(context.legacyAdapter.cancelCount).toBe(0);
    expect(context.log).toEqual([]);
  });

  it('records an invalid routing request without committing or launching', async () => {
    const context = buildFacade();
    context.controlPlane['preparedAttempt'].routing.eligibility.runtimeBinarySha256 = 'invalid';
    await expect(context.facade.start(startCommand())).rejects.toMatchObject({ code: 'invalid_routing_request' });
    expect(context.legacyAdapter.launchCount).toBe(0);
    expect(context.store.records.size).toBe(0);
    expect(context.controlPlane.failures).toEqual([
      expect.objectContaining({ phase: 'routing', code: 'invalid_routing_request' }),
    ]);
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
    expect(context.store.records.get(attemptId)?.runtimeGeneration).toBe('legacy_ts');
  });

  it('rejects inconsistent prepared identities before routing or launch', async () => {
    const context = buildFacade();
    context.controlPlane['preparedAttempt'].routing.attemptId =
      '66666666-6666-4666-8666-666666666666' as AgentRunAttemptId;

    await expect(context.facade.start(startCommand())).rejects.toMatchObject({
      code: 'prepared_attempt_mismatch',
    });

    expect(context.store.records.size).toBe(0);
    expect(context.legacyAdapter.launchCount).toBe(0);
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
    expect(context.legacyAdapter.launchCount).toBe(0);
  });

  it('rejects preparation facts whose admitted digest no longer matches', async () => {
    const context = buildFacade();
    context.controlPlane['preparedAttempt'].preparation.agentDefinitionId = 'mutated';

    await expect(context.facade.start(startCommand())).rejects.toMatchObject({
      code: 'prepared_attempt_mismatch',
    });

    expect(context.store.records.size).toBe(0);
    expect(context.legacyAdapter.launchCount).toBe(0);
  });

  it('supports resume through the same route and launch boundary', async () => {
    const context = buildFacade();
    const command: ResumeAgentCommand = {
      ...startCommand(),
      kind: 'resume',
      payload: {
        agentRunId,
        surface: 'coder.interactive',
        runtimePreference: 'legacy_required',
        checkpointRef: 'checkpoint:1',
      },
    };

    const handle = await context.facade.resume(command);

    expect(handle.attemptId).toBe(attemptId);
    expect(context.log).toEqual([
      'control.prepareResume',
      'route.commit',
      'legacy_ts.launch',
    ]);
  });
});
