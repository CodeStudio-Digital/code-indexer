/**
 * Tests for the CompanyScheduler dispatch loop (impure shell over the pure
 * dispatch-core). Stubs the kanban/store/master/spawn collaborators and the
 * recommender shim; asserts the spawn + card-bookkeeping behavior under the
 * key gating conditions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyScheduler, type CompanySchedulerDeps } from '../CompanyScheduler.js';
import { resolveAutonomy } from '../../autonomy/autonomy-config.js';
import { setGlobalCompanyRecommend } from '../recommend-shim.js';
import { fakeDispatchClaims } from './fake-dispatch-claims.js';

const SESSION_ID = 'c0000000-0000-4000-8000-000000000001';
const AGENT_RUN_ID = 'a0000000-0000-4000-8000-000000000042';
const CODER_SESSION_ID = 'd0000000-0000-4000-8000-000000000007';
const CARD_ID = 'e0000000-0000-4000-8000-000000000001';
const BLOCKER_CARD_ID = 'e0000000-0000-4000-8000-000000000099';
const runId = (n: number): string =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Fake per-session autonomy provider over a session `autonomy` object. */
function fakeAutonomy(autonomy: Record<string, unknown>) {
  return { get: () => resolveAutonomy(JSON.stringify({ autonomy }), {} as NodeJS.ProcessEnv) };
}

function makeCard(over: Record<string, unknown> = {}) {
  return {
    id: CARD_ID,
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
  publish: ReturnType<typeof vi.fn>;
}

function makeScheduler(opts: {
  cards: ReturnType<typeof makeCard>[];
  masterAlive: boolean;
  runs?: Array<{ id: string; role: string; status: string }>;
  spawnImpl?: () => Promise<{ agentRunId: string; coderSessionId: string }>;
  /** C2 — per-session autonomy provider; omitted = env+defaults fallback. */
  autonomy?: { get: () => ReturnType<typeof resolveAutonomy> };
}): { scheduler: CompanyScheduler; spies: Spies; published: Array<{ event: string; data: unknown }> } {
  const published: Array<{ event: string; data: unknown }> = [];
  const spies: Spies = {
    spawn: vi.fn(opts.spawnImpl ?? (async () => ({
      agentRunId: AGENT_RUN_ID,
      coderSessionId: CODER_SESSION_ID,
    }))),
    assignAgent: vi.fn(),
    moveCard: vi.fn(),
    addComment: vi.fn(),
    publish: vi.fn((event: string, data: unknown) => { published.push({ event, data }); }),
  };
  const deps = {
    ctx: {
      companySessionId: SESSION_ID,
      companyFiles: { listAgentRunsSync: () => opts.runs ?? [] },
    },
    kanban: {
      dispatchClaims: fakeDispatchClaims(AGENT_RUN_ID),
      getCard: (id: string) => opts.cards.find(card => card.id === id),
      listCardsFull: () => opts.cards,
      assignAgent: spies.assignAgent,
      moveCard: spies.moveCard,
      addComment: spies.addComment,
    },
    master: { isAlive: opts.masterAlive },
    subordinates: { spawn: spies.spawn },
    concurrencyLimit: 10,
    bus: { publish: spies.publish },
    autonomy: opts.autonomy,
    now: () => 0,
  } as unknown as CompanySchedulerDeps;
  return { scheduler: new CompanyScheduler(deps), spies, published };
}

describe('CompanyScheduler.tick', () => {
  // C2 — the scheduler is ON by default. Blank-stub the env (NOT '1') so the
  // repo .env leaking into vitest can't skew these tests: blank = default ON.
  beforeEach(() => { vi.stubEnv('MCP_COMPANY_SCHEDULER', ''); });
  afterEach(() => {
    vi.unstubAllEnvs();
    setGlobalCompanyRecommend(null);
  });

  it('dispatches the recommended role for an unblocked todo card when the master is idle', async () => {
    setGlobalCompanyRecommend(async () => ({ recommendations: [{ role: 'frontend', kind: 'spawn', score: 0.9 }] }));
    const { scheduler, spies, published } = makeScheduler({ cards: [makeCard()], masterAlive: false });
    await scheduler.tick();
    expect(spies.spawn).toHaveBeenCalledTimes(1);
    expect(spies.spawn).toHaveBeenCalledWith(expect.objectContaining({ role: 'frontend' }));
    expect(spies.assignAgent).toHaveBeenCalledWith(CARD_ID, AGENT_RUN_ID, 'frontend');
    expect(spies.moveCard).toHaveBeenCalledWith(CARD_ID, 'in_progress');
    // C1 — visibility events on the session metaBus (at from deps.now → 0).
    expect(published).toContainEqual({
      event: 'scheduler_dispatched',
      data: { cardId: CARD_ID, role: 'frontend', agentRunId: AGENT_RUN_ID, at: 0 },
    });
    expect(published).toContainEqual({
      event: 'scheduler_sweep',
      data: { dispatched: 1, freeSlots: 9, at: 0 },
    });
  });

  it('dispatches ready work while the master is alive, using durable card ownership', async () => {
    setGlobalCompanyRecommend(async () => ({ recommendations: [{ role: 'frontend', kind: 'spawn', score: 0.9 }] }));
    const { scheduler, spies } = makeScheduler({ cards: [makeCard()], masterAlive: true });
    await scheduler.tick();
    expect(spies.spawn).toHaveBeenCalledOnce();
  });

  it('skips a card when the recommender resolves no role (never blind-guesses)', async () => {
    setGlobalCompanyRecommend(async () => ({ recommendations: [] }));
    const { scheduler, spies, published } = makeScheduler({ cards: [makeCard()], masterAlive: false });
    await scheduler.tick();
    expect(spies.spawn).not.toHaveBeenCalled();
    // C1 — the skip is visible; no sweep event when nothing dispatched.
    expect(published).toContainEqual({
      event: 'scheduler_skipped',
      data: { cardId: CARD_ID, reason: 'no_role', at: 0 },
    });
    expect(published.some((p) => p.event === 'scheduler_sweep')).toBe(false);
  });

  it('publishes scheduler_skipped with spawn_failed when the spawn throws', async () => {
    setGlobalCompanyRecommend(async () => ({ recommendations: [{ role: 'frontend', kind: 'spawn', score: 0.9 }] }));
    const { scheduler, published } = makeScheduler({
      cards: [makeCard()],
      masterAlive: false,
      spawnImpl: async () => { throw new Error('over cap'); },
    });
    await scheduler.tick();
    expect(published).toContainEqual({
      event: 'scheduler_skipped',
      data: { cardId: CARD_ID, reason: 'spawn_outcome_unknown', agentRunId: AGENT_RUN_ID, at: 0 },
    });
    expect(published.some((p) => p.event === 'scheduler_dispatched')).toBe(false);
    expect(published.some((p) => p.event === 'scheduler_sweep')).toBe(false);
  });

  it('skips a blocked card', async () => {
    setGlobalCompanyRecommend(async () => ({ recommendations: [{ role: 'frontend', kind: 'spawn', score: 0.9 }] }));
    const { scheduler, spies } = makeScheduler({
      cards: [makeCard({ blocked_by: [BLOCKER_CARD_ID] })],
      masterAlive: false,
    });
    await scheduler.tick();
    expect(spies.spawn).not.toHaveBeenCalled();
  });

  it('does nothing when the fleet is already at the concurrency cap', async () => {
    setGlobalCompanyRecommend(async () => ({ recommendations: [{ role: 'frontend', kind: 'spawn', score: 0.9 }] }));
    const runs = Array.from({ length: 10 }, (_, i) => ({
      id: runId(i + 1),
      role: 'frontend',
      status: 'running',
    }));
    const { scheduler, spies } = makeScheduler({ cards: [makeCard()], masterAlive: false, runs });
    await scheduler.tick();
    expect(spies.spawn).not.toHaveBeenCalled();
  });
});

describe('CompanyScheduler — C2 autonomy gate (live kill-switch in tick)', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_COMPANY_SCHEDULER', '');
    setGlobalCompanyRecommend(async () => ({
      recommendations: [{ role: 'frontend', kind: 'spawn', score: 0.9 }],
    }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setGlobalCompanyRecommend(null);
  });

  it('default ON: no env, no provider → tick dispatches (env+defaults fallback)', async () => {
    const { scheduler, spies } = makeScheduler({ cards: [makeCard()], masterAlive: false });
    await scheduler.tick();
    expect(spies.spawn).toHaveBeenCalledTimes(1);
  });

  it("env MCP_COMPANY_SCHEDULER='0' kills the tick (no provider → env fallback)", async () => {
    vi.stubEnv('MCP_COMPANY_SCHEDULER', '0');
    const { scheduler, spies } = makeScheduler({ cards: [makeCard()], masterAlive: false });
    await scheduler.tick();
    expect(spies.spawn).not.toHaveBeenCalled();
  });

  it('session autonomy.scheduler=false disables via provider (env would allow)', async () => {
    const { scheduler, spies } = makeScheduler({
      cards: [makeCard()],
      masterAlive: false,
      autonomy: fakeAutonomy({ scheduler: false }),
    });
    await scheduler.tick();
    expect(spies.spawn).not.toHaveBeenCalled();
  });

  it('freeze: start() still ARMS the timer but every tick is a no-op (live re-enable needs no restart)', async () => {
    const { scheduler, spies } = makeScheduler({
      cards: [makeCard()],
      masterAlive: false,
      autonomy: fakeAutonomy({ freeze: true }),
    });
    scheduler.start();
    try {
      // The timer must be armed even while frozen — the gate lives in tick().
      expect(
        (scheduler as unknown as { timer: unknown }).timer,
      ).not.toBeNull();
      await scheduler.tick();
      expect(spies.spawn).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
    }
  });
});
