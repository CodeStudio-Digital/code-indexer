import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DispatchClaims } from '../dispatch-claims.js';
import { dispatchCard, type DispatchCardDeps } from '../dispatch-card.js';
import { RuntimeReconciler, type RuntimeReconcilerDeps } from '../../RuntimeReconciler.js';
import { resolveAutonomy } from '../../autonomy/autonomy-config.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function bundle() { const root = await mkdtemp(join(tmpdir(), 'company-dispatch-regression-')); roots.push(root); return root; }
const SESSION_A = 'c0000000-0000-4000-8000-000000000001';
const SESSION_B = 'c0000000-0000-4000-8000-000000000002';
const RUN_B = 'a0000000-0000-4000-8000-000000000002';
const CARD = 'e0000000-0000-4000-8000-000000000001';
function card() { return { id: CARD, title: 'One task', description: '', column: 'todo', blocked_by: [], comments: [], agents: [] as Array<{ agent_run_id: string; unassigned_at: string | null }> }; }
function fixture(root: string, shared = card(), sessionId = SESSION_A) {
  const spawn = vi.fn(async ({ reservedAgentRunId }: { reservedAgentRunId?: string }) => ({ agentRunId: reservedAgentRunId!, coderSessionId: RUN_B }));
  const deps = {
    sessionId, recommend: null,
    kanban: {
      dispatchClaims: new DispatchClaims(root), getCard: () => shared,
      assignAgent: vi.fn((_id: string, id: string) => { shared.agents.push({ agent_run_id: id, unassigned_at: null }); }),
      unassignAgent: vi.fn((_id: string, id: string) => { shared.agents = shared.agents.filter(agent => agent.agent_run_id !== id); }),
      moveCard: vi.fn((_id: string, column: string) => { shared.column = column; return shared; }), addComment: vi.fn(),
    }, subordinates: { spawn },
  } as unknown as DispatchCardDeps;
  return { deps, spawn, shared };
}
describe('Company dispatch durable ownership', () => {
  it('starts exactly one agent when independent front coordinators race on the same card', async () => {
    const root = await bundle(); const shared = card();
    const a = fixture(root, shared, SESSION_A); const b = fixture(root, shared, SESSION_B);
    const results = await Promise.all([dispatchCard(a.deps, CARD, { role: 'frontend' }), dispatchCard(b.deps, CARD, { role: 'frontend' })]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(a.spawn.mock.calls.length + b.spawn.mock.calls.length).toBe(1);
    expect(shared.agents).toHaveLength(1);
    const persisted = await new DispatchClaims(root).read(CARD);
    expect(persisted).toMatchObject({ phase: 'running', agentRunId: shared.agents[0].agent_run_id });
  });
  it('refuses an obsolete reservation after a second coordinator wins a new epoch', async () => {
    const root = await bundle(); let now = 1;
    const a = new DispatchClaims(root, () => now); const b = new DispatchClaims(root, () => now);
    const old = (await a.acquire(CARD, SESSION_A))!;
    now += 60_001; const next = (await b.acquire(CARD, SESSION_B))!;
    expect(next.epoch).toBe(old.epoch + 1);
    await expect(a.transition(CARD, old, 'starting')).rejects.toThrow('dispatch_fenced');
  });
  it('does not run an agent when durable card bookkeeping fails', async () => {
    const f = fixture(await bundle());
    vi.mocked(f.deps.kanban.assignAgent).mockImplementation(() => { throw new Error('disk unavailable'); });
    expect(await dispatchCard(f.deps, CARD, { role: 'frontend' })).toMatchObject({ ok: false, reason: 'bookkeeping_failed' });
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it('keeps uncertain spawn ownership across process-like coordinator recreation, without replay', async () => {
    const root = await bundle(); const f = fixture(root);
    f.spawn.mockRejectedValueOnce(new Error('transport closed after launch'));
    expect(await dispatchCard(f.deps, CARD, { role: 'frontend' })).toMatchObject({ ok: false, reason: 'spawn_outcome_unknown' });
    expect(await new DispatchClaims(root).acquire(CARD, SESSION_B)).toBeNull();
    expect(await new DispatchClaims(root).read(CARD)).toMatchObject({ phase: 'uncertain' });
  });
  it('does not release an uncertain spawn during orphan reconciliation even if its run record ended', async () => {
    const root = await bundle(); const claims = new DispatchClaims(root);
    const claim = (await claims.acquire(CARD, SESSION_A))!;
    await claims.transition(CARD, claim, 'starting'); await claims.transition(CARD, claim, 'uncertain');
    const moveCard = vi.fn(); const unassignAgent = vi.fn();
    const deps = {
      ctx: { companySessionId: SESSION_A, companyFiles: { listAgentRunsSync: () => [{ id: claim.agentRunId, status: 'error' }] } },
      kanban: { dispatchClaims: claims, listCardsFull: () => [{ id: CARD, column: 'in_progress', blocked_by: [], agents: [{ agent_run_id: claim.agentRunId }] }], moveCard, unassignAgent },
      autonomy: { get: () => resolveAutonomy(null, {}) },
    } as unknown as RuntimeReconcilerDeps;
    await (new RuntimeReconciler(deps) as unknown as { reconcileOrphanedCards(): Promise<void> }).reconcileOrphanedCards();
    expect(moveCard).not.toHaveBeenCalled(); expect(unassignAgent).not.toHaveBeenCalled();
    expect((await claims.read(CARD))!.phase).toBe('uncertain');
  });
  it('releases and restores a card after a proven pre-execution refusal, allowing a later legitimate retry', async () => {
    const f = fixture(await bundle());
    f.spawn.mockRejectedValueOnce(Object.assign(new Error('capacity reached'), { code: 'SPAWN_NOT_STARTED' }));
    expect(await dispatchCard(f.deps, CARD, { role: 'frontend' })).toMatchObject({ ok: false, reason: 'spawn_failed' });
    expect(f.shared.column).toBe('todo'); expect(f.shared.agents).toEqual([]);
    expect(await dispatchCard(f.deps, CARD, { role: 'frontend' })).toMatchObject({ ok: true });
  });
  it.each(['running', 'paused', 'completed'])('does not reset a sibling-owned %s run using a local catalog', async status => {
    const moveCard = vi.fn(); const unassignAgent = vi.fn();
    const deps = {
      ctx: { companySessionId: SESSION_A, companyFiles: { listAgentRunsSync: () => [], listCompanyAgentRunsSync: () => [{ id: RUN_B, status, company_session_id: SESSION_B }] } },
      kanban: { listCardsFull: () => [{ id: CARD, column: 'in_progress', blocked_by: [], agents: [{ agent_run_id: RUN_B }] }], moveCard, unassignAgent },
      autonomy: { get: () => resolveAutonomy(null, {}) },
    } as unknown as RuntimeReconcilerDeps;
    await (new RuntimeReconciler(deps) as unknown as { reconcileOrphanedCards(): Promise<void> }).reconcileOrphanedCards();
    expect(moveCard).not.toHaveBeenCalled(); expect(unassignAgent).not.toHaveBeenCalled();
  });
});
