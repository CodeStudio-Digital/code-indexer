import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileSessionRepository,
  SessionCatalog,
  SessionLocator,
} from '../../../packages/session-storage/src/index.js';
import { AppStudioStore } from '../../../packages/store/src/app-studio-store.js';
import {
  buildBundlePlans,
  commitStagingBundle,
  prepareStagingBundle,
} from '../bundles.js';
import { loadDatabaseConstructor } from '../db.js';
import { exportBundle } from '../exporter.js';
import type {
  MigrationRunState,
  ProjectRow,
} from '../model.js';
import { buildRelationalExportIndex } from '../relational.js';
import { UuidRegistry } from '../uuid-map.js';
import {
  smokeOperationalBundleRepositories,
  verifyBundle,
} from '../verify.js';

const cleanup: string[] = [];
const electronDescribe = process.versions.electron ? describe : describe.skip;

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

electronDescribe('App Studio filesystem migration', () => {
  it('exports the v6 graph in the exact layout reopened by AppStudioStore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-fs-app-studio-'));
    cleanup.push(root);
    const dataDir = join(root, 'data');
    const projectRoot = join(root, 'project');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });

    const Database = loadDatabaseConstructor();
    const db = new Database(':memory:');
    let repository: FileSessionRepository | undefined;
    let store: AppStudioStore | undefined;
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          root_path TEXT NOT NULL,
          name TEXT,
          is_synthetic INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE app_studio_sessions (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id),
          company_session_id INTEGER,
          name TEXT NOT NULL,
          app_slug TEXT NOT NULL,
          stack_profile_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE app_studio_plan_revisions (
          id INTEGER PRIMARY KEY,
          app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id),
          revision_number INTEGER NOT NULL,
          status TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          fitness_json TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          approved_at TEXT
        );
        CREATE TABLE app_studio_work_items (
          app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id),
          id TEXT NOT NULL,
          plan_revision_id INTEGER NOT NULL REFERENCES app_studio_plan_revisions(id),
          slice_id TEXT,
          title TEXT NOT NULL,
          outcome TEXT NOT NULL,
          kind TEXT NOT NULL,
          owner_role TEXT NOT NULL,
          priority INTEGER NOT NULL,
          status TEXT NOT NULL,
          sort_order INTEGER NOT NULL,
          depends_on_json TEXT NOT NULL,
          source_ids_json TEXT NOT NULL,
          acceptance_json TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          file_scope_json TEXT NOT NULL,
          blocked_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(app_session_id, id)
        );
        CREATE TABLE app_studio_work_item_runs (
          id INTEGER PRIMARY KEY,
          app_session_id INTEGER NOT NULL,
          work_item_id TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          role TEXT NOT NULL,
          company_agent_run_id INTEGER,
          coder_session_id INTEGER,
          status TEXT NOT NULL,
          runtime_config_hash TEXT,
          idempotency_key TEXT NOT NULL,
          status_message TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(app_session_id, work_item_id)
            REFERENCES app_studio_work_items(app_session_id, id)
        );
        CREATE TABLE app_studio_decisions (
          id INTEGER PRIMARY KEY,
          app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id),
          plan_revision_id INTEGER NOT NULL REFERENCES app_studio_plan_revisions(id),
          question TEXT NOT NULL,
          options_json TEXT NOT NULL,
          blocked_work_item_ids_json TEXT NOT NULL,
          status TEXT NOT NULL,
          answer TEXT,
          requested_at TEXT NOT NULL,
          resolved_at TEXT
        );
        CREATE TABLE app_studio_events (
          id INTEGER PRIMARY KEY,
          app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id),
          kind TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          idempotency_key TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE app_studio_deployments (
          id INTEGER PRIMARY KEY,
          app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id),
          plan_revision_id INTEGER NOT NULL REFERENCES app_studio_plan_revisions(id),
          status TEXT NOT NULL,
          url TEXT,
          account TEXT,
          database_id TEXT,
          health_ok INTEGER NOT NULL,
          details_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO projects (id, root_path, name) VALUES (1, ?, 'fixture')`,
      ).run(projectRoot);
      db.exec(`
        INSERT INTO app_studio_sessions VALUES (
          7, 1, NULL, 'Hotel', 'hotel', 'cf-fullstack-v1',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:08.000Z'
        );
        INSERT INTO app_studio_plan_revisions VALUES (
          11, 7, 1, 'approved', '{"v":1}', '{"status":"ready"}',
          'app_orchestrator', '2026-01-01T00:00:01.000Z',
          '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'
        );
        INSERT INTO app_studio_work_items VALUES (
          7, 'build', 11, 'slice-1', 'Build', 'Ship it', 'implement',
          'fullstack', 10, 'done', 1, '[]', '["cap-1"]',
          '["works"]', '[{"kind":"test"}]', '["src/**"]', NULL,
          '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:04.000Z'
        );
        INSERT INTO app_studio_work_items VALUES (
          7, 'verify', 11, 'slice-1', 'Verify', 'Prove it', 'verify',
          'qa', 9, 'ready', 2, '["build"]', '["test-1"]',
          '["passes"]', '[]', '["tests/**"]', NULL,
          '2026-01-01T00:00:04.000Z', '2026-01-01T00:00:05.000Z'
        );
        INSERT INTO app_studio_work_item_runs VALUES (
          21, 7, 'build', 1, 'fullstack', NULL, NULL, 'running',
          'hash', 'legacy-run-21', 'working',
          '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:05.000Z',
          NULL, '2026-01-01T00:00:06.000Z'
        );
        INSERT INTO app_studio_decisions VALUES (
          31, 7, 11, 'Release?', '["yes","no"]', '["verify"]',
          'open', NULL, '2026-01-01T00:00:06.000Z', NULL
        );
        INSERT INTO app_studio_events VALUES (
          41, 7, 'work.started', 'work_item', 'build',
          '{"source":"legacy"}', 'legacy-event-41',
          '2026-01-01T00:00:06.000Z'
        );
        INSERT INTO app_studio_deployments VALUES (
          51, 7, 11, 'live', 'https://hotel.example', 'acct', 'db-1',
          1, '{"healthy":true}', '2026-01-01T00:00:07.000Z',
          '2026-01-01T00:00:08.000Z'
        );
      `);

      const projects: ProjectRow[] = [{
        id: 1,
        root_path: projectRoot,
        name: 'fixture',
        is_synthetic: 0,
      }];
      const fingerprint = 'a'.repeat(64);
      const registry = new UuidRegistry(null, fingerprint);
      const plans = buildBundlePlans(db, dataDir, projects, registry);
      const plan = plans.find((candidate) =>
        candidate.identity.kind === 'app_studio'
      );
      expect(plan).toBeDefined();
      expect(plan).toMatchObject({ scope: 'global' });

      const relational = buildRelationalExportIndex(db, plans, registry);
      prepareStagingBundle(plan!, fingerprint);
      const runState: MigrationRunState = {
        format_version: 1,
        source_db_path: 'fixture.sqlite',
        source_db_fingerprint: fingerprint,
        source_db_bytes: 0,
        phase: 'exporting',
        started_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        expected_counts: {},
        exported_counts: {},
        legacy_orphan_cleanup: {},
        roots: [projectRoot],
      };
      await exportBundle({
        db,
        dataDir,
        sourceFingerprint: fingerprint,
        projects,
        relational,
        sealer: { seal: (value) => value },
        logger: { info: () => undefined, warn: () => undefined },
        runState,
      }, plan!);
      expect(() =>
        verifyBundle(plan!.stagingDir, plan!.uuid, fingerprint, 'staging')
      ).not.toThrow();
      commitStagingBundle(plan!, fingerprint);
      await expect(
        smokeOperationalBundleRepositories([plan!]),
      ).resolves.toBeUndefined();

      const locator = new SessionLocator({
        dataDir,
        projectRootResolver: {
          resolveProjectRoot: (projectId) =>
            projectId === 1 ? projectRoot : undefined,
          listProjectRoots: () => [{
            project_id: 1,
            root_path: projectRoot,
          }],
        },
      });
      repository = new FileSessionRepository({ locator });
      const catalog = new SessionCatalog({ locator, repository });
      store = new AppStudioStore({
        repository,
        catalog,
        locator,
        getProject: (projectId) =>
          projectId === 1 ? { id: 1, root_path: projectRoot } : null,
      });

      expect(await store.getSession(plan!.uuid)).toMatchObject({
        id: plan!.uuid,
        seq: 7,
        project_id: 1,
        name: 'Hotel',
        app_slug: 'hotel',
      });
      const [build, verify] = await store.listWorkItems(plan!.uuid);
      expect(build).toMatchObject({
        source_id: 'build',
        plan_revision_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
      expect(build.id).not.toBe('build');
      expect(JSON.parse(verify.depends_on_json)).toEqual([build.id]);
      expect(
        (await store.listWorkItemRuns(plan!.uuid))[0],
      ).toMatchObject({
        work_item_id: build.id,
        status: 'interrupted',
      });
      expect(JSON.parse(
        (await store.listDecisions(plan!.uuid))[0].blocked_work_item_ids_json,
      )).toEqual([verify.id]);
      expect((await store.listEvents(plan!.uuid))[0]).toMatchObject({
        entity_id: build.id,
      });
      expect(await store.getLatestDeployment(plan!.uuid)).toMatchObject({
        plan_revision_id: build.plan_revision_id,
        status: 'live',
        health_ok: 1,
      });
    } finally {
      await store?.close();
      await repository?.close();
      db.close();
    }
  });
});
