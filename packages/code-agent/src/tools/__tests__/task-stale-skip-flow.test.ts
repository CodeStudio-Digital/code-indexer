/**
 * PR-D end-to-end skip-stale flow through execute_tasks.
 *
 * Each test sets up a fake "previous successful run" by mocking
 * `findLastCompletedTaskItem` on the filesystem session store, then invokes
 * execute_tasks and asserts:
 *   - skip path: runSubagent never called, task_finished status='skipped',
 *     skip_reason='inputs_unchanged' persisted.
 *   - bypass paths: env override, force_run flag, missing files,
 *     mismatched fingerprint all run normally.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CoderTask, TasksState } from '@mcp/code-agent/sessions/types.js';
import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/index.js';
import { newSessionId } from '@mcp/session-storage';
import { computeTaskFingerprint } from '../execute-tasks/task-stale-check.js';
import { SYSTEM_PROMPT_VERSION } from '@mcp/code-agent/core/runner/assembly/system-prompt.js';

vi.mock('../implement-subagent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../implement-subagent.js')>();
  return {
    ...actual,
    runSubagent: vi.fn(),
    runParallelAgents: vi.fn(),
  };
});

const { buildExecuteTasksTool } = await import('../execute-tasks.js');
const { runSubagent } = await import('../implement-subagent.js');
const SESSION_ID = newSessionId();

function task(overrides: Partial<CoderTask> = {}): CoderTask {
  return {
    id: 'tsk_one', title: 'A', description: 'desc',
    files: ['src/a.ts'], references: [], depends_on: [],
    suggested_mode: 'subagent', estimated_complexity: 'medium',
    kind: 'implement', status: 'pending',
    ...overrides,
  };
}

function makeMockStore(staleHit: string | null = null) {
  return {
    createTaskRun: vi.fn(),
    updateTaskRun: vi.fn(),
    upsertTaskRunItem: vi.fn(),
    getTaskRun: vi.fn(),
    listTaskRunsBySession: vi.fn(),
    listTaskRunItems: vi.fn(),
    getTaskRunWithItems: vi.fn(),
    recoverRunningTaskRuns: vi.fn(),
    findLastCompletedTaskItem: vi.fn(async () =>
      staleHit ? { task_id: 'tsk_one', status: 'done', inputs_fingerprint: staleHit } : null,
    ),
  };
}

let dir: string;

beforeEach(() => {
  vi.mocked(runSubagent).mockReset();
  vi.stubEnv('CODER_TASK_MAX_RETRIES', '0');
  dir = mkdtempSync(join(tmpdir(), 'task-stale-flow-'));
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function setupCtx(t: CoderTask, store: ReturnType<typeof makeMockStore>) {
  const runner = {
    emit: vi.fn(),
    sessionId: SESSION_ID,
    agentLoopV2: false,
  };
  const state: TasksState = {
    summary: '', tasks: [t], execution_mode: 'all-subagent',
    approved: true, current_task_id: null,
  };
  const ctx = {
    cwd: dir, projectName: 'test', runner,
    getTasksState: () => state,
    updateTaskStatus: vi.fn(),
    reportProgress: vi.fn(),
  } as unknown as ToolContext;
  const tool = buildExecuteTasksTool({
    provider: {} as never,
    parentTools: [],
    sessionStore: store as unknown as FsSessionStore,
  });
  return { tool, ctx, runner };
}

describe('execute_tasks skip-stale integration', () => {
  it('skips when last fingerprint matches current inputs', async () => {
    const t = task({ files: ['a.ts'] });
    const expected = computeTaskFingerprint({ task: t, cwd: dir, systemPromptVersion: SYSTEM_PROMPT_VERSION });
    const store = makeMockStore(expected);
    const { tool, ctx, runner } = setupCtx(t, store);

    const result = await tool.handler({}, ctx);
    expect(result.isError).toBeFalsy();
    expect(runSubagent).not.toHaveBeenCalled();
    expect(runner.emit).toHaveBeenCalledWith(
      'task_finished',
      expect.objectContaining({ task_id: 'tsk_one', status: 'skipped' }),
    );
    expect(store.upsertTaskRunItem).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 'tsk_one',
        status: 'skipped',
        skip_reason: 'inputs_unchanged',
        inputs_fingerprint: expected,
      }),
    );
  });

  it('runs normally when last fingerprint differs', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed', finalText: 'done',
      usage: { input_tokens: 1, output_tokens: 1 }, sandboxViolations: [],
    });
    const store = makeMockStore('different-hash-value');
    const { tool, ctx } = setupCtx(task({ files: ['a.ts'] }), store);

    await tool.handler({}, ctx);
    expect(runSubagent).toHaveBeenCalledTimes(1);
    // Successful run persisted with the NEW fingerprint.
    const finishedCall = store.upsertTaskRunItem.mock.calls.find(
      (c) => c[0].status === 'done',
    );
    expect(finishedCall?.[0].inputs_fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('runs normally when no prior completed item exists', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed', finalText: 'first run',
      usage: { input_tokens: 1, output_tokens: 1 }, sandboxViolations: [],
    });
    const store = makeMockStore(null);
    const { tool, ctx } = setupCtx(task({ files: ['a.ts'] }), store);

    await tool.handler({}, ctx);
    expect(runSubagent).toHaveBeenCalledTimes(1);
  });

  it('respects CODER_TASKS_DISABLE_SKIP_STALE=1 (forced run)', async () => {
    vi.stubEnv('CODER_TASKS_DISABLE_SKIP_STALE', '1');
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed', finalText: 'forced',
      usage: { input_tokens: 1, output_tokens: 1 }, sandboxViolations: [],
    });
    const t = task({ files: ['a.ts'] });
    const matched = computeTaskFingerprint({ task: t, cwd: dir, systemPromptVersion: SYSTEM_PROMPT_VERSION });
    const store = makeMockStore(matched);
    const { tool, ctx } = setupCtx(t, store);

    await tool.handler({}, ctx);
    expect(runSubagent).toHaveBeenCalledTimes(1);
  });

  it('respects per-task force_run flag', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed', finalText: 'forced',
      usage: { input_tokens: 1, output_tokens: 1 }, sandboxViolations: [],
    });
    const t = task({ files: ['a.ts'], force_run: true });
    const matched = computeTaskFingerprint({ task: t, cwd: dir, systemPromptVersion: SYSTEM_PROMPT_VERSION });
    const store = makeMockStore(matched);
    const { tool, ctx } = setupCtx(t, store);

    await tool.handler({}, ctx);
    expect(runSubagent).toHaveBeenCalledTimes(1);
  });

  it('does NOT skip when task has no files (fingerprint requires at least 1)', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed', finalText: 'no-scope',
      usage: { input_tokens: 1, output_tokens: 1 }, sandboxViolations: [],
    });
    const t = task({ files: [] });
    const store = makeMockStore('any-hash');
    const { tool, ctx } = setupCtx(t, store);

    await tool.handler({}, ctx);
    expect(runSubagent).toHaveBeenCalledTimes(1);
  });
});
