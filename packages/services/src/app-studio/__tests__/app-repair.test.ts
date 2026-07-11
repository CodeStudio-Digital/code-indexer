import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDbStatus, writeDbStatus } from '@mcp/app-studio/status-files.js';
import {
  analyzeAppWorkspaceRepair,
  applyAppWorkspaceRepair,
  restoreAppWorkspaceRepair,
} from '../app-repair.js';
import { appWorkerTestHarnessIssues } from '../app-test-harness.js';

let workspace: string | null = null;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

function input() {
  return { workspaceDir: workspace!, appSlug: 'repair-test', appName: 'Repair test', port: 5199 };
}

function createWorkspace(options: { currentHarness?: boolean; currentConfigs?: boolean; currentDirectories?: boolean } = {}) {
  workspace = mkdtempSync(join(tmpdir(), 'app-repair-'));
  const scripts = options.currentHarness ? {
    test: 'npm run test:worker && npm run test:e2e',
    'test:worker': 'vitest run --config vitest.config.ts --passWithNoTests',
    'test:e2e': 'playwright test --pass-with-no-tests',
  } : { test: 'legacy-test-command' };
  writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({
    name: 'repair-test',
    scripts,
    devDependencies: {
      vitest: '1.0.0',
      '@cloudflare/vitest-pool-workers': '1.0.0',
      '@playwright/test': '1.0.0',
    },
  }, null, 2)}\n`, 'utf8');
  mkdirSync(join(workspace, 'migrations'), { recursive: true });
  writeFileSync(join(workspace, 'migrations', '0001_init.sql'), 'CREATE TABLE items (id INTEGER PRIMARY KEY);\n', 'utf8');
  mkdirSync(join(workspace, 'seeds'), { recursive: true });
  writeFileSync(join(workspace, 'seeds', 'seed.sql'), 'INSERT OR IGNORE INTO items (id) VALUES (1);\n', 'utf8');
  if (options.currentConfigs) {
    writeFileSync(
      join(workspace, 'vitest.config.ts'),
      "// TEST_MIGRATIONS TEST_SEED_QUERIES\nconst test = { setupFiles: ['./tests/worker/setup.ts'] };\n",
      'utf8',
    );
    writeFileSync(join(workspace, 'playwright.config.ts'), '// current\n', 'utf8');
    mkdirSync(join(workspace, 'tests', 'worker'), { recursive: true });
    writeFileSync(
      join(workspace, 'tests', 'worker', 'setup.ts'),
      '// applyD1Migrations TEST_SEED_QUERIES testEnv.DB\n',
      'utf8',
    );
  }
  if (options.currentDirectories) {
    mkdirSync(join(workspace, 'tests', 'worker'), { recursive: true });
    mkdirSync(join(workspace, 'tests', 'e2e'), { recursive: true });
  }
}

describe('App Studio general repair', () => {
  it('previews and repairs only managed test infrastructure, then restores it', async () => {
    createWorkspace();
    const beforePackage = readFileSync(join(workspace!, 'package.json'), 'utf8');
    const analysis = await analyzeAppWorkspaceRepair(input(), { inspectMigrationHistory: async () => [] });

    expect(analysis.actions.map((action) => action.id)).toEqual([
      'repair-test-package',
      'repair-worker-test-harness',
      'create-playwright-config',
      'create-test-directories',
    ]);
    expect(appWorkerTestHarnessIssues(workspace!)).not.toEqual([]);

    const application = await applyAppWorkspaceRepair(input(), analysis);
    expect(application.applied_actions).toEqual(analysis.actions.map((action) => action.id));
    expect(existsSync(join(workspace!, 'vitest.config.ts'))).toBe(true);
    expect(existsSync(join(workspace!, 'tests', 'worker', 'setup.ts'))).toBe(true);
    expect(existsSync(join(workspace!, 'playwright.config.ts'))).toBe(true);
    expect(appWorkerTestHarnessIssues(workspace!)).toEqual([]);

    restoreAppWorkspaceRepair(workspace!, application);
    expect(readFileSync(join(workspace!, 'package.json'), 'utf8')).toBe(beforePackage);
    expect(existsSync(join(workspace!, 'vitest.config.ts'))).toBe(false);
    expect(existsSync(join(workspace!, 'tests', 'worker'))).toBe(false);
    expect(existsSync(join(workspace!, 'tests', 'e2e'))).toBe(false);
  });

  it('refuses undo after a repaired file is changed by the user', async () => {
    createWorkspace();
    const analysis = await analyzeAppWorkspaceRepair(input(), { inspectMigrationHistory: async () => [] });
    const application = await applyAppWorkspaceRepair(input(), analysis);
    writeFileSync(join(workspace!, 'vitest.config.ts'), '// user change\n', 'utf8');

    expect(() => restoreAppWorkspaceRepair(workspace!, application)).toThrow(/mudou depois do reparo/);
  });

  it('synchronizes the sidecar from the real D1 ledger without executing migrations', async () => {
    createWorkspace({ currentHarness: true, currentConfigs: true, currentDirectories: true });
    writeDbStatus(workspace!, {
      engine: 'd1',
      local_ready: false,
      applied: [],
      seeded: true,
      seed_hash: 'seed-hash',
      last_error_phase: 'migration',
      last_error: 'stale failure',
      last_apply_at: '2026-01-01T00:00:00.000Z',
    });
    const analysis = await analyzeAppWorkspaceRepair(input(), {
      inspectMigrationHistory: async () => ['0001_init.sql'],
    });

    expect(analysis.actions.map((action) => action.id)).toEqual(['sync-database-status']);
    await applyAppWorkspaceRepair(input(), analysis);
    expect(readDbStatus(workspace!)).toMatchObject({
      local_ready: true,
      applied: ['0001_init.sql'],
      seeded: true,
      last_error_phase: null,
      last_error: null,
    });
  });

  it('reports destructive migrations and invalid seeds for specialist review', async () => {
    createWorkspace({ currentHarness: true, currentConfigs: true, currentDirectories: true });
    writeFileSync(join(workspace!, 'migrations', '0002_drop.sql'), 'DROP TABLE items;\n', 'utf8');
    writeFileSync(join(workspace!, 'seeds', 'seed.sql'), 'INSERT INTO items (id) VALUES (1);\n', 'utf8');
    writeDbStatus(workspace!, {
      engine: 'd1',
      local_ready: true,
      applied: ['0001_init.sql'],
      seeded: true,
      seed_hash: null,
      last_error_phase: null,
      last_error: null,
      last_apply_at: '2026-01-01T00:00:00.000Z',
    });
    const analysis = await analyzeAppWorkspaceRepair(input(), {
      inspectMigrationHistory: async () => ['0001_init.sql'],
    });

    expect(analysis.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'destructive-pending-migrations', repairable: false }),
      expect.objectContaining({ code: 'invalid-seed', repairable: false }),
    ]));
    expect(analysis.actions).toEqual([]);
  });
});
