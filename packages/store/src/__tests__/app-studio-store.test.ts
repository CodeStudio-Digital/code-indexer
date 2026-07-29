import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditAppPlan } from '@mcp/app-studio/plan/fitness.js';
import { emptyAppPlan } from '@mcp/app-studio/plan/types.js';
import {
  FileSessionRepository,
  SessionCatalog,
  SessionLocator,
} from '@mcp/session-storage';
import { AppStudioStore } from '../app-studio-store.js';

interface Fixture {
  root: string;
  dataDir: string;
  projectRoot: string;
  repository: FileSessionRepository;
  store: AppStudioStore;
}

async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'mcp-app-studio-fs-'));
  const dataDir = join(root, 'data');
  const projectRoot = join(root, 'workspace');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  const locator = new SessionLocator({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 1 ? projectRoot : undefined,
      listProjectRoots: () => [
        { project_id: 1, root_path: projectRoot },
      ],
    },
  });
  const repository = new FileSessionRepository({ locator });
  const catalog = new SessionCatalog({ locator, repository });
  const store = new AppStudioStore({
    repository,
    catalog,
    locator,
    getProject: (projectId) =>
      projectId === 1
        ? { id: 1, root_path: projectRoot }
        : null,
  });
  return { root, dataDir, projectRoot, repository, store };
}

describe('AppStudioStore filesystem v6', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setup();
  });

  afterEach(async () => {
    await fixture.store.close();
    await fixture.repository.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  it('creates a global UUID bundle and refuses a second app for the project', async () => {
    const app = await fixture.store.createSession({
      project_id: 1,
      name: 'Hotel',
      app_slug: 'hotel',
    });

    expect(app.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(app.stack_profile_id).toBe('cf-fullstack-v1');
    expect((await fixture.store.getSessionByProjectId(1))?.id).toBe(app.id);
    const bundle = join(
      fixture.dataDir,
      'sessions',
      'global',
      String(app.id),
    );
    await expect(stat(join(bundle, 'session.json'))).resolves.toBeDefined();
    expect(
      JSON.parse(await readFile(join(bundle, 'session.json'), 'utf8')),
    ).toMatchObject({
      kind: 'app_studio',
      storage_scope: { kind: 'global' },
    });
    await expect(
      fixture.store.createSession({
        project_id: 1,
        name: 'Other',
        app_slug: 'other',
      }),
    ).rejects.toThrow('already has an App Studio session');
  });

  it('persists canonical plan revisions as independent UUID entities', async () => {
    const app = await fixture.store.createSession({
      project_id: 1,
      name: 'Hotel',
      app_slug: 'hotel',
    });
    const plan = emptyAppPlan('pt-BR');
    const draft = await fixture.store.savePlanRevision({
      app_session_id: app.id,
      plan,
      fitness: auditAppPlan(plan),
    });

    expect(draft).toMatchObject({ status: 'draft', revision_number: 1 });
    await expect(
      fixture.store.approvePlanRevision(app.id, draft.id),
    ).rejects.toThrow(/ready App plan/);
    expect(await fixture.store.listPlanRevisions(app.id)).toHaveLength(1);
  });

  it('makes old work stale and never reuses semantic plan ids as public ids', async () => {
    const app = await fixture.store.createSession({
      project_id: 1,
      name: 'Hotel',
      app_slug: 'hotel',
    });
    const plan = emptyAppPlan('pt-BR');
    const first = await fixture.store.savePlanRevision({
      app_session_id: app.id,
      plan,
      fitness: auditAppPlan(plan),
    });
    const [work] = await fixture.store.upsertWorkItems([
      {
        app_session_id: app.id,
        id: 'hotel-search',
        plan_revision_id: first.id,
        title: 'Busca',
        kind: 'implement',
        owner_role: 'fullstack',
        status: 'backlog',
      },
    ]);

    expect(work.source_id).toBe('hotel-search');
    expect(work.id).not.toBe('hotel-search');
    await fixture.store.savePlanRevision({
      app_session_id: app.id,
      plan: {
        ...plan,
        intent: {
          ...plan.intent,
          summary: 'Uma experiência de hotel modificada para viajantes.',
        },
      },
      fitness: auditAppPlan(plan),
      expected_revision_number: 1,
    });
    expect(await fixture.store.getWorkItem(app.id, 'hotel-search')).toMatchObject({
      id: work.id,
      status: 'stale',
    });
  });

  it('keeps attempts and evidence in separate files under one leased bundle', async () => {
    const app = await fixture.store.createSession({
      project_id: 1,
      name: 'Hotel',
      app_slug: 'hotel',
    });
    const plan = emptyAppPlan('pt-BR');
    const revision = await fixture.store.savePlanRevision({
      app_session_id: app.id,
      plan,
      fitness: auditAppPlan(plan),
    });
    const [work] = await fixture.store.upsertWorkItems([
      {
        app_session_id: app.id,
        id: 'reserve',
        plan_revision_id: revision.id,
        title: 'Reserva idempotente',
        kind: 'implement',
        owner_role: 'backend',
      },
    ]);
    const run = await fixture.store.createWorkItemRun({
      appSessionId: app.id,
      workItemId: work.id,
      attempt: 1,
      role: 'backend',
    });
    await fixture.store.updateWorkItemRunStatus(run.id, 'completed', {
      statusMessage: 'verified',
    });
    await fixture.store.setWorkItemStatus(app.id, work.id, 'review', {
      evidenceJson: '[{"kind":"test","value":"reserve.test"}]',
    });

    expect(
      (await fixture.store.listWorkItemRuns(app.id, {
        workItemId: work.id,
      }))[0],
    ).toMatchObject({ attempt: 1, status: 'completed' });
    expect(
      JSON.parse(
        (await fixture.store.getWorkItem(app.id, work.id))!.evidence_json,
      ),
    ).toHaveLength(1);
  });

  it('releases verification from reviewed work but not implementation dependents', async () => {
    const app = await fixture.store.createSession({
      project_id: 1,
      name: 'Hotel',
      app_slug: 'hotel',
    });
    const plan = emptyAppPlan('pt-BR');
    const revision = await fixture.store.savePlanRevision({
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
    await fixture.store.upsertWorkItems([
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
    await fixture.store.approvePlanRevision(app.id, revision.id);
    await fixture.store.refreshReadyWorkItems(app.id);

    expect(
      await fixture.store.getWorkItem(app.id, 'foundation:verify'),
    ).toMatchObject({ status: 'ready' });
    expect(
      await fixture.store.getWorkItem(app.id, 'catalog:implement'),
    ).toMatchObject({ status: 'backlog' });
  });
});
