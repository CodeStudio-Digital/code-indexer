import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import type { SessionId } from '@mcp/session-storage';
import type { CoderTask, TasksState } from '@mcp/session-storage/session-state-types.js';
import type { ToolContext } from '../../core/tool.js';
import { openNativeTaskCheckpoint, nativeTaskDefinitionSha } from '../execute-tasks/native-task-checkpoint.js';
import { NOOP_PERSIST } from '../execute-tasks/task-run-types.js';
import { createTaskRunPersist } from '../execute-tasks/task-run-persistence.js';
import { inlineRunProjection } from '../execute-tasks/inline-run-projection.js';

let directory: string, store: FsSessionStore, sessionId: SessionId;
const scopes: Awaited<ReturnType<typeof openNativeTaskCheckpoint>>[] = [];
function openStore() {
  return FsSessionStore.fromRoots({ dataDir: join(directory, 'data'), projectRootResolver: {
    resolveProjectRoot: id => id === 7 ? join(directory, 'project') : null,
    listProjectRoots: () => [{ project_id: 7, root_path: join(directory, 'project') }],
  } });
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'native-task-checkpoint-'));
  await mkdir(join(directory, 'project')); store = openStore();
  sessionId = (await store.createSession({ project_id: 7, title: 'Recovery', provider: 'test', model: 'test' })).id;
});
afterEach(async () => {
  for (const scope of scopes.splice(0)) await scope.close();
  await store.close(); vi.restoreAllMocks();
  if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\') || !directory.includes('native-task-checkpoint-')) throw new Error('Foreign fixture');
  await rm(directory, { recursive: true, force: true });
});
function task(id = 'write'): CoderTask {
  return { id, title: id, description: 'Write one file', files: ['a.txt'], references: [], depends_on: [],
    suggested_mode: 'subagent', estimated_complexity: 'small', status: 'pending' };
}
function harness(tasks = [task()]) {
  const controller = new AbortController();
  const state: TasksState = { gate: 'approve', approved: true, execution_mode: 'all-subagent', current_task_id: null, summary: 'Tasks', tasks };
  const reconcile = vi.fn(async (_ref: string): Promise<import('../../ports/agent-tree-port.js').AgentTreeReconciliation> =>
    ({ outcome: 'terminal', stepStatus: 'completed', detail: 'complete verified journal and reap', summary: 'long'.repeat(10_000) }));
  const context = { cwd: directory, sessionId, runtimeGeneration: 'rust_v1', signal: controller.signal,
    currentToolUseId: `native-tool:${'a'.repeat(64)}`, getTasksState: () => state,
    updateTaskStatus: async (id: string, patch: Partial<CoderTask>) => { Object.assign(state.tasks.find(t => t.id === id)!, patch); return state; },
    ports: { agentTree: { runtimeGeneration: 'rust_v1', ownerAgentRunId: 'owner', reconcile, run: vi.fn() } },
    toolCallLedger: { markOutcomeUnknown: vi.fn() },
  } as unknown as ToolContext;
  const open = async () => { const scope = await openNativeTaskCheckpoint({ store, sessionId, context, state }); scopes.push(scope); return scope; };
  return { open, context, reconcile, state, controller };
}
const ref = () => `native-child-journal:${randomUUID()}:${randomUUID()}:${randomUUID()}:${randomUUID()}`;
const admit = async (scope: Awaited<ReturnType<typeof openNativeTaskCheckpoint>>, t: CoderTask, reference = ref()) => {
  const projection = vi.fn(async () => {});
  await scope.wrap({ ...NOOP_PERSIST, recordTaskAdmitted: projection }).recordTaskAdmitted!({ runId: randomUUID(), task: t,
    waveIdx: 1, startedAt: new Date().toISOString(), nativeTranscriptRef: reference });
  expect(projection).toHaveBeenCalledOnce(); return reference;
};

it('recovers a completed effect after process restart and missing parent result without another admission', async () => {
  const h = harness(), first = await h.open(), reference = await admit(first, h.state.tasks[0]);
  await first.close(); await store.close(); store = openStore();
  await h.open(); expect(h.reconcile).toHaveBeenCalledWith(reference, expect.anything());
  expect(h.state.tasks[0]).toMatchObject({ status: 'done', result: { summary: expect.stringContaining(reference) } });
  expect(h.state.tasks[0].result!.summary.length).toBeLessThan(300);
  const row = await store.loadOrchestrationCheckpointForAudit(sessionId, 'execute_tasks', 'native-task-board');
  expect(row?.expires_at).toBe('9999-12-31T23:59:59.999Z'); expect(row?.payload_json).not.toContain('Write one file');
});

it.each(['outcome_unknown', 'throw'] as const)('blocks even a replacement plan when old child reconciliation is %s', async failure => {
  const h = harness(), scope = await h.open(); const reference = await admit(scope, h.state.tasks[0]); await scope.close();
  h.state.tasks = [task('different')];
  if (failure === 'throw') h.reconcile.mockRejectedValue(new Error('corrupt journal'));
  else h.reconcile.mockResolvedValue({ outcome: 'outcome_unknown', detail: 'reap missing' });
  await expect(h.open()).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' });
  expect(h.context.toolCallLedger!.markOutcomeUnknown).toHaveBeenCalledWith('execute_tasks');
  expect(h.state.tasks[0].status).toBe('pending'); expect(h.reconcile).toHaveBeenCalledWith(reference, expect.anything());
  h.reconcile.mockResolvedValue({ outcome: 'terminal', stepStatus: 'completed', detail: 'repaired' });
  const recovered = await h.open(); await admit(recovered, h.state.tasks[0]);
  const row = await store.loadOrchestrationCheckpointForAudit(sessionId, 'execute_tasks', 'native-task-board');
  expect(JSON.parse(row!.payload_json).admissions).toHaveLength(1);
});

it('serializes concurrent admissions and excludes a second live owner', async () => {
  const h = harness([task('one'), task('two')]), scope = await h.open();
  await expect(h.open()).rejects.toThrow('another execution');
  await Promise.all(h.state.tasks.map(t => admit(scope, t)));
  const row = await store.loadOrchestrationCheckpointForAudit(sessionId, 'execute_tasks', 'native-task-board');
  expect(JSON.parse(row!.payload_json).admissions).toHaveLength(2);
});

it('does not allow a cancelled owner to start a child', async () => {
  const h = harness(), scope = await h.open(), projection = vi.fn(async () => {});
  h.controller.abort();
  await expect(scope.wrap({ ...NOOP_PERSIST, recordTaskAdmitted: projection }).recordTaskAdmitted!({ runId: 'run',
    task: h.state.tasks[0], waveIdx: 1, startedAt: new Date().toISOString(), nativeTranscriptRef: ref() })).rejects.toThrow();
  expect(projection).not.toHaveBeenCalled();
});

it.each(['before_commit', 'after_commit'] as const)('poisons the owner after admission storage fails %s', async boundary => {
  const h = harness(), projection = vi.fn(async () => {});
  const save = store.saveOrchestrationCheckpoint.bind(store), reference = ref();
  const failure = Object.assign(new Error('injected admission storage failure'), { code: 'ENOSPC' });
  let fail = false;
  const scope = await openNativeTaskCheckpoint({ ...h, sessionId, store: {
    loadOrchestrationCheckpointForAudit: store.loadOrchestrationCheckpointForAudit.bind(store),
    tryAcquireOrchestrationCheckpoint: store.tryAcquireOrchestrationCheckpoint.bind(store),
    renewOrchestrationCheckpoint: store.renewOrchestrationCheckpoint.bind(store),
    releaseOrchestrationCheckpoint: store.releaseOrchestrationCheckpoint.bind(store),
    saveOrchestrationCheckpoint: async input => {
      if (!fail) return save(input);
      if (boundary === 'after_commit') await save(input);
      throw failure;
    },
  } });
  scopes.push(scope); fail = true;
  const persist = scope.wrap({ ...NOOP_PERSIST, recordTaskAdmitted: projection });
  const input = { runId: randomUUID(), task: h.state.tasks[0], waveIdx: 1,
    startedAt: new Date().toISOString(), nativeTranscriptRef: reference };
  await expect(persist.recordTaskAdmitted!(input)).rejects.toThrow('storage failure');
  fail = false;
  await expect(persist.recordTaskAdmitted!({ ...input, nativeTranscriptRef: ref() })).rejects.toThrow();
  expect(projection).not.toHaveBeenCalled();
  await scope.close(); await store.close(); store = openStore();
  await h.open();
  if (boundary === 'after_commit') expect(h.reconcile).toHaveBeenCalledWith(reference, expect.anything());
  else expect(h.reconcile).not.toHaveBeenCalled();
});

it('refuses an unverified replacement for the same task before admitting a retry', async () => {
  const h = harness(), scope = await h.open(); await admit(scope, h.state.tasks[0]);
  h.reconcile.mockResolvedValue({ outcome: 'outcome_unknown', detail: 'ack lost' });
  await expect(admit(scope, h.state.tasks[0])).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' });
});

it('does not initialize over an existing checkpoint and rejects an expired lease publication', async () => {
  const input = { sessionId, kind: 'execute_tasks' as const, scopeId: 'lease-test', privacyClass: 'session_private_redacted' as const,
    payloadJson: '{"first":true}', expiresAt: '9999-12-31T23:59:59.999Z', createOnly: true };
  expect(await store.saveOrchestrationCheckpoint(input)).toBe(true);
  expect(await store.saveOrchestrationCheckpoint({ ...input, payloadJson: '{"overwritten":true}' })).toBe(false);
  const token = await store.tryAcquireOrchestrationCheckpoint(sessionId, 'execute_tasks', 'lease-test', 1000);
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 5000);
  expect(await store.saveOrchestrationCheckpoint({ ...input, createOnly: false, leaseToken: token! })).toBe(false);
  vi.restoreAllMocks();
  expect((await store.loadOrchestrationCheckpointForAudit(sessionId, 'execute_tasks', 'lease-test'))?.payload_json).toBe('{"first":true}');
});

it('hashes the actual task definition independently of status and object insertion order', () => {
  const first = task(), reordered = Object.fromEntries(Object.entries(first).reverse()) as unknown as CoderTask;
  expect(nativeTaskDefinitionSha(first)).toBe(nativeTaskDefinitionSha({ ...reordered, status: 'done', result: { summary: 'result', files_modified: [] } }));
  expect(nativeTaskDefinitionSha(first)).not.toBe(nativeTaskDefinitionSha({ ...first, files: ['other'] }));
});

it.each(['done', 'failed'] as const)('finishes the exact inline run with status %s across restart', async status => {
  const runId = randomUUID(), persist = createTaskRunPersist({ store, sessionId }), t = task('inline');
  await persist.recordRunStarted({ runId, mode: 'inline-all', startedAt: new Date().toISOString() });
  await persist.recordTaskStarted({ runId, task: t, waveIdx: 1, startedAt: new Date().toISOString() });
  const complete = { ...t, task_run_id: runId, mode_used: 'inline' as const, status, finished_at: new Date().toISOString(),
    result: { summary: 'Verified', files_modified: [], ...(status === 'failed' ? { errors: 'Test failed' } : {}) } };
  const other = randomUUID(); await persist.recordRunStarted({ runId: other, mode: 'auto', startedAt: new Date().toISOString() });
  const outcome = await inlineRunProjection(store, sessionId)(complete);
  expect(outcome?.status).toBe(status === 'done' ? 'completed' : 'failed');
  await store.close(); store = openStore();
  expect((await store.getTaskRun(sessionId, runId))?.status).toBe(outcome!.status);
  expect((await store.getTaskRun(sessionId, other))?.status).toBe('running');
  expect((await store.listTaskRunItems(sessionId, runId))[0].status).toBe(status);
  expect(await inlineRunProjection(store, sessionId)(complete)).toEqual(outcome);
});
