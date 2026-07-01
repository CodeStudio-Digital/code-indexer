/**
 * Tests for the CompanyScheduler dispatch loop (impure shell over the pure
 * dispatch-core). Stubs the kanban/store/master/spawn collaborators and the
 * recommender shim; asserts the spawn + card-bookkeeping behavior under the
 * key gating conditions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyScheduler, type CompanySchedulerDeps } from '../CompanyScheduler.js';
import { setGlobalCompanyRecommend } from '../recommend-shim.js';

function makeCard(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: 'Build login form',
    description: 'A todo card',
    column: 'todo',
    tag: null,
    blocked_by: [],
    dependencies: [],
    agents: [],
    checklist: [],
    comments: [],
    created_at: '2026-06-01 10:00:00',
    updated_at: '2026-06-01 10:00:00',
    ...over,
  };
}

interface Spies {
  spawn: ReturnType<typeof vi.fn>;
  assignAgent: ReturnType<typeof vi.fn>;
  moveCard: ReturnType<typeof vi.fn>;
  addComment: ReturnType<typeof vi.fn>;
}

function makeScheduler(opts: {
  cards: ReturnType<typeof makeCard>[];
  masterAlive: boolean;
  runs?: Array<{ id: number; role: string; status: string }>;
}): { scheduler: CompanyScheduler; spies: Spies } {
  const spies: Spies = {
    spawn: vi.fn(async () => ({ agentRunId: 42, coderSessionId: 7 })),
    assignAgent: vi.fn(),
    moveCard: vi.fn(),
    addComment: vi.fn(),
  };
  const deps = {
    ctx: {
      companySessionId: 1,
      companyStore: { listAgentRuns: () => opts.runs ?? [] },
    },
    kanban: {
      listCardsFull: () => opts.cards,
      assignAgent: spies.assignAgent,
      moveCard: spies.moveCard,
      addComment: spies.addComment,
    },
    master: { isAlive: opts.masterAlive },
    subordinates: { spawn: spies.spawn },
    concurrencyLimit: 10,
    now: () => 0,
  } as unknown as CompanySchedulerDeps;
  return { scheduler: new CompanyScheduler(deps), spies };
}

describe('CompanyScheduler.tick', () => {
  beforeEach(() => { process.env.MCP_COMPANY_SCHEDULER = '1'; });
  afterEach(() => {
    delete process.env.MCP_COMPANY_SCHEDULER;
    setGlobalCompanyRecommend(null);
  });

  it('dispatches the recommended role for an unblocked todo card when the master is idle', async () => {
    setGlobalCompanyRecommend(async () => ({ recommendations: [{ role: 'frontend', kind: 'spawn', score: 0.9 }] }));
    const { scheduler, spies } = makeScheduler({ cards: [makeCard()], masterAlive: false });
    await scheduler.tick();
    expect(spies.spawn).toHaveBeenCalledTimes(1);
    expect(spies.spawn).toHaveBeenCalledWith(expect.objectContaining({ role: 'frontend' }));
    expect(spies.assignAgent).toHaveBeenCalledWith(1, 42, 'frontend');
    expect(spies.moveCard).toHaveBeenCalledWith(1, 'in_progress');
  });

  it('does NOT dispatch while the master is alive (master owns delegation)', async () => {
    setGlobalCompanyRecommend(async () => ({ recommendations: [{ role: 'frontend', kind: 'spawn', score: 0.9 }] }));
    const { scheduler, spies } = makeScheduler({ cards: [makeCard()], masterAlive: true });
    await scheduler.tick();
    expect(spies.spawn).not.toHaveBeenCalled();
  });

  it('skips a card when the recommender resolves no role (never blind-guesses)', async () => {
    setGlobalCompanyRecommend(async () => ({ recommendations: [] }));
    const { scheduler, spies } = makeScheduler({ cards: [makeCard()], masterAlive: false });
    await scheduler.tick();
    expect(spies.spawn).not.toHaveBeenCalled();
  });

  it('skips a blocked card', async () => {
    setGlobalCompanyRecommend(async () => ({ recommendations: [{ role: 'frontend', kind: 'spawn', score: 0.9 }] }));
    const { scheduler, spies } = makeScheduler({
      cards: [makeCard({ blocked_by: [99] })],
      masterAlive: false,
    });
    await scheduler.tick();
    expect(spies.spawn).not.toHaveBeenCalled();
  });

  it('does nothing when the fleet is already at the concurrency cap', async () => {
    setGlobalCompanyRecommend(async () => ({ recommendations: [{ role: 'frontend', kind: 'spawn', score: 0.9 }] }));
    const runs = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, role: 'frontend', status: 'running' }));
    const { scheduler, spies } = makeScheduler({ cards: [makeCard()], masterAlive: false, runs });
    await scheduler.tick();
    expect(spies.spawn).not.toHaveBeenCalled();
  });
});
