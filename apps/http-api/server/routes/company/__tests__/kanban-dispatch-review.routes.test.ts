import { randomUUID } from 'node:crypto';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { companyFixture } from '@mcp/company/services/__tests__/company-multisession-fixture.js';
import { DispatchClaims } from '@mcp/company/services/scheduler/dispatch-claims.js';
import { CompanyWorkspaceCoordinator } from '@mcp/company/services/workspace-coordinator.js';
import { CompanyKanbanFiles } from '@mcp/company/services/company-kanban-files.js';
import { withSessionLock } from '../../coder/sessionLock.js';
const runtime = vi.hoisted(() => ({ get: vi.fn(() => null), spawn: vi.fn() }));
vi.mock('../../../../sse/companyOrchestrator.js', () => ({ getCompanyOrchestrator: runtime.get, getOrSpawnCompanyOrchestrator: runtime.spawn, evictCompanyOrchestrator: vi.fn() }));
import { mountCompanyKanbanDispatchRoutes } from '../kanban-dispatch.js';
beforeEach(() => { runtime.get.mockReset().mockReturnValue(null); runtime.spawn.mockReset(); });
afterEach(() => vi.restoreAllMocks());
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }
async function fixture() {
  const f = await companyFixture(); const files = f.files(f.company.id);
  const card = files.createKanbanCardSync({ title: 'Fix checkout', description: 'Original task evidence', column: 'in_progress' });
  const claims = new DispatchClaims(files.location.bundle_path);
  const claim = (await claims.acquire(card.id, f.child.id))!;
  await claims.transition(card.id, claim, 'starting'); await claims.transition(card.id, claim, 'uncertain', 'Worker acknowledgement lost');
  const ownerFiles = f.files(f.child.id);
  const run = await ownerFiles.createAgentRun({ id: claim.agentRunId, role: 'frontend', coder_session_id: randomUUID(), provider: 'fixture', model: 'fixture', project_ids: [7], status: 'error' });
  files.assignKanbanAgentSync(card.id, run.id, run.role);
  const app = new HttpRouter(); mountCompanyKanbanDispatchRoutes(app, f as never);
  const path = `/api/company/sessions/${f.company.id}/kanban/cards/${card.id}/dispatch-review`;
  const post = (body: Record<string, unknown> = { reviewed: true, token: claim.token, epoch: claim.epoch }) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ...f, files, ownerFiles, card, claims, claim, run, app, path, post };
}
describe('Fenced Company dispatch review', () => {
  it('exposes the exact task, owner, original error and conversation before operator review', async () => {
    const f = await fixture(); const response = await f.app.request(f.path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pending: true, reviewable: true, task: { title: 'Fix checkout', description: 'Original task evidence' }, claim: { token: f.claim.token, epoch: f.claim.epoch, error: 'Worker acknowledgement lost' }, owner: { sessionId: f.child.id, agentRunId: f.run.id, coderSessionId: f.run.coder_session_id, runStatus: 'error' } });
  });
  it('requires an explicit review and exact token/epoch without mutating the reservation', async () => {
    const f = await fixture();
    expect((await f.post({ token: f.claim.token, epoch: f.claim.epoch })).status).toBe(400);
    expect((await f.post({ reviewed: true, token: randomUUID(), epoch: f.claim.epoch })).status).toBe(409);
    expect((await f.post({ reviewed: true, token: f.claim.token, epoch: f.claim.epoch + 1 })).status).toBe(409);
    expect((await f.claims.read(f.card.id))!.phase).toBe('uncertain');
  });
  it('rejects a live worker even when the stored run claims to have ended', async () => {
    const f = await fixture(); runtime.get.mockReturnValue({ metaBus: {} } as never);
    expect(await (await f.app.request(f.path)).json()).toMatchObject({ reviewable: false, ownerActive: true });
    const response = await f.post(); expect(response.status).toBe(409); expect((await response.json()).code).toBe('DISPATCH_OWNER_ACTIVE');
    expect((await f.claims.read(f.card.id))!.phase).toBe('uncertain');
  });
  it('rechecks worker ownership after waiting for the start/resume lock', async () => {
    const f = await fixture(); const entered = deferred(); const release = deferred();
    const start = withSessionLock(f.child.id, async () => { entered.resolve(); await release.promise; runtime.get.mockReturnValue({ metaBus: {} } as never); });
    await entered.promise; const request = f.post(); release.resolve(); await start;
    expect((await request).status).toBe(409); expect((await f.claims.read(f.card.id))!.phase).toBe('uncertain');
  });
  it('releases only the reviewed claim, preserves the unknown result and requires a separate manual dispatch', async () => {
    const f = await fixture(); const response = await f.post();
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, original_outcome: 'unchanged', dispatched: false, card: { column: 'review' } });
    expect(f.files.getKanbanCardFullSync(f.card.id)!.agents.every(agent => agent.unassigned_at)).toBe(true);
    expect(f.files.getKanbanCardFullSync(f.card.id)!.comments).toHaveLength(1);
    expect(f.ownerFiles.getAgentRunSync(f.run.id)!.status).toBe('error');
    expect((await f.claims.read(f.card.id))!).toMatchObject({ phase: 'released', error: 'Worker acknowledgement lost', manualDispatchRequired: true, review: { previousPhase: 'uncertain', originalOutcome: 'unchanged' } });
    expect(await f.claims.acquire(f.card.id, f.child.id)).toBeNull();
    expect(await f.claims.acquire(f.card.id, f.child.id, { manual: true })).toMatchObject({ epoch: f.claim.epoch + 1 });
    expect(runtime.spawn).not.toHaveBeenCalled();
  });
  it('fences stale review requests after a new dispatcher acquired another epoch', async () => {
    const f = await fixture(); await f.post();
    const next = (await f.claims.acquire(f.card.id, f.child.id, { manual: true }))!;
    const response = await f.post(); expect(response.status).toBe(409); expect((await response.json()).code).toBe('DISPATCH_REVIEW_STALE');
    expect(await f.claims.read(f.card.id)).toMatchObject({ token: next.token, epoch: next.epoch, phase: 'reserved' });
  });
  it('retains a resumable review after bookkeeping fails and never replays the original dispatcher', async () => {
    const f = await fixture();
    const move = vi.spyOn(CompanyKanbanFiles.prototype, 'moveKanbanCardSync').mockImplementationOnce(() => { throw new Error('Disk unavailable'); });
    const failed = await f.post(); expect(failed.status).toBe(503); expect((await failed.json()).code).toBe('DISPATCH_REVIEW_INCOMPLETE');
    expect((await f.claims.read(f.card.id))!.phase).toBe('reviewing');
    await expect(f.claims.transition(f.card.id, f.claim, 'running')).rejects.toThrow('dispatch_fenced');
    expect(await f.claims.acquire(f.card.id, f.child.id, { manual: true })).toBeNull();
    move.mockRestore(); expect((await f.post()).status).toBe(200);
    expect(runtime.spawn).not.toHaveBeenCalled();
  });
  it('refuses review until the original agent pending workspace effects are reconciled', async () => {
    const f = await fixture(); const workspace = new CompanyWorkspaceCoordinator(f.files.location.bundle_path);
    await workspace.run({ sessionId: f.child.id, agentRunId: f.claim.agentRunId, toolUseId: 'edit-unknown', toolName: 'edit_file' }, async () => 'unknown', () => true);
    const response = await f.post(); expect(response.status).toBe(409); expect((await response.json()).code).toBe('DISPATCH_EFFECTS_PENDING');
    expect(await (await f.app.request(f.path)).json()).toMatchObject({ reviewable: false, pendingEffects: [{ toolUseId: 'edit-unknown' }] });
    await workspace.reconcile((await workspace.owners()).map(owner => owner.token));
    expect((await f.post()).status).toBe(200);
  });
  it('allows only one concurrent operator review to release a claim', async () => {
    const f = await fixture(); const responses = await Promise.all([f.post(), f.post()]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(f.files.getKanbanCardFullSync(f.card.id)!.comments).toHaveLength(1);
  });
  it('recovers a reopened completed card without reinterpreting its previous successful run', async () => {
    const f = await fixture();
    await f.claims.transition(f.card.id, f.claim, 'running');
    await f.ownerFiles.updateAgentRunStatus(f.run.id, 'completed');
    f.files.moveKanbanCardSync(f.card.id, 'done'); f.files.moveKanbanCardSync(f.card.id, 'todo');
    expect((await f.post()).status).toBe(200);
    expect(f.ownerFiles.getAgentRunSync(f.run.id)!.status).toBe('completed');
    expect(f.files.getKanbanCardFullSync(f.card.id)!.column).toBe('review');
    expect(await f.claims.acquire(f.card.id, f.child.id)).toBeNull();
    expect(await f.claims.acquire(f.card.id, f.child.id, { manual: true })).not.toBeNull();
  });
  it('fails closed when a claim points to an owner from another company', async () => {
    const f = await fixture(); await f.post();
    const foreign = (await f.claims.acquire(f.card.id, f.foreign.id, { manual: true }))!;
    expect((await f.app.request(f.path)).status).toBe(409);
    expect((await f.post({ reviewed: true, token: foreign.token, epoch: foreign.epoch })).status).toBe(503);
    expect((await f.claims.read(f.card.id))!.phase).toBe('reserved');
  });
});
