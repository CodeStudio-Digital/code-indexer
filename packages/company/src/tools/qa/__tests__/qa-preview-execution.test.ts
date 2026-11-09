import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { QaTestRunStore } from '@mcp/services/qa/store/qa-test-run-store.js';
import { QaTestResultStore } from '@mcp/services/qa/store/qa-test-result-store.js';
import { setGlobalPreviewDevtools } from '@mcp/code-agent/tools/preview/bridge.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CompanyOrchestratorPort } from '@mcp/company/orchestrator-port.js';
import { qaStartRun, setQaTestRunStore } from '../qa-start-run.js';
import { qaCheckPreview } from '../qa-check-preview.js';
import { qaPublishResult } from '../qa-publish-result.js';
import { parsePreviewCriteria, previewAssertionScript } from '../qa-preview-input.js';

describe('preview QA durable execution', () => {
  let directory: string;
  let sessions: FsSessionStore;
  let runs: QaTestRunStore;
  let results: QaTestResultStore;
  let orchestrator: CompanyOrchestratorPort;
  let ctx: ToolContext;
  const invoke = vi.fn();
  const publish = vi.fn();
  const move = vi.fn();
  const taskId = '00000000-0000-4000-8000-000000000042';
  const target = 'http://localhost:5173/login';
  const criteria = [{ name: 'Login shown', selector: 'h1', text: 'Login' }];

  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await mkdtemp(join(tmpdir(), 'qa-preview-proof-'));
    sessions = FsSessionStore.fromRoots({ dataDir: directory, projectRootResolver: { resolveProjectRoot: () => null, listProjectRoots: () => [] } });
    const created = await sessions.repository.createSession({ kind: 'company', scope: { kind: 'global' }, title: 'QA fixture', status: 'idle' });
    await sessions.refresh();
    runs = new QaTestRunStore(sessions);
    results = new QaTestResultStore(sessions);
    setQaTestRunStore(runs, results);
    move.mockImplementation((_id, column) => ({ id: taskId, column }));
    orchestrator = { companySessionId: created.session.id, getSessionConfigJson: () => '{}', hasApprovedPlan: () => null,
      publishQaResult: publish, kanbanGetCard: () => ({ id: taskId, column: 'review' }), kanbanMoveCard: move,
      kanbanAddComment: vi.fn(), kanbanCreateCard: () => ({ id: taskId }), kanbanAddDependency: vi.fn() } as unknown as CompanyOrchestratorPort;
    ctx = { cwd: directory, projectName: 'fixture', companyContext: { companySessionId: created.session.id } } as unknown as ToolContext;
    invoke.mockImplementation(async ({ method }) => {
      if (method === 'eval') return { value: { url: target, title: 'Login', checks: [{ name: 'Login shown', passed: true, observed: ['Login'] }] } };
      if (method === 'screenshot') return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=' };
      return { ok: true };
    });
    setGlobalPreviewDevtools({ invoke, cancel: vi.fn() });
  });
  afterEach(async () => {
    setGlobalPreviewDevtools(null); setQaTestRunStore(null);
    runs?.close(); results?.close(); await sessions?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function start() {
    const reply = await qaStartRun(orchestrator, 'master', null).handler({ suite: 'Login', target_url: target, criteria, kanban_feature_card_id: taskId }, ctx);
    expect(reply.isError, reply.content).not.toBe(true);
    return (reply.structuredData as { run_id: string }).run_id;
  }

  it('uses native preview by default, persists real artifacts/results, updates task, and survives store recreation', async () => {
    const id = await start();
    expect(await runs.getRun(id)).toMatchObject({ executor: 'preview', company_session_id: orchestrator.companySessionId, target_url: target, criteria: [{ ...criteria[0], visible: true }] });
    const reply = await qaCheckPreview(orchestrator, 'master', null).handler({ run_id: id }, ctx);
    expect(reply.isError, reply.content).not.toBe(true);
    const run = await runs.getRun(id);
    expect(run).toMatchObject({ status: 'completed', passed: 1, failed: 0 });
    const evidence = JSON.parse(await readFile(join(run!.report_persisted_path!, 'test-results/preview/evidence.json'), 'utf8'));
    expect(evidence).toMatchObject({ runId: id, sessionId: orchestrator.companySessionId, taskId, executor: 'preview' });
    expect((await readFile(join(run!.report_persisted_path!, 'test-results/preview/screenshot.png'))).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(await results.listResults(id)).toHaveLength(1);
    expect(move).toHaveBeenCalledWith(taskId, 'done');
    const reopened = new QaTestRunStore(sessions);
    expect(await reopened.getRun(id)).toMatchObject({ executor: 'preview', passed: 1 }); reopened.close();
    const before = invoke.mock.calls.length;
    await qaCheckPreview(orchestrator, 'master', null).handler({ run_id: id }, ctx);
    expect(invoke).toHaveBeenCalledTimes(before);
    const republished = await qaPublishResult(orchestrator, 'master', null).handler({ run_id: id, passed: 999 }, ctx);
    expect(republished.isError, republished.content).not.toBe(true);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ passed: 1 }));
  });

  it('rejects self-reported success without an executed, completed run', async () => {
    const noRun = await qaPublishResult(orchestrator, 'master', null).handler({ suite: 'fake', passed: 9, failed: 0 }, ctx);
    expect(noRun.isError).toBe(true);
    const id = await start();
    const running = await qaPublishResult(orchestrator, 'master', null).handler({ run_id: id }, ctx);
    expect(running.isError).toBe(true); expect(publish).not.toHaveBeenCalled();
  });

  it('does not execute or publish a run from another session', async () => {
    const id = await start();
    const foreign = { ...orchestrator, companySessionId: '00000000-0000-4000-8000-000000000099' } as CompanyOrchestratorPort;
    expect((await qaCheckPreview(foreign, 'master', null).handler({ run_id: id }, ctx)).isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  });

  it('preserves an ambiguous preview effect and never automatically retries it', async () => {
    const id = await start(); invoke.mockRejectedValueOnce(new Error('transport disconnected after dispatch'));
    const reply = await qaCheckPreview(orchestrator, 'master', null).handler({ run_id: id }, ctx);
    expect(reply.effectOutcome).toBe('unknown');
    expect(await runs.getRun(id)).toMatchObject({ status: 'error', passed: 0 });
    await qaCheckPreview(orchestrator, 'master', null).handler({ run_id: id }, ctx);
    expect(invoke).toHaveBeenCalledTimes(1); expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a wrong target or missing image instead of marking success', async () => {
    const id = await start();
    invoke.mockImplementation(async ({ method }) => method === 'eval' ? { value: { url: 'http://localhost:5173/wrong', checks: [{ name: 'Login shown', passed: true }] } } : { ok: true });
    expect((await qaCheckPreview(orchestrator, 'master', null).handler({ run_id: id, navigate: false }, ctx)).isError).toBe(true);
    expect(await runs.getRun(id)).toMatchObject({ status: 'error', passed: 0 });
    expect(move).not.toHaveBeenCalled();
  });

  it('files failed criteria and returns a red feature to in_progress', async () => {
    const id = await start();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (req) => req.method === 'eval' ? { value: { url: target, checks: [{ name: 'Login shown', passed: false }] } } : original(req));
    const reply = await qaCheckPreview(orchestrator, 'master', null).handler({ run_id: id }, ctx);
    expect(reply.isError, reply.content).not.toBe(true);
    expect(await runs.getRun(id)).toMatchObject({ failed: 1, passed: 0 });
    expect(move).toHaveBeenCalledWith(taskId, 'in_progress');
    expect((await results.listFailures(id))[0].kanban_card_id).toBe(taskId);
  });
});

it('evaluates real DOM criteria and treats strings as data, not executable input', () => {
  const criteria = parsePreviewCriteria([{ name: 'visible login', selector: 'h1', text: 'Login' }, { name: 'no error', selector: '.error', visible: false }, { name: 'missing', selector: '.missing' }]);
  const element = { innerText: 'Login', getClientRects: () => [{}] };
  const result = runInNewContext(previewAssertionScript(criteria), { location: { href: 'http://localhost/' }, document: { title: 'App', querySelectorAll: (selector: string) => selector === 'h1' ? [element] : [] }, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) });
  expect(result.checks.map((check: { passed: boolean }) => check.passed)).toEqual([true, true, false]);
  expect(() => parsePreviewCriteria([{ name: 'x', selector: 'x', visible: 'yes' }])).toThrow('boolean');
});
