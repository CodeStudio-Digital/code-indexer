import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeGoalsDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_GOALS_(CREATE|FINISH)/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  for (const name of ['create_goal', 'get_goal', 'update_goal']) assert(body.tools.some(t => t.function?.name === name));
  const finish = JSON.stringify(body.messages[start].content).includes('HARNESS_NATIVE_GOALS_FINISH');
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-goal-${finish}-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  if (!results.length) return call(finish ? [['get_goal', {}], ['update_goal', { status: 'complete', note: 'Restart verified' }], ['get_goal', {}]]
    : [['get_goal', {}], ['create_goal', { goal: 'Preserve harness settings', budget_tokens: 10000 }], ['get_goal', {}], ['create_goal', { goal: 'Do not replace the goal' }], ['get_goal', {}]]);
  if (finish) {
    assert.equal(results.length, 3); assert.match(results[0].content, /Status: in_progress/);
    assert.match(results[1].content, /marked complete/); assert.match(results[2].content, /Status: complete/);
  } else {
    assert.equal(results.length, 5); assert.match(results[0].content, /no goal set/);
    assert.match(results[1].content, /Goal set/); assert.match(results[2].content, /Preserve harness settings/);
    assert.match(results[3].content, /left unchanged/); assert.match(results[4].content, /Preserve harness settings/);
  }
  return { role: 'assistant', content: `HARNESS_NATIVE_GOALS_${finish ? 'FINISHED' : 'CREATED'}_OK` };
}

async function send(dashboard, id, stage) {
  const stream = await dashboard.evaluate(async ({ id, stage }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(90000), body: JSON.stringify({ content: `HARNESS_NATIVE_GOALS_${stage}`, profile: 'full', max_turns: 4 }) });
    if (!response.ok) throw new Error('Goal fixture ' + response.status + ': ' + (await response.text()).slice(0, 1000)); return response.text();
  }, { id, stage });
  assert(stream.includes(`HARNESS_NATIVE_GOALS_${stage === 'CREATE' ? 'CREATED' : 'FINISHED'}_OK`), stream.slice(-7000));
  assert.equal((stream.match(/event: goal_mutations_persisted/g) ?? []).length, stage === 'CREATE' ? 2 : 1);
  return stream;
}
export async function assertNativeGoal(dashboard, evidence, status) {
  const state = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/state-summary`);
    if (!response.ok) throw new Error('Native goal state ' + response.status); return response.json();
  }, evidence.sessionId);
  assert.equal(state.goal?.text, 'Preserve harness settings'); assert.equal(state.goal?.status, status);
  assert.equal(state.goal.budget_tokens, 10000);
  if (status === 'complete') assert.equal(state.goal.completion_note, 'Restart verified');
  return state.goal;
}
export async function runNativeGoalsFixture({ dashboard, post, root, setSession }) {
  const caseRoot = join(dirname(root), 'goal-tools'); await mkdir(caseRoot, { recursive: true });
  const project = await post('/api/projects', { name: 'Native goals', root_path: caseRoot });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native goals', provider: 'harness-local', model: 'harness-model', max_turns: 4 });
  setSession(session.id);
  await send(dashboard, session.id, 'CREATE');
  const evidence = { sessionId: session.id, created: true, duplicatePreserved: true };
  evidence.goal = await assertNativeGoal(dashboard, evidence, 'in_progress');
  return evidence;
}
export async function finishNativeGoalsFixture({ dashboard, evidence, setSession }) {
  setSession(evidence.sessionId);
  await send(dashboard, evidence.sessionId, 'FINISH');
  const goal = await assertNativeGoal(dashboard, evidence, 'complete');
  assert.equal(goal.created_at, evidence.goal.created_at);
  return { passed: true, sameGoalGeneration: true, goal };
}
