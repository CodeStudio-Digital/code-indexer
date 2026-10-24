import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeTaskCompleteDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m.content).includes('HARNESS_NATIVE_TASK_COMPLETE'));
  if (start < 0) return;
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const call = list => ({ role: 'assistant', tool_calls: list.map(([name, args], index) => ({ index,
    id: `task-complete-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  assert(body.tools.some(t => t.function?.name === 'task_complete'));
  if (!results.length) return call([
    ['write_file', { path: 'outside.ts', content: 'must not execute' }],
    ['apply_patch', { patch: '*** Begin Patch\n*** Update File: allowed.ts\n*** Move to: outside.ts\n@@\n-before\n+must not execute\n*** End Patch' }],
  ]);
  assert(results.slice(0, 2).every(r => r.content.includes('policy_task_scope')), JSON.stringify(results.slice(0, 2)));
  if (results.length === 2) return call([['task_complete', { task_id: 'foreign', summary: 'Not my task' }]]);
  assert.match(results[2].content, /doesn't match the active scope/);
  if (results.length === 3) return call([['write_file', { path: 'allowed.ts', content: 'finished in scope' }],
    ['task_complete', { task_id: 'tsk_inline', summary: 'Task verified', files_modified: ['allowed.ts'] }]]);
  assert(!results[4].content.includes('requires runner context'));
  if (results.length === 5) return call([['list_tasks', {}], ['write_file', { path: 'outside.ts', content: 'after scope completion' }]]);
  assert.equal(results.length, 7); assert.match(results[5].content, /status=done/);
  return { role: 'assistant', content: 'HARNESS_NATIVE_TASK_COMPLETE_OK' };
}
export async function runNativeTaskCompleteFixture({ app, dashboard, post, root, setSession, reopenApplication }) {
  const caseRoot = join(dirname(root), 'task-complete'); await mkdir(caseRoot); await writeFile(join(caseRoot, 'allowed.ts'), 'before\n');
  const project = await post('/api/projects', { name: 'Native task completion', root_path: caseRoot });
  const sessionId = await app.evaluate(async ({ app }, { projectId, caseRoot }) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { FsSessionStore } = require(join(app.getAppPath(), 'dist/packages/session-storage/src/fs-store/fs-session-store.js'));
    const store = FsSessionStore.fromRoots({ dataDir: process.env.MCP_DATA_DIR,
      projectRootResolver: { resolveProjectRoot: id => id === projectId ? caseRoot : null,
        listProjectRoots: () => [{ project_id: projectId, root_path: caseRoot }] } });
    try {
      const session = await store.createSession({ project_id: projectId, title: 'Continue inline task', provider: 'harness-local', model: 'harness-model' });
      await store.recordTasks({ session_id: session.id, tool_use_id: 'legacy-task', operation_id: 'seed-active-task', state: {
        gate: 'approve', summary: 'Finish the owned task', execution_mode: 'inline', approved: true, current_task_id: 'tsk_inline',
        tasks: [{ id: 'tsk_inline', title: 'Finish', description: 'Complete allowed.ts', files: ['allowed.ts'], depends_on: [], references: [],
          suggested_mode: 'inline', estimated_complexity: 'small', status: 'running', mode_used: 'inline' }],
      } }); return session.id;
    } finally { await store.close(); }
  }, { projectId: project.id, caseRoot });
  ({ dashboard } = await reopenApplication()); setSession(sessionId);
  await post(`/api/coder/sessions/${sessionId}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
  const stream = await dashboard.evaluate(async id => {
    const r = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(90000), body: JSON.stringify({ content: 'HARNESS_NATIVE_TASK_COMPLETE', profile: 'full', max_turns: 8 }) });
    if (!r.ok) throw new Error('Task completion HTTP ' + r.status + ': ' + await r.text()); return r.text();
  }, sessionId);
  assert(stream.includes('HARNESS_NATIVE_TASK_COMPLETE_OK'), stream.slice(-10000));
  assert.equal((stream.match(/event: task_finished\n/g) ?? []).length, 1);
  const evidence = { sessionId, caseRoot, passed: true, outOfScopeWritesRefused: 2, wrongTaskRefused: true, confirmedCompletionEvents: 1 };
  evidence.state = await recoverNativeTaskCompleteFixture({ dashboard, evidence }); return evidence;
}
export async function recoverNativeTaskCompleteFixture({ dashboard, evidence }) {
  const state = await dashboard.evaluate(async id => {
    const r = await fetch(`mcp://app/api/coder/sessions/${id}/tasks`);
    if (!r.ok) throw new Error('Task completion state ' + r.status); return r.json();
  }, evidence.sessionId);
  assert.equal(state.current_task_id, null); assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].status, 'done'); assert.equal(state.tasks[0].result.summary, 'Task verified');
  assert.equal(await readFile(join(evidence.caseRoot, 'allowed.ts'), 'utf8'), 'finished in scope');
  assert.equal(await readFile(join(evidence.caseRoot, 'outside.ts'), 'utf8'), 'after scope completion');
  return { passed: true, activeScopeClosed: true, completedTasks: 1 };
}
