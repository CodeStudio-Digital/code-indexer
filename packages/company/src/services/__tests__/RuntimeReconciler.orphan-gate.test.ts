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
      companySessionId: 1,
      companyStore: {
        // Run 5 is dead ('completed') → card 10 below is orphaned.
        listAgentRuns: () => [{ id: 5, role: 'frontend', status: 'completed' }],
      },
    },
    kanban: {
      listCardsFull: () => [{
        id: 10,
        column: 'in_progress',
        blocked_by: [],
        agents: [{ agent_run_id: 5, unassigned_at: null }],
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
    (reconciler as unknown as { reconcileOrphanedCards: () => void })
      .reconcileOrphanedCards();
  return { sweep, moveCard, unassignAgent };
}

describe('RuntimeReconciler — C2 orphanReset autonomy gate', () => {
  beforeEach(() => { vi.stubEnv('MCP_COMPANY_SCHEDULER', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('default ON: no env, no provider → orphaned card is unassigned and reset to todo', () => {
    const { sweep, moveCard, unassignAgent } = makeReconciler({});
    sweep();
    expect(unassignAgent).toHaveBeenCalledWith(10, 5);
    expect(moveCard).toHaveBeenCalledWith(10, 'todo');
  });

  it("env MCP_COMPANY_SCHEDULER='0' kills the sweep (no provider → env fallback)", () => {
    vi.stubEnv('MCP_COMPANY_SCHEDULER', '0');
    const { sweep, moveCard } = makeReconciler({});
    sweep();
    expect(moveCard).not.toHaveBeenCalled();
  });

  it('session autonomy.orphanReset=false disables via provider', () => {
    const { sweep, moveCard } = makeReconciler({
      autonomy: fakeAutonomy({ orphanReset: false }),
    });
    sweep();
    expect(moveCard).not.toHaveBeenCalled();
  });

  it('freeze kills the sweep even with orphanReset=true', () => {
    const { sweep, moveCard } = makeReconciler({
      autonomy: fakeAutonomy({ orphanReset: true, freeze: true }),
    });
    sweep();
    expect(moveCard).not.toHaveBeenCalled();
  });

  it('gate is consulted LIVE — flipping the provider config between sweeps flips behavior', () => {
    let frozen = true;
    const { sweep, moveCard } = makeReconciler({
      autonomy: {
        get: () => resolveAutonomy(
          JSON.stringify({ autonomy: { freeze: frozen } }),
          {} as NodeJS.ProcessEnv,
        ),
      },
    });
    sweep();
    expect(moveCard).not.toHaveBeenCalled();
    frozen = false; // e.g. PATCH /config lifted the freeze → provider re-reads
    sweep();
    expect(moveCard).toHaveBeenCalledWith(10, 'todo');
  });
});
