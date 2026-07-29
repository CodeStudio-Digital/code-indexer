import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import { QaTestRunStore } from '@mcp/services/qa/store/qa-test-run-store.js';
import { QaTestResultStore } from '@mcp/services/qa/store/qa-test-result-store.js';
import {
  CompanySessionRepository,
  asCompanySessionId,
  type CompanySessionId,
} from '@mcp/session-storage';

describe('filesystem QA stores', () => {
  let temporaryRoot: string;
  let dataDir: string;
  let projectRoot: string;
  let sessionStore: FsSessionStore;
  let firstSessionId: CompanySessionId;
  let secondSessionId: CompanySessionId;
  let firstBundle: string;
  let runs: QaTestRunStore;
  let results: QaTestResultStore;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-fs-qa-'));
    dataDir = join(temporaryRoot, 'data');
    projectRoot = join(temporaryRoot, 'project');
    await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
    sessionStore = FsSessionStore.fromRoots({
      dataDir,
      projectRootResolver: {
        resolveProjectRoot: (projectId) =>
          projectId === 1 ? projectRoot : null,
        listProjectRoots: () => [
          { project_id: 1, root_path: projectRoot },
        ],
      },
    });
    const first = await sessionStore.repository.createSession({
      kind: 'company',
      scope: { kind: 'project', project_id: 1 },
      owner_project_id: 1,
      linked_projects: [{ project_id: 1, root_path: projectRoot }],
      title: 'Company one',
      status: 'idle',
    });
    const second = await sessionStore.repository.createSession({
      kind: 'company',
      scope: { kind: 'project', project_id: 1 },
      owner_project_id: 1,
      linked_projects: [{ project_id: 1, root_path: projectRoot }],
      title: 'Company two',
      status: 'idle',
    });
    await sessionStore.refresh();
    firstSessionId = asCompanySessionId(String(first.session.id));
    secondSessionId = asCompanySessionId(String(second.session.id));
    firstBundle = first.location.bundle_path;
    runs = new QaTestRunStore(sessionStore);
    results = new QaTestResultStore(sessionStore);
  });

  afterEach(async () => {
    runs.close();
    results.close();
    await sessionStore.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('persists UUID runs as independent JSON files with bundle-local seq', async () => {
    const first = await runs.startRun({
      company_session_id: firstSessionId,
      agent_run_id: null,
      suite: 'login',
      trigger: 'agent',
    });
    const second = await runs.startRun({
      company_session_id: firstSessionId,
      agent_run_id: null,
      suite: 'checkout',
      trigger: 'human',
    });

    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(second).toMatchObject({
      status: 'running',
      passed: 0,
      failed: 0,
      skipped: 0,
      completed_at: null,
    });
    expect(
      (await readdir(join(firstBundle, 'company', 'qa-runs'))).sort(),
    ).toEqual([`${first.id}.json`, `${second.id}.json`].sort());
  });

  it('serializes concurrent starts in one session and isolates other sessions', async () => {
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        runs.startRun({
          company_session_id: firstSessionId,
          agent_run_id: null,
          suite: `suite-${index}`,
          trigger: 'agent',
        }),
      ),
    );
    await runs.startRun({
      company_session_id: secondSessionId,
      agent_run_id: null,
      suite: 'other',
      trigger: 'agent',
    });

    expect(new Set(created.map((run) => run.id)).size).toBe(12);
    expect(created.map((run) => run.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(
      await runs.listRuns({ company_session_id: firstSessionId }),
    ).toHaveLength(12);
    expect(
      await runs.listRuns({ company_session_id: secondSessionId }),
    ).toHaveLength(1);
  });

  it('freezes the first terminal transition and recovers running runs', async () => {
    const completed = await runs.startRun({
      company_session_id: firstSessionId,
      agent_run_id: null,
      suite: 'done',
      trigger: 'agent',
    });
    const first = await runs.completeRun(completed.id, {
      status: 'completed',
      passed: 4,
      failed: 1,
      skipped: 0,
      duration_ms: 1234,
    });
    const replay = await runs.completeRun(completed.id, {
      status: 'aborted',
      passed: 99,
      failed: 99,
      skipped: 99,
      duration_ms: 9,
    });
    await runs.startRun({
      company_session_id: secondSessionId,
      agent_run_id: null,
      suite: 'interrupted',
      trigger: 'agent',
    });

    expect(replay).toMatchObject({
      status: 'completed',
      passed: 4,
      completed_at: first?.completed_at,
    });
    await expect(runs.recoverStaleRuns()).resolves.toEqual({ recovered: 1 });
    await expect(runs.recoverStaleRuns()).resolves.toEqual({ recovered: 0 });
  });

  it('records one result JSON per test and preserves insertion order', async () => {
    const run = await runs.startRun({
      company_session_id: firstSessionId,
      agent_run_id: null,
      suite: 'login',
      trigger: 'agent',
    });
    const passedId = await results.recordResult({
      run_id: run.id,
      spec_file: 'login.spec.ts',
      test_name: 'valid login',
      status: 'passed',
      duration_ms: 10,
      error: null,
      trace_path: null,
    });
    const failedId = await results.recordResult({
      run_id: run.id,
      spec_file: 'login.spec.ts',
      test_name: 'wrong password',
      status: 'failed',
      duration_ms: 20,
      error: 'toast missing',
      trace_path: 'test-results/trace.zip',
      summary_md_path: 'test-results/summary.md',
    });

    const rows = await results.listResults(run.id);
    expect(rows.map((row) => row.id)).toEqual([passedId, failedId]);
    expect((await results.listFailures(run.id)).map((row) => row.id))
      .toEqual([failedId]);
    expect(rows[1]).toMatchObject({
      error: 'toast missing',
      summary_md_path: 'test-results/summary.md',
    });
    expect(
      (await readdir(join(firstBundle, 'company', 'qa-results'))).sort(),
    ).toEqual([`${passedId}.json`, `${failedId}.json`].sort());
  });

  it('links a failed result to a UUID Kanban card without shared files', async () => {
    const run = await runs.startRun({
      company_session_id: firstSessionId,
      agent_run_id: null,
      suite: 'login',
      trigger: 'agent',
    });
    const resultId = await results.recordResult({
      run_id: run.id,
      spec_file: 'login.spec.ts',
      test_name: 'fails',
      status: 'failed',
      duration_ms: 1,
      error: 'broken',
      trace_path: null,
    });
    const cardId = '00000000-0000-4000-8000-000000000501';
    await results.setKanbanCardId(resultId, cardId);

    await expect(
      results.findRecentResultByName({
        spec_file: 'login.spec.ts',
        test_name: 'fails',
      }),
    ).resolves.toMatchObject({
      id: resultId,
      kanban_card_id: cardId,
    });
  });

  it('stores report artifacts only inside the owning bundle', async () => {
    const run = await runs.startRun({
      company_session_id: firstSessionId,
      agent_run_id: null,
      suite: 'artifacts',
      trigger: 'agent',
    });
    let directory = '';
    await runs.withRunArtifactDirectory(
      firstSessionId,
      run.id,
      async (absoluteDirectory) => {
        directory = absoluteDirectory;
        await stat(absoluteDirectory);
      },
    );

    expect(directory).toBe(
      join(firstBundle, 'company', 'qa-artifacts', run.id),
    );
    await runs.setReportPersistedPath(run.id, directory);
    await expect(runs.getRun(run.id)).resolves.toMatchObject({
      report_persisted_path: directory,
    });
  });

  it('fails closed for an unknown Company root and cross-session artifact write', async () => {
    await expect(
      runs.startRun({
        company_session_id: '00000000-0000-4000-8000-000000000999',
        agent_run_id: null,
        suite: 'missing',
        trigger: 'agent',
      }),
    ).rejects.toThrow('no SQLite fallback');

    const run = await runs.startRun({
      company_session_id: firstSessionId,
      agent_run_id: null,
      suite: 'owned',
      trigger: 'agent',
    });
    await expect(
      runs.withRunArtifactDirectory(
        secondSessionId,
        run.id,
        async () => undefined,
      ),
    ).rejects.toThrow('does not belong');
  });

  it('detects stale runs only when no result exists', async () => {
    const silent = await runs.startRun({
      company_session_id: firstSessionId,
      agent_run_id: null,
      suite: 'silent',
      trigger: 'agent',
    });
    const alive = await runs.startRun({
      company_session_id: firstSessionId,
      agent_run_id: null,
      suite: 'alive',
      trigger: 'agent',
    });
    await results.recordResult({
      run_id: alive.id,
      spec_file: 'alive.spec.ts',
      test_name: 'heartbeat',
      status: 'passed',
      duration_ms: 1,
      error: null,
      trace_path: null,
    });

    expect((await runs.findStaleRunningRuns(0)).map((run) => run.id))
      .toContain(silent.id);
    expect((await runs.findStaleRunningRuns(0)).map((run) => run.id))
      .not.toContain(alive.id);
  });

  it('round-trips watchdog metadata from the run entity', async () => {
    const run = await runs.startRun({
      company_session_id: firstSessionId,
      agent_run_id: null,
      suite: 'watchdog',
      trigger: 'agent',
    });
    await runs.completeRun(run.id, {
      status: 'error',
      passed: 0,
      failed: 0,
      skipped: 0,
      duration_ms: null,
      last_error:
        'No events received from reporter — check reporter wiring',
      error_class: 'orphan',
    });

    await expect(
      runs.countWatchdogKills({
        company_session_id: firstSessionId,
        windowMs: 60_000,
      }),
    ).resolves.toBe(1);
  });

  it('persists relation UUIDs in the entity envelope', async () => {
    const run = await runs.startRun({
      company_session_id: firstSessionId,
      agent_run_id: null,
      suite: 'relation',
      trigger: 'agent',
    });
    const resultId = await results.recordResult({
      run_id: run.id,
      spec_file: 'relation.spec.ts',
      test_name: 'relation',
      status: 'passed',
      duration_ms: 1,
      error: null,
      trace_path: null,
    });
    const repository = new CompanySessionRepository({
      sessionRoot: firstBundle,
    });
    await expect(repository.get('qaResult', resultId)).resolves.toMatchObject({
      relations: { run_id: run.id },
      data: { run_id: run.id },
    });
  });
});
