import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildBundlePlans,
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
import { verifyBundle } from '../verify.js';

const cleanup: string[] = [];
const electronDescribe = process.versions.electron ? describe : describe.skip;

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

electronDescribe('Company QA artifact migration', () => {
  it('copies a persisted report directory into the QA run bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-fs-company-qa-'));
    cleanup.push(root);
    const dataDir = join(root, 'data');
    const projectRoot = join(root, 'project');
    const legacyReport = join(root, 'legacy-report');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(legacyReport, 'playwright-report'), { recursive: true });
    mkdirSync(join(legacyReport, 'test-results', 'login'), { recursive: true });
    writeFileSync(
      join(legacyReport, 'playwright-report', 'index.html'),
      '<html>report</html>',
    );
    writeFileSync(
      join(legacyReport, 'test-results', 'login', 'trace.zip'),
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );

    const Database = loadDatabaseConstructor();
    const db = new Database(':memory:');
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          root_path TEXT NOT NULL,
          name TEXT,
          is_synthetic INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE company_sessions (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          config_json TEXT NOT NULL,
          runtime_kind TEXT,
          master_session_id INTEGER,
          parent_session_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE company_session_projects (
          company_session_id INTEGER NOT NULL REFERENCES company_sessions(id),
          project_id INTEGER NOT NULL REFERENCES projects(id),
          label TEXT,
          PRIMARY KEY (company_session_id, project_id)
        );
        CREATE TABLE company_agent_runs (
          id INTEGER PRIMARY KEY,
          company_session_id INTEGER NOT NULL REFERENCES company_sessions(id),
          role TEXT NOT NULL,
          coder_session_id INTEGER,
          project_ids_json TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL,
          status_message TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE qa_test_runs (
          id INTEGER PRIMARY KEY,
          company_session_id INTEGER NOT NULL REFERENCES company_sessions(id),
          agent_run_id INTEGER,
          suite TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          passed INTEGER NOT NULL,
          failed INTEGER NOT NULL,
          skipped INTEGER NOT NULL,
          duration_ms INTEGER,
          trigger TEXT NOT NULL,
          report_persisted_path TEXT
        );
      `);
      db.prepare(
        `INSERT INTO projects (id, root_path, name) VALUES (1, ?, 'fixture')`,
      ).run(projectRoot);
      db.exec(`
        INSERT INTO company_sessions VALUES (
          7, 'QA Company', 'running', '{}', 'company', NULL, NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
        );
        INSERT INTO company_session_projects VALUES (7, 1, 'primary');
        INSERT INTO company_agent_runs VALUES (
          91, 7, 'legacy-orphan', NULL, '[1]',
          'fixture', 'fixture-model', 'aborted', 'legacy coder session missing',
          '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z'
        );
      `);
      db.prepare(`
        INSERT INTO qa_test_runs VALUES (
          41, 7, NULL, 'smoke', 'running',
          '2026-01-01T00:00:02.000Z', NULL,
          0, 0, 0, NULL, 'agent', ?
        )
      `).run(legacyReport);

      const projects: ProjectRow[] = [{
        id: 1,
        root_path: projectRoot,
        name: 'fixture',
        is_synthetic: 0,
      }];
      const fingerprint = 'b'.repeat(64);
      const registry = new UuidRegistry(null, fingerprint);
      const plans = buildBundlePlans(db, dataDir, projects, registry);
      const plan = plans.find((candidate) =>
        candidate.identity.kind === 'company'
      );
      expect(plan).toBeDefined();
      const relational = buildRelationalExportIndex(db, plans, registry);
      const qaRun = relational.rowsByTable.get('qa_test_runs')?.[0];
      const agentRun = relational.rowsByTable.get('company_agent_runs')?.[0];
      expect(qaRun).toBeDefined();
      expect(agentRun).toBeDefined();
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

      const relativeRoot = join('company', 'qa-artifacts', qaRun!.entityUuid);
      expect(
        readFileSync(
          join(plan!.stagingDir, relativeRoot, 'playwright-report', 'index.html'),
          'utf8',
        ),
      ).toBe('<html>report</html>');
      expect(
        readFileSync(
          join(plan!.stagingDir, relativeRoot, 'test-results', 'login', 'trace.zip'),
        ),
      ).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

      const entity = JSON.parse(
        readFileSync(
          join(plan!.stagingDir, 'company', 'qa-runs', `${qaRun!.entityUuid}.json`),
          'utf8',
        ),
      ) as {
        data: {
          report_persisted_path: string;
          report: {
            relative_path: string;
            file_count: number;
            size_bytes: number;
          };
        };
      };
      expect(entity.data.report_persisted_path).toBe(
        join(plan!.finalDir, relativeRoot),
      );
      expect(entity.data.report).toMatchObject({
        relative_path:
          `company/qa-artifacts/${qaRun!.entityUuid}`,
        file_count: 2,
        size_bytes: 23,
      });
      const migratedAgentRun = JSON.parse(
        readFileSync(
          join(
            plan!.stagingDir,
            'company',
            'agent-runs',
            `${agentRun!.entityUuid}.json`,
          ),
          'utf8',
        ),
      ) as {
        id: string;
        data: {
          coder_session_id: string;
          project_ids: number[];
          legacy_coder_session_unavailable: boolean;
        };
      };
      expect(migratedAgentRun.data).toMatchObject({
        coder_session_id: migratedAgentRun.id,
        project_ids: [1],
        legacy_coder_session_unavailable: true,
      });
      expect(() =>
        verifyBundle(plan!.stagingDir, plan!.uuid, fingerprint, 'staging')
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});
