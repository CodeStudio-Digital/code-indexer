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
import type { AgentInboxMessage } from '@mcp/company/types.js';
import type { CompanyAgentRunFileRow } from '../CompanySessionFiles.js';
import {
  asAgentRunId,
  asCompanySessionId,
  asSessionId,
} from '@mcp/session-storage';

const SID = asCompanySessionId('c0000000-0000-4000-8000-000000000100');
const runId = (n: number) =>
  asAgentRunId(`a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const messageId = (n: number): string =>
  `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CODER_SESSION_ID = asSessionId('d0000000-0000-4000-8000-000000000001');

function makeRun(
  over: Partial<CompanyAgentRunFileRow> &
    Pick<CompanyAgentRunFileRow, 'id' | 'role'>,
): CompanyAgentRunFileRow {
  return {
    id: over.id, seq: over.seq ?? 1, company_session_id: SID, role: over.role, coder_session_id: CODER_SESSION_ID,
    project_ids_json: '[]', status: over.status ?? 'waiting', status_message: '',
    provider: '', model: '', configured_provider: '', configured_model: '',
    dispatch_source: 'company', fallback_reason: null, created_at: '2026-05-25T10:00:00Z',
    updated_at: over.updated_at ?? new Date().toISOString(), archive_id: null,
    board_watermark_seq: 0,
  };
}

function makeQueue(runs: CompanyAgentRunFileRow[]): { queue: InboxQueue; enqueueForMaster: ReturnType<typeof vi.fn>; publish: ReturnType<typeof vi.fn> } {
  const companyFiles = {
    listAgentRunsSync: () => runs,
    getAgentRunSync: (id: string) => runs.find((r) => r.id === id) ?? null,
    listInboxMessagesSync: () => [] as AgentInboxMessage[],
    getSession: () => ({ id: SID, name: 'test' }),
    createInboxMessageSync: () => { throw new Error('should not queue a doomed message'); },
  };
  const publish = vi.fn();
  const deps: InboxQueueDeps = {
    ctx: {
      companySessionId: SID,
      companyFiles,
    } as unknown as InboxQueueDeps['ctx'],
    subordinates: {} as unknown as InboxQueueDeps['subordinates'],
    attention: { on: () => () => {} } as unknown as InboxQueueDeps['attention'],
    publisher: { publish } as unknown as InboxQueueDeps['publisher'],
  };
  const queue = new InboxQueue(deps);
  const enqueueForMaster = vi.fn(() => ({
    message: {
      id: messageId(500),
      seq: 500,
      company_session_id: SID,
      from_agent_run_id: runId(1),
      from_role: 'backend',
      to_role: 'master',
      to_agent_run_id: null,
      kind: 'notify' as const,
      body: 'dead letter',
      status: 'pending' as const,
      answer: null,
      wait_token: null,
      created_at: new Date().toISOString(),
      delivered_at: null,
      answered_at: null,
    },
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
    const res = queue.send({ fromAgentRunId: runId(1), fromRole: 'backend', toRole: 'frontend', kind: 'notify', body: 'need the API shape', wait: false });
    expect(enqueueForMaster).toHaveBeenCalledTimes(1);
    const wrapped = enqueueForMaster.mock.calls[0][0].body as string;
    expect(wrapped).toMatch(/DEAD-LETTER/);
    expect(wrapped).toMatch(/need the API shape/);
    expect(res.message.id).toBe(messageId(500));
    expect(publish).toHaveBeenCalledWith('inbox_dead_letter', expect.objectContaining({ toRole: 'frontend', reason: 'no_target_run' }));
  });

  it('escalates when the only agent of the role is in a failed state', () => {
    const { queue, enqueueForMaster } = makeQueue([makeRun({ id: runId(9), role: 'frontend', status: 'error' })]);
    queue.send({ fromAgentRunId: runId(1), fromRole: 'backend', toRole: 'frontend', kind: 'notify', body: 'ping', wait: false });
    expect(enqueueForMaster).toHaveBeenCalledTimes(1);
  });

  it('does NOT escalate a healthy target', () => {
    const { queue, enqueueForMaster } = makeQueue([makeRun({ id: runId(9), role: 'frontend', status: 'waiting' })]);
    // Healthy target → falls through to the normal queue path, which our stub
    // store makes throw (proving we did NOT dead-letter).
    expect(() => queue.send({ fromAgentRunId: runId(1), fromRole: 'backend', toRole: 'frontend', kind: 'notify', body: 'ping', wait: false }))
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
      queue.send({ fromAgentRunId: runId(1), fromRole: 'backend', toRole: 'frontend', kind: 'notify', body: 'ping', wait: false });
    } catch { /* legacy path may throw — irrelevant to the escalation invariant */ }
    expect(enqueueForMaster).not.toHaveBeenCalled();
  });
});
