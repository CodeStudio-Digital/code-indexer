import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { companyFixture } from './company-multisession-fixture.js';
import { CompanySessionMessenger } from '../session-messenger.js';
import { InboxQueue } from '../InboxQueue.js';

describe('Company session addressing and durable inbox', () => {
  it('routes to the exact sibling session, preserving ownership and idempotency across instances', async () => {
    const f = await companyFixture(); const source = f.files(f.company.id); const target = f.files(f.child.id);
    const input = { targetSessionId: f.child.id, targetRole: 'master', body: 'Review the implementation', idempotencyKey: 'human-one' };
    const [a, b] = await Promise.all([new CompanySessionMessenger(source).send(input, 'operator'), new CompanySessionMessenger(source).send(input, 'operator')]);
    expect(a.id).toBe(b.id); expect(target.listInboxMessagesSync()).toHaveLength(1); expect(source.listInboxMessagesSync()).toHaveLength(0);
    expect(a).toMatchObject({ from_session_id: f.company.id, to_session_id: f.child.id, origin: 'operator', status: 'pending' });
    await expect(new CompanySessionMessenger(source).send({ ...input, body: 'different request' }, 'operator')).rejects.toThrow('idempotency');
  });
  it('rejects another company and an agent UUID belonging to another session', async () => {
    const f = await companyFixture(); const source = f.files(f.company.id);
    const run = await source.createAgentRun({ role: 'frontend', coder_session_id: randomUUID(), project_ids: [7], provider: 'fixture', model: 'fixture' });
    const messenger = new CompanySessionMessenger(source);
    await expect(messenger.send({ targetSessionId: f.foreign.id, targetRole: 'master', body: 'No', idempotencyKey: 'foreign', fromAgentRunId: run.id })).rejects.toThrow('company boundaries');
    await expect(messenger.send({ targetSessionId: f.child.id, targetAgentRunId: run.id, body: 'No', idempotencyKey: 'wrong-agent', fromAgentRunId: run.id })).rejects.toThrow('does not belong');
    await expect(messenger.send({ targetSessionId: f.child.id, targetRole: 'master', body: 'No', idempotencyKey: 'fake', fromAgentRunId: randomUUID() })).rejects.toThrow('Unknown source agent');
  });
  it('recovers an answer from disk and waits through a watcher rather than repeated polling', async () => {
    const f = await companyFixture(); const source = f.files(f.company.id); const target = f.files(f.child.id);
    const message = await new CompanySessionMessenger(source).send({ targetSessionId: f.child.id, targetRole: 'master', body: 'Which test?', kind: 'question', idempotencyKey: 'answer' }, 'operator');
    const waiting = new CompanySessionMessenger(source).wait(f.child.id, message.id);
    target.answerInboxMessageSync(message.id, 'regression.test.ts');
    await expect(waiting).resolves.toBe('regression.test.ts');
    await expect(new CompanySessionMessenger(source).wait(f.child.id, message.id)).resolves.toBe('regression.test.ts');
  });
  it('cancels waiting without deleting the queued request', async () => {
    const f = await companyFixture(); const source = f.files(f.company.id); const abort = new AbortController();
    const message = await new CompanySessionMessenger(source).send({ targetSessionId: f.child.id, targetRole: 'master', body: 'Pending', idempotencyKey: 'cancel-wait' }, 'operator');
    abort.abort(new Error('session paused'));
    await expect(new CompanySessionMessenger(source).wait(f.child.id, message.id, abort.signal)).rejects.toThrow('session paused');
    expect(f.files(f.child.id).getInboxMessageSync(message.id)?.status).toBe('pending');
  });
  it('wakes the target inbox from an external write while retaining requests for an explicitly paused session', async () => {
    const f = await companyFixture(); const files = f.files(f.child.id);
    const router = { tryDeliverNow: vi.fn(async () => undefined) };
    const inbox = new InboxQueue({ ctx: { companySessionId: f.child.id, companyFiles: files, isAborted: false }, attention: { on: vi.fn() }, subordinates: {}, publisher: { publish: vi.fn() } } as never);
    inbox.setMasterRouter(router as never); inbox.startExternalDeliveryWatcher();
    try {
      await new CompanySessionMessenger(f.files(f.company.id)).send({ targetSessionId: f.child.id, targetRole: 'master', body: 'Wake', idempotencyKey: 'wake' }, 'operator');
      await vi.waitFor(() => expect(router.tryDeliverNow).toHaveBeenCalledOnce());
      await files.updateSessionStatus('paused');
      await new CompanySessionMessenger(f.files(f.company.id)).send({ targetSessionId: f.child.id, targetRole: 'master', body: 'Queue', idempotencyKey: 'paused' }, 'operator');
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(router.tryDeliverNow).toHaveBeenCalledOnce();
    } finally { inbox.dispose(); }
  });
});
