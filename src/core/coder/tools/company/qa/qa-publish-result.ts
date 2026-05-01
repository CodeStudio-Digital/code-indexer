/**
 * Tool: `qa_publish_result`. Called by a QA subordinate at the end of a
 * Playwright run to surface aggregate stats on the company stream. The
 * dashboard's QaRunBadge / TestsTab subscribe to `qa_run_completed`.
 *
 * The tool is a thin orchestrator: it validates input, publishes one
 * event on the meta bus, and returns. Persistence (qa_test_runs table,
 * routes) lands in phase 2 — for now the badge re-derives state from
 * the live event stream + buffered SSE replay.
 */
import type { CoderTool, JsonSchema } from '../../../core/tool.js';
import { ok, err } from '../../../core/tool.js';
import type { CompanyOrchestrator } from '../../../company/orchestrator.js';
import { publish as busPublish } from '../../../../../apps/http-api/coder-bus.js';
import type {
  QaFailingTest,
  QaRunCompletedPayload,
} from './qa-event-types.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    suite: {
      type: 'string',
      description:
        'Suite identifier (typically the spec file or feature name, e.g. "login" or "tests/e2e/login.spec.ts").',
    },
    passed: { type: 'number', description: 'Tests that passed.' },
    failed: { type: 'number', description: 'Tests that failed.' },
    skipped: { type: 'number', description: 'Tests skipped (default 0).' },
    duration_ms: {
      type: 'number',
      description: 'Total wall-clock duration of the run in milliseconds.',
    },
    trace_urls: {
      type: 'array',
      items: { type: 'string' },
      description: 'Relative paths (within the workspace) to .zip traces produced by Playwright.',
    },
    failing_tests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          error: { type: 'string' },
          trace_url: { type: 'string' },
        },
        required: ['name', 'error'],
      },
      description: 'Per-failure detail. Empty/omitted when the suite is green.',
    },
  },
  required: ['suite', 'passed', 'failed'],
};

export function qaPublishResult(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: number | null,
): CoderTool {
  return {
    name: 'qa_publish_result',
    description:
      'Publish the result of a Playwright test run to the company stream. The dashboard picks this up to update the QA badge and test history.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args) => {
      try {
        const payload = coercePayload(args, agentRole, agentRunId);
        busPublish(orchestrator.metaBus, 'qa_run_completed', payload);
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
  agentRunId: number | null,
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
