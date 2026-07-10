import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import { recordTddCycle } from '@mcp/app-studio/architecture/tdd-cycles.js';
import { filesContaining, readIfExists, runWorkspaceScript, summarizeOutput } from '@mcp/app-studio/pipeline/gate-checks.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    case_ids: { type: 'array', items: { type: 'string' }, description: 'Architecture TDD case ids exercised by this run.' },
    phase: { type: 'string', enum: ['red', 'green'], description: 'red must fail before implementation; green must pass after implementation.' },
    script: { type: 'string', enum: ['test:worker', 'test:e2e'], description: 'Workspace test script to run.' },
  },
  required: ['case_ids', 'phase', 'script'],
};

export const appRunTestCycle: CoderTool = {
  name: 'app_run_test_cycle',
  description: 'Run and record a deterministic TDD red/green cycle for architecture test case ids. Red succeeds only when tests fail; green succeeds only when tests pass.',
  parameters: PARAMETERS,
  source: 'native',
  handler: async (args, ctx) => {
    const caseIds = Array.isArray(args.case_ids) ? [...new Set(args.case_ids.map(String).map((id) => id.trim()).filter(Boolean))] : [];
    const phase = args.phase === 'red' || args.phase === 'green' ? args.phase : null;
    const script = args.script === 'test:worker' || args.script === 'test:e2e' ? args.script : null;
    if (caseIds.length === 0 || !phase || !script) return err('case_ids, phase and script are required.');
    const resolved = resolveHostPath('.', ctx);
    if (resolved.kind === 'no-bind-mount') return err(resolved.message);
    const testFiles = filesContaining(`${resolved.path}/tests`, /\.(ts|tsx)$/, /./);
    const testText = testFiles.map((file) => readIfExists(`${resolved.path}/tests/${file}`) ?? '').join('\n');
    const missing = caseIds.filter((caseId) => !testText.includes(caseId));
    if (missing.length > 0) return err(`Test files must reference every case id before the cycle runs. Missing: ${missing.join(', ')}.`);
    const result = await runWorkspaceScript(resolved.path, script, script === 'test:e2e' ? 180_000 : 120_000);
    const expected = phase === 'red' ? !result.ok : result.ok;
    if (!expected) {
      return err(
        phase === 'red'
          ? `TDD red phase unexpectedly passed. Add the test before implementation or make its expected behavior specific.\n${summarizeOutput(result.output)}`
          : `TDD green phase failed. Fix the implementation and rerun.\n${summarizeOutput(result.output)}`,
      );
    }
    const state = recordTddCycle(resolved.path, { caseIds, script, phase, output: result.output });
    return ok(JSON.stringify({ phase, script, case_ids: caseIds, recorded: caseIds.map((id) => state.cycles[id]) }, null, 2));
  },
};
