import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/code-agent/core/tool.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import { recordTddCycle } from '@mcp/app-studio/architecture/tdd-cycles.js';
import { parseAppArchitecturePlan } from '@mcp/app-studio/architecture/types.js';
import { parseAppWireframePlan } from '@mcp/app-studio/experience/types.js';
import { parseAppWorkflowState } from '@mcp/app-studio/workflow/state.js';
import { filesContaining, readIfExists, runWorkspaceScript, summarizeOutput } from '@mcp/app-studio/verification/workspace-checks.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';
import { appResult } from './model-output.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    case_ids: { type: 'array', items: { type: 'string' }, description: 'Architecture TDD case ids exercised by this run.' },
    phase: { type: 'string', enum: ['red', 'green'], description: 'red must fail before implementation; green must pass after implementation.' },
    script: { type: 'string', enum: ['test:worker', 'test:e2e'], description: 'Workspace test script to run.' },
  },
  required: ['case_ids', 'phase', 'script'],
};

export function appRunTestCycle(binding: AppToolBinding): CoderTool { return {
  name: 'app_run_test_cycle',
  description: 'Run and record a deterministic TDD red/green cycle for cases owned by the current architecture or approved wireframe. Red succeeds only when tests fail; green succeeds only when tests pass.',
  parameters: PARAMETERS,
  source: 'native',
  handler: async (args, ctx) => {
    const caseIds = Array.isArray(args.case_ids) ? [...new Set(args.case_ids.map(String).map((id) => id.trim()).filter(Boolean))] : [];
    const phase = args.phase === 'red' || args.phase === 'green' ? args.phase : null;
    const script = args.script === 'test:worker' || args.script === 'test:e2e' ? args.script : null;
    if (caseIds.length === 0 || !phase || !script) return err('case_ids, phase and script are required.');
    const store = getAppStudioStore();
    if (!store) return err('AppStudioStore not wired.');
    const session = binding.resolveAppSession(store);
    if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);
    const state = parseAppWorkflowState(session.pipeline_json);
    const active = state?.phases.some((phase) => (phase.id === 'blueprint' || phase.id === 'build' || phase.id === 'deliver') && (phase.status === 'active' || phase.status === 'attention'));
    if (!state || !active) return err('Test cycles are available only inside an active Blueprint, Build or Deliver card.');
    const architecture = parseAppArchitecturePlan(store.getLatestArchitectureRevision(session.id)?.architecture_json);
    const architectureCases = (architecture?.tdd.cases ?? []).filter((item) => script === 'test:e2e'
      ? item.owner_profile === 'ui' || item.owner_profile === 'verify'
      : item.owner_profile === 'data' || item.owner_profile === 'api' || item.owner_profile === 'verify');
    const wireframe = parseAppWireframePlan(store.getLatestWireframeRevision(session.id)?.wireframe_json);
    const allowedCases = script === 'test:e2e' ? [...architectureCases, ...(wireframe?.tdd_cases ?? [])] : architectureCases;
    const allowed = new Set(allowedCases.map((item) => item.id));
    const unknown = caseIds.filter((id) => !allowed.has(id));
    if (unknown.length > 0) return err(`TDD cases do not match script '${script}': ${unknown.join(', ')}.`);
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
    const cycleState = recordTddCycle(resolved.path, { caseIds, script, phase, output: result.output });
    return appResult('App test cycle recorded', { phase, script, case_ids: caseIds, recorded: caseIds.map((id) => cycleState.cycles[id]) });
  },
}; }
