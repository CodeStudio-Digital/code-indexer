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
 *                     independent QA-result JSON entities.
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
import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../../deps.js';
import { parseJsonBody, parseSessionIdParam } from '../../_helpers.js';
import { asCompanySessionId, isUuid } from '@mcp/session-storage';
import type { QaTestStatus } from '@mcp/services/qa/types.js';
import { getCompanyOrchestrator } from '../../../../sse/companyOrchestrator.js';
import { publish as busPublish } from '../../../../coder-bus.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import { persistAndStamp } from '@mcp/services/qa/report-persistence.js';
import {
  upsertBugCard,
  syncFeatureCard,
  type EvidenceUrlBuilder,
  type QaKanbanStore,
} from '@mcp/services/qa/kanban-bridge.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { classifyQaFailure } from '@mcp/services/qa/parsers/error-classifier.js';
import {
  SIDECAR_DOWN_THRESHOLD,
  clearSidecarTracker,
  resetSidecarTracker,
  trackSidecarFailure,
} from '@mcp/services/qa/sidecar-down-tracker.js';

interface StartedEvent {
  kind: 'started';
  runId: string;
  count?: number;
}
interface TestResultEvent {
  kind: 'test_result';
  runId: string;
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
  runId: string;
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

export function mountQaTestEventRoute(app: HttpRouter, deps: ServerDeps): void {
  const { qaTestRunStore, qaTestResultStore, sessionStore } = deps;

  app.post('/api/company/sessions/:id/qa/test-event', async (c) => {
    const sessionId = asCompanySessionId(parseSessionIdParam(c));
    const body = await parseJsonBody<Event>(c);
    const runId = parseRunId(body.runId);
    if (runId === null) return c.json({ error: 'invalid runId' }, 400);

    const run = await qaTestRunStore.getRun(runId);
    if (!run) return c.json({ error: 'unknown runId' }, 404);
    if (run.company_session_id !== sessionId) return c.json({ error: 'session mismatch' }, 403);

    // B7 — every reporter event counts as PROGRESS: stamp last_event_at
    // so the adaptive watchdog resets its clock (no-op once the run left
    // `running`). Best-effort — a store hiccup must not block the suite.
    try {
      await qaTestRunStore.touchLastEvent(runId);
    } catch (e) {
      console.warn(`[qa-test-event] touchLastEvent(${runId}) failed: ${(e as Error).message}`);
    }

    // Live orchestrator (if any) — used to republish events on the SSE
    // bus so the dashboard can update without polling. When the
    // orchestrator has been evicted we silently degrade to persistence
    // only; the polling fallback in `useLiveRun` still keeps the UI fresh.
    const orchestrator = getCompanyOrchestrator(sessionId);

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
        const id = await qaTestResultStore.recordResult({
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

        // B7 — dead-sidecar detection: 2 CONSECUTIVE spec failures whose
        // message classifies as `sidecar_down` ⇒ the shared browser is
        // gone; complete the run early instead of letting every
        // remaining spec fail one by one for 10+ minutes.
        const isFailure =
          status === 'failed' || status === 'timed-out' || status === 'interrupted';
        const failureClass = isFailure ? classifyQaFailure(ev.error) : null;
        if (failureClass === 'sidecar_down') {
          const streak = trackSidecarFailure(runId);
          if (streak >= SIDECAR_DOWN_THRESHOLD) {
            const terminated = await completeRunSidecarDown({
              sessionId,
              runId,
              qaTestRunStore,
              qaTestResultStore,
              orchestrator,
            });
            clearSidecarTracker(runId);
            return c.json({ ok: true, id, terminated: terminated ? 'sidecar_down' : undefined });
          }
        } else {
          resetSidecarTracker(runId);
        }
        return c.json({ ok: true, id });
      }
      case 'completed': {
        const ev = body as CompletedEvent;
        // B7 — run over; drop any sidecar-down streak state for it.
        clearSidecarTracker(runId);
        const updated = await qaTestRunStore.completeRun(runId, {
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
          await runKanbanBridge({
            sessionId,
            run: updated,
            qaResultStore: qaTestResultStore,
            companyStore: createQaKanbanStore(sessionId, sessionStore),
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

function parseRunId(raw: unknown): string | null {
  return typeof raw === 'string' && isUuid(raw)
    ? raw.toLowerCase()
    : null;
}

function normaliseStatus(raw: unknown): QaTestStatus | null {
  if (typeof raw !== 'string') return null;
  const candidate = raw === 'timedOut' ? 'timed-out' : raw;
  return TEST_STATUS_VALUES.has(candidate as QaTestStatus)
    ? (candidate as QaTestStatus)
    : null;
}

/**
 * B7 — complete a run EARLY because the shared Chrome Service died mid-
 * suite (2 consecutive `sidecar_down` spec failures). Counts are
 * recomputed from the results already streamed in; the same
 * `qa_run_completed` bus event the UI already consumes is published so
 * the Tests tab flips from spinner to error without polling. Artifacts
 * are persisted best-effort like the normal completion path. Returns
 * true when the run actually transitioned (idempotent under races —
 * `completeRun` is a no-op once the run left `running`).
 */
async function completeRunSidecarDown(opts: {
  sessionId: string;
  runId: string;
  qaTestRunStore: ServerDeps['qaTestRunStore'];
  qaTestResultStore: ServerDeps['qaTestResultStore'];
  orchestrator: ReturnType<typeof getCompanyOrchestrator>;
}): Promise<boolean> {
  const { sessionId, runId, qaTestRunStore, qaTestResultStore, orchestrator } = opts;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  try {
    for (const r of await qaTestResultStore.listResults(runId)) {
      if (r.status === 'passed') passed++;
      else if (r.status === 'skipped') skipped++;
      else failed++;
    }
  } catch {
    /* keep zeros — counts are informative here */
  }
  const updated = await qaTestRunStore.completeRun(runId, {
    status: 'error',
    passed,
    failed,
    skipped,
    duration_ms: null,
    last_error:
      'Chrome Service connection lost mid-run (2+ consecutive specs failed with browser-connection errors). Remaining specs were not executed.',
    error_class: 'sidecar_down',
  });
  if (!updated || updated.status !== 'error') return false;

  void persistAndStamp(getSandboxManager(), qaTestRunStore, {
    sessionId,
    runId,
    serviceId: updated.service_id,
  }).catch((err: unknown) => {
    console.warn(
      `[qa-test-event] persistAndStamp (sidecar_down) failed for run ${runId}: ${(err as Error).message}`,
    );
  });

  if (orchestrator) {
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
  console.warn(
    `[qa-test-event] run ${runId} completed early: error_class=sidecar_down (Chrome Service unreachable mid-run).`,
  );
  return true;
}

/**
 * v4.5 — drive the kanban-bridge from a completed run. Does NOT throw;
 * captures every per-card failure as a console warning. Inlined here
 * (rather than living in a service class) to keep the test-event
 * route's flow obvious.
 */
async function runKanbanBridge(opts: {
  sessionId: string;
  run: import('@mcp/services/qa/types.js').QaRun;
  qaResultStore: import('@mcp/services/qa/store/interfaces.js').IQaTestResultStore;
  companyStore: QaKanbanStore;
}): Promise<void> {
  const { sessionId, run, qaResultStore, companyStore } = opts;

  const buildEvidenceUrl: EvidenceUrlBuilder = (relPath) =>
    `/api/company/sessions/${sessionId}/qa/artifact?service=${encodeURIComponent(run.service_id)}&path=${encodeURIComponent(relPath)}`;
  const runDetailUrl = `/c/${sessionId}?tab=tests&run=${run.id}`;

  // 1) Bug cards for failed/timed-out/interrupted results.
  try {
    const failures = await qaResultStore.listFailures(run.id);
    for (const result of failures) {
      const out = await upsertBugCard(
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
      const out = await syncFeatureCard(
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

function createQaKanbanStore(
  sessionId: string,
  sessionStore: FsSessionStore,
): QaKanbanStore {
  const files = new CompanySessionFiles({
    companySessionId: sessionId,
    sessionStore,
  });
  const mutate = <T>(operation: () => T): Promise<T> =>
    sessionStore.runSessionMutation(sessionId, async () => operation());
  return {
    createKanbanCard: (_companySessionId, input) =>
      mutate(() =>
        files.createKanbanCardSync({
          ...input,
          createdBy: input.created_by,
        }),
      ),
    getKanbanCard: (cardId) => files.getKanbanCardFullSync(cardId),
    addKanbanComment: (cardId, authorRole, agentRunId, content) =>
      mutate(() =>
        files.addKanbanCommentSync(
          cardId,
          authorRole,
          agentRunId,
          content,
        ),
      ),
    addCardDependency: (cardId, dependsOnId) =>
      mutate(() =>
        files.addKanbanDependencySync(cardId, dependsOnId),
      ),
    moveKanbanCard: (cardId, column) =>
      mutate(() => {
        const card = files.moveKanbanCardSync(cardId, column);
        if (!card) throw new Error(`Unknown Company kanban card ${cardId}`);
        return card;
      }),
  };
}
