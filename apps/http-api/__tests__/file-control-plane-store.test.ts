import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneFileRepository } from '@mcp/session-storage';
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  asAgentRunAttemptId,
  asAgentRunId,
  asCorrelationId,
  asSessionCommandId,
  type SessionCommand,
} from '@mcp/agent-runtime-contracts';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import { FileControlPlaneStore } from '../file-control-plane-store.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { prepareCoderAttempt, preparationSha256 } from '@mcp/code-agent/runtime/attempt-preparation.js';
import { activateCoderRuntimeFacade } from '../sse/coder-runtime-facade.js';
import { createBus, publish } from '../coder-bus.js';

let temporaryRoot: string;
let dataDir: string;
let projectRoot: string;
let sessions: FsSessionStore;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-file-control-plane-'));
  dataDir = join(temporaryRoot, 'data');
  projectRoot = join(temporaryRoot, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  sessions = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 7 ? projectRoot : undefined,
      listProjectRoots: () => [
        { project_id: 7, root_path: projectRoot },
      ],
    },
    projectInfoResolver: (projectId) =>
      projectId === 7
        ? {
            project_id: 7,
            name: 'Control plane fixture',
            root_path: projectRoot,
          }
        : null,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await sessions.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

function commandFor(
  sessionId: Awaited<ReturnType<FsSessionStore['createSession']>>['id'],
  key: string,
): SessionCommand<Record<string, unknown>> {
  return {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    commandId: asSessionCommandId(randomUUID()),
    idempotencyKey: key,
    kind: 'send_message',
    sessionId,
    actor: {
      actorId: 'fixture-user',
      actorType: 'user',
      source: 'http',
    },
    requestedAt: new Date().toISOString(),
    correlationId: asCorrelationId(randomUUID()),
    payload: { promptHash: 'fixture' },
  };
}

describe('FileControlPlaneStore', () => {
  async function preparingAttempt() {
    const session = await sessions.createSession({ project_id: 7, title: 'Preparation', provider: 'openai', model: 'requested' });
    const authority = new FileControlPlaneStore(sessions);
    const command = commandFor(session.id, 'prepared');
    const agentRunId = asAgentRunId(randomUUID());
    const attemptId = asAgentRunAttemptId(randomUUID());
    const executorOwnerId = `worker:${randomUUID()}`;
    await authority.acceptCommand({ command, payloadHash: hashControlPlanePayload(command.payload), run: {
      agentRunId, attemptId, role: 'build', agentDefinitionId: 'build', waitMode: 'foreground',
      requestedCapabilityProfile: 'full', executorOwnerId,
      executorExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    } });
    const context = { sessionId: session.id, commandId: command.commandId, correlationId: command.correlationId,
      actor: command.actor, agentRunId, attemptId, executorOwnerId, fencingEpoch: 1 };
    const registry = new ToolRegistry();
    registry.register({ name: 'read_file', description: 'Read', source: 'native', parameters: { type: 'object', properties: {} },
      handler: async () => ({ content: 'ok' }) });
    registry.seal();
    const preparation = prepareCoderAttempt({ sessionId: session.id, agentRunId, runnerRunId: 'runner-1', provider: 'openai', model: 'resolved-model',
      reasoningEffort: 'high', agentDefinitionId: 'build', capabilityProfile: 'full', systemPromptSha256: 'a'.repeat(64),
      environment: { kind: 'host', cwd: projectRoot }, policy: { permissionMode: 'ask', planMode: true, specMode: false },
    }, registry);
    return { authority, context, preparation };
  }

  async function facadeFixture() {
    const { authority: store, context, preparation } = await preparingAttempt();
    const admission = await store.admitCoderAttempt(context, preparation);
    const bus = createBus(new AbortController());
    const abortWorker = vi.fn(async () => {});
    const provideInput = vi.fn(async () => true);
    const activate = () => activateCoderRuntimeFacade({ store, context, preparation, admission, bus,
      workerEntrypointSha256: 'a'.repeat(64), assertOwner() {}, abortWorker, provideInput,
      workerClosed: new Promise<void>(() => {}),
    });
    return { store, context, preparation, admission, bus, abortWorker, provideInput, activate };
  }

  it('preserves a worker terminal committed between the HTTP observation and queued fallback', async () => {
    const { authority, context } = await preparingAttempt();
    expect((await authority.getAttemptState(context)).command.status).toBe('accepted');
    const workerTerminal = authority.terminalizeRun({ context, status: 'failed', commandStatus: 'failed',
      reason: 'worker-startup-failed', attemptLeaseStatus: 'released' });
    const httpFallback = authority.terminalizeCommand({ context, status: 'failed', reason: 'request-setup-failed', preserveExistingTerminal: true });
    await Promise.all([workerTerminal, httpFallback]);
    expect(await authority.getCommand(context.sessionId, context.commandId)).toMatchObject({ status: 'failed', reasonCode: 'worker-startup-failed' });
    await expect(authority.terminalizeCommand({ context, status: 'failed', reason: 'request-setup-failed' })).rejects.toThrow('reason differs');
  });

  it('activates the real legacy preparation through the facade only after committing its immutable runtime route', async () => {
    const f = await facadeFixture();
    const markStarted = f.store.markRunStarted.bind(f.store);
    vi.spyOn(f.store, 'markRunStarted').mockImplementation(async (...args) => {
      expect(await f.store.getRuntimeRoute(f.context.sessionId, f.context.attemptId)).toMatchObject({
        runtimeGeneration: 'legacy_ts', preference: 'legacy_required', provider: f.preparation.provider,
        capabilityCatalogVersion: f.preparation.capabilitySet.catalogVersion,
      });
      return markStarted(...args);
    });
    const handle = await f.activate();
    expect(handle.runtimeGeneration).toBe('legacy_ts');
    expect(await handle.getSnapshot()).toMatchObject({ run: { status: 'running' },
      activeAttempt: { runnerRunId: f.preparation.runnerRunId },
      stream: { id: f.bus.busId, durability: 'volatile', sequenceScope: 'stream' } });
    const reopened = new FileControlPlaneStore(sessions);
    expect(await reopened.getRuntimeRoute(f.context.sessionId, f.context.attemptId))
      .toEqual(await f.store.getRuntimeRoute(f.context.sessionId, f.context.attemptId));
    publish(f.bus, 'delta', { text: 'hello' });
    const iterator = handle.subscribeEvents()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'legacy.delta', payload: { text: 'hello' },
      partitionKey: f.bus.busId, stream: { durability: 'volatile' } });
    await iterator.return?.();
    await Promise.all([handle.cancel({ code: 'user_cancelled' }), handle.cancel({ code: 'user_cancelled' })]);
    expect(f.abortWorker).toHaveBeenCalledOnce();
    await expect(reopened.markRunStarted(f.context, f.preparation.runnerRunId)).rejects.toThrow('cancellation');
  });

  it('blocks admission after a cancellation committed before worker preparation, including after reopen', async () => {
    const { authority: store, context, preparation } = await preparingAttempt();
    await store.commitRuntimeRequest(context, 'cancel', { code: 'user_cancelled' });
    const reopened = new FileControlPlaneStore(sessions);
    await expect(reopened.admitCoderAttempt(context, preparation)).rejects.toThrow('cancellation');
    await expect(reopened.markRunStarted(context, preparation.runnerRunId)).rejects.toThrow('cancellation');
  });

  it('never activates when a route write fails or its ACK is lost', async () => {
    for (const loseAck of [false, true]) {
      const f = await facadeFixture();
      const create = ControlPlaneFileRepository.prototype.create;
      const spy = vi.spyOn(ControlPlaneFileRepository.prototype, 'create').mockImplementation(async function (this: ControlPlaneFileRepository, kind, input) {
        if (kind !== 'runtimeRoute') return create.call(this, kind, input);
        if (loseAck) await create.call(this, kind, input);
        throw new Error(loseAck ? 'route ACK lost' : 'ENOSPC route');
      });
      const start = vi.spyOn(f.store, 'markRunStarted');
      await expect(f.activate()).rejects.toThrow(loseAck ? 'route ACK lost' : 'ENOSPC');
      expect(start).not.toHaveBeenCalled();
      expect(await f.store.getRun(f.context.sessionId, f.context.agentRunId)).toMatchObject({ status: 'failed' });
      spy.mockRestore();
    }
  });

  it('rejects a legacy preparation whose admitted facts were changed before facade activation', async () => {
    const f = await facadeFixture();
    f.preparation.model = 'tampered';
    await expect(f.activate()).rejects.toThrow('admitted facts');
    expect(await f.store.getRuntimeRoute(f.context.sessionId, f.context.attemptId)).toBeNull();
    expect(f.abortWorker).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent interaction delivery and never retries a lost acknowledgement', async () => {
    const f = await facadeFixture();
    const handle = await f.activate();
    const response = { idempotencyKey: 'answer-1', value: 'yes' };
    await Promise.all([handle.resolveInteraction('ask-1', response), handle.resolveInteraction('ask-1', response)]);
    expect(f.provideInput).toHaveBeenCalledOnce();
    await expect(handle.resolveInteraction('ask-1', { ...response, value: 'no' })).rejects.toThrow('changed');
    f.provideInput.mockRejectedValueOnce(new Error('ACK lost'));
    await expect(handle.resolveInteraction('ask-2', { ...response, idempotencyKey: 'answer-2' })).rejects.toThrow('ACK lost');
    await expect(handle.resolveInteraction('ask-2', { ...response, idempotencyKey: 'answer-2' })).rejects.toThrow('ACK lost');
    expect(f.provideInput).toHaveBeenCalledTimes(2);
    await f.store.commitRuntimeRequest(f.context, 'interaction:answer-3', {
      interactionId: 'ask-3', response: { ...response, idempotencyKey: 'answer-3' },
    });
    await expect(handle.resolveInteraction('ask-3', { ...response, idempotencyKey: 'answer-3' })).rejects.toThrow('uncertain');
    expect(f.provideInput).toHaveBeenCalledTimes(2);
  });

  it('durably admits resolved worker facts once and preserves them across authority reopens', async () => {
    const { authority, context, preparation } = await preparingAttempt();
    const admission = await authority.admitCoderAttempt(context, preparation);
    expect(admission).toMatchObject({ preparationSha256: preparationSha256(preparation), runtimeGeneration: 'legacy_ts' });
    expect(await authority.getRun(context.sessionId, context.agentRunId)).toMatchObject({
      status: 'starting', version: 2, effectiveProvider: 'openai', effectiveModel: 'resolved-model',
      effectiveReasoningEffort: 'high', capabilitySetRef: preparation.capabilitySet.ref,
      policySnapshotRef: `${admission.preparationRef}#policy`,
    });
    const reopened = new FileControlPlaneStore(sessions);
    expect(await reopened.admitCoderAttempt(context, preparation)).toEqual(admission);
    expect(await reopened.getRun(context.sessionId, context.agentRunId)).toMatchObject({ version: 2 });
    await expect(reopened.admitCoderAttempt(context, { ...preparation, model: 'different-model' }))
      .rejects.toThrow('different facts');
    await expect(reopened.admitCoderAttempt(context, { ...preparation, systemPromptSha256: 'b'.repeat(64) }))
      .rejects.toThrow('different facts');
  });

  it('rejects stale fences, changed capability content and attempts that already started', async () => {
    const { authority, context, preparation } = await preparingAttempt();
    await expect(authority.admitCoderAttempt({ ...context, fencingEpoch: 2 }, preparation)).rejects.toThrow();
    const changed = structuredClone(preparation);
    changed.capabilityDescriptors[0].description = 'Different schema source';
    await expect(authority.admitCoderAttempt(context, changed)).rejects.toThrow('descriptor digest');
    await authority.admitCoderAttempt(context, preparation);
    await authority.markRunStarted(context, 'runner');
    await expect(authority.admitCoderAttempt(context, preparation)).rejects.toThrow('starting');
  });

  it('repairs only the projection after a lost preparation ACK and never changes the durable facts', async () => {
    const { authority, context, preparation } = await preparingAttempt();
    const create = ControlPlaneFileRepository.prototype.create;
    const spy = vi.spyOn(ControlPlaneFileRepository.prototype, 'create').mockImplementationOnce(async function (this: ControlPlaneFileRepository, kind, input) {
      await create.call(this, kind, input);
      throw new Error('lost commit ACK');
    });
    await expect(authority.admitCoderAttempt(context, preparation)).rejects.toThrow('lost commit ACK');
    spy.mockRestore();
    expect(await authority.getRun(context.sessionId, context.agentRunId)).toMatchObject({ version: 1 });
    const reopened = new FileControlPlaneStore(sessions);
    await expect(reopened.admitCoderAttempt(context, { ...preparation, model: 'wrong' })).rejects.toThrow('different facts');
    await reopened.admitCoderAttempt(context, preparation);
    expect(await reopened.getRun(context.sessionId, context.agentRunId)).toMatchObject({ version: 2, effectiveModel: 'resolved-model' });
  });

  it('does not resolve the run when preparation cannot be written', async () => {
    const { authority, context, preparation } = await preparingAttempt();
    vi.spyOn(ControlPlaneFileRepository.prototype, 'create').mockRejectedValueOnce(new Error('ENOSPC'));
    await expect(authority.admitCoderAttempt(context, preparation)).rejects.toThrow('ENOSPC');
    expect(await authority.getRun(context.sessionId, context.agentRunId)).toMatchObject({ version: 1, status: 'starting' });
    expect((await authority.getRun(context.sessionId, context.agentRunId))?.effectiveModel).toBeUndefined();
  });

  it('allows the first SSE binding after activation but rejects replacing either bus or runner', async () => {
    const { authority, context, preparation } = await preparingAttempt();
    await authority.admitCoderAttempt(context, preparation);
    await authority.markRunStarted(context, preparation.runnerRunId);
    await authority.bindCommandExecution(context, 'bus:first');
    await authority.bindCommandExecution(context, 'bus:first');
    await expect(authority.bindCommandExecution(context, 'bus:other')).rejects.toThrow('cannot bind');
    await expect(authority.markRunStarted(context, 'other-runner')).rejects.toThrow('different runner');
    expect(await authority.getCommand(context.sessionId, context.commandId)).toMatchObject({ result: { busId: 'bus:first' } });
  });

  it('persists idempotent command/run/attempt authority inside the session bundle', async () => {
    const session = await sessions.createSession({
      project_id: 7,
      title: 'Filesystem authority',
      provider: 'openai',
      model: 'gpt-test',
    });
    const authority = new FileControlPlaneStore(sessions, {
      journalEnabled: true,
    });
    const command = commandFor(session.id, 'client-key');
    const agentRunId = asAgentRunId(randomUUID());
    const attemptId = asAgentRunAttemptId(randomUUID());
    const executorOwnerId = `coder-worker:${session.id}:${agentRunId}`;
    const accepted = await authority.acceptCommand({
      command,
      payloadHash: hashControlPlanePayload(command.payload),
      run: {
        agentRunId,
        attemptId,
        role: 'build',
        agentDefinitionId: 'build',
        waitMode: 'foreground',
        requestedCapabilityProfile: 'full',
        executorOwnerId,
        executorExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted' || !accepted.agentRun || !accepted.attempt) {
      throw new Error('expected accepted command with a run');
    }

    const replay = await authority.acceptCommand({
      command: { ...command, commandId: asSessionCommandId(randomUUID()) },
      payloadHash: hashControlPlanePayload(command.payload),
    });
    expect(replay.kind).toBe('existing');
    if (replay.kind !== 'existing') throw new Error('expected replay');
    expect(replay.command.commandId).toBe(command.commandId);

    const context = {
      sessionId: session.id,
      commandId: command.commandId,
      correlationId: command.correlationId,
      actor: command.actor,
      agentRunId,
      attemptId,
      executorOwnerId,
      fencingEpoch: 1,
    };
    await authority.bindCommandExecution(
      context,
      `bus:${randomUUID()}`,
    );
    await authority.markRunStarted(context, `runner:${randomUUID()}`);
    const heartbeatAt = new Date().toISOString();
    await authority.renewAttemptLease(
      context,
      new Date(Date.now() + 600_000).toISOString(),
      heartbeatAt,
    );
    await authority.terminalizeRun({
      context,
      status: 'completed',
      commandStatus: 'succeeded',
      reason: 'completed',
      attemptLeaseStatus: 'released',
    });

    expect(await authority.getCommand(session.id, command.commandId)).toMatchObject({
      status: 'succeeded',
      reasonCode: 'completed',
      agentRunId,
    });
    expect(await authority.getRun(session.id, agentRunId)).toMatchObject({
      status: 'completed',
      terminalReason: 'completed',
    });

    const location = await sessions.getSessionLocation(session.id);
    if (!location) throw new Error('session bundle disappeared');
    expect(
      await readdir(join(location.bundle_path, 'events', 'commands')),
    ).toEqual(expect.arrayContaining([`${command.commandId}.json`]));
    expect(
      await readdir(join(location.bundle_path, 'events', 'runs')),
    ).toEqual(expect.arrayContaining([`${agentRunId}.json`]));
    expect(
      await readdir(join(location.bundle_path, 'events', 'attempts')),
    ).toEqual(expect.arrayContaining([`${attemptId}.json`]));
  });

  it('recovers a non-terminal run as interrupted without consulting SQLite', async () => {
    const session = await sessions.createSession({
      project_id: 7,
      title: 'Recovery',
      provider: 'anthropic',
      model: 'claude-test',
    });
    const authority = new FileControlPlaneStore(sessions);
    const command = commandFor(session.id, 'recovery-key');
    const agentRunId = asAgentRunId(randomUUID());
    const attemptId = asAgentRunAttemptId(randomUUID());
    const executorOwnerId = `coder-worker:${session.id}:${agentRunId}`;
    const accepted = await authority.acceptCommand({
      command,
      payloadHash: hashControlPlanePayload(command.payload),
      run: {
        agentRunId,
        attemptId,
        role: 'explore',
        agentDefinitionId: 'explore',
        waitMode: 'foreground',
        requestedCapabilityProfile: 'navigate',
        executorOwnerId,
        executorExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    if (
      accepted.kind !== 'accepted' ||
      !accepted.agentRun ||
      !accepted.attempt
    ) {
      throw new Error('expected accepted command with a run');
    }
    const context = {
      sessionId: session.id,
      commandId: command.commandId,
      correlationId: command.correlationId,
      actor: command.actor,
      agentRunId,
      attemptId,
      executorOwnerId,
      fencingEpoch: 1,
    };
    await authority.markRunStarted(context, 'runner-before-crash');

    const restarted = new FileControlPlaneStore(sessions);
    expect(await restarted.recoverInterruptedRuns()).toBe(1);
    expect(await restarted.getRun(session.id, agentRunId)).toMatchObject({
      status: 'interrupted',
      terminalReason: 'process-restart',
    });
    expect(
      await restarted.getCommand(session.id, command.commandId),
    ).toMatchObject({
      status: 'failed',
      reasonCode: 'process-restart',
    });
  });
});
