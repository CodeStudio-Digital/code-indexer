/**
 * Tests for the Phase 4 dead-letter escalation in InboxQueue.send().
 *
 * When MCP_COMPANY_INBOX_DEADLETTER=1 and a role-addressed message has no
 * viable recipient (no_target_run / failed_status), the message is re-routed
 * to the master inbox instead of queued to expire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxQueue, type InboxQueueDeps } from '../InboxQueue.js';
import type { MasterInboxRouter } from '../MasterInboxRouter.js';
import type { AgentInboxMessage, CompanyAgentRun } from '@mcp/company/types.js';

const SID = 100;

function makeRun(over: Partial<CompanyAgentRun> & Pick<CompanyAgentRun, 'id' | 'role'>): CompanyAgentRun {
  return {
    id: over.id, company_session_id: SID, role: over.role, coder_session_id: 0,
    project_ids_json: '[]', status: over.status ?? 'waiting', status_message: '',
    provider: '', model: '', created_at: '2026-05-25T10:00:00Z',
    updated_at: over.updated_at ?? new Date().toISOString(), archive_id: null,
  };
}

function makeQueue(runs: CompanyAgentRun[]): { queue: InboxQueue; enqueueForMaster: ReturnType<typeof vi.fn>; publish: ReturnType<typeof vi.fn> } {
  const mockStore = {
    listAgentRuns: () => runs,
    getAgentRun: (id: number) => runs.find((r) => r.id === id) ?? null,
    listInboxMessages: () => [] as AgentInboxMessage[],
    getCompanySession: () => null,
    createInboxMessage: () => { throw new Error('should not queue a doomed message'); },
  };
  const publish = vi.fn();
  const deps: InboxQueueDeps = {
    ctx: {
      companySessionId: SID,
      companyStore: mockStore as unknown as InboxQueueDeps['ctx']['companyStore'],
    } as unknown as InboxQueueDeps['ctx'],
    subordinates: {} as unknown as InboxQueueDeps['subordinates'],
    attention: { on: () => () => {} } as unknown as InboxQueueDeps['attention'],
    publisher: { publish } as unknown as InboxQueueDeps['publisher'],
  };
  const queue = new InboxQueue(deps);
  const enqueueForMaster = vi.fn(() => ({
    message: { id: 500, wait_token: null } as AgentInboxMessage,
    deliveredImmediately: false,
  }));
  queue.setMasterRouter({ enqueueForMaster } as unknown as MasterInboxRouter);
  return { queue, enqueueForMaster, publish };
}

describe('InboxQueue dead-letter escalation', () => {
  const original = process.env.MCP_COMPANY_INBOX_DEADLETTER;
  beforeEach(() => { process.env.MCP_COMPANY_INBOX_DEADLETTER = '1'; });
  afterEach(() => {
    if (original === undefined) delete process.env.MCP_COMPANY_INBOX_DEADLETTER;
    else process.env.MCP_COMPANY_INBOX_DEADLETTER = original;
  });

  it('escalates to the master when the target role has no agents', () => {
    const { queue, enqueueForMaster, publish } = makeQueue([]);
    const res = queue.send({ fromAgentRunId: 1, fromRole: 'backend', toRole: 'frontend', kind: 'notify', body: 'need the API shape', wait: false });
    expect(enqueueForMaster).toHaveBeenCalledTimes(1);
    const wrapped = enqueueForMaster.mock.calls[0][0].body as string;
    expect(wrapped).toMatch(/DEAD-LETTER/);
    expect(wrapped).toMatch(/need the API shape/);
    expect(res.message.id).toBe(500);
    expect(publish).toHaveBeenCalledWith('inbox_dead_letter', expect.objectContaining({ toRole: 'frontend', reason: 'no_target_run' }));
  });

  it('escalates when the only agent of the role is in a failed state', () => {
    const { queue, enqueueForMaster } = makeQueue([makeRun({ id: 9, role: 'frontend', status: 'error' })]);
    queue.send({ fromAgentRunId: 1, fromRole: 'backend', toRole: 'frontend', kind: 'notify', body: 'ping', wait: false });
    expect(enqueueForMaster).toHaveBeenCalledTimes(1);
  });

  it('does NOT escalate a healthy target', () => {
    const { queue, enqueueForMaster } = makeQueue([makeRun({ id: 9, role: 'frontend', status: 'waiting' })]);
    // Healthy target → falls through to the normal queue path, which our stub
    // store makes throw (proving we did NOT dead-letter).
    expect(() => queue.send({ fromAgentRunId: 1, fromRole: 'backend', toRole: 'frontend', kind: 'notify', body: 'ping', wait: false }))
      .toThrow(/should not queue/);
    expect(enqueueForMaster).not.toHaveBeenCalled();
  });

  it('is OFF by default (flag unset) — does not escalate', () => {
    delete process.env.MCP_COMPANY_INBOX_DEADLETTER;
    const { queue, enqueueForMaster } = makeQueue([]);
    // With the flag off, whatever the legacy path does (queue the row, or throw
    // via an unrelated fail-fast health check), the one invariant is: it must
    // NOT re-route to the master. Swallow any throw and assert on that.
    try {
      queue.send({ fromAgentRunId: 1, fromRole: 'backend', toRole: 'frontend', kind: 'notify', body: 'ping', wait: false });
    } catch { /* legacy path may throw — irrelevant to the escalation invariant */ }
    expect(enqueueForMaster).not.toHaveBeenCalled();
  });
});
