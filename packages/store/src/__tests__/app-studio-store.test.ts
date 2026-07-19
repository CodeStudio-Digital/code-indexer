import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditAppPlan } from '@mcp/app-studio/plan/fitness.js';
import { emptyAppPlan } from '@mcp/app-studio/plan/types.js';
import { CodeIndexDB } from '../db.js';
import { AppStudioStore } from '../app-studio-store.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-app-studio-v6-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  const project = db.raw().prepare("INSERT INTO projects (name, root_path) VALUES ('app', ?)").run(join(dir, 'workspace'));
  return { dir, db, store: new AppStudioStore(db.raw()), projectId: Number(project.lastInsertRowid) };
}

describe('AppStudioStore v6', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => { h = setup(); });
  afterEach(() => { if (h) { h.db.close(); rmSync(h.dir, { recursive: true, force: true }); } });

  it('creates only the fixed v6 App session contract', () => {
    const app = h.store.createSession({ project_id: h.projectId, name: 'Hotel', app_slug: 'hotel' });
    expect(app.stack_profile_id).toBe('cf-fullstack-v1');
    expect(h.store.getSessionByProjectId(h.projectId)?.id).toBe(app.id);
    expect(() => h.store.createSession({ project_id: h.projectId, name: 'Other', app_slug: 'other' })).toThrow();
  });

  it('stores one canonical plan history and approves readiness on the revision itself', () => {
    const app = h.store.createSession({ project_id: h.projectId, name: 'Hotel', app_slug: 'hotel' });
    const plan = emptyAppPlan('pt-BR');
    const draft = h.store.savePlanRevision({ app_session_id: app.id, plan, fitness: auditAppPlan(plan) });
    expect(draft.status).toBe('draft');
    expect(() => h.store.approvePlanRevision(app.id, draft.id)).toThrow(/ready App plan/);
    expect(h.store.listPlanRevisions(app.id)).toHaveLength(1);
  });

  it('makes work from an older plan stale when the plan changes', () => {
    const app = h.store.createSession({ project_id: h.projectId, name: 'Hotel', app_slug: 'hotel' });
    const plan = emptyAppPlan('pt-BR');
    const first = h.store.savePlanRevision({ app_session_id: app.id, plan, fitness: auditAppPlan(plan) });
    h.store.upsertWorkItems([{
      app_session_id: app.id,
      id: 'hotel-search',
      plan_revision_id: first.id,
      title: 'Busca',
      kind: 'implement',
      owner_role: 'fullstack',
      status: 'backlog',
    }]);
    h.store.savePlanRevision({
      app_session_id: app.id,
      plan: { ...plan, intent: { ...plan.intent, summary: 'Uma experiência de hotel modificada para viajantes.' } },
      fitness: auditAppPlan(plan),
      expected_revision_number: 1,
    });
    expect(h.store.getWorkItem(app.id, 'hotel-search')).toMatchObject({ status: 'stale' });
  });

  it('keeps work attempts and evidence attached to the same card', () => {
    const app = h.store.createSession({ project_id: h.projectId, name: 'Hotel', app_slug: 'hotel' });
    const plan = emptyAppPlan('pt-BR');
    const revision = h.store.savePlanRevision({ app_session_id: app.id, plan, fitness: auditAppPlan(plan) });
    h.store.upsertWorkItems([{
      app_session_id: app.id,
      id: 'reserve',
      plan_revision_id: revision.id,
      title: 'Reserva idempotente',
      kind: 'implement',
      owner_role: 'backend',
    }]);
    const run = h.store.createWorkItemRun({ appSessionId: app.id, workItemId: 'reserve', attempt: 1, role: 'backend' });
    h.store.updateWorkItemRunStatus(run.id, 'completed', { statusMessage: 'verified' });
    h.store.setWorkItemStatus(app.id, 'reserve', 'review', { evidenceJson: '[{"kind":"test","value":"reserve.test"}]' });
    expect(h.store.listWorkItemRuns(app.id, { workItemId: 'reserve' })[0]).toMatchObject({ attempt: 1, status: 'completed' });
    expect(JSON.parse(h.store.getWorkItem(app.id, 'reserve')!.evidence_json)).toHaveLength(1);
  });

  it('releases verification for reviewed work without releasing other dependents', () => {
    const app = h.store.createSession({ project_id: h.projectId, name: 'Hotel', app_slug: 'hotel' });
    const plan = emptyAppPlan('pt-BR');
    const revision = h.store.savePlanRevision({
      app_session_id: app.id,
      plan,
      fitness: {
        v: 1,
        status: 'ready',
        plan_fingerprint: 'plan:test',
        checked_at: '2026-07-19T00:00:00.000Z',
        checks: [],
        counts: { passed: 0, warnings: 0, errors: 0 },
      },
    });
    h.store.upsertWorkItems([
      {
        app_session_id: app.id,
        id: 'foundation:implement',
        plan_revision_id: revision.id,
        title: 'Construir fundação',
        kind: 'implement',
        owner_role: 'fullstack',
        status: 'review',
      },
      {
        app_session_id: app.id,
        id: 'foundation:verify',
        plan_revision_id: revision.id,
        title: 'Revisar fundação',
        kind: 'verify',
        owner_role: 'qa',
        status: 'backlog',
        depends_on_json: JSON.stringify(['foundation:implement']),
      },
      {
        app_session_id: app.id,
        id: 'catalog:implement',
        plan_revision_id: revision.id,
        title: 'Construir catálogo',
        kind: 'implement',
        owner_role: 'fullstack',
        status: 'backlog',
        depends_on_json: JSON.stringify(['foundation:implement']),
      },
    ]);
    h.store.approvePlanRevision(app.id, revision.id);

    h.store.refreshReadyWorkItems(app.id);

    expect(h.store.getWorkItem(app.id, 'foundation:verify')).toMatchObject({ status: 'ready' });
    expect(h.store.getWorkItem(app.id, 'catalog:implement')).toMatchObject({ status: 'backlog' });
  });
});
