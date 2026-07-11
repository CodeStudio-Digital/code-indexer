import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { listSqlMigrations } from '@mcp/app-studio/pipeline/gate-checks.js';
import { appMigrationHazards } from '@mcp/app-studio/database/migration.js';
import { validateAppSeedSql } from '@mcp/app-studio/database/seed.js';
import { APP_STUDIO_DIRNAME, readDbStatus, writeDbStatus } from '@mcp/app-studio/status-files.js';
import { runHostCommand } from '../host-scaffold/run-host-command.js';
import { buildConfigFiles } from '../host-scaffold/app-studio/templates-config.js';
import { inspectLocalD1MigrationHistory } from './d1-provisioner.js';
import { APP_TEST_SCRIPTS, inspectAppTestPackage, inspectAppWorkerHarness } from './app-test-harness.js';

export type AppRepairAreaId = 'workspace' | 'database';
export type AppRepairActionId =
  | 'repair-test-package'
  | 'repair-worker-test-harness'
  | 'create-playwright-config'
  | 'create-test-directories'
  | 'sync-database-status';

export interface AppRepairIssue {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  repairable: boolean;
}

export interface AppRepairAction {
  id: AppRepairActionId;
  area: AppRepairAreaId;
  title: string;
  reason: string;
}

export interface AppWorkspaceRepairAnalysis {
  changed: boolean;
  issues: AppRepairIssue[];
  actions: AppRepairAction[];
  fingerprint: string;
  actual_applied_migrations: string[] | null;
}

export interface AppWorkspaceRepairInput {
  workspaceDir: string;
  appSlug: string;
  appName: string;
  port: number;
}

export interface AppWorkspaceRepairOptions {
  inspectMigrationHistory?: (input: AppWorkspaceRepairInput) => Promise<string[] | null>;
}

export interface AppWorkspaceRepairBackupFile {
  path: string;
  existed: boolean;
  backup_path: string | null;
  applied_hash?: string | null;
}

export interface AppWorkspaceRepairApplication {
  backup_root: string;
  files: AppWorkspaceRepairBackupFile[];
  created_directories: string[];
  applied_actions: AppRepairActionId[];
}

const MANAGED_FILES = ['package.json', 'package-lock.json', 'vitest.config.ts', 'tests/worker/setup.ts', 'playwright.config.ts', '.app-studio/db.json'] as const;

function readOptional(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function fileHash(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function safeRelative(workspaceDir: string, absolute: string): string {
  const root = resolve(workspaceDir);
  const target = resolve(absolute);
  const rel = relative(root, target).replace(/\\/g, '/');
  if (!rel || rel.startsWith('../') || rel === '..') throw new Error(`Repair target escapes the app workspace: ${absolute}`);
  return rel;
}

function migrationHazards(workspaceDir: string, pending: string[]): string[] {
  return pending.flatMap((name) => {
    const sql = readOptional(join(workspaceDir, 'migrations', name)) ?? '';
    const hazards = appMigrationHazards(sql);
    return hazards.length > 0 ? [`${name}: ${hazards.join(', ')}`] : [];
  });
}

export async function analyzeAppWorkspaceRepair(
  input: AppWorkspaceRepairInput,
  options: AppWorkspaceRepairOptions = {},
): Promise<AppWorkspaceRepairAnalysis> {
  const issues: AppRepairIssue[] = [];
  const actions: AppRepairAction[] = [];
  const pkg = inspectAppTestPackage(input.workspaceDir);
  if (!pkg.parsed) {
    issues.push({ code: 'invalid-package-json', severity: 'error', message: 'package.json is missing or invalid; automatic repair was refused.', repairable: false });
  } else if (pkg.missingScripts.length > 0 || pkg.missingDependencies.length > 0) {
    issues.push({
      code: 'outdated-test-package',
      severity: 'warning',
      message: `The test harness is outdated (scripts: ${pkg.missingScripts.join(', ') || 'ok'}; packages: ${pkg.missingDependencies.join(', ') || 'ok'}).`,
      repairable: true,
    });
    actions.push({ id: 'repair-test-package', area: 'workspace', title: 'Atualizar infraestrutura de testes', reason: 'Alinha scripts e dependencias do scaffold atual sem alterar codigo do app.' });
  }

  const workerHarness = inspectAppWorkerHarness(input.workspaceDir);
  if (!workerHarness.configCurrent || !workerHarness.setupCurrent) {
    const missing = !workerHarness.configExists || !workerHarness.setupExists;
    issues.push({
      code: missing ? 'missing-worker-test-harness' : 'outdated-worker-test-harness',
      severity: 'warning',
      message: missing
        ? 'The managed Worker test configuration or D1 setup file is missing.'
        : 'The Worker test harness does not apply migrations and canonical seed data through D1 bindings.',
      repairable: true,
    });
    actions.push({
      id: 'repair-worker-test-harness',
      area: 'workspace',
      title: 'Atualizar testes do banco local',
      reason: 'Aplica migracoes e exemplos em um D1 de teste isolado, sem alterar o banco local do app.',
    });
  }
  if (!existsSync(join(input.workspaceDir, 'playwright.config.ts'))) {
    issues.push({ code: 'missing-playwright-config', severity: 'warning', message: 'playwright.config.ts is missing.', repairable: true });
    actions.push({ id: 'create-playwright-config', area: 'workspace', title: 'Restaurar configuracao de testes do navegador', reason: 'Cria somente o arquivo gerenciado que esta ausente.' });
  }
  if (!existsSync(join(input.workspaceDir, 'tests', 'worker')) || !existsSync(join(input.workspaceDir, 'tests', 'e2e'))) {
    issues.push({ code: 'missing-test-directories', severity: 'warning', message: 'The managed tests/worker or tests/e2e directory is missing.', repairable: true });
    actions.push({ id: 'create-test-directories', area: 'workspace', title: 'Restaurar pastas de testes', reason: 'Recria as pastas vazias esperadas pelo fluxo TDD.' });
  }

  const migrations = listSqlMigrations(input.workspaceDir);
  const actualApplied = options.inspectMigrationHistory
    ? await options.inspectMigrationHistory(input)
    : await inspectLocalD1MigrationHistory({
        workspaceDir: input.workspaceDir,
        appSlug: input.appSlug,
        bindingName: 'DB',
      });
  const dbStatus = readDbStatus(input.workspaceDir);
  if (actualApplied && JSON.stringify(actualApplied) !== JSON.stringify(dbStatus?.applied ?? [])) {
    issues.push({ code: 'stale-database-status', severity: 'warning', message: `The database ledger records ${actualApplied.length} migrations, while App Studio records ${dbStatus?.applied.length ?? 0}.`, repairable: true });
    actions.push({ id: 'sync-database-status', area: 'database', title: 'Sincronizar historico do banco', reason: 'Atualiza apenas o status lateral usando o ledger real do D1; nao executa SQL.' });
  } else if (actualApplied === null && existsSync(join(input.workspaceDir, '.wrangler'))) {
    issues.push({ code: 'database-ledger-unreadable', severity: 'error', message: 'The local D1 state exists, but its migration ledger could not be read.', repairable: false });
  }

  const applied = new Set(actualApplied ?? dbStatus?.applied ?? []);
  const pending = migrations.filter((name) => !applied.has(name));
  const hazards = migrationHazards(input.workspaceDir, pending);
  if (hazards.length > 0) {
    issues.push({ code: 'destructive-pending-migrations', severity: 'error', message: `Pending destructive migrations require specialist review: ${hazards.join('; ')}`, repairable: false });
  }
  const seedSql = readOptional(join(input.workspaceDir, 'seeds', 'seed.sql'));
  const seedIssue = seedSql ? validateAppSeedSql(seedSql) : 'seeds/seed.sql is missing.';
  if (seedIssue) issues.push({ code: 'invalid-seed', severity: 'error', message: `Canonical seed requires specialist correction: ${seedIssue}`, repairable: false });

  const fingerprintSource = MANAGED_FILES.map((rel) => [rel, readOptional(join(input.workspaceDir, rel))]);
  const managedDirectories = ['tests/worker', 'tests/e2e'].map((rel) => [rel, existsSync(join(input.workspaceDir, rel))]);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ fingerprintSource, managedDirectories, actualApplied, migrations }))
    .digest('hex');
  return { changed: actions.length > 0, issues, actions, fingerprint, actual_applied_migrations: actualApplied };
}

function backupFiles(workspaceDir: string, fingerprint: string, targets: string[]): AppWorkspaceRepairApplication {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = join(workspaceDir, APP_STUDIO_DIRNAME, 'repairs', `${stamp}-${fingerprint.slice(0, 8)}`);
  const files = [...new Set(targets)].map((rel) => {
    const absolute = join(workspaceDir, ...rel.split('/'));
    safeRelative(workspaceDir, absolute);
    if (!existsSync(absolute)) return { path: rel, existed: false, backup_path: null };
    const backup = join(backupRoot, 'files', ...rel.split('/'));
    mkdirSync(dirname(backup), { recursive: true });
    copyFileSync(absolute, backup);
    return { path: rel, existed: true, backup_path: backup };
  });
  return { backup_root: backupRoot, files, created_directories: [], applied_actions: [] };
}

export function validateAppWorkspaceRepairUndo(workspaceDir: string, application: AppWorkspaceRepairApplication): void {
  for (const file of application.files) {
    if (file.applied_hash === undefined) continue;
    const absolute = join(workspaceDir, ...file.path.split('/'));
    safeRelative(workspaceDir, absolute);
    if (fileHash(absolute) !== file.applied_hash) {
      throw new Error(`Nao foi possivel desfazer: '${file.path}' mudou depois do reparo.`);
    }
  }
  for (const rel of application.created_directories ?? []) {
    const absolute = join(workspaceDir, ...rel.split('/'));
    safeRelative(workspaceDir, absolute);
    if (!existsSync(absolute)) continue;
    const managedNames = new Set(application.files
      .map((file) => file.path.startsWith(`${rel}/`) ? file.path.slice(rel.length + 1) : '')
      .filter((name) => name && !name.includes('/')));
    const unexpected = readdirSync(absolute).filter((name) => !managedNames.has(name));
    if (unexpected.length > 0) throw new Error(`Nao foi possivel desfazer: '${rel}' recebeu novos arquivos depois do reparo.`);
  }
}

export function restoreAppWorkspaceRepair(workspaceDir: string, application: AppWorkspaceRepairApplication): void {
  validateAppWorkspaceRepairUndo(workspaceDir, application);
  for (const file of [...application.files].reverse()) {
    const absolute = join(workspaceDir, ...file.path.split('/'));
    safeRelative(workspaceDir, absolute);
    if (file.existed && file.backup_path) {
      safeRelative(workspaceDir, file.backup_path);
      mkdirSync(dirname(absolute), { recursive: true });
      copyFileSync(file.backup_path, absolute);
    } else if (existsSync(absolute)) {
      unlinkSync(absolute);
    }
  }
  for (const rel of [...(application.created_directories ?? [])].reverse()) {
    const absolute = join(workspaceDir, ...rel.split('/'));
    if (existsSync(absolute) && readdirSync(absolute).length === 0) rmdirSync(absolute);
  }
}

export async function applyAppWorkspaceRepair(
  input: AppWorkspaceRepairInput,
  analysis: AppWorkspaceRepairAnalysis,
): Promise<AppWorkspaceRepairApplication> {
  const actionIds = new Set(analysis.actions.map((action) => action.id));
  const targets: string[] = [];
  if (actionIds.has('repair-test-package')) targets.push('package.json', 'package-lock.json');
  if (actionIds.has('repair-worker-test-harness')) targets.push('vitest.config.ts', 'tests/worker/setup.ts');
  if (actionIds.has('create-playwright-config')) targets.push('playwright.config.ts');
  if (actionIds.has('create-test-directories')) targets.push('tests/worker/.gitkeep', 'tests/e2e/.gitkeep');
  if (actionIds.has('sync-database-status')) targets.push('.app-studio/db.json');
  const application = backupFiles(input.workspaceDir, analysis.fingerprint, targets);
  if (actionIds.has('create-test-directories')) {
    application.created_directories = ['tests/worker', 'tests/e2e']
      .filter((rel) => !existsSync(join(input.workspaceDir, ...rel.split('/'))));
  }
  try {
    if (actionIds.has('repair-test-package')) {
      const pkgBefore = inspectAppTestPackage(input.workspaceDir);
      if (!pkgBefore.parsed) throw new Error('package.json became invalid after the repair preview.');
      if (pkgBefore.missingDependencies.length > 0) {
        const install = await runHostCommand({
          program: 'npm',
          args: ['install', '--no-audit', '--no-fund', '--loglevel=error', '-D', ...pkgBefore.missingDependencies],
          cwd: input.workspaceDir,
          timeoutMs: 180_000,
        });
        if (!install.ok) throw new Error(`Dependency repair failed: ${install.stderrTail}`);
      }
      const pkg = JSON.parse(readFileSync(join(input.workspaceDir, 'package.json'), 'utf8')) as Record<string, unknown>;
      pkg.scripts = { ...((pkg.scripts ?? {}) as Record<string, unknown>), ...APP_TEST_SCRIPTS };
      writeFileSync(join(input.workspaceDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    }

    const templates = new Map(buildConfigFiles({ slug: input.appSlug, appSlug: input.appSlug, appName: input.appName, port: input.port }).map((file) => [file.path, file.contents]));
    if (actionIds.has('repair-worker-test-harness')) {
      mkdirSync(join(input.workspaceDir, 'tests', 'worker'), { recursive: true });
      writeFileSync(join(input.workspaceDir, 'vitest.config.ts'), templates.get('vitest.config.ts')!, 'utf8');
      writeFileSync(join(input.workspaceDir, 'tests', 'worker', 'setup.ts'), templates.get('tests/worker/setup.ts')!, 'utf8');
    }
    if (actionIds.has('create-playwright-config')) writeFileSync(join(input.workspaceDir, 'playwright.config.ts'), templates.get('playwright.config.ts')!, 'utf8');
    if (actionIds.has('create-test-directories')) {
      mkdirSync(join(input.workspaceDir, 'tests', 'worker'), { recursive: true });
      mkdirSync(join(input.workspaceDir, 'tests', 'e2e'), { recursive: true });
      writeFileSync(join(input.workspaceDir, 'tests', 'worker', '.gitkeep'), '', 'utf8');
      writeFileSync(join(input.workspaceDir, 'tests', 'e2e', '.gitkeep'), '', 'utf8');
    }
    if (actionIds.has('sync-database-status') && analysis.actual_applied_migrations) {
      const current = readDbStatus(input.workspaceDir);
      const migrations = listSqlMigrations(input.workspaceDir);
      const allKnownApplied = migrations.every((name) => analysis.actual_applied_migrations!.includes(name));
      writeDbStatus(input.workspaceDir, {
        engine: 'd1',
        local_ready: analysis.actual_applied_migrations.length > 0,
        applied: analysis.actual_applied_migrations,
        seeded: current?.seeded ?? false,
        seed_hash: current?.seed_hash ?? null,
        last_error_phase: current?.last_error_phase === 'migration' && allKnownApplied ? null : current?.last_error_phase ?? null,
        last_error: current?.last_error_phase === 'migration' && allKnownApplied ? null : current?.last_error ?? null,
        last_apply_at: new Date().toISOString(),
      });
    }
    for (const file of application.files) {
      file.applied_hash = fileHash(join(input.workspaceDir, ...file.path.split('/')));
    }
    application.applied_actions = [...actionIds];
    mkdirSync(application.backup_root, { recursive: true });
    writeFileSync(join(application.backup_root, 'manifest.json'), `${JSON.stringify(application, null, 2)}\n`, 'utf8');
    return application;
  } catch (e) {
    for (const file of application.files) delete file.applied_hash;
    restoreAppWorkspaceRepair(input.workspaceDir, application);
    throw e;
  }
}
