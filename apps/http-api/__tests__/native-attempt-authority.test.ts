import { createHash } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentV1Common, agentV1Runtime, agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import { ControlPlaneFileRepository } from '@mcp/session-storage';
import { nativePrepareAttempt, type PreparedDurabilityFacts, type SupervisorLifecycleFact } from '@mcp/agent-runtime-host';
import type { NativeWorkspaceLease } from '../native-workspace-leases.js';
import { FileControlPlaneStore } from '../file-control-plane-store.js';
import { nativeRecordId } from '../native-attempt-preparation.js';
import { nativeAttemptFixture, nativeFixtureRoute } from './native-attempt-fixture.js';
import { containmentProof } from '../../../packages/agent-runtime-host/src/__tests__/host-supervisor-fact-support.js';

const fixtures: Awaited<ReturnType<typeof nativeAttemptFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) {
  await f.sessions.close(); await rm(f.directory, { recursive: true, force: true });
} });
async function setup() { const f = await nativeAttemptFixture(); fixtures.push(f); return f; }
const control = () => ({ signal: new AbortController().signal, deadlineAtUnixMs: BigInt(Date.now() + 10_000) });

async function physicalFacts(f: Awaited<ReturnType<typeof setup>>) {
  const provenance = { runtimeInstanceId: 'runner:1', buildId: 'fixture-build', pid: 123, binarySha256: Buffer.alloc(32, 0xaa) };
  const effectiveContainment = containmentProof();
  const facts: SupervisorLifecycleFact[] = [
    { case: 'launchAccepted', value: create(agentV1Supervisor.LaunchAcceptedSchema, { identity: f.identity }) },
    { case: 'attemptProcessSpawned', value: create(agentV1Supervisor.AttemptProcessSpawnedSchema, { identity: f.identity, runnerProvenance: provenance }) },
    { case: 'attemptContainmentReport', value: create(agentV1Supervisor.AttemptContainmentReportSchema,
      { identity: f.identity, runtimeInstanceId: 'runner:1', requestedBudget: f.spec.resourceBudget, effectiveContainment }) },
  ];
  const port = f.store.createSupervisorFactPort(f.context, 'management:1');
  for (const [i, fact] of facts.entries()) {
    const hash = createHash('sha256').update(toBinary(agentV1Supervisor.ManagementPayloadSchema,
      create(agentV1Supervisor.ManagementPayloadSchema, { body: fact }))).digest();
    await port.commit(fact, { connectionId: 'management:1', messageId: `fact:${i}`, streamSeq: BigInt(i + 2),
      payloadSha256: hash, envelopeSha256: hash, observedAtUnixMs: BigInt(Date.now()) },
    { ...control(), idempotencyKey: `management-supervisor-fact:v1:${hash.toString('hex')}` });
  }
  return { connectionId: 'control:1', prepareMessageId: 'prepare:1', preparedMessageId: 'prepared:1', prepare: f.prepare,
    prepared: create(agentV1Runtime.AttemptPreparedSchema, { identity: f.identity, runtimeInstanceId: 'runner:1',
      specSha256: f.prepare.expectedSpecSha256, loadedSnapshots: f.prepare.expectedSnapshots,
      effectiveResourceBudget: f.spec.resourceBudget, effectiveContainment, readyAtUnixMs: BigInt(Date.now()) }) } satisfies PreparedDurabilityFacts;
}

describe('product native attempt admission and activation', () => {
  it('authorizes only the exact admitted worktree lease, also after reopening the store', async () => {
    const f = await setup();
    const lease: NativeWorkspaceLease = { leaseId: 'lease', attemptId: f.context.attemptId,
      ownerAgentRunId: f.context.agentRunId, environmentId: 'environment:worktree', environmentVersion: 1,
      root: 'd:\\project\\.mcp-indexer\\worktrees\\verified', access: 'exclusive_write',
      fencingEpoch: 1, version: 1, acquiredAtUnixMs: Date.now(), expiresAtUnixMs: Date.now() + 60_000 };
    await expect(f.store.assertNativeWorkspaceLease(f.context, lease)).rejects.toThrow('no admitted preparation');
    f.spec.workspaceLeaseSnapshot = create(agentV1Common.SnapshotRefSchema, {
      ref: 'workspace:lease', version: 1n, origin: 'product-authority', schemaVersion: 1,
      schemaId: 'codestudio.product.workspace-lease.v1',
      contentSha256: createHash('sha256').update(JSON.stringify(lease)).digest(),
    });
    f.input.prepare = nativePrepareAttempt(f.spec);
    await f.store.admitNativeAttempt(f.context, f.input);
    const reopened = new FileControlPlaneStore(f.sessions);
    await expect(reopened.assertNativeWorkspaceLease(f.context, lease)).resolves.toBeUndefined();
    for (const changed of [{ root: 'd:\\another-project' }, { fencingEpoch: 2 }, { access: 'read_only' as const },
      { expiresAtUnixMs: lease.expiresAtUnixMs + 1 }, { attemptId: 'another-attempt' }]) {
      await expect(reopened.assertNativeWorkspaceLease(f.context, { ...lease, ...changed }))
        .rejects.toThrow('differs from its admitted preparation');
    }
    await f.store.terminalizeRun({ context: f.context, status: 'failed', commandStatus: 'failed', reason: 'test' });
    await expect(reopened.assertNativeWorkspaceLease(f.context, lease)).rejects.toThrow();
  });

  it('does not release activation authority on disk full and repairs projection failure from the same receipt', async () => {
    const f = await setup(); await f.store.admitNativeAttempt(f.context, f.input); await nativeFixtureRoute(f, 'fixture-build');
    const facts = await physicalFacts(f);
    const port = f.store.createNativeActivationPort(f.context, f.nonce);
    const diskFull = vi.spyOn(ControlPlaneFileRepository.prototype, 'create').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    await expect(port.commitPrepared(facts, control())).rejects.toThrow('disk full');
    expect((await f.store.getAttemptState(f.context)).run.status).toBe('starting');
    expect((await f.repository.list('nativeActivation')).items).toHaveLength(0);
    diskFull.mockRestore();
    const originalUpdate = ControlPlaneFileRepository.prototype.update;
    vi.spyOn(ControlPlaneFileRepository.prototype, 'update').mockImplementationOnce(async function(this: ControlPlaneFileRepository, ...args) {
      await originalUpdate.apply(this, args);
      throw new Error('projection unavailable after updating run');
    });
    await expect(port.commitPrepared(facts, control())).rejects.toThrow('projection unavailable');
    expect((await f.store.getAttemptState(f.context)).run.version).toBe(3);
    expect((await f.store.getAttemptState(f.context)).attempt.version).toBe(1);
    vi.restoreAllMocks();
    const restored = await new FileControlPlaneStore(f.sessions).createNativeActivationPort(f.context, f.nonce).commitPrepared(facts, control());
    expect(restored.activate.agentRunVersion).toBe(3n);
    expect((await f.repository.list('nativeActivation')).items).toHaveLength(1);
    expect((await f.store.getAttemptState(f.context)).attempt.version).toBe(2);
  });

  it('refuses an expired commit deadline even when physical preparation was previously valid', async () => {
    const f = await setup(); await f.store.admitNativeAttempt(f.context, f.input); await nativeFixtureRoute(f, 'fixture-build');
    const facts = await physicalFacts(f);
    await expect(f.store.createNativeActivationPort(f.context, f.nonce).commitPrepared(facts,
      { ...control(), deadlineAtUnixMs: BigInt(Date.now() - 1) })).rejects.toThrow();
    expect((await f.repository.list('nativeActivation')).items).toHaveLength(0);
  });

  it('persists resolution and activates exact physical receipts before releasing a real grant', async () => {
    const f = await setup();
    const admission = await f.store.admitNativeAttempt(f.context, f.input);
    expect(admission.activationAuthoritySeal).toMatchObject({ agentRunVersion: 3n, attemptVersion: 2n });
    const reopened = new FileControlPlaneStore(f.sessions);
    expect(await reopened.admitNativeAttempt(f.context, f.input)).toEqual(admission);
    expect((await reopened.getAttemptState(f.context)).run).toMatchObject({ status: 'starting', effectiveProvider: 'openai', effectiveModel: 'gpt-5' });
    await nativeFixtureRoute(f, 'fixture-build');
    const facts = await physicalFacts(f);
    const port = reopened.createNativeActivationPort(f.context, f.nonce);
    const grant = await port.commitPrepared(facts, control());
    expect(grant.activate).toMatchObject({ identity: f.identity, agentRunVersion: 3n, attemptVersion: 2n, activationNonce: Uint8Array.from(f.nonce) });
    expect(await port.commitPrepared(facts, control())).toEqual(grant);
    expect((await reopened.getAttemptState(f.context)).run).toMatchObject({ status: 'running', version: 3 });
    expect((await f.repository.list('nativeActivation')).items).toHaveLength(1);
    const text = JSON.stringify((await f.repository.list('nativeActivation')).items);
    expect(text).not.toContain(f.nonce.toString('base64'));
  });

  it('rejects a changed hash, missing snapshot and another nonce before launch', async () => {
    const f = await setup();
    f.input.prepare.expectedSpecSha256[0] ^= 1;
    await expect(f.store.admitNativeAttempt(f.context, f.input)).rejects.toThrow('executable inputs');
    f.input.prepare.expectedSpecSha256[0] ^= 1;
    const snapshot = f.input.prepare.expectedSnapshots.pop()!;
    await expect(f.store.admitNativeAttempt(f.context, f.input)).rejects.toThrow('snapshots');
    f.input.prepare.expectedSnapshots.push(snapshot);
    await f.store.admitNativeAttempt(f.context, f.input);
    await nativeFixtureRoute(f, 'fixture-build');
    const facts = await physicalFacts(f);
    await expect(f.store.createNativeActivationPort(f.context, new Uint8Array(32)).commitPrepared(facts, control())).rejects.toThrow('launch authority');
    expect((await f.repository.list('nativeActivation')).items).toHaveLength(0);
  });

  it('cannot activate without physical proof or after a committed cancellation', async () => {
    const f = await setup(); await f.store.admitNativeAttempt(f.context, f.input);
    const facts = { connectionId: 'control:1', prepareMessageId: 'p', preparedMessageId: 'q', prepare: f.prepare,
      prepared: create(agentV1Runtime.AttemptPreparedSchema,
        { identity: f.identity, specSha256: f.prepare.expectedSpecSha256, readyAtUnixMs: BigInt(Date.now()) }) };
    const port = f.store.createNativeActivationPort(f.context, f.nonce);
    await expect(port.commitPrepared(facts, control())).rejects.toThrow('Rust route');
    await nativeFixtureRoute(f, 'fixture-build');
    await expect(port.commitPrepared(facts, control())).rejects.toThrow('physical launch proof');
    await f.store.commitRuntimeRequest(f.context, 'cancel', { code: 'user' });
    await expect(port.commitPrepared(facts, control())).rejects.toThrow('cancellation');
    expect((await f.store.getAttemptState(f.context)).run.status).toBe('starting');
  });

  it('reconciles activation ACK loss without issuing a different grant or changing versions twice', async () => {
    const f = await setup(); await f.store.admitNativeAttempt(f.context, f.input); await nativeFixtureRoute(f, 'fixture-build');
    const facts = await physicalFacts(f); const original = ControlPlaneFileRepository.prototype.create;
    vi.spyOn(ControlPlaneFileRepository.prototype, 'create').mockImplementationOnce(async function(this: ControlPlaneFileRepository, ...args) {
      await original.apply(this, args); throw new Error('activation ACK lost');
    });
    const port = f.store.createNativeActivationPort(f.context, f.nonce);
    await expect(port.commitPrepared(facts, control())).rejects.toThrow('ACK lost');
    expect((await f.store.getAttemptState(f.context)).run.status).toBe('starting');
    expect(await f.repository.get('nativeActivation', nativeRecordId(f.context.attemptId, 'activate'))).not.toBeNull();
    const replay = await new FileControlPlaneStore(f.sessions).createNativeActivationPort(f.context, f.nonce).commitPrepared(facts, control());
    expect(replay.activate.agentRunVersion).toBe(3n);
    expect((await f.store.getAttemptState(f.context)).attempt.version).toBe(2);
    const changed = { ...facts, preparedMessageId: 'another prepared receipt' };
    await expect(port.commitPrepared(changed, control())).rejects.toThrow('different facts');
  });
});
