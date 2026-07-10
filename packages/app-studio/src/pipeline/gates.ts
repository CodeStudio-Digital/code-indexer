/**
 * Gates determinísticos por etapa — o que `app_submit_stage` verifica ANTES
 * de mandar a etapa para revisão do usuário. Cada issue nomeia o arquivo e
 * o conserto (o consumidor é o próprio agente). Async porque design/
 * backend/review spawnam `npm run typecheck`/`build` — aceitável: roda só
 * no submit (nunca por turno) com timeout duro. `runBuild:false` pula os
 * spawns (testes).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSpec } from '../spec/types.js';
import { validateAppSpec } from '../spec/validate.js';
import { readDbStatus, readDeployStatus } from '../status-files.js';
import { runSecurityAudit } from '../audit/security.js';
import { auditAppArchitecture } from '../architecture/audit.js';
import type { AppArchitecturePlan } from '../architecture/types.js';
import { readTddCycles } from '../architecture/tdd-cycles.js';
import type { AppPipelineState, AppStageGateResult, AppStageId } from './stages.js';
import { roadmapProgress, type AppRecordedKind } from './roadmap.js';
import {
  filesContaining,
  hasCreateTable,
  listSqlMigrations,
  readAllMigrationsSql,
  readIfExists,
  runWorkspaceScript,
  sqlHasStatements,
  summarizeOutput,
} from './gate-checks.js';

export interface AppStageGateInput {
  stage: AppStageId;
  /** Raiz do workspace no host (contém src/, worker/, migrations/…). */
  workspaceDir: string;
  state: AppPipelineState;
  /** Spec corrente da sessão (null enquanto a entrevista não salvou). */
  spec: AppSpec | null;
  /** Features registradas via app_record_feature. */
  recorded: Array<{ name: string; kind: AppRecordedKind }>;
  /** Plano técnico mais recente, obrigatório na etapa architecture. */
  architecture?: AppArchitecturePlan | null;
  /** Revisão aprovada da spec que a arquitetura precisa representar. */
  currentSpecRevisionId?: number | null;
  /** false pula spawns de typecheck/build (testes). Default true. */
  runBuild?: boolean;
}

const CODE_FILE = /\.(ts|tsx)$/;
const BETTER_AUTH_TABLES = ['user', 'session', 'account', 'verification'] as const;

function missingRoadmap(input: AppStageGateInput, tier: 'screen' | 'api'): string[] {
  const items = roadmapProgress(
    input.state.roadmap.filter((item) => item.tier === tier),
    input.recorded,
  );
  return items.filter((item) => !item.recorded).map((item) => item.name);
}

async function scriptIssue(
  workspaceDir: string,
  script: string,
  runBuild: boolean | undefined,
): Promise<string | null> {
  if (runBuild === false) return null;
  const result = await runWorkspaceScript(workspaceDir, script);
  if (result.ok) return null;
  return `\`npm run ${script}\` failed (exit ${result.code ?? 'timeout'}):\n${summarizeOutput(result.output)}`;
}

function tddIssues(input: AppStageGateInput, ownerStage: 'database' | 'design' | 'backend' | 'review'): string[] {
  const cases = (input.architecture?.tdd.cases ?? []).filter((testCase) => testCase.owner_stage === ownerStage);
  if (cases.length === 0) return [];
  const issues: string[] = [];
  const testFiles = filesContaining(join(input.workspaceDir, 'tests'), /\.(ts|tsx)$/, /./);
  const testText = testFiles.map((rel) => readIfExists(join(input.workspaceDir, 'tests', rel)) ?? '').join('\n');
  const cycles = readTddCycles(input.workspaceDir).cycles;
  for (const testCase of cases) {
    if (!testText.includes(testCase.id)) issues.push(`TDD case '${testCase.id}' is not referenced in tests/**/*.ts.`);
    const cycle = cycles[testCase.id];
    if (!cycle?.red_at) issues.push(`TDD case '${testCase.id}' has no recorded red run — call app_run_test_cycle before implementation.`);
    if (!cycle?.green_at) issues.push(`TDD case '${testCase.id}' has no recorded green run — call app_run_test_cycle after implementation.`);
  }
  return issues;
}

export async function runAppStageGate(input: AppStageGateInput): Promise<AppStageGateResult> {
  const issues: string[] = [];
  const { workspaceDir, spec } = input;

  switch (input.stage) {
    case 'discovery': {
      if (!spec) {
        issues.push('No spec saved yet — run the interview and call app_save_spec before submitting discovery.');
        break;
      }
      issues.push(...validateAppSpec(spec));
      break;
    }
    case 'architecture': {
      if (!spec) {
        issues.push('Spec missing — approve discovery before planning the architecture.');
        break;
      }
      const audit = auditAppArchitecture(input.architecture ?? null, spec);
      issues.push(...audit.issues);
      if (
        input.currentSpecRevisionId != null &&
        input.architecture?.spec_revision_id !== input.currentSpecRevisionId
      ) {
        issues.push('Architecture is stale — save it again against the current approved spec revision.');
      }
      break;
    }
    case 'database': {
      if (!spec) {
        issues.push('Spec missing — discovery must be approved before the database stage.');
        break;
      }
      if (!spec.database.required) break; // app sem banco: etapa passa direto (ou é pulada).
      issues.push(...tddIssues(input, 'database'));
      const migrations = listSqlMigrations(workspaceDir);
      if (migrations.length === 0) {
        issues.push('migrations/ has no .sql files — create 0001_init.sql from the spec entities.');
        break;
      }
      const allSql = readAllMigrationsSql(workspaceDir);
      for (const entity of spec.database.entities) {
        if (!hasCreateTable(allSql, entity.name)) {
          issues.push(`No CREATE TABLE for entity '${entity.name}' in migrations/*.sql.`);
        }
      }
      const seedSql = readIfExists(join(workspaceDir, 'seeds', 'seed.sql'));
      if (!seedSql || !sqlHasStatements(seedSql)) {
        issues.push(
          'seeds/seed.sql has no example rows — write realistic INSERT statements so the preview and the "Seus dados" panel have content.',
        );
      }
      const db = readDbStatus(workspaceDir);
      if (!db?.local_ready) {
        issues.push('Local database not provisioned — run app_provision_db after writing the migrations.');
      } else {
        const missing = migrations.filter((name) => !db.applied.includes(name));
        if (missing.length > 0) {
          issues.push(`Migrations not applied locally: ${missing.join(', ')} — run app_provision_db again.`);
        }
        if (sqlHasStatements(seedSql ?? '') && !db.seeded) {
          issues.push('Seed data not loaded — run app_provision_db again after writing seeds/seed.sql.');
        }
      }
      const tests = await scriptIssue(workspaceDir, 'test:worker', input.runBuild);
      if (tests) issues.push(tests);
      break;
    }
    case 'design': {
      if (!spec) {
        issues.push('Spec missing — approve discovery first.');
        break;
      }
      const missing = missingRoadmap(input, 'screen');
      issues.push(...tddIssues(input, 'design'));
      if (missing.length > 0) {
        issues.push(`Screens not recorded (build + app_record_feature kind:'screen'): ${missing.join(', ')}.`);
      }
      const registry = readIfExists(join(workspaceDir, 'src', 'screens', 'registry.ts'));
      if (!registry) {
        issues.push('src/screens/registry.ts not found — every screen must be registered there.');
      } else {
        for (const screen of spec.screens) {
          if (!registry.includes(`'${screen.id}'`) && !registry.includes(`"${screen.id}"`)) {
            issues.push(`src/screens/registry.ts is missing screen id '${screen.id}'.`);
          }
        }
      }
      const typecheck = await scriptIssue(workspaceDir, 'typecheck', input.runBuild);
      if (typecheck) issues.push(typecheck);
      const tests = await scriptIssue(workspaceDir, 'test:e2e', input.runBuild);
      if (tests) issues.push(tests);
      break;
    }
    case 'backend': {
      if (!spec) {
        issues.push('Spec missing — approve discovery first.');
        break;
      }
      const missing = missingRoadmap(input, 'api');
      issues.push(...tddIssues(input, 'backend'));
      if (missing.length > 0) {
        issues.push(`API deliverables not recorded (app_record_feature kind:'api'): ${missing.join(', ')}.`);
      }
      if (spec.database.required) {
        const workerFiles = filesContaining(join(workspaceDir, 'worker'), CODE_FILE, /./);
        const workerText = workerFiles
          .map((rel) => readIfExists(join(workspaceDir, 'worker', rel)) ?? '')
          .join('\n');
        for (const entity of spec.database.entities) {
          if (!workerText.includes(entity.name)) {
            issues.push(`Entity '${entity.name}' has no route in worker/*.ts — expose its CRUD under /api.`);
          }
        }
      }
      const mockImports = filesContaining(join(workspaceDir, 'src', 'screens'), CODE_FILE, /from\s+['"][^'"]*lib\/mock/);
      if (mockImports.length > 0) {
        issues.push(
          `Screens still import lib/mock (swap to lib/api.ts): ${mockImports.map((f) => `src/screens/${f}`).join(', ')}.`,
        );
      }
      if (spec.auth.enabled) {
        if (!existsSync(join(workspaceDir, 'worker', 'auth.ts'))) {
          issues.push('auth.enabled but worker/auth.ts not found — wire better-auth over D1 (see the cloudflare-app skill).');
        }
        const allSql = readAllMigrationsSql(workspaceDir);
        const missingTables = BETTER_AUTH_TABLES.filter((t) => !hasCreateTable(allSql, t));
        if (missingTables.length > 0) {
          issues.push(`better-auth tables missing from migrations: ${missingTables.join(', ')}.`);
        }
        if ((spec.auth.protected_screen_ids?.length ?? 0) > 0) {
          const guards = filesContaining(join(workspaceDir, 'src'), CODE_FILE, /RequireAuth|requireAuth/);
          if (guards.length === 0) {
            issues.push('Protected screens declared but no RequireAuth guard found in src/ — gate the routes.');
          }
        }
      }
      const typecheck = await scriptIssue(workspaceDir, 'typecheck', input.runBuild);
      if (typecheck) issues.push(typecheck);
      const tests = await scriptIssue(workspaceDir, 'test:worker', input.runBuild);
      if (tests) issues.push(tests);
      break;
    }
    case 'review': {
      issues.push(...tddIssues(input, 'review'));
      const audit = runSecurityAudit(workspaceDir, spec);
      issues.push(...audit.errors);
      if (!existsSync(join(workspaceDir, 'REVIEW.md'))) {
        issues.push('REVIEW.md not found — write the plain-language quality report for the user.');
      }
      const build = await scriptIssue(workspaceDir, 'build', input.runBuild);
      if (build) issues.push(build);
      const tests = await scriptIssue(workspaceDir, 'test', input.runBuild);
      if (tests) issues.push(tests);
      break;
    }
    case 'launch': {
      const deploy = readDeployStatus(workspaceDir);
      if (!deploy?.url || !deploy.health_ok) {
        issues.push('App not deployed yet — the user publishes from the Publicar panel (launch chain writes deploy.json).');
      }
      break;
    }
  }
  return { ok: issues.length === 0, issues };
}
