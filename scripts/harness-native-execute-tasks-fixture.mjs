import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeExecuteTasksDelta(body, fixture) {
  const users = body.messages.filter(m => m.role === 'user').map(m => JSON.stringify(m.content));
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `et-${body.messages.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  for (const name of ['A', 'B']) if (users.some(text => text.includes(`HARNESS_ET_WRITE_${name}`))) {
    fixture.childProviderRequests++;
    const result = body.messages.find(m => m.role === 'tool');
    if (result) assert.match(result.content, /created|wrote|written|successfully/i, `Child ${name}: ${result.content}`);
    return body.messages.some(m => m.role === 'tool') ? { role: 'assistant', content: `HARNESS_ET_WRITTEN_${name}` + (name === 'A' ? '\n' + 'detail '.repeat(4000) : '') }
      : call([['create_file', { path: `task-${name}.txt`, content: `task ${name} wrote once` }]]);
  }
  if (users.some(text => text.includes('HARNESS_ET_VERIFY'))) {
    fixture.childProviderRequests++;
    return body.messages.some(m => m.role === 'tool') ? { role: 'assistant', content: 'HARNESS_ET_VERIFIED' }
      : call([['read_file', { path: 'task-A.txt' }], ['read_file', { path: 'task-B.txt' }]]);
  }
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_EXECUTE_TASKS_(ROOT|RESUME)/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  const resume = JSON.stringify(body.messages[start].content).includes('HARNESS_EXECUTE_TASKS_RESUME');
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  assert(body.tools.some(t => t.function?.name === 'execute_tasks'), 'Native catalog lacks execute_tasks');
  if (resume) {
    if (!results.length) return call([['execute_tasks', {}], ['list_tasks', {}]]);
    assert.match(results[0].content, /all tasks already terminal/);
    assert.equal((results[1].content.match(/status=done/g) ?? []).length, 4);
    return { role: 'assistant', content: 'HARNESS_EXECUTE_TASKS_RESUME_OK' };
  }
  if (!results.length) return call([['submit_tasks', { summary: 'Native waves and inline scope', tasks: [
    { id: 'a', title: 'Write A', description: 'HARNESS_ET_WRITE_A create task-A.txt once', files: ['task-A.txt'], kind: 'implement', suggested_mode: 'subagent', parallel_group: 'writes' },
    { id: 'b', title: 'Write B', description: 'HARNESS_ET_WRITE_B create task-B.txt once', files: ['task-B.txt'], kind: 'implement', suggested_mode: 'subagent', parallel_group: 'writes' },
    { id: 'verify', title: 'Verify', description: 'HARNESS_ET_VERIFY read both files', kind: 'verify', suggested_mode: 'subagent', depends_on: ['a', 'b'] },
    { id: 'inline', title: 'Inline', description: 'Write inline-native.txt', files: ['inline-native.txt'], suggested_mode: 'inline', depends_on: ['verify'] },
  ] }]]);
  assert.match(results[0].content, /Task list approved by user/);
  const ids = [...new Set(results[0].content.match(/tsk_[a-z0-9]+/g))]; assert.equal(ids.length, 4);
  if (results.length === 1) return call([['execute_tasks', {}]]);
  assert.match(results[1].content, /opened inline scope/);
  if (results.length === 2) return call([['write_file', { path: 'inline-native.txt', content: 'inline completed' }],
    ['task_complete', { task_id: ids[3], summary: 'Inline verified', files_modified: ['inline-native.txt'] }]]);
  if (results.length === 4) return call([['execute_tasks', {}], ['list_tasks', {}]]);
  assert.equal(results.length, 6); assert.match(results[4].content, /all tasks already terminal/);
  assert.equal((results[5].content.match(/status=done/g) ?? []).length, 4);
  return { role: 'assistant', content: 'HARNESS_EXECUTE_TASKS_ROOT_OK' };
}

async function send(dashboard, sessionId, resume = false) {
  return dashboard.evaluate(async ({ sessionId, resume }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${sessionId}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180000),
      body: JSON.stringify({ content: `HARNESS_EXECUTE_TASKS_${resume ? 'RESUME' : 'ROOT'}`, profile: 'full', plan_mode: !resume, max_turns: 20 }) });
    if (!response.ok) throw new Error('Execute tasks HTTP ' + response.status + ': ' + await response.text());
    const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '', buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        const chunk = decoder.decode(value, { stream: true }); text += chunk; buffer += chunk;
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (!frame.startsWith('event: tasks_posted\n')) continue;
          const payload = JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6));
          const accepted = await fetch(`mcp://app/api/coder/sessions/${sessionId}/tasks-response`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
            body: JSON.stringify({ approved: true, execution_mode: 'per-task', interaction_id: payload.tool_use_id }) });
          if (!accepted.ok) throw new Error('Execute task approval ' + accepted.status + ': ' + await accepted.text());
        }
      }
    } finally { reader.releaseLock(); }
    return text;
  }, { sessionId, resume });
}
async function verifyFiles(root) {
  for (const name of ['A', 'B']) assert.equal(await readFile(join(root, `task-${name}.txt`), 'utf8'), `task ${name} wrote once`);
  assert.equal(await readFile(join(root, 'inline-native.txt'), 'utf8'), 'inline completed');
}
export async function runNativeExecuteTasksFixture({ dashboard, post, root, isolated, fixture, setSession }) {
  const caseRoot = join(dirname(root), 'execute-tasks'); await mkdir(caseRoot);
  const project = await post('/api/projects', { name: 'Native execute tasks', root_path: caseRoot });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native execute tasks',
    provider: 'harness-local', model: 'harness-model', execution_mode: 'ultra', max_turns: 20 });
  setSession(session.id); await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
  const stream = await send(dashboard, session.id);
  assert(stream.includes('HARNESS_EXECUTE_TASKS_ROOT_OK'), stream.slice(-18000));
  const toolResults = stream.split('\n\n').filter(frame => frame.startsWith('event: tool_call_result\n'))
    .map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)));
  assert(toolResults.every(tool => !tool.result.isError), JSON.stringify(toolResults.map(t => ({ name: t.name, content: t.result.content.slice(0, 600) }))));
  const finishedRuns = stream.split('\n\n').filter(frame => frame.startsWith('event: task_run_finished\n'))
    .map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)));
  assert.equal(finishedRuns.length, 1); assert.equal(finishedRuns[0].status, 'completed');
  const board = await dashboard.evaluate(async id => (await fetch(`mcp://app/api/coder/sessions/${id}/tasks`)).json(), session.id);
  assert(board.tasks.every(task => !task.result || Buffer.byteLength(task.result.summary) <= 512));
  await verifyFiles(caseRoot);
  const paths = (await readdir(isolated, { recursive: true })).filter(path => /events[\\/]runtime-routes[\\/].+\.json$/.test(path));
  const routes = (await Promise.all(paths.map(async path => JSON.parse(await readFile(join(isolated, path), 'utf8')))))
    .filter(record => record.relations?.session === session.id || record.data.route.sessionId === session.id);
  assert.equal(routes.length, 4); assert(routes.every(record => record.data.route.runtimeGeneration === 'rust_v1'));
  assert.equal(fixture.childProviderRequests, 6);
  return { passed: true, sessionId: session.id, caseRoot, nativeAttempts: routes.length,
    childProviderRequests: fixture.childProviderRequests, completedTasks: 4, inlineScope: true,
    longChildSummary: true, inlineRunClosed: true, writesPreserved: true };
}
export async function recoverNativeExecuteTasksFixture({ dashboard, evidence, fixture, setSession }) {
  setSession(evidence.sessionId); const before = fixture.childProviderRequests;
  const stream = await send(dashboard, evidence.sessionId, true);
  assert(stream.includes('HARNESS_EXECUTE_TASKS_RESUME_OK'), stream.slice(-16000));
  assert.equal(fixture.childProviderRequests, before, 'Completed tasks replayed children after restart');
  await verifyFiles(evidence.caseRoot); return { passed: true, relaunchedChildren: 0, writesPreserved: true };
}
