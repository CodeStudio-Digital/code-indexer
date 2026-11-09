import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { companyFixture } from '@mcp/company/services/__tests__/company-multisession-fixture.js';
import { mountCompanyChildRoutes } from '../children.js';
import { mountCompanyFileSessionRoutes } from '../session-files.routes.js';
import { mountCompanyInboxRoutes } from '../inbox.js';
import { CompanyWorkspaceCoordinator } from '@mcp/company/services/workspace-coordinator.js';
const runtime = vi.hoisted(() => ({ get: vi.fn(() => null) }));
beforeEach(() => { runtime.get.mockReset().mockReturnValue(null); });
vi.mock('../../../../sse/companyOrchestrator.js', () => ({ getCompanyOrchestrator: runtime.get, evictCompanyOrchestrator: vi.fn(), hasCompanyOrchestrator: vi.fn(), deleteCompanyOrchestrator: vi.fn() }));
vi.mock('../stream.js', () => ({ activeOrchestrators: { get: runtime.get } }));
async function fixture() { const f = await companyFixture(); const app = new Hono(); mountCompanyFileSessionRoutes(app, f as never); mountCompanyChildRoutes(app, f as never); mountCompanyInboxRoutes(app, f as never); return { ...f, app }; }
describe('Company and session API compatibility', () => {
  it('aggregates child session status without changing the legacy root status', async () => {
    const f = await fixture();
    await f.files(f.child.id).updateSessionStatus('running');
    const companies = await (await f.app.request('/api/company/companies')).json();
    expect(companies.find((row: { id: string }) => row.id === f.company.id)).toMatchObject({ status: 'idle', aggregate_status: 'running', session_count: 2, running_sessions: 1, paused_sessions: 0, attention_sessions: 0 });
    const legacy = await (await f.app.request('/api/company/sessions')).json();
    expect(legacy.find((row: { id: string }) => row.id === f.company.id)).toMatchObject({ status: 'idle' });
    expect(legacy.find((row: { id: string }) => row.id === f.company.id)).not.toHaveProperty('aggregate_status');
  });
  it('exposes crash ownership for review while refusing reconciliation of a live worker', async () => {
    const f = await fixture(); const coordinator = new CompanyWorkspaceCoordinator(f.files(f.company.id).location.bundle_path);
    // Synthetic crash: persisted process ownership with no surviving receipt.
    await coordinator.run({ sessionId: f.child.id, agentRunId: f.child.id, toolUseId: 'original-call', toolName: 'exec_command', pendingEffects: () => [new Promise<void>(() => {})] }, async () => 'yielded', () => false);
    await f.files(f.child.id).updateSessionStatus('running');
    const endpoint = `/api/company/companies/${f.company.id}/workspace`;
    runtime.get.mockReturnValue({ metaBus: {} } as never);
    const active = await (await f.app.request(endpoint)).json();
    expect(active.owners[0]).toMatchObject({ phase: 'running', ownerActive: true, reviewable: false, toolUseId: 'original-call' });
    const reconcile = () => f.app.request(`${endpoint}/reconcile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewed: true, tokens: active.owners.map((owner: { token: string }) => owner.token) }) });
    expect((await reconcile()).status).toBe(409);
    runtime.get.mockReturnValue(null);
    const orphan = await (await f.app.request(endpoint)).json();
    expect(orphan.owners[0]).toMatchObject({ phase: 'uncertain', ownerActive: false, reviewable: true, toolUseId: 'original-call' });
    expect((await reconcile()).status).toBe(200);
    expect(await coordinator.owners()).toEqual([]);
  });
  it('projects actual worker/master liveness in state snapshots, including a dormant master', async () => {
    const f = await fixture();
    runtime.get.mockReturnValue({ metaBus: { ended: false }, getMasterStatus: async () => ({ alive: true, endedAt: null }) } as never);
    expect(await (await f.app.request(`/api/company/sessions/${f.child.id}/state-snapshot`)).json()).toMatchObject({ liveOrchestrator: true, masterAlive: true });
    runtime.get.mockReturnValue({ metaBus: { ended: false }, getMasterStatus: async () => ({ alive: false, endedAt: '2026-11-04T00:00:00Z' }) } as never);
    expect(await (await f.app.request(`/api/company/sessions/${f.child.id}/state-snapshot`)).json()).toMatchObject({ liveOrchestrator: true, masterAlive: false, masterEndedAt: '2026-11-04T00:00:00Z' });
  });
  it('projects distinct company/session scopes, preserves legacy URLs and creates an independent conversation', async () => {
    const f = await fixture();
    const response = await f.app.request(`/api/company/companies/${f.company.id}/sessions`);
    const result = await response.json(); expect(result.sessions.map((session: { id: string }) => session.id)).toEqual([f.company.id, f.child.id]);
    expect(result.sessions[1]).toMatchObject({ company_id: f.company.id, session_id: f.child.id, scope: { workspace: 'shared', conversation: 'session' }, configuration: { mode: 'snapshot', inherited_from: f.company.id, inherited_revision: f.company.configuration.revision } });
    const created = await f.app.request(`/api/company/companies/${f.company.id}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Second mission' }) });
    expect(created.status, await created.clone().text()).toBe(201); const session = await created.json(); expect(session.id).not.toBe(f.child.id); expect(session.master_session_id).toBeNull();
    expect((await f.app.request(`/api/company/sessions/${session.id}`)).status).toBe(200);
    const isolated = await f.app.request(`/api/company/companies/${f.company.id}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Unsupported', workspace: 'isolated' }) }); expect(isolated.status).toBe(409);
  });
  it('preserves config snapshot on rename, and requires exact revisions before adopting company defaults', async () => {
    const f = await fixture(); await f.operationalSessionFiles.renameCompanySession(f.child.id, 'Renamed');
    const original = (await f.operationalSessionFiles.getCompanySession(f.child.id))!;
    expect(original.configuration.inherited_revision).toBe(f.company.configuration.revision);
    const parent = await f.operationalSessionFiles.updateCompanySessionConfig(f.company.id, '{"master_provider":"changed"}');
    expect((await f.operationalSessionFiles.getCompanySession(f.child.id))!.config_json).toBe(f.child.config_json);
    const path = `/api/company/companies/${parent.id}/sessions/${f.child.id}/config/adopt`;
    expect((await f.app.request(path, { method: 'POST', body: '{}' })).status).toBe(409);
    const adopted = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedCompanyRevision: parent.configuration.revision, expectedSessionRevision: original.configuration.revision }) });
    expect(adopted.status, await adopted.clone().text()).toBe(200); expect((await adopted.json()).session.configuration.inherited_revision).toBe(parent.configuration.revision);
  });
  it('accepts explicit operator messages and rejects cross-company destinations', async () => {
    const f = await fixture(); const send = (targetSessionId: string) => f.app.request(`/api/company/sessions/${f.company.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetSessionId, targetRole: 'master', body: 'Coordinate', idempotencyKey: targetSessionId }) });
    const response = await send(f.child.id); expect(response.status, await response.clone().text()).toBe(202); expect((await response.json()).message.origin).toBe('operator'); expect((await send(f.foreign.id)).status).toBe(400);
  });
});
