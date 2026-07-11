import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err, ok } from '@mcp/code-agent/core/tool.js';
import { parseAppArchitecturePlan } from '@mcp/app-studio/architecture/types.js';
import { readTddCycles } from '@mcp/app-studio/architecture/tdd-cycles.js';
import { currentStage, parsePipelineState } from '@mcp/app-studio/pipeline/stages.js';
import { APP_STUDIO_DIRNAME } from '@mcp/app-studio/status-files.js';
import { appWorkerTestHarnessIssues } from '@mcp/services/app-studio/index.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Relative tests/worker/**/*.test.ts path.' },
    contents: { type: 'string', description: 'Complete Vitest test file. It must reference every case_ids value.' },
    case_ids: { type: 'array', items: { type: 'string' }, description: 'Database-owned architecture TDD case ids covered by this file.' },
  },
  required: ['path', 'contents', 'case_ids'],
  additionalProperties: false,
};

function normalizedTestPath(value: unknown): string | null {
  const path = typeof value === 'string' ? value.trim().replace(/\\/g, '/').replace(/^\.\//, '') : '';
  if (!/^tests\/worker\/[A-Za-z0-9_./-]+\.test\.ts$/.test(path) || path.includes('..')) return null;
  return path;
}

export function databaseTestContractIssue(contents: string): string | null {
  if (/from\s+['"]node:(?:fs|path)['"]|\b(?:readFileSync|process\.cwd)\b/.test(contents)) {
    return 'Database TDD tests must query the isolated D1 binding. Reading migrations or seed files from disk is not accepted as database evidence.';
  }
  if (!/from\s+['"]cloudflare:workers['"]/.test(contents) || !/\.prepare\s*\(/.test(contents)) {
    return "Database TDD tests must import env from 'cloudflare:workers' and assert behavior through env.DB.prepare(...).";
  }
  return null;
}

export function appSaveTddTest(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_save_tdd_test',
    description: 'Save a database-stage Vitest file for approved architecture TDD cases. Tests must query the isolated D1 binding; source-file inspection is rejected.',
    parameters: PARAMETERS,
    source: 'native',
    riskLevel: 'write',
    handler: async (args, ctx) => {
      try {
        const path = normalizedTestPath(args.path);
        if (!path) return err('path must stay under tests/worker and end in .test.ts. Parent traversal is not allowed.');
        const contents = typeof args.contents === 'string' ? args.contents.trim() : '';
        const caseIds = Array.isArray(args.case_ids)
          ? [...new Set(args.case_ids.map(String).map((id) => id.trim()).filter(Boolean))]
          : [];
        if (!contents || caseIds.length === 0) return err('contents and at least one case_ids value are required.');
        const missingFromSource = caseIds.filter((id) => !contents.includes(id));
        if (missingFromSource.length > 0) return err(`The test source must reference every case id. Missing: ${missingFromSource.join(', ')}.`);
        const contractIssue = databaseTestContractIssue(contents);
        if (contractIssue) return err(contractIssue);

        const store = getAppStudioStore();
        if (!store) return err('app_save_tdd_test: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);
        const state = parsePipelineState(session.pipeline_json);
        const current = state ? currentStage(state) : null;
        if (current?.id !== 'database' || current.status === 'review') {
          return err(`Database TDD tests are locked while the current stage is '${current?.id ?? 'none'}' (${current?.status ?? 'missing'}).`);
        }
        const architecture = parseAppArchitecturePlan(store.getLatestArchitectureRevision(session.id)?.architecture_json);
        const allowed = new Set((architecture?.tdd.cases ?? []).filter((item) => item.owner_stage === 'database').map((item) => item.id));
        const unknown = caseIds.filter((id) => !allowed.has(id));
        if (unknown.length > 0) return err(`These are not database-owned TDD cases in the approved architecture: ${unknown.join(', ')}.`);

        const resolved = resolveHostPath('.', ctx);
        if (resolved.kind === 'no-bind-mount') return err(resolved.message);
        const harnessIssues = appWorkerTestHarnessIssues(resolved.path);
        if (harnessIssues.length > 0) {
          return err(`The app test harness needs repair (${harnessIssues.join('; ')}). Use "Reparar app" in the App Studio guide, then retry this tool.`);
        }

        const absolute = join(resolved.path, ...path.split('/'));
        let backupPath: string | null = null;
        if (existsSync(absolute)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          backupPath = join(resolved.path, APP_STUDIO_DIRNAME, 'backups', 'tests', stamp, ...path.split('/'));
          mkdirSync(dirname(backupPath), { recursive: true });
          copyFileSync(absolute, backupPath);
        }
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, `${contents}\n`, 'utf8');
        const cycles = readTddCycles(resolved.path).cycles;
        const needsRed = caseIds.filter((id) => !cycles[id]?.red_at);
        return ok(JSON.stringify({
          path,
          case_ids: caseIds,
          backup_path: backupPath,
          next: needsRed.length > 0
            ? `Call app_run_test_cycle with phase red for: ${needsRed.join(', ')}.`
            : 'Run app_run_test_cycle with phase green after the database implementation passes these tests.',
        }, null, 2));
      } catch (e) {
        return err(`app_save_tdd_test failed: ${(e as Error).message}`);
      }
    },
  };
}
