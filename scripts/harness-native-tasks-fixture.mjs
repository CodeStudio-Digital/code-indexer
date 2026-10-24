import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeTasksDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_TASKS_(CREATE|APPROVE|CLEAR)/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  const stage = JSON.stringify(body.messages[start].content).match(/HARNESS_NATIVE_TASKS_(CREATE|APPROVE|CLEAR)/)[1];
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-tasks-${stage}-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  if (!results.length) {
    if (stage === 'CREATE') return call([
      ['todo_write', { todos: [
        { id: 'aaa11111', content: 'Inspect source', activeForm: 'Inspecting source', status: 'in_progress' },
        { id: 'bbb22222', content: 'Verify behavior', activeForm: 'Verifying behavior', status: 'pending' },
      ] }],
      ['update_todo', { updates: [{ id: 'aaa11111', status: 'completed' }, { id: 'bbb22222', status: 'in_progress' }] }],
      ['list_tasks', {}], ['task_list', { updates: [{ id: 'bbb22222', status: 'completed' }] }],
    ]);
    if (stage === 'CLEAR') return call([['archive_task_list', {}], ['list_tasks', {}]]);
    return call([['submit_tasks', { summary: 'Native task review fixture', tasks: [
      { id: 'inspect', title: 'Inspect source', description: 'Read implementation' },
      { id: 'verify', title: 'Verify changes', description: 'Run checks', depends_on: ['inspect'] },
    ] }]]);
  }
  if (stage === 'CREATE') {
    assert.equal(results.length, 4); assert.match(results[2].content, /status=done/); assert.match(results[2].content, /status=running/);
    assert(!results.some(r => /requires a runner|requires runner context/i.test(r.content)));
  } else if (stage === 'APPROVE') {
    assert.match(results[0].content, /Task list approved by user/);
    if (results.length === 1) {
      const ids = [...new Set(results[0].content.match(/tsk_[a-z0-9]+/g))]; assert.equal(ids.length, 2);
      return call([['update_task', { task_id: ids[0], title: 'Reviewed source', files_add: ['src/main.ts'] }],
        ['cancel_tasks', { all: true, reason: 'Fixture cancellation' }], ['delete_tasks', { task_ids: [ids[0]] }], ['list_tasks', {}]]);
    }
    assert.equal(results.length, 5); assert.match(results[2].content, /cancelled 2/); assert.match(results[3].content, /deleted 1/);
    assert.match(results[4].content, /status=skipped/); assert(!results[4].content.includes('after=['));
  } else { assert.equal(results.length, 2); assert.match(results[1].content, /no task list found/); }
  return { role: 'assistant', content: `HARNESS_NATIVE_TASKS_${stage}_OK` };
}

async function send(dashboard, id, stage) {
  const stream = await dashboard.evaluate(async ({ id, stage }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(90000), body: JSON.stringify({ content: `HARNESS_NATIVE_TASKS_${stage}`, profile: 'full', plan_mode: stage === 'APPROVE', max_turns: 5 }) });
    if (!response.ok) throw new Error('Task fixture ' + response.status + ': ' + (await response.text()).slice(0, 1000));
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        const chunk = decoder.decode(value, { stream: true }); text += chunk; buffer += chunk;
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (!event.includes('event: tasks_posted')) continue;
          const payload = JSON.parse(event.split('\n').find(line => line.startsWith('data: ')).slice(6));
          const post = async body => fetch(`mcp://app/api/coder/sessions/${id}/tasks-response`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
          if ((await post({ approved: true })).status !== 400) throw new Error('Task response accepted missing identity');
          if ((await post({ approved: true, interaction_id: 'native-tool:foreign' })).status !== 409) throw new Error('Task response accepted foreign identity');
          const accepted = await post({ approved: true, execution_mode: 'inline', interaction_id: payload.tool_use_id });
          if (!accepted.ok) throw new Error('Task approval failed ' + accepted.status + ': ' + await accepted.text());
        }
      }
    } finally { reader.releaseLock(); }
    return text;
  }, { id, stage });
  assert(stream.includes(`HARNESS_NATIVE_TASKS_${stage}_OK`), stream.slice(-7000));
  assert((stream.match(/event: task_updated/g) ?? []).length >= (stage === 'CREATE' ? 3 : stage === 'APPROVE' ? 4 : 1));
  return stream;
}
async function readState(dashboard, id) {
  return dashboard.evaluate(async id => {
    const r = await fetch(`mcp://app/api/coder/sessions/${id}/tasks`);
    if (!r.ok) throw new Error('Native task state ' + r.status); return r.json();
  }, id);
}
export async function runNativeTasksFixture({ dashboard, post, root, setSession }) {
  const caseRoot = join(dirname(root), 'task-tools'); await mkdir(caseRoot, { recursive: true });
  const project = await post('/api/projects', { name: 'Native tasks', root_path: caseRoot });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native tasks', provider: 'harness-local', model: 'harness-model', max_turns: 5 });
  setSession(session.id);
  await send(dashboard, session.id, 'CREATE');
  const track = await readState(dashboard, session.id);
  assert.equal(track.gate, 'track'); assert.deepEqual(track.tasks.map(t => t.status), ['done', 'done']);
  await send(dashboard, session.id, 'APPROVE');
  const state = await readState(dashboard, session.id);
  assert.equal(state.approved, true); assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].status, 'skipped'); assert.deepEqual(state.tasks[0].depends_on, []);
  return { sessionId: session.id, state, checklistAtomic: true, approvalKeyed: true, toolsBeforeRestart: 8 };
}
export async function recoverNativeTasksFixture({ dashboard, evidence, setSession, beforeSend }) {
  assert.deepEqual(await readState(dashboard, evidence.sessionId), evidence.state);
  await beforeSend?.();
  setSession(evidence.sessionId); await send(dashboard, evidence.sessionId, 'CLEAR');
  assert.equal(await readState(dashboard, evidence.sessionId), null);
  return { passed: true, restartPreserved: true, durableClear: true, allNineTools: true };
}
