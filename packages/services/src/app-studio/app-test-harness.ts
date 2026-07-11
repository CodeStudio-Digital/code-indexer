import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const APP_TEST_SCRIPTS = {
  test: 'npm run test:worker && npm run test:e2e',
  'test:worker': 'vitest run --config vitest.config.ts --passWithNoTests',
  'test:e2e': 'playwright test --pass-with-no-tests',
} as const;

const APP_TEST_DEV_DEPENDENCIES = ['vitest', '@cloudflare/vitest-pool-workers', '@playwright/test'] as const;

export interface AppTestPackageState {
  parsed: Record<string, unknown> | null;
  missingScripts: string[];
  missingDependencies: string[];
}

export interface AppWorkerHarnessState {
  configExists: boolean;
  configCurrent: boolean;
  setupExists: boolean;
  setupCurrent: boolean;
}

function readOptional(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

export function inspectAppWorkerHarness(workspaceDir: string): AppWorkerHarnessState {
  const config = readOptional(join(workspaceDir, 'vitest.config.ts'));
  const setup = readOptional(join(workspaceDir, 'tests', 'worker', 'setup.ts'));
  return {
    configExists: config.length > 0,
    configCurrent: config.includes('TEST_MIGRATIONS')
      && config.includes('TEST_SEED_QUERIES')
      && config.includes("setupFiles: ['./tests/worker/setup.ts']"),
    setupExists: setup.length > 0,
    setupCurrent: setup.includes('applyD1Migrations')
      && setup.includes('TEST_SEED_QUERIES')
      && setup.includes('testEnv.DB'),
  };
}

export function inspectAppTestPackage(workspaceDir: string): AppTestPackageState {
  try {
    const parsed = JSON.parse(readFileSync(join(workspaceDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    const scripts = (parsed.scripts ?? {}) as Record<string, unknown>;
    const dependencies = {
      ...((parsed.dependencies ?? {}) as Record<string, unknown>),
      ...((parsed.devDependencies ?? {}) as Record<string, unknown>),
    };
    return {
      parsed,
      missingScripts: Object.entries(APP_TEST_SCRIPTS)
        .filter(([name, value]) => scripts[name] !== value)
        .map(([name]) => name),
      missingDependencies: APP_TEST_DEV_DEPENDENCIES.filter((name) => typeof dependencies[name] !== 'string'),
    };
  } catch {
    return { parsed: null, missingScripts: [], missingDependencies: [] };
  }
}

export function appWorkerTestHarnessIssues(workspaceDir: string): string[] {
  const state = inspectAppTestPackage(workspaceDir);
  if (!state.parsed) return ['package.json is missing or invalid'];
  const issues: string[] = [];
  if (state.missingScripts.length > 0) issues.push(`test scripts: ${state.missingScripts.join(', ')}`);
  if (state.missingDependencies.length > 0) issues.push(`test packages: ${state.missingDependencies.join(', ')}`);
  const worker = inspectAppWorkerHarness(workspaceDir);
  if (!worker.configCurrent) issues.push(worker.configExists ? 'outdated vitest.config.ts' : 'vitest.config.ts');
  if (!worker.setupCurrent) issues.push(worker.setupExists ? 'outdated tests/worker/setup.ts' : 'tests/worker/setup.ts');
  if (!existsSync(join(workspaceDir, 'tests', 'worker'))) issues.push('tests/worker');
  return issues;
}
