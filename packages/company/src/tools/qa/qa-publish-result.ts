/**
 * Republish an existing completed run only after checking its stored
 * results and evidence. Model-supplied counters never create a QA verdict.
 */
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import type { JsonSchema } from "@mcp/provider-sdk";
import { ok, err } from "@mcp/agent-runtime-host/tool-result.js";
import type { CompanyOrchestratorPort as CompanyOrchestrator } from '@mcp/company/orchestrator-port.js';
import type {
  QaFailingTest,
  QaRunCompletedPayload,
} from '@mcp/company/tools/qa/qa-event-types.js';
import { getQaStores } from './qa-start-run.js';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    run_id: { type: 'string', description: 'Persisted, completed QA run in this session. Counts are read from stored evidence; caller counts are ignored.' },
  },
  required: ['run_id'],
  additionalProperties: false,
};

export function qaPublishResult(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: string | null,
): CoderTool {
  return {
    name: 'qa_publish_result',
    description:
      'Republish a completed, persisted QA run with real evidence. Requires run_id. Does not accept self-reported success: verdicts/counts come from recorded results and evidence files. Preview runs finish automatically via qa_check_preview; Playwright runs finish through the reporter.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args) => {
      try {
        const { runStore, resultStore } = getQaStores();
        if (!runStore || !resultStore) return err('QA persistence is unavailable');
        const run = await runStore.getRun(mustString(args.run_id, 'run_id'));
        if (!run || run.company_session_id !== orchestrator.companySessionId) return err('QA run does not belong to this session');
        if (agentRunId !== null && run.agent_run_id !== agentRunId) return err('QA run belongs to a different agent');
        if (run.status !== 'completed') return err('Run is not completed. Execute preview checks or wait for the Playwright reporter; do not fabricate a result.');
        const results = await resultStore.listResults(run.id);
        if (!results.length || !run.report_persisted_path) return err('Run has no persisted QA evidence');
        const root = await realpath(run.report_persisted_path);
        for (const result of results.filter((item) => item.status !== 'skipped')) {
          const artifacts = [result.screenshot_path, result.trace_path, result.summary_md_path].filter((path): path is string => !!path);
          let verified = false;
          for (const artifact of artifacts) {
            const path = await realpath(resolve(root, artifact)).catch(() => '');
            if (path.startsWith(root + sep) && (await stat(path)).isFile()) { verified = true; break; }
          }
          if (!verified) return err(`Missing persisted evidence for ${result.test_name}`);
        }
        const passed = results.filter((item) => item.status === 'passed').length;
        const failed = results.filter((item) => ['failed', 'timed-out', 'interrupted'].includes(item.status)).length;
        const skipped = results.filter((item) => item.status === 'skipped').length;
        if (passed + failed === 0 || run.passed !== passed || run.failed !== failed || run.skipped !== skipped) return err('Persisted QA counts do not match executed evidence');
        const payload: QaRunCompletedPayload = { agent_run_id: run.agent_run_id, agent_role: agentRole, suite: run.suite,
          passed, failed, skipped, duration_ms: run.duration_ms ?? undefined };
        orchestrator.publishQaResult(payload);
        const summary = `passed=${payload.passed} failed=${payload.failed} skipped=${payload.skipped}`;
        return ok(`Published qa_run_completed for "${payload.suite}" — ${summary}`);
      } catch (e) {
        return err(`qa_publish_result failed: ${(e as Error).message}`);
      }
    },
  };
}

/**
 * Pure: validate + normalise the model-supplied args into a typed payload.
 * Throws with a helpful message when types/shape don't match the schema.
 *
 * Exported for unit testing without spinning up an orchestrator.
 */
export function coercePayload(
  args: Record<string, unknown>,
  agentRole: string,
  agentRunId: string | null,
): QaRunCompletedPayload {
  const suite = mustString(args.suite, 'suite');
  const passed = mustNonNegativeInt(args.passed, 'passed');
  const failed = mustNonNegativeInt(args.failed, 'failed');
  const skipped = optionalNonNegativeInt(args.skipped, 'skipped') ?? 0;
  const duration_ms = optionalNonNegativeInt(args.duration_ms, 'duration_ms');
  const trace_urls = optionalStringArray(args.trace_urls, 'trace_urls');
  const failing_tests = optionalFailingTests(args.failing_tests);

  return {
    agent_run_id: agentRunId,
    agent_role: agentRole,
    suite,
    passed,
    failed,
    skipped,
    duration_ms,
    trace_urls,
    failing_tests,
  };
}

function mustString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return v;
}

function mustNonNegativeInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return v;
}

function optionalNonNegativeInt(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  return mustNonNegativeInt(v, field);
}

function optionalStringArray(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error(`${field} must be an array of strings`);
  for (const item of v) {
    if (typeof item !== 'string') throw new Error(`${field} entries must be strings`);
  }
  return v as string[];
}

function optionalFailingTests(v: unknown): QaFailingTest[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error('failing_tests must be an array');
  return v.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`failing_tests[${idx}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const name = mustString(e.name, `failing_tests[${idx}].name`);
    const error = mustString(e.error, `failing_tests[${idx}].error`);
    const trace_url =
      e.trace_url === undefined || e.trace_url === null
        ? undefined
        : mustString(e.trace_url, `failing_tests[${idx}].trace_url`);
    return { name, error, trace_url };
  });
}
