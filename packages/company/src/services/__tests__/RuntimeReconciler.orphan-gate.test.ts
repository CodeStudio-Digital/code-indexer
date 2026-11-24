/**
 * C2 — the orphaned-card sweep is gated by the per-session autonomy config
 * (action `orphanReset`, default ON — it follows the scheduler default).
 * Minimal fixture: one `in_progress` card assigned to a dead run; asserts
 * the reset happens/does not happen depending on provider/env, and that the
 * gate is consulted LIVE (per sweep, not at construction).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeReconciler, type RuntimeReconcilerDeps } from '../RuntimeReconciler.js';
import { resolveAutonomy } from '../autonomy/autonomy-config.js';

const SESSION_ID = 'c0000000-0000-4000-8000-000000000001';
const DEAD_RUN_ID = 'a0000000-0000-4000-8000-000000000005';
const CARD_ID = 'e0000000-0000-4000-8000-000000000010';

/** Fake per-session autonomy provider over a session `autonomy` object. */
function fakeAutonomy(autonomy: Record<string, unknown>) {
  return { get: () => resolveAutonomy(JSON.stringify({ autonomy }), {} as NodeJS.ProcessEnv) };
}

function makeReconciler(opts: {
  autonomy?: { get: () => ReturnType<typeof resolveAutonomy> };
}) {
  const moveCard = vi.fn();
  const unassignAgent = vi.fn();
  const addComment = vi.fn();
  const deps = {
    ctx: {
      companySessionId: SESSION_ID,
      companyFiles: {
        // This run is dead ('completed') → the card below is orphaned.
        listAgentRunsSync: () => [{ id: DEAD_RUN_ID, role: 'frontend', status: 'completed' }],
      },
    },
    kanban: {
      listCardsFull: () => [{
        id: CARD_ID,
        column: 'in_progress',
        blocked_by: [],
        agents: [{ agent_run_id: DEAD_RUN_ID, unassigned_at: null }],
      }],
      moveCard,
      unassignAgent,
      addComment,
    },
    autonomy: opts.autonomy,
  } as unknown as RuntimeReconcilerDeps;
  const reconciler = new RuntimeReconciler(deps);
  // The gate under test is private; the public tick() drags master/subordinate
  // reconciliation (heavy fixtures) along, so we call the sweep directly.
  const sweep = () =>
    (reconciler as unknown as { reconcileOrphanedCards: () => Promise<void> })
      .reconcileOrphanedCards();
  return { sweep, moveCard, unassignAgent };
}

it('recovers the persisted agent once when the Company is restarted and keeps its card assigned', async () => {
  vi.stubEnv('MCP_COMPANY_AUTO_REESTABLISH', '1');
  let company = 'interrupted';
  let owned = false;
  const run = { id: DEAD_RUN_ID, role: 'frontend', status: 'interrupted' };
  const recover = vi.fn(async () => { owned = true; run.status = 'running'; });
  const moveCard = vi.fn(), unassignAgent = vi.fn();
  const reconciler = new RuntimeReconciler({
    ctx: { companySessionId: SESSION_ID, companyFiles: {
      getSession: () => ({ status: company }), listAgentRunsSync: () => [run], listInboxMessagesSync: () => [],
    } },
    subordinates: { ownsRuntime: () => owned, recover },
    master: { isAlive: false }, autonomy: fakeAutonomy({ orphanReset: true }),
    kanban: { listCardsFull: () => [{ id: CARD_ID, column: 'in_progress', agents: [{ agent_run_id: run.id }] }], moveCard, unassignAgent },
  } as unknown as RuntimeReconcilerDeps);
  try {
    await reconciler.tick();
    expect(recover).not.toHaveBeenCalled();
    company = 'running';
    await reconciler.tick();
    await reconciler.tick();
    expect(recover).toHaveBeenCalledExactlyOnceWith(run.id, expect.any(String));
    expect(unassignAgent).not.toHaveBeenCalled();
    expect(moveCard).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

describe('RuntimeReconciler — C2 orphanReset autonomy gate', () => {
  beforeEach(() => { vi.stubEnv('MCP_COMPANY_SCHEDULER', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('default ON: no env, no provider → orphaned card is unassigned and reset to todo', async () => {
    const { sweep, moveCard, unassignAgent } = makeReconciler({});
    await sweep();
    expect(unassignAgent).toHaveBeenCalledWith(CARD_ID, DEAD_RUN_ID);
    expect(moveCard).toHaveBeenCalledWith(CARD_ID, 'todo');
  });

  it("env MCP_COMPANY_SCHEDULER='0' kills the sweep (no provider → env fallback)", async () => {
    vi.stubEnv('MCP_COMPANY_SCHEDULER', '0');
    const { sweep, moveCard } = makeReconciler({});
    await sweep();
    expect(moveCard).not.toHaveBeenCalled();
  });

  it('session autonomy.orphanReset=false disables via provider', async () => {
    const { sweep, moveCard } = makeReconciler({
      autonomy: fakeAutonomy({ orphanReset: false }),
    });
    await sweep();
    expect(moveCard).not.toHaveBeenCalled();
  });

  it('freeze kills the sweep even with orphanReset=true', async () => {
    const { sweep, moveCard } = makeReconciler({
      autonomy: fakeAutonomy({ orphanReset: true, freeze: true }),
    });
    await sweep();
    expect(moveCard).not.toHaveBeenCalled();
  });

  it('gate is consulted LIVE — flipping the provider config between sweeps flips behavior', async () => {
    let frozen = true;
    const { sweep, moveCard } = makeReconciler({
      autonomy: {
        get: () => resolveAutonomy(
          JSON.stringify({ autonomy: { freeze: frozen } }),
          {} as NodeJS.ProcessEnv,
        ),
      },
    });
    await sweep();
    expect(moveCard).not.toHaveBeenCalled();
    frozen = false; // e.g. PATCH /config lifted the freeze → provider re-reads
    await sweep();
    expect(moveCard).toHaveBeenCalledWith(CARD_ID, 'todo');
  });
});
