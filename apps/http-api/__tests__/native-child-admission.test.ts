import { rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Runtime, asAgentRunId, asAgentRunAttemptId, asSessionCommandId, asCorrelationId,
  type SessionCommand } from '@mcp/agent-runtime-contracts';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import { nativeChildTranscriptRef } from '../native-child-storage.js';
import { nativePrepareAttempt } from '@mcp/agent-runtime-host';
import { ControlPlaneFileRepository } from '@mcp/session-storage';
import { FileControlPlaneStore } from '../file-control-plane-store.js';
import { nativeTreeId, type NativeChildRequest } from '../native-child-admission.js';
import { nativeAttemptFixture, nativeFixtureRoute } from './native-attempt-fixture.js';

const fixtures: Awaited<ReturnType<typeof nativeAttemptFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) {
  await f.sessions.close(); await rm(f.directory, { recursive: true, force: true });
} });
async function setup(maxAgents = 4, maxDepth = 2) {
  const f = await nativeAttemptFixture(); fixtures.push(f);
  f.spec.runTreeBudget = create(agentV1Common.AgentRunBudgetSchema, { maxAgents, maxDepth });
  f.input.prepare = nativePrepareAttempt(f.spec);
  await f.store.admitNativeAttempt(f.context, f.input); await nativeFixtureRoute(f, 'tree-fixture');
  await f.store.markRunStarted(f.context, 'root-runtime');
  const request: NativeChildRequest = { idempotencyKey: 'spawn:1', role: 'review', agentDefinitionId: 'review',
    taskSha256: createHash('sha256').update(toBinary(agentV1Runtime.TaskInputSchema, f.spec.task!)).digest('hex'),
    provider: 'openai', model: 'gpt-5', deadlineAtUnixMs: Number(f.spec.deadlineAtUnixMs) - 1000 };
  return { ...f, request };
}

describe('native child admission', () => {
  it('recovers persisted inbox receipts after reopen without replay and rejects tampered payloads or sibling access', async () => {
    const f = await setup(), child = await f.store.admitNativeChild(f.context, f.request);
    const sibling = await f.store.admitNativeChild(f.context, { ...f.request, idempotencyKey: 'sibling' });
    await f.store.markRunStarted(child.context, 'child-runtime'); await f.store.markRunStarted(sibling.context, 'sibling-runtime');
    const envelope = { id: 'a'.repeat(64), from: '/root', to: '/root/child', kind: 'message', message: 'Saved before provider frontier' };
    const payload = { schema: 1, type: 'inbox', sourceAgentRunId: f.context.agentRunId, envelope };
    await f.store.commitRuntimeRequest(child.context, `native-tree:inbox:${envelope.id}`, payload);
    await f.store.terminalizeRun({ context: child.context, status: 'failed', commandStatus: 'failed', reason: 'crash before frontier' });
    const source = { reference: nativeChildTranscriptRef(child.context, f.context.attemptId) };
    const reopened = new FileControlPlaneStore(f.sessions);
    expect(await reopened.readNativeContinuationInbox(f.context, source)).toEqual([envelope]);
    await expect(reopened.readNativeContinuationInbox(sibling.context, source)).rejects.toThrow('branch');
    await expect(reopened.readNativeContinuationInbox(f.context, { agentRunId: child.context.agentRunId, attemptId: child.context.attemptId })).rejects.toThrow('terminal root');
    const rows = (await f.repository.list('runtimeRequest')).items;
    expect(rows).toHaveLength(1);
    vi.spyOn(ControlPlaneFileRepository.prototype, 'list').mockResolvedValueOnce({ items: [{ ...rows[0]!, data: {
      ...rows[0]!.data, nativeTree: { ...payload, envelope: { ...envelope, message: 'tampered' } },
    } }], nextCursor: null });
    await expect(reopened.readNativeContinuationInbox(f.context, source)).rejects.toThrow('payload differs');
  });

  it('permits explicit new followup work on a completed child while fencing ordinary resume and duplicate consumers', async () => {
    const f = await setup(8), first = await f.store.admitNativeChild(f.context, f.request);
    await f.store.markRunStarted(first.context, 'child-runtime');
    await f.store.terminalizeRun({ context: first.context, status: 'completed', commandStatus: 'succeeded', reason: 'done' });
    const request = { ...f.request, idempotencyKey: 'followup:1', resumeFromRef: nativeChildTranscriptRef(first.context, f.context.attemptId) };
    await expect(f.store.admitNativeChild(f.context, request)).rejects.toThrow(/completed/i);
    await expect(f.store.admitNativeChild(f.context, { ...f.request, idempotencyKey: 'invalid', continuationPurpose: 'followup' }))
      .rejects.toThrow('continuation');
    const followup = { ...request, continuationPurpose: 'followup' as const };
    const next = await f.store.admitNativeChild(f.context, followup);
    expect(next.kind).toBe('reserved'); expect(next.context.attemptId).not.toBe(first.context.attemptId);
    const reopened = new FileControlPlaneStore(f.sessions);
    expect((await reopened.admitNativeChild(f.context, followup)).kind).toBe('existing');
    await expect(reopened.admitNativeChild(f.context, { ...followup, idempotencyKey: 'followup:2' })).rejects.toThrow('already claimed');
    expect((await f.repository.list('run')).items).toHaveLength(3);
  });

  it('reserves a continuation source once across retries, reopen and a failed successor', async () => {
    const f = await setup(8), first = await f.store.admitNativeChild(f.context, f.request);
    await f.store.terminalizeRun({ context: first.context, status: 'failed', commandStatus: 'failed', reason: 'interrupted' });
    const request = { ...f.request, idempotencyKey: 'resume:1', resumeFromRef: nativeChildTranscriptRef(first.context, f.context.attemptId) };
    await expect(f.store.admitNativeChild(f.context, { ...request, model: 'foreign' })).rejects.toThrow('configured provider');
    const next = await f.store.admitNativeChild(f.context, request);
    const reopened = new FileControlPlaneStore(f.sessions);
    expect((await reopened.admitNativeChild(f.context, request)).kind).toBe('existing');
    await f.store.terminalizeRun({ context: next.context, status: 'failed', commandStatus: 'failed', reason: 'ACK lost' });
    await expect(reopened.admitNativeChild(f.context, { ...request, idempotencyKey: 'resume:2' })).rejects.toThrow('already claimed');
    expect((await f.repository.list('run')).items).toHaveLength(3);
  });

  it('repairs admission after a source claim ACK is lost without granting a second consumer', async () => {
    const f = await setup(8), first = await f.store.admitNativeChild(f.context, f.request);
    await f.store.terminalizeRun({ context: first.context, status: 'failed', commandStatus: 'failed', reason: 'interrupted' });
    const request = { ...f.request, idempotencyKey: 'resume:1', resumeFromRef: nativeChildTranscriptRef(first.context, f.context.attemptId) };
    const original = ControlPlaneFileRepository.prototype.create;
    const spy = vi.spyOn(ControlPlaneFileRepository.prototype, 'create').mockImplementationOnce(async function(this: ControlPlaneFileRepository, ...args) {
      await original.apply(this, args); throw new Error('claim ACK lost');
    });
    await expect(f.store.admitNativeChild(f.context, request)).rejects.toThrow('claim ACK lost'); spy.mockRestore();
    await expect(f.store.admitNativeChild(f.context, { ...request, idempotencyKey: 'foreign-consumer' })).rejects.toThrow('already claimed');
    expect((await f.store.admitNativeChild(f.context, request)).kind).toBe('reserved');
    expect((await f.store.admitNativeChild(f.context, request)).kind).toBe('existing');
    expect((await f.repository.list('run')).items).toHaveLength(3);
  });

  it('resolves a terminal journal reference after reopen and rejects a sibling reader', async () => {
    const f = await setup();
    const child = await f.store.admitNativeChild(f.context, f.request);
    const sibling = await f.store.admitNativeChild(f.context, { ...f.request, idempotencyKey: 'sibling' });
    const reference = nativeChildTranscriptRef(child.context, f.context.attemptId);
    await expect(f.store.resolveNativeChildTranscript(f.context, reference)).rejects.toThrow('terminal');
    await f.store.terminalizeRun({ context: child.context, status: 'failed', commandStatus: 'failed', reason: 'fixture' });
    const reopened = new FileControlPlaneStore(f.sessions);
    expect(await reopened.resolveNativeChildTranscript(f.context, reference)).toEqual(child.context);
    expect(await reopened.resolveSessionChildTranscript(f.context.sessionId, reference)).toEqual(child.context);
    await expect(reopened.resolveSessionChildTranscript(f.context.sessionId, reference.replace(child.context.sessionId, randomUUID()))).rejects.toThrow('session');
    await expect(reopened.resolveNativeChildTranscript(sibling.context, reference)).rejects.toThrow('branch');
    await expect(reopened.resolveNativeChildTranscript(f.context, reference.replace(child.context.sessionId, randomUUID()))).rejects.toThrow('session');
    await expect(reopened.resolveNativeChildTranscript(f.context, reference.replace(f.context.attemptId, randomUUID()))).rejects.toThrow('durable tree');
  });

  it('lets a later root read its session child journal without inheriting the old executor authority', async () => {
    const f = await setup(); const child = await f.store.admitNativeChild(f.context, f.request);
    const envelope = { id: 'b'.repeat(64), from: '/root/child', to: '/root', kind: 'message', message: 'Root inbox saved before crash' };
    await f.store.commitRuntimeRequest(f.context, `native-tree:inbox:${envelope.id}`,
      { schema: 1, type: 'inbox', sourceAgentRunId: child.context.agentRunId, envelope });
    const reference = nativeChildTranscriptRef(child.context, f.context.attemptId);
    await f.store.terminalizeRun({ context: child.context, status: 'failed', commandStatus: 'failed', reason: 'fixture' });
    await f.store.terminalizeRun({ context: f.context, status: 'failed', commandStatus: 'failed', reason: 'fixture' });
    const command: SessionCommand = { schemaVersion: 1, commandId: asSessionCommandId(randomUUID()), sessionId: f.context.sessionId,
      correlationId: asCorrelationId(randomUUID()), requestedAt: new Date().toISOString(), actor: f.context.actor,
      kind: 'send_message', idempotencyKey: randomUUID(), payload: {} };
    const current = { ...f.context, commandId: command.commandId, correlationId: command.correlationId,
      agentRunId: asAgentRunId(randomUUID()), attemptId: asAgentRunAttemptId(randomUUID()), executorOwnerId: `new-worker:${randomUUID()}` };
    await f.store.acceptCommand({ command, payloadHash: hashControlPlanePayload(command.payload), run: {
      ...current, role: 'coder', agentDefinitionId: 'coder', waitMode: 'foreground', requestedCapabilityProfile: 'full',
      executorExpiresAt: new Date(Date.now() + 60_000).toISOString() } });
    await f.store.markRunStarted(current, 'new-runtime');
    expect(await new FileControlPlaneStore(f.sessions).readNativeContinuationInbox(current,
      { agentRunId: f.context.agentRunId, attemptId: f.context.attemptId })).toEqual([envelope]);
    await expect(f.store.readNativeContinuationInbox(current, { agentRunId: current.agentRunId, attemptId: current.attemptId }))
      .rejects.toThrow('terminal root');
    expect(await new FileControlPlaneStore(f.sessions).resolveNativeChildTranscript(current, reference)).toEqual(child.context);
    expect(await new FileControlPlaneStore(f.sessions).resolveSessionChildTranscript(f.context.sessionId, reference)).toEqual(child.context);
    await expect(f.store.resolveNativeChild(current, child.context.agentRunId)).rejects.toThrow('owned reservation');
    await expect(f.store.resolveNativeChildTranscript({ ...current, fencingEpoch: 2 }, reference)).rejects.toThrow('fenced');
    await f.store.terminalizeRun({ context: current, status: 'completed', commandStatus: 'succeeded', reason: 'reader done' });
    const foreignCommand = { ...command, commandId: asSessionCommandId(randomUUID()), correlationId: asCorrelationId(randomUUID()),
      actor: { ...command.actor, actorId: 'another-session-actor' }, idempotencyKey: randomUUID() };
    const foreign = { ...current, commandId: foreignCommand.commandId, correlationId: foreignCommand.correlationId,
      actor: foreignCommand.actor, agentRunId: asAgentRunId(randomUUID()), attemptId: asAgentRunAttemptId(randomUUID()) };
    await f.store.acceptCommand({ command: foreignCommand, payloadHash: hashControlPlanePayload(foreignCommand.payload), run: {
      ...foreign, role: 'coder', agentDefinitionId: 'coder', waitMode: 'foreground', requestedCapabilityProfile: 'full',
      executorExpiresAt: new Date(Date.now() + 60_000).toISOString() } });
    await f.store.markRunStarted(foreign, 'foreign-reader');
    await expect(f.store.readNativeContinuationInbox(foreign, { agentRunId: f.context.agentRunId, attemptId: f.context.attemptId }))
      .rejects.toThrow('terminal root');
  });
  it('reserves one identity under concurrent requests and returns existing after reopen', async () => {
    const f = await setup();
    const [first, repeated] = await Promise.all([f.store.admitNativeChild(f.context, f.request), f.store.admitNativeChild(f.context, f.request)]);
    expect(first.kind).toBe('reserved'); expect(repeated.kind).toBe('existing');
    expect(first.context).toEqual(repeated.context);
    expect(first.context.commandId).toBe(f.context.commandId);
    expect(first.context.sessionId).toBe(f.context.sessionId);
    expect(first.context.agentRunId).not.toBe(f.context.agentRunId);
    expect(await new FileControlPlaneStore(f.sessions).admitNativeChild(f.context, f.request)).toEqual(repeated);
    const child = await f.store.getAttemptState(first.context);
    expect(child.run).toMatchObject({ parentAgentRunId: f.context.agentRunId, ownerAgentRunId: f.context.agentRunId,
      spawnDepth: 1, status: 'starting', effectivePreset: 'review' });
    expect((await f.repository.list('run')).items).toHaveLength(2);
    expect(await f.store.resolveNativeChild(f.context, first.context.agentRunId)).toEqual(first.context);
    await expect(f.store.resolveNativeChild(f.context, 'foreign')).rejects.toThrow('another tree');
    await expect(f.store.resolveNativeChild(first.context, first.context.agentRunId)).rejects.toThrow('root owner');
  });

  it('bounds a concurrent burst including the root and never returns a slot on logical terminal', async () => {
    const f = await setup(3);
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      f.store.admitNativeChild(f.context, { ...f.request, idempotencyKey: `spawn:${i}` })));
    const admitted = results.filter(result => result.status === 'fulfilled');
    expect(admitted).toHaveLength(2); expect(results.filter(result => result.status === 'rejected')).toHaveLength(6);
    const child = (admitted[0] as PromiseFulfilledResult<Awaited<ReturnType<FileControlPlaneStore['admitNativeChild']>>>).value;
    await f.store.markRunStarted(child.context, 'child-runtime');
    await f.store.terminalizeRun({ context: child.context, status: 'completed', commandStatus: 'succeeded', reason: 'child done' });
    expect((await f.store.getCommand(f.context.sessionId, f.context.commandId))?.status).toBe('running');
    expect((await f.store.getAttemptState(f.context)).run.status).toBe('running');
    await expect(f.store.admitNativeChild(f.context, { ...f.request, idempotencyKey: 'another' })).rejects.toThrow('agent budget');
    const replay = await f.store.admitNativeChild(f.context, { ...f.request, idempotencyKey: 'spawn:0' });
    expect(replay.kind).toBe('existing');
    expect((await f.store.getAttemptState(replay.context, false)).run.status).toBe('completed');
  });

  it('records no runnable child on disk full and repairs a reservation whose ACK was lost', async () => {
    const f = await setup(); const original = ControlPlaneFileRepository.prototype.create;
    const spy = vi.spyOn(ControlPlaneFileRepository.prototype, 'create').mockImplementationOnce(async () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    await expect(f.store.admitNativeChild(f.context, f.request)).rejects.toThrow('disk full');
    expect((await f.repository.list('run')).items).toHaveLength(1);
    spy.mockImplementationOnce(async function(this: ControlPlaneFileRepository, ...args) {
      await original.apply(this, args); throw new Error('reservation ACK lost');
    });
    await expect(f.store.admitNativeChild(f.context, f.request)).rejects.toThrow('ACK lost');
    expect((await f.repository.list('run')).items).toHaveLength(1); spy.mockRestore();
    const replay = await new FileControlPlaneStore(f.sessions).admitNativeChild(f.context, f.request);
    expect(replay.kind).toBe('existing'); expect((await f.repository.list('run')).items).toHaveLength(2);
    await expect(f.store.admitNativeChild(f.context, { ...f.request, taskSha256: 'b'.repeat(64) })).rejects.toThrow('diverged');
  });

  it('repairs run/attempt projection failure without consuming another agent', async () => {
    const f = await setup(2); const original = ControlPlaneFileRepository.prototype.create;
    vi.spyOn(ControlPlaneFileRepository.prototype, 'create').mockImplementation(async function(this: ControlPlaneFileRepository, ...args) {
      if (args[0] === 'attempt') throw new Error('projection interrupted');
      return original.apply(this, args);
    });
    await expect(f.store.admitNativeChild(f.context, f.request)).rejects.toThrow('projection interrupted');
    expect((await f.repository.list('run')).items).toHaveLength(2);
    vi.restoreAllMocks();
    const replay = await new FileControlPlaneStore(f.sessions).admitNativeChild(f.context, f.request);
    expect(replay.kind).toBe('existing'); expect((await f.repository.list('attempt')).items).toHaveLength(2);
    const tree = await f.repository.get('nativeTree', nativeTreeId(f.context.attemptId));
    expect(tree?.data.children).toHaveLength(1);
  });

  it('rejects cancellation, foreign fencing, excessive deadline and unsupported tree budget', async () => {
    const f = await setup();
    await expect(f.store.admitNativeChild({ ...f.context, fencingEpoch: 2 }, f.request)).rejects.toThrow('fenced');
    await expect(f.store.admitNativeChild(f.context, { ...f.request, deadlineAtUnixMs: Number(f.spec.deadlineAtUnixMs) + 1 })).rejects.toThrow('deadline');
    await f.store.commitRuntimeRequest(f.context, 'cancel', { code: 'user' });
    await expect(f.store.admitNativeChild(f.context, f.request)).rejects.toThrow('cancellation');
    const noChildren = await setup(1);
    await expect(noChildren.store.admitNativeChild(noChildren.context, noChildren.request)).rejects.toThrow('agent budget');
    const noDepth = await setup(4, 0);
    await expect(noDepth.store.admitNativeChild(noDepth.context, noDepth.request)).rejects.toThrow('depth');
  });

  it('seals child preparation to its reserved task and model and fences it when its parent stops', async () => {
    const f = await setup(); const child = await f.store.admitNativeChild(f.context, f.request);
    const spec = create(agentV1Runtime.ResolvedAttemptSpecSchema, { ...f.spec, role: 'review', agentDefinitionId: 'review', spawnDepth: 1,
      identity: create(agentV1Common.AttemptIdentitySchema, { ...child.context, fencingEpoch: 1n, rootAgentRunId: f.context.agentRunId,
        parentAgentRunId: f.context.agentRunId, ownerAgentRunId: f.context.agentRunId }),
      deadlineAtUnixMs: BigInt(f.request.deadlineAtUnixMs) });
    const input = { ...f.input, prepare: nativePrepareAttempt(spec) };
    const altered = structuredClone(spec); altered.providerBinding!.effectiveModel = 'different';
    await expect(f.store.admitNativeAttempt(child.context, { ...input, prepare: nativePrepareAttempt(altered) })).rejects.toThrow('reserved task, model');
    await expect(f.store.admitNativeAttempt(child.context, input)).resolves.toBeDefined();
    await f.store.commitRuntimeRequest(f.context, 'cancel', { code: 'root cancelled' });
    await expect(f.store.resolveNativeChild(f.context, child.context.agentRunId)).rejects.toThrow('cancellation');
    expect(await f.store.resolveNativeChild(f.context, child.context.agentRunId, false)).toEqual(child.context);
    await expect(f.store.getAttemptState(child.context)).rejects.toThrow('cancellation');
    await expect(f.store.renewAttemptLease(child.context, new Date(f.request.deadlineAtUnixMs).toISOString())).rejects.toThrow('cancellation');
    await expect(f.store.commitRuntimeRequest(child.context, 'cancel', { code: 'ancestor_cancelled' })).resolves.toBe(true);
    await expect(f.store.commitRuntimeRequest(child.context, 'interaction:late', {})).rejects.toThrow('cancellation');
    await f.store.terminalizeRun({ context: child.context, status: 'interrupted', commandStatus: 'failed', reason: 'root cancelled' });
    expect((await f.store.getCommand(f.context.sessionId, f.context.commandId))?.status).toBe('running');
    expect((await f.store.getAttemptState(child.context, false)).attempt.status).toBe('terminal');
  });

  it('rejects a legacy route and a different native build on a reserved child', async () => {
    const f = await setup(); const child = await f.store.admitNativeChild(f.context, f.request);
    const rootRoute = (await f.store.getRuntimeRoute(f.context.sessionId, f.context.attemptId))!;
    const route = { ...rootRoute, agentRunId: child.context.agentRunId, attemptId: child.context.attemptId };
    await expect(f.store.commitRuntimeRoute(child.context, { ...route, runtimeGeneration: 'legacy_ts' })).rejects.toThrow('root generation');
    await expect(f.store.commitRuntimeRoute(child.context, { ...route, runtimeBuildId: 'different' })).rejects.toThrow('same runtime build');
    await expect(f.store.commitRuntimeRoute(child.context, route)).resolves.toMatchObject({ inserted: true });
    await f.repository.moveToTrash('runtimeRoute', f.context.attemptId);
    await expect(f.store.getAttemptState(child.context)).rejects.toThrow('unrouted ancestor');
  });

  it('requires native ancestry and the correct depth for grandchildren', async () => {
    const f = await setup(5, 1); const child = await f.store.admitNativeChild(f.context, f.request);
    await f.store.markRunStarted(child.context, 'child-runtime');
    await expect(f.store.admitNativeChild(child.context, { ...f.request, idempotencyKey: 'grandchild' })).rejects.toThrow('unrouted ancestor');
    const rootRoute = await f.store.getRuntimeRoute(f.context.sessionId, f.context.attemptId);
    await f.repository.create('runtimeRoute', { id: child.context.attemptId, data: { checkpointType: 'runtime-route-v1',
      route: { ...rootRoute, agentRunId: child.context.agentRunId, attemptId: child.context.attemptId } } });
    await expect(f.store.admitNativeChild(child.context, { ...f.request, idempotencyKey: 'grandchild' })).rejects.toThrow('depth');
    await f.store.commitRuntimeRequest(f.context, 'cancel', { code: 'parent cancelled' });
    await expect(f.store.admitNativeChild(child.context, f.request)).rejects.toThrow('cancellation');
  });
});
