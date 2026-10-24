import { createHash } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import type { SupervisorLifecycleFact, SupervisorFactBinding } from '@mcp/agent-runtime-host';
import { ControlPlaneFileRepository } from '@mcp/session-storage';
import { FileControlPlaneStore } from '../file-control-plane-store.js';
import { supervisorFactId } from '../supervisor-fact-ledger.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';

const fixtures: Awaited<ReturnType<typeof supervisorFactFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) { await f.sessions.close(); await rm(f.directory, { recursive: true, force: true }); }
});
async function setup() { const f = await supervisorFactFixture(); fixtures.push(f); return f; }

function commitInput(fact: SupervisorLifecycleFact, seq = 2n, controller = new AbortController()) {
  const payload = toBinary(agentV1Supervisor.ManagementPayloadSchema, create(agentV1Supervisor.ManagementPayloadSchema, { body: fact }));
  const hash = createHash('sha256').update(payload).digest();
  const binding: SupervisorFactBinding = { connectionId: 'management:fixture', messageId: `fact:${seq}`,
    replyToMessageId: 'launch:fixture', streamSeq: seq, payloadSha256: hash, envelopeSha256: hash,
    observedAtUnixMs: BigInt(Date.now()) };
  const control = { signal: controller.signal, deadlineAtUnixMs: BigInt(Date.now() + 30_000),
    idempotencyKey: `management-supervisor-fact:v1:${hash.toString('hex')}` };
  return [fact, binding, control] as const;
}
function lifecycle(f: Awaited<ReturnType<typeof setup>>): SupervisorLifecycleFact[] {
  const identity = f.identity;
  return [
    { case: 'launchAccepted', value: create(agentV1Supervisor.LaunchAcceptedSchema, { identity, reservationId: 'reservation:1' }) },
    { case: 'attemptProcessSpawned', value: create(agentV1Supervisor.AttemptProcessSpawnedSchema, { identity, reservationId: 'reservation:1' }) },
    { case: 'attemptContainmentReport', value: create(agentV1Supervisor.AttemptContainmentReportSchema, { identity }) },
    { case: 'attemptProcessExited', value: create(agentV1Supervisor.AttemptProcessExitedSchema, { identity }) },
    { case: 'attemptProcessReaped', value: create(agentV1Supervisor.AttemptProcessReapedSchema, { identity }) },
  ];
}

describe('product supervisor fact authority', () => {
  it('persists all phases, preserves protobuf bytes, and reconciles exact replay after reopen', async () => {
    const f = await setup(); const facts = lifecycle(f);
    const port = f.store.createSupervisorFactPort(f.context, 'management:fixture');
    for (const [i, fact] of facts.entries()) await port.commit(...commitInput(fact, BigInt(i + 2)));
    const reopened = new FileControlPlaneStore(f.sessions).createSupervisorFactPort(f.context, 'management:fixture');
    await reopened.commit(...commitInput(facts[0]!));
    const records = await f.repository.listByRelation('supervisorFact', 'attempt', f.context.attemptId);
    expect(records.items).toHaveLength(5);
    for (const record of records.items) {
      const decoded = fromBinary(agentV1Supervisor.ManagementPayloadSchema, Buffer.from(String(record.data.encodedPayload), 'base64'));
      expect(decoded.body.case).toBe(record.data.factCase);
      expect(decoded.body.value).toMatchObject({ identity: f.identity });
    }
  });

  it('rejects missing phases, conflicting outcomes, changed replay and authority', async () => {
    const f = await setup(); const facts = lifecycle(f);
    const port = f.store.createSupervisorFactPort(f.context, 'management:fixture');
    await expect(port.commit(...commitInput(facts[1]!))).rejects.toThrow('predecessor');
    await port.commit(...commitInput(facts[0]!));
    const changed = commitInput(facts[0]!);
    await expect(port.commit(changed[0], { ...changed[1], messageId: 'different' }, changed[2])).rejects.toThrow('different bytes');
    const rejected = { case: 'launchRejected' as const, value: create(agentV1Supervisor.LaunchRejectedSchema, { identity: f.identity }) };
    await expect(port.commit(...commitInput(rejected))).rejects.toThrow('outcome');
    const stale = lifecycle(f)[1]!; stale.value.identity!.fencingEpoch++;
    await expect(port.commit(...commitInput(stale, 3n))).rejects.toThrow('authority');
    const foreign = commitInput(facts[1]!, 3n);
    await expect(port.commit(foreign[0], { ...foreign[1], connectionId: 'foreign' }, foreign[2])).rejects.toThrow('connection');
  });

  it('records physical exit/reap after logical cancellation without reactivating the attempt', async () => {
    const f = await setup(); const facts = lifecycle(f);
    const port = f.store.createSupervisorFactPort(f.context, 'management:fixture');
    for (let i = 0; i < 3; i++) await port.commit(...commitInput(facts[i]!, BigInt(i + 2)));
    await f.store.commitRuntimeRequest(f.context, 'cancel', { code: 'user' });
    await f.store.terminalizeRun({ context: f.context, status: 'aborted', commandStatus: 'cancelled', reason: 'user' });
    await port.commit(...commitInput(facts[3]!, 5n));
    await port.commit(...commitInput(facts[4]!, 6n));
    expect((await f.store.getAttemptState(f.context, false)).attempt.status).toBe('terminal');
    await expect(port.commit(...commitInput(facts[0]!))).rejects.toThrow('lease');
  });

  it('does not acknowledge a disk failure and reconciles a committed record after ACK loss', async () => {
    const f = await setup(); const fact = lifecycle(f)[0]!;
    const port = f.store.createSupervisorFactPort(f.context, 'management:fixture');
    const original = ControlPlaneFileRepository.prototype.create;
    const spy = vi.spyOn(ControlPlaneFileRepository.prototype, 'create');
    spy.mockRejectedValueOnce(new Error('ENOSPC'));
    await expect(port.commit(...commitInput(fact))).rejects.toThrow('ENOSPC');
    expect(await f.repository.get('supervisorFact', supervisorFactId(f.context.attemptId, fact.case))).toBeNull();
    spy.mockImplementationOnce(async function(this: ControlPlaneFileRepository, ...args) {
      await original.apply(this, args); throw new Error('ACK lost');
    });
    await expect(port.commit(...commitInput(fact))).rejects.toThrow('ACK lost');
    await new FileControlPlaneStore(f.sessions).createSupervisorFactPort(f.context, 'management:fixture').commit(...commitInput(fact));
    expect((await f.repository.list('supervisorFact')).items).toHaveLength(1);
  });

  it('rejects late completion after abort but permits exact reconciliation without another record', async () => {
    const f = await setup(); const fact = lifecycle(f)[0]!;
    const controller = new AbortController(); const port = f.store.createSupervisorFactPort(f.context, 'management:fixture');
    const original = ControlPlaneFileRepository.prototype.create;
    vi.spyOn(ControlPlaneFileRepository.prototype, 'create').mockImplementationOnce(async function(this: ControlPlaneFileRepository, ...args) {
      const result = await original.apply(this, args); controller.abort(new Error('timed out')); return result;
    });
    await expect(port.commit(...commitInput(fact, 2n, controller))).rejects.toThrow('timed out');
    await port.commit(...commitInput(fact));
    expect((await f.repository.list('supervisorFact')).items).toHaveLength(1);
  });

  it('does not write a queued fact after its commit was cancelled', async () => {
    const f = await setup(); const controller = new AbortController();
    let release!: () => void;
    const blocked = f.sessions.runSessionMutation(f.context.sessionId, () => new Promise<void>((resolve) => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const pending = f.store.createSupervisorFactPort(f.context, 'management:fixture').commit(...commitInput(lifecycle(f)[0]!, 2n, controller));
    controller.abort(new Error('cancelled in queue'));
    release(); await blocked;
    await expect(pending).rejects.toThrow('cancelled in queue');
    expect((await f.repository.list('supervisorFact')).items).toHaveLength(0);
  });

  it('snapshots the payload before queueing and rejects expired or incorrectly keyed commits', async () => {
    const f = await setup(); const fact = lifecycle(f)[0]!;
    const port = f.store.createSupervisorFactPort(f.context, 'management:fixture');
    const input = commitInput(fact);
    await expect(async () => port.commit(input[0], input[1], { ...input[2], deadlineAtUnixMs: 1n })).rejects.toThrow('deadline');
    await expect(async () => port.commit(input[0], input[1], { ...input[2], idempotencyKey: 'arbitrary' })).rejects.toThrow('envelope');
    const pending = port.commit(...input);
    if (fact.case === 'launchAccepted') fact.value.reservationId = 'changed after enqueue';
    await pending;
    const record = await f.repository.get('supervisorFact', supervisorFactId(f.context.attemptId, fact.case));
    const payload = fromBinary(agentV1Supervisor.ManagementPayloadSchema, Buffer.from(String(record!.data.encodedPayload), 'base64'));
    expect(payload.body.value).toMatchObject({ reservationId: 'reservation:1' });
  });
});
