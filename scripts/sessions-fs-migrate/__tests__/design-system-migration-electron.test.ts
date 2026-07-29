import { createHash } from 'node:crypto';
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
  DesignSystemSessionRepository,
} from '../../../packages/session-storage/src/entities/design-system-session-repository.js';
import {
  FileSessionRepository,
  SessionLocator,
} from '../../../packages/session-storage/src/index.js';
import {
  buildBundlePlans,
  commitStagingBundle,
  prepareStagingBundle,
} from '../bundles.js';
import {
  captureEssentialDigest,
  createCleanClone,
  smokeCodeIndexDatabase,
} from '../cleaner.js';
import {
  buildDesignSessionIdRemap,
} from '../design-system-links.js';
import { loadDatabaseConstructor, tableExists } from '../db.js';
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

electronDescribe('Design System filesystem migration', () => {
  it('exports canonical Design entities/artifacts and rewrites the project link in the clean clone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-fs-design-migrate-'));
    cleanup.push(root);
    const projectRoot = join(root, 'project');
    const dataDir = join(root, 'data');
    const sourcePath = join(root, 'source.sqlite');
    const cleanPath = join(root, 'clean.sqlite');
    const sourceZipPath = join(root, 'theme.zip');
    const tarballPath = join(root, 'acme-ui-1.2.3.tgz');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const sourceZip = Buffer.from('legacy-design-source');
    const tarball = Buffer.from('legacy-design-tarball');
    writeFileSync(sourceZipPath, sourceZip);
    writeFileSync(tarballPath, tarball);
    const sourceZipHash = createHash('sha256').update(sourceZip).digest('hex');

    const Database = loadDatabaseConstructor();
    const { CodeIndexDB } = await import(
      '../../../packages/store/src/db.js'
    );
    const bootstrap = new CodeIndexDB(sourcePath, {
      checkpointOwner: true,
      externalCheckpointer: true,
    });
    bootstrap.close();
    const db = new Database(sourcePath);
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE design_system_sessions (
          id INTEGER PRIMARY KEY,
          company_session_id INTEGER,
          project_id INTEGER REFERENCES projects(id),
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          package_name TEXT NOT NULL,
          stack TEXT NOT NULL,
          source_zip_hash TEXT,
          source_zip_path TEXT,
          next_bump_hint TEXT NOT NULL,
          mcp_server_config_id TEXT,
          mode TEXT NOT NULL,
          pipeline_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE design_system_versions (
          id INTEGER PRIMARY KEY,
          ds_session_id INTEGER NOT NULL REFERENCES design_system_sessions(id),
          semver TEXT NOT NULL,
          bump_kind TEXT NOT NULL,
          is_auto_bump INTEGER NOT NULL,
          status TEXT NOT NULL,
          source_hash TEXT,
          tarball_path TEXT,
          manifest_json TEXT,
          mcp_manifest_json TEXT,
          docs_md TEXT,
          storybook_path TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          published_at TEXT
        );
        CREATE TABLE design_system_components (
          id INTEGER PRIMARY KEY,
          version_id INTEGER NOT NULL REFERENCES design_system_versions(id),
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          props_schema_json TEXT,
          example_code TEXT,
          created_at TEXT NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO projects (
           id, root_path, name, builder_json
         ) VALUES (1, ?, 'fixture', ?)`,
      ).run(
        projectRoot,
        JSON.stringify({
          stack: 'react-ts',
          port: 4173,
          designSystem: {
            sessionId: 41,
            packageName: '@acme/ui',
            version: '1.2.3',
          },
        }),
      );
      db.prepare(
        `INSERT INTO design_system_sessions VALUES (
          41, NULL, 1, 'studio', 'Acme UI', '@acme/ui', 'react-ts',
          ?, ?, 'minor', 'mcp-ds-41', 'fidelity', ?,
          '2026-01-01T00:00:00.000Z'
        )`,
      ).run(
        sourceZipHash,
        sourceZipPath,
        '{"version":1,"stages":[]}',
      );
      db.prepare(
        `INSERT INTO design_system_versions VALUES (
          52, 41, '1.2.3', 'minor', 1, 'published', 'tree-hash', ?,
          ?, ?, '# Acme UI', NULL, NULL,
          '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z'
        )`,
      ).run(
        tarballPath,
        '{"name":"@acme/ui","version":"1.2.3"}',
        '{"tools":[{"name":"get_component"}]}',
      );
      db.prepare(
        `INSERT INTO design_system_components VALUES (
          63, 52, 'Button', 'atom', '{"type":"object"}',
          'export function Button() {}',
          '2026-01-01T00:00:03.000Z'
        )`,
      ).run();

      const projects: ProjectRow[] = [{
        id: 1,
        root_path: projectRoot,
        name: 'fixture',
        is_synthetic: 0,
      }];
      const fingerprint = 'd'.repeat(64);
      const registry = new UuidRegistry(null, fingerprint);
      const plans = buildBundlePlans(db, dataDir, projects, registry);
      const plan = plans.find((candidate) =>
        candidate.identity.kind === 'design'
      );
      expect(plan).toBeDefined();
      expect(plan).toMatchObject({
        scope: 'project',
        projectRoot,
      });
      const remap = buildDesignSessionIdRemap(plans);
      expect(remap.get('41')).toBe(plan!.uuid);

      const relational = buildRelationalExportIndex(db, plans, registry);
      prepareStagingBundle(plan!, fingerprint);
      const runState: MigrationRunState = {
        format_version: 1,
        source_db_path: sourcePath,
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
            projectId === 1 ? projectRoot : null,
          listProjectRoots: () => [
            { project_id: 1, root_path: projectRoot },
          ],
        },
      });
      const runtimeSessions = new FileSessionRepository({
        locator,
        artifactRecoveryRegistry: new Set(),
      });
      await runtimeSessions.primeSession(
        locator.locate(
          { kind: 'project', project_id: 1 },
          plan!.uuid,
        ),
      );
      await runtimeSessions.close();

      const session = JSON.parse(
        readFileSync(join(plan!.finalDir, 'session.json'), 'utf8'),
      ) as {
        id: string;
        kind: string;
        metadata: {
          design: {
            sourceZipRef: { relative_path: string };
          };
        };
      };
      expect(session).toMatchObject({
        id: plan!.uuid,
        kind: 'design',
        metadata: {
          design: {
            sourceZipRef: {
              relative_path: expect.stringMatching(/^attachments\//),
            },
          },
        },
      });
      expect(
        readFileSync(
          join(
            plan!.finalDir,
            ...session.metadata.design.sourceZipRef.relative_path.split('/'),
          ),
        ),
      ).toEqual(sourceZip);

      const repository = new DesignSystemSessionRepository({
        sessionRoot: plan!.finalDir,
      });
      const versions = await repository.listVersions();
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        kind: 'design.version',
        relations: { design_session: plan!.uuid },
        data: {
          semver: '1.2.3',
          bumpKind: 'minor',
          status: 'published',
          manifestJson: '{"name":"@acme/ui","version":"1.2.3"}',
          tarballRef: {
            relative_path: expect.stringMatching(/^attachments\//),
          },
        },
      });
      expect(
        readFileSync(
          join(
            plan!.finalDir,
            ...versions[0].data.tarballRef!.relative_path.split('/'),
          ),
        ),
      ).toEqual(tarball);
      expect(await repository.listComponents(versions[0].id)).toMatchObject([
        {
          kind: 'design.component',
          relations: { version: versions[0].id },
          data: {
            versionId: versions[0].id,
            name: 'Button',
            componentKind: 'atom',
          },
        },
      ]);

      const essential = captureEssentialDigest(db, {
        designSessionIdRemap: remap,
      });
      db.close();
      createCleanClone(sourcePath, cleanPath, essential, {
        designSessionIdRemap: remap,
      });

      const clean = new Database(cleanPath, { readonly: true });
      try {
        expect(tableExists(clean, 'design_system_sessions')).toBe(false);
        expect(tableExists(clean, 'design_system_versions')).toBe(false);
        expect(tableExists(clean, 'design_system_components')).toBe(false);
        const project = clean.prepare(
          `SELECT builder_json FROM projects WHERE id = 1`,
        ).get() as { builder_json: string };
        expect(JSON.parse(project.builder_json)).toMatchObject({
          stack: 'react-ts',
          port: 4173,
          designSystem: {
            sessionId: plan!.uuid,
            packageName: '@acme/ui',
            version: '1.2.3',
          },
        });
      } finally {
        clean.close();
      }
      await smokeCodeIndexDatabase(cleanPath, essential);

      const original = new Database(sourcePath, { readonly: true });
      try {
        const project = original.prepare(
          `SELECT builder_json FROM projects WHERE id = 1`,
        ).get() as { builder_json: string };
        expect(JSON.parse(project.builder_json).designSystem.sessionId).toBe(41);
        expect(tableExists(original, 'design_system_sessions')).toBe(true);
      } finally {
        original.close();
      }
      return;
    } finally {
      if (db.open) db.close();
    }
  });

  it('creates a separate Design bundle beside its project-owned Company parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-fs-design-company-'));
    cleanup.push(root);
    const projectRoot = join(root, 'project');
    const dataDir = join(root, 'data');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const Database = loadDatabaseConstructor();
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          root_path TEXT NOT NULL,
          name TEXT,
          is_synthetic INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE company_sessions (
          id INTEGER PRIMARY KEY,
          runtime_kind TEXT
        );
        CREATE TABLE company_session_projects (
          company_session_id INTEGER NOT NULL,
          project_id INTEGER NOT NULL
        );
        CREATE TABLE design_system_sessions (
          id INTEGER PRIMARY KEY,
          company_session_id INTEGER,
          project_id INTEGER
        );
        INSERT INTO company_sessions VALUES (7, 'company');
        INSERT INTO company_session_projects VALUES (7, 1);
        INSERT INTO design_system_sessions VALUES (9, 7, NULL);
      `);
      db.prepare(
        `INSERT INTO projects VALUES (1, ?, 'fixture', 0)`,
      ).run(projectRoot);
      const projects: ProjectRow[] = [{
        id: 1,
        root_path: projectRoot,
        name: 'fixture',
        is_synthetic: 0,
      }];
      const plans = buildBundlePlans(
        db,
        dataDir,
        projects,
        new UuidRegistry(null, 'c'.repeat(64)),
      );
      const company = plans.find((plan) => plan.identity.kind === 'company');
      const design = plans.find((plan) => plan.identity.kind === 'design');
      expect(company).toBeDefined();
      expect(design).toBeDefined();
      expect(design).toMatchObject({
        scope: company!.scope,
        projectRoot: company!.projectRoot,
      });
      expect(design!.uuid).not.toBe(company!.uuid);
      expect(design!.finalDir).toBe(
        join(projectRoot, '.mcp-indexer', 'session', design!.uuid),
      );
    } finally {
      db.close();
    }
  });
});
