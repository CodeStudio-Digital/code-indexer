import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeTreeDelta(body) {
  const users = body.messages.filter(m => m.role === 'user').map(m => JSON.stringify(m.content));
  const results = body.messages.filter(m => m.role === 'tool');
  const call = (id, name, args) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  if (users.some(text => text.includes('HARNESS_NATIVE_TREE_CHILD_MEMO'))) return !results.length
    ? call('tree-memo', 'record_memo', { text: 'Keep user settings.', kind: 'warning' }) : { role: 'assistant', content: 'HARNESS_TREE_MEMO_DONE' };
  if (users.some(text => text.includes('HARNESS_NATIVE_TREE_CHILD_WRITE'))) return !results.length
    ? call('tree-write', 'create_file', { path: 'child.txt', content: 'written once' }) : { role: 'assistant', content: 'HARNESS_TREE_WRITE_DONE' };
  if (users.some(text => text.includes('HARNESS_NATIVE_TREE_REVIEW'))) return { role: 'assistant', content: '<review>{"findings":[]}</review>' };
  if (!users.some(text => text.includes('HARNESS_NATIVE_TREE_ROOT'))) return;
  for (const name of ['spawn_agent', 'resume_agent', 'read_agent_transcript', 'request_review', 'list_agents', 'wait_agents']) assert(body.tools.some(t => t.function?.name === name), `Missing ${name}`);
  if (!results.length) return call('tree-spawn', 'spawn_agent', { agents: [
    { task: 'HARNESS_NATIVE_TREE_CHILD_MEMO record the warning.', profile: 'explore', label: 'memo', max_turns: 3 },
    { task: 'HARNESS_NATIVE_TREE_CHILD_WRITE create child.txt exactly once.', profile: 'implement', label: 'writer', max_turns: 1, files: ['child.txt'] },
  ] });
  const group = results[0].content.match(/group=([a-f\d]+)/i)?.[1]; assert(group, results[0].content);
  if (results.length === 1) return call('tree-resume', 'resume_agent', { spawn_id: group, guidance: 'Summarize the confirmed write without repeating it.' });
  assert.match(results[1].content, /HARNESS_TREE_WRITE_DONE/);
  if (results.length === 2) return call('tree-history', 'read_agent_transcript', { spawn_id: group, agent: 'writer', max_chars: 4000 });
  assert.match(results[2].content, /HARNESS_TREE_WRITE_DONE/);
  if (results.length === 3) return call('tree-review', 'request_review', { spec: 'HARNESS_NATIVE_TREE_REVIEW inspect child.txt', diff: 'diff --git a/child.txt b/child.txt\n+written once' });
  assert.match(results[3].content, /Reviewer found no issues/);
  if (results.length === 4) return call('tree-inventory', 'list_agents', { format: 'json' });
  const inventory = JSON.parse(results[4].content);
  assert.equal(inventory.total, 5); assert.equal(inventory.agents.filter(agent => agent.is_self).length, 1);
  assert.equal(inventory.agents.filter(agent => agent.status === 'completed').length, 3);
  assert.equal(inventory.agents.filter(agent => agent.status === 'interrupted').length, 1);
  if (results.length === 5) return call('tree-wait', 'wait_agents', { agent_run_ids: inventory.agents.filter(agent => !agent.is_self).map(agent => agent.agent_run_id), timeout_minutes: 0 });
  assert.equal(results.length, 6); assert.match(results[5].content, /All targeted agents finished/);
  return { role: 'assistant', content: 'HARNESS_NATIVE_TREE_OK' };
}
function events(stream, name) {
  return stream.split('\n\n').filter(frame => frame.startsWith(`event: ${name}\n`))
    .map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)));
}
export async function runNativeTreeFixture({ dashboard, post, root, isolated, setSession }) {
  const caseRoot = join(dirname(root), 'native-tree'); await mkdir(caseRoot, { recursive: true });
  const project = await post('/api/projects', { name: 'Native tree', root_path: caseRoot });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native tree', provider: 'harness-local', model: 'harness-model', max_turns: 30 });
  setSession(session.id);
  const stream = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ content: 'HARNESS_NATIVE_TREE_ROOT use spawn_agent, resume_agent, read_agent_transcript, request_review and list_agents.', profile: 'full', max_turns: 30 }) });
    if (!response.ok) throw new Error('Native tree HTTP ' + response.status + ': ' + await response.text());
    const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '', buffer = '';
    try { for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      const chunk = decoder.decode(value, { stream: true }); text += chunk; buffer += chunk;
      let end; while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (!frame.startsWith('event: tool_approval_request\n')) continue;
        const data = JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6));
        const approval = await fetch(`mcp://app/api/coder/sessions/${id}/tool-approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool_use_id: data.toolUseId, approved: true }) });
        if (!approval.ok) throw new Error('Tree approval ' + approval.status + ': ' + await approval.text());
      }
    } } finally { reader.releaseLock(); }
    return text;
  }, session.id);
  assert(stream.includes('HARNESS_NATIVE_TREE_OK'), stream.slice(-10000));
  const starts = events(stream, 'agents_group_start'); assert(starts.length > 0);
  const groupId = starts[0].groupId;
  assert(events(stream, 'agent_progress').length > 0); assert(events(stream, 'agents_group_end').length > 0);
  assert.equal(await readFile(join(caseRoot, 'child.txt'), 'utf8'), 'written once');
  const paths = (await readdir(isolated, { recursive: true })).filter(path => /events[\\/]runtime-routes[\\/].+\.json$/.test(path));
  const routes = (await Promise.all(paths.map(async path => JSON.parse(await readFile(join(isolated, path), 'utf8')))))
    .filter(record => record.relations?.session === session.id || record.data.route.sessionId === session.id);
  assert.equal(routes.length, 5, JSON.stringify(routes.map(record => record.data.route)));
  assert(routes.every(record => record.data.route.runtimeGeneration === 'rust_v1'), 'Mixed runtimes in one tree');
  const evidence = { sessionId: session.id, groupId, caseRoot, nativeAttempts: routes.length, writePreserved: true,
    inventoryMembers: 5, waitedTerminalAgents: 4, groupEvents: starts.length, progressEvents: events(stream, 'agent_progress').length };
  evidence.history = await recoverNativeTreeFixture({ dashboard, evidence }); return evidence;
}
export async function recoverNativeTreeFixture({ dashboard, evidence }) {
  for (const agent of ['memo', 'writer']) {
    const result = await dashboard.evaluate(async ({ id, groupId, agent }) => {
      const response = await fetch(`mcp://app/api/coder/sessions/${id}/agents/transcript?spawn_id=${encodeURIComponent(groupId)}&agent=${agent}&max_chars=4000`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('Native child history ' + response.status + ': ' + await response.text()); return response.json();
    }, { id: evidence.sessionId, groupId: evidence.groupId, agent });
    assert.equal(result.ok, true); assert.equal(result.hasTranscript, true);
    assert.match(result.text, agent === 'memo' ? /record_memo/ : /HARNESS_TREE_WRITE_DONE/);
  }
  assert.equal(await readFile(join(evidence.caseRoot, 'child.txt'), 'utf8'), 'written once');
  return { passed: true, readReferences: 2, writePreserved: true };
}
