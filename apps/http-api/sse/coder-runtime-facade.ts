import {
  AgentRuntimeFacade, LegacyAgentRuntimeAdapter, RuntimeRouter,
  type AgentControlPlanePort, type AgentRunHandleApi, type AttemptAuthority,
  type PreparedLegacyAgentAttempt, type StartAgentCommand,
} from '@mcp/agent-runtime-host';
import { isResolvedAgentRun, type CoderAttemptAdmissionV1, type CoderAttemptPreparationV1 } from '@mcp/agent-runtime-contracts';
import { hashControlPlanePayload, type ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import type { FileControlPlaneAuthority } from '../file-control-plane-store.js';
import type { CoderRunBus } from '../coder-bus.js';
import { coderStreamIdentity, subscribeCoderFacadeEvents } from './coder-facade-events.js';
import { CoderInteractionNotPendingError } from './coder-runtime-errors.js';

interface CoderFacadeActivation {
  store: FileControlPlaneAuthority;
  context: ControlPlaneRunContext;
  preparation: CoderAttemptPreparationV1;
  admission: CoderAttemptAdmissionV1;
  bus: CoderRunBus;
  /** Digest of the actual worker entrypoint. */
  workerEntrypointSha256: string;
  assertOwner(): void;
  abortWorker(): Promise<void>;
  provideInput(interactionId: string, value: string): Promise<boolean>;
  workerClosed: Promise<void>;
}

/** The worker has already prepared its registry and is waiting for its receipt.
 * Launch here means granting that existing worker permission to enter its loop;
 * it must never spawn a second worker or resolve a different provider. */
export async function activateCoderRuntimeFacade(input: CoderFacadeActivation): Promise<AgentRunHandleApi> {
  const { store, context, bus, preparation, admission } = input;
  const initial = await store.getAttemptState(context);
  input.assertOwner();
  if (!isResolvedAgentRun(initial.run)) throw new Error('Worker preparation was not durably resolved');
  const authority: AttemptAuthority = {
    ...context, fencingEpoch: BigInt(context.fencingEpoch), rootAgentRunId: initial.command.agentRunId!,
    leaseExpiresAtUnixMs: BigInt(Date.parse(initial.attempt.executorLease.expiresAt)),
    // Worker execution renews its lease during the run.
    // This deadline bounds activation only; subsequent controls re-read the lease.
    deadlineAtUnixMs: BigInt(Date.parse(initial.command.deadlineAt ?? initial.attempt.executorLease.expiresAt)),
  };
  const prepared: PreparedLegacyAgentAttempt = {
    run: initial.run, attempt: initial.attempt, authority, preparation, admission,
    expectedSpecSha256: Buffer.from(admission.preparationSha256, 'hex'),
    routing: {
      sessionId: context.sessionId, agentRunId: context.agentRunId, attemptId: context.attemptId,
      preference: 'legacy_required', cohort: 'product-legacy',
      eligibility: {
        surface: 'coder.interactive', platform: `${process.platform}-${process.arch}`,
        environmentKind: preparation.environment.kind, provider: preparation.provider,
        capabilityProfile: preparation.capabilityProfile, capabilityCatalogVersion: preparation.capabilitySet.catalogVersion,
        capabilityIds: preparation.capabilitySet.eligible, engineVersion: 'coder-worker-v1',
        runtimeBuildId: `legacy-worker-entrypoint:${input.workerEntrypointSha256}`,
        runtimeBinarySha256: input.workerEntrypointSha256, protocolVersion: 'coder-attempt-admission-v1',
        requiredContainmentLevel: 'monitored',
      },
    },
  };
  const assertAuthority = async (candidate: AttemptAuthority) => {
    for (const key of ['sessionId', 'commandId', 'agentRunId', 'attemptId', 'executorOwnerId',
      'fencingEpoch', 'correlationId', 'rootAgentRunId'] as const) {
      if (candidate[key] !== authority[key]) throw new Error(`Facade authority changed: ${key}`);
    }
    input.assertOwner();
    await store.getAttemptState(context);
    input.assertOwner();
  };
  const assertCommand = (command: StartAgentCommand | { commandId: string; sessionId: string; correlationId: string }) => {
    if (command.commandId !== context.commandId || command.sessionId !== context.sessionId
      || command.correlationId !== context.correlationId) throw new Error('Facade command is not the accepted worker command');
    input.assertOwner();
  };
  const interactions = new Map<string, { hash: string; result: Promise<void> }>();
  const controlPlane: AgentControlPlanePort = {
    async prepareStart(command) { assertCommand(command); await assertAuthority(authority); return prepared; },
    async prepareResume(command) { assertCommand(command); await assertAuthority(authority); return prepared; },
    async commitAttemptStartFailure(failure) {
      await store.terminalizeRun({ context, status: 'failed', commandStatus: 'failed', reason: failure.code });
    },
    async commitCancelRequest(candidate, reason) {
      await assertAuthority(candidate);
      await store.commitRuntimeRequest(context, 'cancel', reason);
    },
    async resolveInteraction(candidate, interactionId, response) {
      await assertAuthority(candidate);
      if (!interactionId || !response.idempotencyKey || typeof response.value !== 'string') {
        throw new Error('Legacy input requires an interaction id, idempotency key and string value');
      }
      const key = `interaction:${response.idempotencyKey}`;
      const hash = hashControlPlanePayload({ interactionId, response });
      const existing = interactions.get(key);
      if (existing) {
        if (existing.hash !== hash) throw new Error('Interaction replay changed its input');
        return existing.result;
      }
      if (interactions.size >= 1024) throw new Error('Interaction receipt capacity reached');
      const result = (async () => {
        if (!await store.commitRuntimeRequest(context, key, { interactionId, response })) {
          throw new Error('Interaction delivery is uncertain; automatic replay is forbidden');
        }
        await assertAuthority(candidate);
        if (!await input.provideInput(interactionId, response.value as string)) throw new CoderInteractionNotPendingError();
      })();
      interactions.set(key, { hash, result });
      return result;
    },
    async getSnapshot(agentRunId) {
      if (agentRunId !== context.agentRunId) throw new Error('Snapshot belongs to another run');
      const state = await store.getAttemptState(context, false);
      const route = await store.getRuntimeRoute(context.sessionId, context.attemptId);
      return { run: state.run, activeAttempt: state.attempt, runtimeGeneration: route?.runtimeGeneration,
        lastGlobalSeq: bus.ended ? bus.nextSeq : bus.nextSeq - 1, stream: coderStreamIdentity(bus) };
    },
    subscribeEvents(agentRunId, cursor) {
      if (agentRunId !== context.agentRunId) throw new Error('Event subscription belongs to another run');
      return subscribeCoderFacadeEvents(bus, context, cursor);
    },
  };
  const router = new RuntimeRouter({
    getByAttemptId: async (attemptId) => {
      if (attemptId !== context.attemptId) throw new Error('Route lookup belongs to another attempt');
      return await store.getRuntimeRoute(context.sessionId, attemptId) ?? undefined;
    },
    commitIfAbsent: (route) => store.commitRuntimeRoute(context, route),
  });
  const adapter = new LegacyAgentRuntimeAdapter({
    assertCurrent: assertAuthority,
    async launch(candidate, _route, signal) {
      if (candidate.admission.preparationSha256 !== admission.preparationSha256) {
        throw new Error('Worker activation requires its committed legacy preparation');
      }
      signal.throwIfAborted();
      input.assertOwner();
      await store.markRunStarted(context, preparation.runnerRunId);
      input.assertOwner();
      return { cancel: () => input.abortWorker(), closed: input.workerClosed };
    },
  }, 1);
  const facade = new AgentRuntimeFacade({ controlPlane, router, runtimeAdapters: [adapter] });
  const command = initial.command;
  const common = { schemaVersion: command.schemaVersion, commandId: command.commandId,
    sessionId: command.sessionId, actor: command.actor, idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId, requestedAt: command.requestedAt, deadlineAt: command.deadlineAt };
  const routing = { surface: 'coder.interactive', runtimePreference: 'legacy_required' as const };
  // Normalize the accepted HTTP send_message intent to facade start, retaining
  // its durable identity. Never create or overwrite a second SessionCommand.
  return command.kind === 'resume'
    ? facade.resume({ ...common, kind: 'resume', payload: { ...routing, agentRunId: context.agentRunId } })
    : facade.start({ ...common, kind: 'start', payload: { ...routing, admittedPreparationRef: admission.preparationRef } });
}
