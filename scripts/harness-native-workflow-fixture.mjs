import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeWorkflowDelta(body, fixture) {
  const users = body.messages.filter(m => m.role === 'user').map(m => JSON.stringify(m.content));
  const call = (id, name, args) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  if (users.some(text => text.includes('HARNESS_WF_WRITE'))) {
    fixture.childProviderRequests++;
    return body.messages.some(m => m.role === 'tool') ? { role: 'assistant', content: 'HARNESS_WF_WRITTEN' }
      : call('wf-write', 'create_file', { path: 'workflow.txt', content: 'workflow wrote once' });
  }
  if (users.some(text => text.includes('HARNESS_WF_VERIFY'))) {
    fixture.childProviderRequests++;
    assert(users.some(text => text.includes('HARNESS_WF_WRITTEN')), 'Workflow dependency digest missing');
    return body.messages.some(m => m.role === 'tool') ? { role: 'assistant', content: 'HARNESS_WF_VERIFIED' }
      : call('wf-verify', 'read_file', { path: 'workflow.txt' });
  }
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_WORKFLOW_(ROOT|RESUME)/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  assert(body.tools.some(t => t.function?.name === 'workflow'), 'Ultra native catalog lacks workflow');
  const prompt = JSON.stringify(body.messages[start].content);
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  if (!results.length) {
    const resume = prompt.match(/HARNESS_WORKFLOW_RESUME (wf_[a-f\d]+)/)?.[1];
    return call('wf-root', 'workflow', resume ? { resume_workflow_id: resume, retry_failed: true } : { name: 'Write and verify', steps: [
      { id: 'write', prompt: 'HARNESS_WF_WRITE create workflow.txt exactly once.', profile: 'implement', files: ['workflow.txt'] },
      { id: 'verify', prompt: 'HARNESS_WF_VERIFY inspect workflow.txt.', profile: 'verify', depends_on: ['write'] },
    ] });
  }
  assert.match(results[0].content, /2\/2 completed/); assert.match(results[0].content, /HARNESS_WF_VERIFIED/);
  return { role: 'assistant', content: 'HARNESS_WORKFLOW_OK' };
}

async function send(dashboard, sessionId, content) {
  return dashboard.evaluate(async ({ sessionId, content }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${sessionId}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ content, profile: 'full', max_turns: 8 }) });
    if (!response.ok) throw new Error('Workflow HTTP ' + response.status + ': ' + await response.text());
    return response.text();
  }, { sessionId, content });
}
function events(stream, name) {
  return stream.split('\n\n').filter(frame => frame.startsWith(`event: ${name}\n`))
    .map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)));
}
export async function runNativeWorkflowFixture({ dashboard, post, root, isolated, fixture, setSession }) {
  const caseRoot = join(dirname(root), 'workflow'); await mkdir(caseRoot);
  const project = await post('/api/projects', { name: 'Native workflow', root_path: caseRoot });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native workflow',
    provider: 'harness-local', model: 'harness-model', execution_mode: 'ultra', max_turns: 8 });
  setSession(session.id);
  await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
  const stream = await send(dashboard, session.id, 'HARNESS_WORKFLOW_ROOT write and verify with the workflow tool.');
  assert(stream.includes('HARNESS_WORKFLOW_OK'), stream.slice(-14000));
  const starts = events(stream, 'workflow_run_started'); assert.equal(starts.length, 1);
  assert.equal(events(stream, 'workflow_run_finished')[0]?.status, 'completed');
  assert.equal(await readFile(join(caseRoot, 'workflow.txt'), 'utf8'), 'workflow wrote once');
  const paths = (await readdir(isolated, { recursive: true })).filter(path => /events[\\/]runtime-routes[\\/].+\.json$/.test(path));
  const routes = (await Promise.all(paths.map(async path => JSON.parse(await readFile(join(isolated, path), 'utf8')))))
    .filter(record => record.relations?.session === session.id || record.data.route.sessionId === session.id);
  assert.equal(routes.length, 3); assert(routes.every(record => record.data.route.runtimeGeneration === 'rust_v1'));
  assert.equal(fixture.childProviderRequests, 4);
  return { passed: true, sessionId: session.id, workflowId: starts[0].workflow_id, caseRoot,
    nativeAttempts: routes.length, childProviderRequests: fixture.childProviderRequests, writePreserved: true };
}
export async function recoverNativeWorkflowFixture({ dashboard, evidence, fixture, setSession }) {
  setSession(evidence.sessionId);
  const before = fixture.childProviderRequests;
  const stream = await send(dashboard, evidence.sessionId, `HARNESS_WORKFLOW_RESUME ${evidence.workflowId}`);
  assert(stream.includes('HARNESS_WORKFLOW_OK'), stream.slice(-14000));
  assert.equal(events(stream, 'agents_group_start').length, 0);
  assert.equal(fixture.childProviderRequests, before, 'Completed workflow replayed a child after restart');
  assert.equal(await readFile(join(evidence.caseRoot, 'workflow.txt'), 'utf8'), 'workflow wrote once');
  return { passed: true, relaunchedChildren: 0, writePreserved: true };
}
