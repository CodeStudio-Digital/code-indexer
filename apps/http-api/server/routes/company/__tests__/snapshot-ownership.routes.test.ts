import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ServerDeps } from '../../../deps.js';

const calls = vi.hoisted(() => ({ diff: vi.fn(), accept: vi.fn(), revert: vi.fn(), acceptHunk: vi.fn(), revertHunk: vi.fn() }));
vi.mock('@mcp/services/services/session-snapshots.js', () => ({
  SessionSnapshotService: class {
    getDiff = calls.diff; acceptFile = calls.accept; revertFile = calls.revert;
    acceptHunk = calls.acceptHunk; revertHunk = calls.revertHunk;
  },
}));
vi.mock('../../snapshot-review-routes.js', () => ({ mountSnapshotReviewRoutes: vi.fn() }));
vi.mock('../../coder/tool-snapshot.js', () => ({ mountToolSnapshotRoutes: vi.fn() }));
vi.mock('../../../../sse/companyOrchestrator.js', () => ({ getCompanyOrchestrator: vi.fn(), evictCompanyOrchestrator: vi.fn() }));
import { mountCompanySnapshotRoutes } from '../snapshot.js';

const companyA = '00000000-0000-4000-8000-000000000001';
const companyB = '00000000-0000-4000-8000-000000000002';
const coder = '00000000-0000-4000-8000-000000000003';
const baseline = '00000000-0000-4000-8000-000000000004';
function setup() {
  vi.clearAllMocks();
  for (const call of Object.values(calls)) call.mockResolvedValue({ ok: true });
  const app = new Hono();
  mountCompanySnapshotRoutes(app, {
    db: {}, sessionStore: {
      refresh: vi.fn(async () => undefined),
      catalog: { list: () => [{ session: { id: companyA, kind: 'company' } }, { session: { id: companyB, kind: 'company' } }, { session: { id: coder, kind: 'coder', parent_session_id: companyA, metadata: { group_id: companyB, company_session_id: companyB } } }] },
      getBaselineById: async () => ({ id: baseline, session_kind: 'coder', session_id: coder }),
    },
  } as unknown as ServerDeps);
  return app;
}
describe('Company snapshot ownership', () => {
  it.each(['diff', 'accept', 'revert', 'accept-hunk', 'revert-hunk'])('rejects foreign baseline on %s before any filesystem action', async (action) => {
    const app = setup();
    const response = await app.request(`/api/company/sessions/${companyB}/snapshot/file/${baseline}/${action}`, action === 'diff' ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fingerprint: 'hunk' }) });
    expect(response.status).toBe(404);
    for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
  });
  it.each(['diff', 'accept', 'revert', 'accept-hunk', 'revert-hunk'])('retains owner access on %s', async (action) => {
    const app = setup();
    const response = await app.request(`/api/company/sessions/${companyA}/snapshot/file/${baseline}/${action}`, action === 'diff' ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fingerprint: 'hunk' }) });
    expect(response.status).toBe(200);
    expect(Object.values(calls).reduce((count, call) => count + call.mock.calls.length, 0)).toBe(1);
  });
});
