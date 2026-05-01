/**
 * `POST /api/company/sessions/:id/qa/test-event` — endpoint the custom
 * Playwright reporter (running INSIDE the sandbox container) posts to
 * as the suite progresses.
 *
 * Three event kinds, mirroring the reporter:
 *   - `started`     → reporter saw `onBegin`. Already-existing run row
 *                     is left as-is (the QA agent created it before
 *                     spawning playwright). We only validate the run
 *                     belongs to the session in the URL.
 *   - `test_result` → reporter saw `onTestEnd`. We persist a row in
 *                     `qa_test_results`.
 *   - `completed`   → reporter saw `onEnd`. We patch the run with final
 *                     counts + duration.
 *
 * Validation is intentionally permissive: missing fields default to
 * sensible values so a slightly out-of-sync reporter doesn't block the
 * suite. Untrusted callers can't reach this endpoint anyway — the
 * reporter posts from inside the container, gated by the same auth as
 * other company routes.
 *
 * **Persistence only** in v1 — the LiveRunView gets data via polling
 * `/qa/runs/active`. Phase 2D will additionally republish events on the
 * `MetaBusPublisher` so the SSE stream pushes incremental updates with
 * zero polling.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../../deps.js';
import { parseIdParam, parseJsonBody } from '../../_helpers.js';
import type { QaTestStatus } from '../../../../../../core/qa/types.js';
import { orchestratorRegistry } from '../../../../sse/OrchestratorRegistry.js';
import { publish as busPublish } from '../../../../coder-bus.js';
import { getSandboxManager } from '../../../../../../core/sandbox/index.js';
import { persistAndStamp } from '../../../../../../core/qa/report-persistence.js';
import {
  upsertBugCard,
  syncFeatureCard,
  type EvidenceUrlBuilder,
} from '../../../../../../core/qa/kanban-bridge.js';

interface StartedEvent {
  kind: 'started';
  runId: string | number;
  count?: number;
}
interface TestResultEvent {
  kind: 'test_result';
  runId: string | number;
  spec: string;
  name: string;
  status: string;
  duration_ms?: number;
  error?: string | null;
  trace_path?: string | null;
  screenshot_path?: string | null;
  video_path?: string | null;
  /** v4.5 — workspace-relative path to the per-test markdown summary. */
  summary_md_path?: string | null;
}
interface CompletedEvent {
  kind: 'completed';
  runId: string | number;
  passed?: number;
  failed?: number;
  skipped?: number;
  duration_ms?: number;
  /** v4.5 — events the reporter dropped after exhausting retries. */
  dropped_events?: number;
}

type Event = StartedEvent | TestResultEvent | CompletedEvent;

const TEST_STATUS_VALUES = new Set<QaTestStatus>([
  'passed',
  'failed',
  'skipped',
  'timed-out',
  'interrupted',
]);

export function mountQaTestEventRoute(app: Hono, deps: ServerDeps): void {
  const { qaTestRunStore, qaTestResultStore, companyStore } = deps;

  app.post('/api/company/sessions/:id/qa/test-event', async (c) => {
    const sessionId = parseIdParam(c);
    const body = await parseJsonBody<Event>(c);
    const runId = parseRunId(body.runId);
    if (runId === null) return c.json({ error: 'invalid runId' }, 400);

    const run = qaTestRunStore.getRun(runId);
    if (!run) return c.json({ error: 'unknown runId' }, 404);
    if (run.company_session_id !== sessionId) return c.json({ error: 'session mismatch' }, 403);

    // Live orchestrator (if any) — used to republish events on the SSE
    // bus so the dashboard can update without polling. When the
    // orchestrator has been evicted we silently degrade to persistence
    // only; the polling fallback in `useLiveRun` still keeps the UI fresh.
    const orchestrator = orchestratorRegistry.get(sessionId);

    switch (body.kind) {
      case 'started':
        if (orchestrator) {
          busPublish(orchestrator.metaBus, 'qa_run_started', {
            agent_run_id: run.agent_run_id,
            agent_role: run.suite,
            suite: run.suite,
            test_count: typeof (body as StartedEvent).count === 'number' ? (body as StartedEvent).count : undefined,
            trigger: run.trigger,
          });
        }
        return c.json({ ok: true });
      case 'test_result': {
        const ev = body as TestResultEvent;
        const status = normaliseStatus(ev.status);
        if (!status) return c.json({ error: `invalid status "${ev.status}"` }, 400);
        const id = qaTestResultStore.recordResult({
          run_id: runId,
          spec_file: ev.spec ?? 'unknown',
          test_name: ev.name ?? '(anonymous)',
          status,
          duration_ms: typeof ev.duration_ms === 'number' ? ev.duration_ms : null,
          error: ev.error ?? null,
          trace_path: ev.trace_path ?? null,
          screenshot_path: ev.screenshot_path ?? null,
          video_path: ev.video_path ?? null,
          summary_md_path: ev.summary_md_path ?? null,
        });
        if (orchestrator) {
          // Build artifact URLs for the SSE payload using the run's
          // service_id (frontend can render gallery icons live without
          // an extra fetch).
          const artUrl = (path: string | null | undefined) =>
            path
              ? `/api/company/sessions/${sessionId}/qa/artifact?service=${encodeURIComponent(run.service_id)}&path=${encodeURIComponent(path)}`
              : undefined;
          busPublish(orchestrator.metaBus, 'qa_run_test_result', {
            agent_run_id: run.agent_run_id,
            agent_role: run.suite,
            spec: ev.spec ?? 'unknown',
            test_name: ev.name ?? '(anonymous)',
            status,
            duration_ms: typeof ev.duration_ms === 'number' ? ev.duration_ms : undefined,
            error: ev.error ?? undefined,
            trace_url: artUrl(ev.trace_path),
            screenshot_url: artUrl(ev.screenshot_path),
            video_url: artUrl(ev.video_path),
            summary_md_url: artUrl(ev.summary_md_path),
          });
        }
        return c.json({ ok: true, id });
      }
      case 'completed': {
        const ev = body as CompletedEvent;
        const updated = qaTestRunStore.completeRun(runId, {
          status: 'completed',
          passed: ev.passed ?? 0,
          failed: ev.failed ?? 0,
          skipped: ev.skipped ?? 0,
          duration_ms: typeof ev.duration_ms === 'number' ? ev.duration_ms : null,
          last_error:
            typeof ev.dropped_events === 'number' && ev.dropped_events > 0
              ? `Reporter dropped ${ev.dropped_events} event(s) before flush — partial data.`
              : null,
        });

        // v4.5: persist artifacts to host disk so they survive sandbox
        // teardown. Best-effort; never blocks the response.
        if (updated) {
          void persistAndStamp(getSandboxManager(), qaTestRunStore, {
            sessionId,
            runId,
            serviceId: updated.service_id,
          }).catch((err: unknown) => {
            console.warn(
              `[qa-test-event] persistAndStamp failed for run ${runId}: ${(err as Error).message}`,
            );
          });
        }

        // v4.5: kanban-bridge — auto-create bug cards for failures + sync
        // the feature card. Done synchronously so the response payload
        // already carries `kanban_card_id` per failed result. Errors are
        // captured per-result inside the bridge and never bubble up.
        if (updated) {
          runKanbanBridge({
            sessionId,
            run: updated,
            qaResultStore: qaTestResultStore,
            companyStore,
          });
        }

        if (orchestrator && updated) {
          busPublish(orchestrator.metaBus, 'qa_run_completed', {
            agent_run_id: updated.agent_run_id,
            agent_role: updated.suite,
            suite: updated.suite,
            passed: updated.passed,
            failed: updated.failed,
            skipped: updated.skipped,
            duration_ms: updated.duration_ms ?? undefined,
          });
        }
        return c.json({ ok: true, run: updated });
      }
      default:
        return c.json({ error: 'unknown kind' }, 400);
    }
  });
}

function parseRunId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

function normaliseStatus(raw: unknown): QaTestStatus | null {
  if (typeof raw !== 'string') return null;
  const candidate = raw === 'timedOut' ? 'timed-out' : raw;
  return TEST_STATUS_VALUES.has(candidate as QaTestStatus)
    ? (candidate as QaTestStatus)
    : null;
}

/**
 * v4.5 — drive the kanban-bridge from a completed run. Does NOT throw;
 * captures every per-card failure as a console warning. Inlined here
 * (rather than living in a service class) to keep the test-event
 * route's flow obvious.
 */
function runKanbanBridge(opts: {
  sessionId: number;
  run: import('../../../../../../core/qa/types.js').QaRun;
  qaResultStore: import('../../../../../../core/qa/store/interfaces.js').IQaTestResultStore;
  companyStore: import('../../../../../../store/company-store.js').CompanyStore;
}): void {
  const { sessionId, run, qaResultStore, companyStore } = opts;

  const buildEvidenceUrl: EvidenceUrlBuilder = (relPath) =>
    `/api/company/sessions/${sessionId}/qa/artifact?service=${encodeURIComponent(run.service_id)}&path=${encodeURIComponent(relPath)}`;
  const runDetailUrl = `/c/${sessionId}?tab=tests&run=${run.id}`;

  // 1) Bug cards for failed/timed-out/interrupted results.
  try {
    const failures = qaResultStore.listFailures(run.id);
    for (const result of failures) {
      const out = upsertBugCard(
        { companyStore, qaResultStore },
        { sessionId, run, result, buildEvidenceUrl, runDetailUrl },
      );
      for (const w of out.warnings) {
        console.warn(`[qa-kanban-bridge] result ${result.id}: ${w}`);
      }
    }
  } catch (e) {
    console.warn(`[qa-kanban-bridge] listFailures(${run.id}) failed: ${(e as Error).message}`);
  }

  // 2) Sync the feature card status (only when the run knows its target).
  if (run.kanban_feature_card_id != null) {
    try {
      const out = syncFeatureCard(
        { companyStore, qaResultStore },
        {
          featureCardId: run.kanban_feature_card_id,
          run,
          passed: run.passed,
          failed: run.failed,
          runDetailUrl,
        },
      );
      for (const w of out.warnings) {
        console.warn(`[qa-kanban-bridge] feature card ${run.kanban_feature_card_id}: ${w}`);
      }
    } catch (e) {
      console.warn(`[qa-kanban-bridge] syncFeatureCard failed: ${(e as Error).message}`);
    }
  }
}
