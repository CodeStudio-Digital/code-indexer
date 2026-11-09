import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/agent-runtime-host/tool-result.js';
import { okStructured } from '@mcp/code-agent/core/model-output.js';
import { invokePreview } from '@mcp/code-agent/tools/preview/bridge.js';
import { previewFailure } from '@mcp/code-agent/tools/preview/failure.js';
import type { CompanyOrchestratorPort } from '@mcp/company/orchestrator-port.js';
import { upsertBugCard, syncFeatureCard, type QaKanbanStore } from '@mcp/services/qa/kanban-bridge.js';
import { getQaStores } from './qa-start-run.js';
import { parsePreviewCriteria, parsePreviewTarget, previewAssertionScript } from './qa-preview-input.js';

const activeChecks = new Set<string>();
type Observation = { url: string; title: string; checks: Array<{ name: string; passed: boolean; error?: string; observed?: string[] }> };

function checkedResponse(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('Preview returned no evidence');
  const data = value as Record<string, unknown>;
  if (typeof data.error === 'string') throw new Error(data.error);
  return data;
}

export function qaCheckPreview(orchestrator: CompanyOrchestratorPort, agentRole: string, agentRunId: string | null): CoderTool {
  return {
    name: 'qa_check_preview', source: 'native', effectBoundary: 'control', mutates: true,
    parallelSafe: false, riskLevel: 'execute', timeoutMs: 180_000,
    description: 'Execute the criteria of a persisted preview QA run against the real page. Saves screenshot, DOM assertions, console and network evidence; derives verdicts and updates history/Kanban. Idempotent after completion. Set navigate=false after using preview tools for a stateful flow; current page must match target_url.',
    parameters: { type: 'object', properties: { run_id: { type: 'string' }, navigate: { type: 'boolean', description: 'Open target first (default true). False preserves a stateful flow.' } }, required: ['run_id'], additionalProperties: false },
    handler: async (args, ctx) => {
      const { runStore, resultStore } = getQaStores();
      if (!runStore || !resultStore) return err('QA persistence is unavailable');
      const runId = String(args.run_id ?? '');
      if (activeChecks.has(runId)) return err('This QA run is already executing. Wait for its result.');
      let ownsRun = false;
      try {
        const run = await runStore.getRun(runId);
        if (!run || run.company_session_id !== orchestrator.companySessionId) return err('QA run does not belong to this session');
        if (agentRunId !== run.agent_run_id) return err('QA run belongs to a different agent; start your own run');
        if (run.executor !== 'preview') return err('This is a Playwright run; use its reporter');
        if (run.status !== 'running') return okStructured({ run_id: run.id, status: run.status, passed: run.passed, failed: run.failed, last_error: run.last_error, reused: true });
        const target = parsePreviewTarget(run.target_url);
        const criteria = parsePreviewCriteria(run.criteria);
        activeChecks.add(runId);
        ownsRun = true;
        await runStore.touchLastEvent(runId);
        // Preview calls retain the harness mutation fence, cancellation and
        // outcome-unknown classification. Never replay an ambiguous action.
        if (args.navigate !== false) checkedResponse(await invokePreview(ctx, 'open', { url: target }));
        const evaluation = checkedResponse(await invokePreview(ctx, 'eval', { js: previewAssertionScript(criteria) }));
        const observation = evaluation.value as Observation | undefined;
        if (!observation || !Array.isArray(observation.checks) || observation.checks.length !== criteria.length) throw new Error('Preview did not return all criterion observations');
        const actual = new URL(observation.url);
        const expected = new URL(target);
        if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.search !== expected.search || actual.hash !== expected.hash) {
          throw new Error(`Preview target changed (${actual.href}); start a run with the actual acceptance target`);
        }
        if (observation.checks.some((check, i) => check.name !== criteria[i]?.name || typeof check.passed !== 'boolean')) throw new Error('Invalid criterion evidence');
        const consoleEvidence = checkedResponse(await invokePreview(ctx, 'console', { level: 'all', limit: 250 }));
        const networkEvidence = checkedResponse(await invokePreview(ctx, 'network', { limit: 250, includeBody: false }));
        const screenshot = checkedResponse(await invokePreview(ctx, 'screenshot', { fullPage: false }));
        if (typeof screenshot.base64 !== 'string' || !screenshot.base64.startsWith('iVBORw0KGgo')) throw new Error('Preview returned no valid PNG evidence');
        const summaryPath = 'test-results/preview/summary.md';
        const evidencePath = 'test-results/preview/evidence.json';
        const screenshotPath = 'test-results/preview/screenshot.png';
        const persistedPath = await runStore.withRunArtifactDirectory(run.company_session_id, runId, async (directory) => {
          await mkdir(join(directory, 'test-results', 'preview'), { recursive: true });
          await writeFile(join(directory, evidencePath), JSON.stringify({ runId, sessionId: run.company_session_id, taskId: run.kanban_feature_card_id,
            executor: 'preview', target, criteria, capturedAt: new Date().toISOString(), observation, console: consoleEvidence, network: networkEvidence }, null, 2), { flag: 'wx' });
          await writeFile(join(directory, summaryPath), `# Preview QA\n\nRun: ${runId}\n\nTarget: ${target}\n\n${observation.checks.map((check) => `- ${check.passed ? 'PASS' : 'FAIL'}: ${check.name}${check.error ? ` — ${check.error}` : ''}`).join('\n')}\n\nDetailed DOM, console and network observations: evidence.json.\n`, { flag: 'wx' });
          await writeFile(join(directory, screenshotPath), Buffer.from(screenshot.base64 as string, 'base64'), { flag: 'wx' });
          return directory;
        });
        await runStore.setReportPersistedPath(runId, persistedPath);
        for (const check of observation.checks) {
          await resultStore.recordResult({ run_id: runId, spec_file: `preview:${target}`, test_name: check.name,
            status: check.passed ? 'passed' : 'failed', duration_ms: null,
            error: check.passed ? null : check.error ?? 'The observed page did not meet this acceptance criterion',
            trace_path: null, screenshot_path: screenshotPath, summary_md_path: summaryPath });
        }
        const passed = observation.checks.filter((check) => check.passed).length;
        const completed = await runStore.completeRun(runId, { status: 'completed', passed, failed: criteria.length - passed, skipped: 0,
          duration_ms: Math.max(0, Date.now() - Date.parse(run.started_at)) });
        if (!completed || completed.status !== 'completed') throw new Error('QA run was aborted before its evidence could be finalized');
        const warnings: string[] = [];
        const companyStore: QaKanbanStore = {
          createKanbanCard: (_session, input) => orchestrator.kanbanCreateCard(input),
          getKanbanCard: (id) => orchestrator.kanbanGetCard(id),
          addKanbanComment: (...values) => orchestrator.kanbanAddComment(...values),
          addCardDependency: (id, dependency) => orchestrator.kanbanAddDependency(id, dependency),
          moveKanbanCard: (id, column) => orchestrator.kanbanMoveCard(id, column),
        };
        const buildEvidenceUrl = (path: string) => `/api/company/sessions/${run.company_session_id}/qa/artifact?run=${runId}&path=${encodeURIComponent(path)}`;
        for (const result of await resultStore.listFailures(runId)) {
          const outcome = await upsertBugCard({ companyStore, qaResultStore: resultStore }, { sessionId: run.company_session_id, run: completed, result, buildEvidenceUrl });
          warnings.push(...outcome.warnings);
        }
        if (run.kanban_feature_card_id) {
          const outcome = await syncFeatureCard({ companyStore, qaResultStore: resultStore }, { featureCardId: run.kanban_feature_card_id,
            run: completed, passed: completed.passed, failed: completed.failed });
          warnings.push(...outcome.warnings);
        }
        orchestrator.publishQaResult({ agent_run_id: agentRunId, agent_role: agentRole, suite: run.suite,
          passed: completed.passed, failed: completed.failed, skipped: 0, duration_ms: completed.duration_ms ?? undefined });
        return okStructured({ run_id: runId, status: completed.status, passed: completed.passed, failed: completed.failed,
          evidence_url: buildEvidenceUrl(evidencePath), summary_url: buildEvidenceUrl(summaryPath), screenshot_url: buildEvidenceUrl(screenshotPath), warnings });
      } catch (error) {
        if (ownsRun) await runStore.completeRun(runId, { status: 'error', passed: 0, failed: 0, skipped: 0, duration_ms: null,
          error_class: 'driver_error', last_error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
        return previewFailure(error);
      } finally { if (ownsRun) activeChecks.delete(runId); }
    },
  };
}
