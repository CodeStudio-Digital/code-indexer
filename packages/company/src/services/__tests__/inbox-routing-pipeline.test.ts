/**
 * Tests for C7 — InboxRoutingPipeline.
 *
 * Locks in:
 *   - RoleMatchingSubordinatesSource emits only matching roles, excludes master
 *   - HealthFilter drops failed_status + overloaded
 *   - LoadScorer ranks by loadFitness = 1 / (1 + pending)
 *   - routeInbox() picks winner + lists failover + flags rejections
 *   - Parity: routing decision matches legacy resolveTargetRunId for healthy targets
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInboxRoutingPipeline,
  HealthFilter,
  LoadScorer,
  RoleMatchingSubordinatesSource,
  routeInbox,
  type AgentRunCandidate,
  type InboxRoutingQuery,
} from '../inbox-routing-pipeline.js';
import type { CompanyAgentRun, AgentRunStatus } from '@mcp/company-contracts/models/agent-run.js';
import type { AgentInboxMessage } from '@mcp/company-contracts/models/inbox.js';

const COMPANY_SESSION_ID = 100;

function makeRun(id: number, role: string, status: AgentRunStatus = 'waiting'): CompanyAgentRun {
  return {
    id,
    company_session_id: COMPANY_SESSION_ID,
    role,
    coder_session_id: id,
    project_ids_json: '[]',
    provider: '',
    model: '',
    status,
    status_message: '',
    created_at: '2026-05-25T10:00:00Z',
    updated_at: '2026-05-25T10:00:00Z',
    archive_id: null,
  };
}

function makeMsg(id: number, toRunId: number): AgentInboxMessage {
  return {
    id,
    company_session_id: COMPANY_SESSION_ID,
    from_agent_run_id: 99,
    from_role: 'sender',
    to_role: null,
    to_agent_run_id: toRunId,
    kind: 'notify',
    body: 'x',
    status: 'pending',
    answer: null,
    wait_token: null,
    delivered_at: null,
    answered_at: null,
    created_at: '2026-05-25T10:00:00Z',
  } as AgentInboxMessage;
}

function makeQuery(over: Partial<InboxRoutingQuery>): InboxRoutingQuery {
  return {
    queryId: 'q1',
    companySessionId: COMPANY_SESSION_ID,
    agentRuns: [],
    pendingByRunId: new Map(),
    ...over,
  };
}

describe('RoleMatchingSubordinatesSource', () => {
  const source = new RoleMatchingSubordinatesSource();

  it('enable() requires toRole or toAgentRunId', () => {
    expect(source.enable(makeQuery({}))).toBe(false);
    expect(source.enable(makeQuery({ toRole: 'qa' }))).toBe(true);
    expect(source.enable(makeQuery({ toAgentRunId: 5 }))).toBe(true);
  });

  it('emits only runs matching toRole; excludes master', async () => {
    const runs = [
      makeRun(1, 'qa'),
      makeRun(2, 'backend'),
      makeRun(3, 'qa'),
      makeRun(4, 'master'),
    ];
    const out = await source.source(
      makeQuery({ toRole: 'qa', agentRuns: runs, pendingByRunId: new Map() }),
    );
    expect(out.map((c) => c.run.id).sort()).toEqual([1, 3]);
  });

  it('emits exactly one run when toAgentRunId is set', async () => {
    const runs = [makeRun(1, 'qa'), makeRun(2, 'qa'), makeRun(3, 'backend')];
    const out = await source.source(
      makeQuery({ toAgentRunId: 2, agentRuns: runs, pendingByRunId: new Map() }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].run.id).toBe(2);
  });

  it('populates pendingCount from pendingByRunId map', async () => {
    const runs = [makeRun(1, 'qa')];
    const messages = [makeMsg(10, 1), makeMsg(11, 1)];
    const out = await source.source(
      makeQuery({
        toRole: 'qa',
        agentRuns: runs,
        pendingByRunId: new Map([[1, messages]]),
      }),
    );
    expect(out[0].pendingCount).toBe(2);
  });
});

describe('HealthFilter', () => {
  const filter = new HealthFilter();
  const originalEnv = process.env.MCP_COMPANY_INBOX_MAX_PENDING;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MCP_COMPANY_INBOX_MAX_PENDING;
    else process.env.MCP_COMPANY_INBOX_MAX_PENDING = originalEnv;
  });

  function makeCand(run: CompanyAgentRun, pending = 0): AgentRunCandidate {
    return {
      candidateId: `run:${run.id}`,
      run,
      pendingCount: pending,
      score: 0,
      signals: {},
    };
  }

  it('drops error/aborted/interrupted', () => {
    const candidates = [
      makeCand(makeRun(1, 'qa', 'waiting')),
      makeCand(makeRun(2, 'qa', 'error')),
      makeCand(makeRun(3, 'qa', 'aborted')),
      makeCand(makeRun(4, 'qa', 'interrupted')),
    ];
    const out = filter.filter(makeQuery({ toRole: 'qa' }), candidates);
    expect(out.kept.map((c) => c.run.id)).toEqual([1]);
    expect(out.removed).toHaveLength(3);
  });

  it('drops overloaded (pending ≥ default 3)', () => {
    const candidates = [
      makeCand(makeRun(1, 'qa'), 0),
      makeCand(makeRun(2, 'qa'), 3),
      makeCand(makeRun(3, 'qa'), 10),
    ];
    const out = filter.filter(makeQuery({ toRole: 'qa' }), candidates);
    expect(out.kept.map((c) => c.run.id)).toEqual([1]);
    expect(out.removed.map((c) => c.run.id).sort()).toEqual([2, 3]);
  });

  it('honors MCP_COMPANY_INBOX_MAX_PENDING', () => {
    process.env.MCP_COMPANY_INBOX_MAX_PENDING = '5';
    const candidates = [
      makeCand(makeRun(1, 'qa'), 3),
      makeCand(makeRun(2, 'qa'), 6),
    ];
    const out = filter.filter(makeQuery({ toRole: 'qa' }), candidates);
    expect(out.kept.map((c) => c.run.id)).toEqual([1]);
    expect(out.removed.map((c) => c.run.id)).toEqual([2]);
  });
});

describe('LoadScorer', () => {
  const scorer = new LoadScorer();

  it('loadFitness = 1 / (1 + pending)', async () => {
    const candidates: AgentRunCandidate[] = [
      { candidateId: 'a', run: makeRun(1, 'qa'), pendingCount: 0, score: 0, signals: {} },
      { candidateId: 'b', run: makeRun(2, 'qa'), pendingCount: 1, score: 0, signals: {} },
      { candidateId: 'c', run: makeRun(3, 'qa'), pendingCount: 4, score: 0, signals: {} },
    ];
    const out = await scorer.score(makeQuery({ toRole: 'qa' }), candidates);
    if (!out[0].ok || !out[1].ok || !out[2].ok) return;
    expect(out[0].candidate.score).toBeCloseTo(1.0);       // 1 / 1
    expect(out[1].candidate.score).toBeCloseTo(0.5);       // 1 / 2
    expect(out[2].candidate.score).toBeCloseTo(0.2);       // 1 / 5
    // signal also surfaced
    expect(out[0].candidate.signals.loadFitness).toBeCloseTo(1.0);
  });

  it('keeps the input order (Scorer contract)', async () => {
    const candidates: AgentRunCandidate[] = [
      { candidateId: 'a', run: makeRun(1, 'qa'), pendingCount: 5, score: 0, signals: {} },
      { candidateId: 'b', run: makeRun(2, 'qa'), pendingCount: 0, score: 0, signals: {} },
    ];
    const out = await scorer.score(makeQuery({ toRole: 'qa' }), candidates);
    if (!out[0].ok || !out[1].ok) return;
    expect(out[0].candidate.run.id).toBe(1);
    expect(out[1].candidate.run.id).toBe(2);
  });
});

describe('routeInbox (end-to-end)', () => {
  const pipeline = createInboxRoutingPipeline();

  it('picks the run with smallest backlog among same-role candidates', async () => {
    const runs = [makeRun(1, 'qa'), makeRun(2, 'qa'), makeRun(3, 'qa')];
    const pending = new Map<number, AgentInboxMessage[]>([
      [1, [makeMsg(10, 1), makeMsg(11, 1)]], // pending=2
      [2, [makeMsg(12, 2)]],                  // pending=1
      [3, []],                                // pending=0 → winner
    ]);
    const decision = await routeInbox(
      pipeline,
      makeQuery({ toRole: 'qa', agentRuns: runs, pendingByRunId: pending }),
    );
    expect(decision.targetRunId).toBe(3);
    expect(decision.failoverRunIds).toEqual(expect.arrayContaining([1, 2]));
  });

  it('returns null when no healthy candidate exists', async () => {
    const runs = [makeRun(1, 'qa', 'error'), makeRun(2, 'qa', 'aborted')];
    const decision = await routeInbox(
      pipeline,
      makeQuery({ toRole: 'qa', agentRuns: runs, pendingByRunId: new Map() }),
    );
    expect(decision.targetRunId).toBeNull();
    expect(decision.rejected.map((r) => r.runId).sort()).toEqual([1, 2]);
    expect(decision.rejected.every((r) => r.reason === 'failed_status')).toBe(true);
  });

  it('flags overloaded targets in rejected list', async () => {
    const runs = [makeRun(1, 'qa'), makeRun(2, 'qa')];
    const pending = new Map<number, AgentInboxMessage[]>([
      [1, [makeMsg(10, 1), makeMsg(11, 1), makeMsg(12, 1)]], // overloaded
      [2, []],
    ]);
    const decision = await routeInbox(
      pipeline,
      makeQuery({ toRole: 'qa', agentRuns: runs, pendingByRunId: pending }),
    );
    expect(decision.targetRunId).toBe(2);
    expect(decision.rejected.find((r) => r.runId === 1)?.reason).toBe('overloaded');
    // Run 2 was the winner — should NOT appear in rejected.
    expect(decision.rejected.find((r) => r.runId === 2)).toBeUndefined();
  });

  it('honors toAgentRunId — only that run is considered', async () => {
    const runs = [makeRun(1, 'qa'), makeRun(2, 'qa'), makeRun(3, 'qa')];
    const decision = await routeInbox(
      pipeline,
      makeQuery({ toAgentRunId: 2, agentRuns: runs, pendingByRunId: new Map() }),
    );
    expect(decision.targetRunId).toBe(2);
    // No failover when scoped to a single run.
    expect(decision.failoverRunIds).toEqual([]);
  });

  it('parity with legacy resolveTargetRunId — smallest backlog wins, same role', async () => {
    // The legacy method scans `listAgentRuns(...).filter(r => r.role === toRole && r.role !== 'master')`
    // and picks the run with smallest `listInboxMessages(... status:['pending','delivered']).length`.
    // The pipeline should pick the same id.
    const runs = [
      makeRun(1, 'qa'),
      makeRun(2, 'qa'),
      makeRun(3, 'qa'),
      makeRun(4, 'backend'),   // different role — excluded
      makeRun(5, 'master'),    // master — excluded
    ];
    const pending = new Map<number, AgentInboxMessage[]>([
      [1, [makeMsg(10, 1)]],
      [2, [makeMsg(11, 2), makeMsg(12, 2)]],
      [3, []],
    ]);
    const decision = await routeInbox(
      pipeline,
      makeQuery({ toRole: 'qa', agentRuns: runs, pendingByRunId: pending }),
    );
    // Legacy would pick id=3 (zero backlog). Pipeline should match.
    expect(decision.targetRunId).toBe(3);
  });

  it('empty agent_runs → no target, no rejections', async () => {
    const decision = await routeInbox(
      pipeline,
      makeQuery({ toRole: 'qa', agentRuns: [], pendingByRunId: new Map() }),
    );
    expect(decision.targetRunId).toBeNull();
    expect(decision.rejected).toEqual([]);
    expect(decision.failoverRunIds).toEqual([]);
  });
});
