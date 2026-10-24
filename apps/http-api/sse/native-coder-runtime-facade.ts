import { fromBinary } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Runtime, agentV1SessionStore, isResolvedAgentRun,
  type AgentRunSpec } from '@mcp/agent-runtime-contracts';
import { AgentRuntimeFacade, NativeRustAgentRuntimeAdapter, RuntimeRouter,
  type AgentControlPlanePort, type AttemptAuthority, type PreparedAgentAttempt,
  type RuntimeEligibilityPort, type RuntimeEligibilityInput, type NativeRustHostAttemptRuntime } from '@mcp/agent-runtime-host';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import { admitNativeProductAttempt, type NativeProductAttemptInput } from '../native-attempt-runtime.js';
import { markEnded, type CoderRunBus } from '../coder-bus.js';
import { coderStreamIdentity, subscribeCoderFacadeEvents } from './coder-facade-events.js';
import { NativeCoderEventProjection } from './native-coder-events.js';
import { CoderInteractionNotPendingError } from './coder-runtime-errors.js';
import type { ContentBlock } from '@mcp/provider-sdk/wire.js';
import { uncertainToolOutcomeError } from '@mcp/code-agent/core/uncertain-tool-outcome.js';

export interface NativeCoderFacadeInput extends NativeProductAttemptInput {
  readonly runSpec: AgentRunSpec;
  readonly bus: CoderRunBus;
  readonly eligibility: RuntimeEligibilityPort;
  readonly capabilityCatalogVersion: string;
  readonly capabilityIds: readonly string[];
  readonly environmentKind: RuntimeEligibilityInput['environmentKind'];
  readonly assertOwner: () => void;
  readonly provideInput: (interactionId: string, value: string) => Promise<boolean>;
  readonly isInteractionPending?: (interactionId: string) => boolean;
  readonly runtimeCreated?: (runtime: NativeRustHostAttemptRuntime) => void | Promise<void>;
  /** Close Host waiters after Control acknowledges cancellation, or after
   * physical shutdown. A pending policy response must not race the Cancel ACK. */
  readonly stopHostEffects?: () => void;
  /** Physical owners and workspace authority must drain before public terminal
   * publication can admit another command. Cancel ACK remains independent. */
  readonly drainHostEffects?: () => Promise<void>;
  readonly resolveToolUserMessage?: (encoded: string) => readonly ContentBlock[];
  readonly transcriptRef?: string;
  readonly onUncertainEffect?: () => void;
}

/** Product composition for explicit native test/shadow routes. Physical
 * eligibility still comes from the existing certification port. */
export async function activateNativeCoderRuntimeFacade(input: NativeCoderFacadeInput) {
  const { store, bus } = input;
  const context = { ...input.context };
  bus.ctrl.signal.throwIfAborted();
  input.assertOwner();
  if (input.runSpec.sessionId !== context.sessionId || input.runSpec.commandId !== context.commandId
    || input.runSpec.role !== input.spec.role) throw new Error('Native logical spec differs from accepted command');
  const provisioned = await admitNativeProductAttempt(input);
  const wireSpec = fromBinary(agentV1Runtime.ResolvedAttemptSpecSchema, provisioned.prepare.encodedSpec);
  const initial = await store.getAttemptState(context);
  if (!isResolvedAgentRun(initial.run)) throw new Error('Native preparation is not durably resolved');
  const authority: AttemptAuthority = { ...context, fencingEpoch: BigInt(context.fencingEpoch),
    rootAgentRunId: initial.command.agentRunId!, deadlineAtUnixMs: wireSpec.deadlineAtUnixMs,
    leaseExpiresAtUnixMs: BigInt(Date.parse(initial.attempt.executorLease.expiresAt)) };
  const containment = input.requiredContainmentLevel;
  const eligibility: RuntimeEligibilityInput = {
    surface: 'coder.interactive', platform: `${process.platform}-${process.arch}`,
    environmentKind: input.environmentKind,
    provider: initial.run.effectiveProvider, capabilityProfile: input.runSpec.requestedCapabilityProfile,
    capabilityCatalogVersion: input.capabilityCatalogVersion, capabilityIds: [...input.capabilityIds],
    engineVersion: 'rust-v1', runtimeBuildId: input.runtimePackage.manifest.buildId,
    runtimeBinarySha256: input.runtimePackage.binaries.runner.sha256, protocolVersion: '1.1',
    requiredContainmentLevel: containment === agentV1Common.ContainmentLevel.HARD_AGGREGATE ? 'hard_aggregate'
      : containment === agentV1Common.ContainmentLevel.HARD_PROCESS ? 'hard_process' : 'monitored',
  };
  const prepared: PreparedAgentAttempt = { spec: structuredClone(input.runSpec), run: initial.run,
    attempt: initial.attempt, authority, wireSpec, expectedSpecSha256: provisioned.prepare.expectedSpecSha256,
    routing: { ...context, preference: 'rust_required', cohort: `product-native-${input.integrationMode}`, eligibility } };
  const assertAuthority = async (candidate: AttemptAuthority, requireActiveLease = true) => {
    for (const key of ['sessionId', 'commandId', 'agentRunId', 'attemptId', 'executorOwnerId',
      'fencingEpoch', 'correlationId', 'rootAgentRunId'] as const) {
      if (candidate[key] !== authority[key]) throw new Error(`Native facade authority changed: ${key}`);
    }
    input.assertOwner(); await store.getAttemptState(context, requireActiveLease); input.assertOwner();
  };
  const projection = new NativeCoderEventProjection(bus, context.attemptId, input.resolveToolUserMessage);
  let activeLease: Parameters<NonNullable<ConstructorParameters<typeof NativeRustAgentRuntimeAdapter>[0]['leaseAcquired']>>[0] | undefined;
  let consumer: Promise<void> | undefined;
  let projectionFailure: unknown;
  let cancelled = false;
  let resolveClosed!: () => void;
  let rejectClosed!: (cause: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  void closed.catch(() => undefined);
  const interactions = new Map<string, { hash: string; result: Promise<void> }>();
  const controlPlane: AgentControlPlanePort = {
    async prepareStart(command) {
      if (command.commandId !== context.commandId || command.sessionId !== context.sessionId
        || command.correlationId !== context.correlationId) throw new Error('Native command changed');
      await assertAuthority(authority); return prepared;
    },
    async prepareResume(command) {
      if (command.payload.agentRunId !== context.agentRunId || command.commandId !== context.commandId
        || command.sessionId !== context.sessionId || command.correlationId !== context.correlationId) throw new Error('Native resume changed');
      await assertAuthority(authority); return prepared;
    },
    async commitAttemptStartFailure(failure) {
      await store.terminalizeRun({ context, status: 'failed', commandStatus: 'failed', reason: failure.code });
    },
    async commitCancelRequest(candidate, reason) {
      await assertAuthority(candidate, false); await store.commitRuntimeRequest(context, 'cancel', reason);
      cancelled = true; bus.ctrl.abort(reason);
    },
    async resolveInteraction(candidate, interactionId, response) {
      await assertAuthority(candidate);
      if (!interactionId || !response.idempotencyKey || typeof response.value !== 'string') throw new Error('Native input requires a keyed string response');
      const key = `interaction:${response.idempotencyKey}`;
      const hash = hashControlPlanePayload({ interactionId, response });
      const previous = interactions.get(key);
      if (previous) {
        if (previous.hash !== hash) throw new Error('Native interaction replay diverged');
        return previous.result;
      }
      // A prompt may be rendered from the committed tool input just before its
      // Host waiter opens. Do not consume a durable response identity early.
      if (input.isInteractionPending && !input.isInteractionPending(interactionId)) throw new CoderInteractionNotPendingError();
      if (interactions.size >= 1024) throw new Error('Native interaction receipt bound exceeded');
      const result = (async () => {
        if (!await store.commitRuntimeRequest(context, key, { interactionId, response })) throw new Error('Native interaction delivery is uncertain; automatic replay is forbidden');
        await assertAuthority(candidate);
        if (!await input.provideInput(interactionId, response.value as string)) throw new CoderInteractionNotPendingError();
      })();
      interactions.set(key, { hash, result }); return result;
    },
    async getSnapshot(agentRunId) {
      if (agentRunId !== context.agentRunId) throw new Error('Native snapshot belongs to another run');
      const state = await store.getAttemptState(context, false);
      const route = await store.getRuntimeRoute(context.sessionId, context.attemptId);
      return { run: state.run, activeAttempt: state.attempt, runtimeGeneration: route?.runtimeGeneration,
        lastGlobalSeq: bus.ended ? bus.nextSeq : bus.nextSeq - 1, stream: coderStreamIdentity(bus) };
    },
    subscribeEvents(agentRunId, cursor) {
      if (agentRunId !== context.agentRunId) throw new Error('Native event subscription belongs to another run');
      return subscribeCoderFacadeEvents(bus, context, cursor, 'native');
    },
  };
  const finish = async (physicalFailure?: unknown) => {
    await consumer;
    let drainFailure: unknown;
    try { await input.drainHostEffects?.(); } catch (cause) { drainFailure = cause; }
    const terminal = projection.completed;
    const completed = terminal?.classification === agentV1SessionStore.EngineTerminalClassificationV1.COMPLETED;
    const interrupted = cancelled || terminal?.classification === agentV1SessionStore.EngineTerminalClassificationV1.INTERRUPTED;
    const failed = physicalFailure || projectionFailure || drainFailure || projection.hasUncertainEffects || (!completed && !interrupted);
    const reason = projection.hasUncertainEffects ? 'outcome_unknown' : drainFailure ? 'native_host_cleanup_failed'
      : (physicalFailure || projectionFailure) && (completed || interrupted) ? 'native_attempt_failed'
      : !cancelled && terminal && ['max_turns', 'max_tool_calls', 'ipc_identity_budget', 'workspace_transition'].includes(terminal.reasonCode) ? terminal.reasonCode
      : interrupted ? 'aborted' : terminal?.reasonCode ?? 'native_attempt_failed';
    await store.terminalizeRun({ context, status: failed ? 'failed' : interrupted ? 'interrupted' : 'completed',
      commandStatus: failed ? 'failed' : interrupted ? 'cancelled' : 'succeeded', reason,
      transcriptRef: input.transcriptRef ?? `native-journal:${context.sessionId}` });
    markEnded(bus, failed ? 'error' : 'done', { reason, interrupted, runtime: 'rust_v1' });
    if (projection.hasUncertainEffects) throw Object.assign(uncertainToolOutcomeError(context.attemptId),
      { cause: physicalFailure ?? projectionFailure ?? drainFailure });
    if (failed) throw physicalFailure ?? projectionFailure ?? drainFailure ?? new Error(reason);
  };
  const adapter = new NativeRustAgentRuntimeAdapter({
    assertCurrent: assertAuthority, provision: () => provisioned.provision(),
    assertCancellationAuthority: authority => assertAuthority(authority, false),
    async runtimeCreated(runtime) {
      // Existing transcript belongs to previous attempts and is rendered by
      // history projection. Subscribe at this writer's opening boundary before
      // runtime.run() can publish the first event of the new attempt.
      const afterSequence = runtime.latestEventSequence;
      consumer = (async () => {
        try { for await (const event of runtime.subscribeCommittedEvents(afterSequence)) {
          projection.apply(event); if (projection.hasUncertainEffects) input.onUncertainEffect?.();
        } }
        catch (cause) { projectionFailure = cause; }
        finally {
          projection.finishStream();
          if (projection.hasUncertainEffects) input.onUncertainEffect?.();
        }
      })();
      await input.runtimeCreated?.(runtime);
    },
    leaseAcquired(lease) {
      activeLease = lease;
      void lease.closed.then(() => { input.stopHostEffects?.(); return finish(); },
        (cause) => { input.stopHostEffects?.(); return finish(cause); }).then(resolveClosed, rejectClosed);
    },
  }, 1);
  const facade = new AgentRuntimeFacade({ controlPlane, runtimeAdapters: [adapter], router: new RuntimeRouter({
    getByAttemptId: async (id) => {
      if (id !== context.attemptId) throw new Error('Native route belongs to another attempt');
      return await store.getRuntimeRoute(context.sessionId, id) ?? undefined;
    }, commitIfAbsent: (route) => store.commitRuntimeRoute(context, route),
  }, input.eligibility) });
  const command = initial.command;
  const common = { schemaVersion: command.schemaVersion, commandId: command.commandId, sessionId: command.sessionId,
    actor: command.actor, idempotencyKey: command.idempotencyKey, correlationId: command.correlationId,
    requestedAt: command.requestedAt, deadlineAt: command.deadlineAt };
  try {
    const nativeHandle = !initial.run.parentAgentRunId && command.kind === 'resume'
      ? await facade.resume({ ...common, kind: 'resume', payload: { surface: 'coder.interactive', runtimePreference: 'rust_required', agentRunId: context.agentRunId } })
      : await facade.start({ ...common, kind: 'start', payload: { surface: 'coder.interactive', runtimePreference: 'rust_required', spec: prepared.spec } });
    let cancellation: Promise<void> | undefined;
    const handle: typeof nativeHandle = {
      agentRunId: nativeHandle.agentRunId, attemptId: nativeHandle.attemptId,
      runtimeGeneration: nativeHandle.runtimeGeneration,
      cancel(reason) {
        // A public Stop also aborts the attempt bus. Both paths must join the
        // same durable request and Control ACK: a second transaction can race
        // the terminal event that releases this worker's authority. Retain a
        // rejected promise as well; an uncertain request is never auto-retried.
        cancellation ??= (async () => { await nativeHandle.cancel(reason); input.stopHostEffects?.(); })();
        return cancellation;
      },
      resolveInteraction: (id, response) => nativeHandle.resolveInteraction(id, response),
      getSnapshot: () => nativeHandle.getSnapshot(),
      subscribeEvents: (cursor) => nativeHandle.subscribeEvents(cursor), dispose: () => nativeHandle.dispose(),
    };
    const abort = () => { if (!cancelled) void handle.cancel({ code: 'user_cancelled' }).catch(rejectClosed); };
    if (bus.ctrl.signal.aborted) abort(); else bus.ctrl.signal.addEventListener('abort', abort, { once: true });
    void closed.then(() => bus.ctrl.signal.removeEventListener('abort', abort),
      () => bus.ctrl.signal.removeEventListener('abort', abort));
    return { handle, closed, getTerminal: () => projection.completed, getUsage: () => projection.totalUsage,
      hasUncertainEffects: () => projection.hasUncertainEffects,
      renewAuthority: (request: Parameters<NonNullable<typeof activeLease>['renewAuthority']>[0]) => {
        if (!activeLease) return Promise.reject(new Error('Native physical authority is unavailable'));
        return activeLease.renewAuthority(request);
      } };
  } catch (cause) {
    await input.source.close?.(cause);
    rejectClosed(cause); markEnded(bus, 'error', { reason: 'native_start_failed' }); throw cause;
  }
}
