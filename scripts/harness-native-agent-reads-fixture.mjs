import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeAgentReadsDelta(body, fixture) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_AGENT_(SEED|READS)/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  if (JSON.stringify(body.messages[start].content).includes('HARNESS_NATIVE_AGENT_SEED')) {
    return { role: 'assistant', content: 'HARNESS_NATIVE_AGENT_SEED_OK' };
  }
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  if (!results.length) return { role: 'assistant', tool_calls: [
    ['list_agents', {}], ['list_agent_runs', { limit: 5 }],
    ['get_agent_run', { run_id: fixture.seedId }], ['get_agent_result', { run_id: fixture.seedId }],
    ['get_agent_run', { run_id: '../providers' }],
    ['get_agent_result', { run_id: '11111111-1111-4111-8111-111111111111' }],
    ['get_agent_result', { run_id: fixture.foreignId }],
  ].map(([name, args], index) => {
    assert(body.tools.some(t => t.function?.name === `mcp__${name}`), `Native catalog omitted ${name}`);
    return { index, id: `harness-agent-read-${index}`, type: 'function',
      function: { name: `mcp__${name}`, arguments: JSON.stringify(args) } };
  }) };
  assert.equal(results.length, 7);
  assert.match(results[0].content, /agents/); assert.match(results[0].content, /providers/);
  for (const index of [1, 2, 3]) assert(results[index].content.includes(fixture.seedId), `Agent read ${index} lost seeded identity`);
  for (const index of [2, 3]) {
    assert.match(results[index].content, /completed/); assert.match(results[index].content, /HARNESS_NATIVE_AGENT_SEED_OK/);
  }
  assert.match(results[4].content, /Invalid agent run id/);
  assert.match(results[5].content, /Unknown agent run/);
  assert.match(results[6].content, /Unknown agent run/);
  assert(!results[1].content.includes(fixture.foreignId), 'Foreign project leaked into agent list');
  return { role: 'assistant', content: 'HARNESS_NATIVE_AGENT_READS_OK' };
}

async function send(dashboard, id, content) {
  return dashboard.evaluate(async ({ id, content }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ content, profile: 'full', max_turns: 3 }) });
    if (!response.ok) throw new Error(`Agent read fixture HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
    return response.text();
  }, { id, content });
}

export async function runNativeAgentReadsFixture({ dashboard, post, root, projectId, setSession, fixture, restored = false }) {
  if (!restored) {
    // Other matrix cases intentionally retain uncertain writers across restart.
    // Give this read fixture its own sibling root, preserving those fences.
    const caseRoot = join(dirname(root), 'agent-reads'); await mkdir(caseRoot);
    const owner = await post('/api/projects', { name: 'Native agent reads', root_path: caseRoot });
    fixture.projectId = owner.id;
    const foreign = await post('/api/coder/sessions', { project_id: projectId, title: 'Foreign agent metadata',
      provider: 'harness-local', model: 'harness-model', agent: 'explore',
      metadata: { mcp_agent_run: { schema_version: 1, principal: 'local-dev', profile_id: null,
        agent_id: 'explore', task_preview: 'Must remain outside owned reads' } } });
    fixture.foreignId = foreign.id;
  }
  const sessionOptions = { project_id: fixture.projectId, provider: 'harness-local', model: 'harness-model', agent: 'explore', max_turns: 3 };
  if (!restored) {
    const seed = await post('/api/coder/sessions', { ...sessionOptions, title: 'Native MCP agent read target', metadata: {
      mcp_agent_run: { schema_version: 1, principal: 'local-dev', profile_id: null, agent_id: 'explore', task_preview: 'Read fixture' },
    } });
    fixture.seedId = seed.id; setSession(seed.id);
    const stream = await send(dashboard, seed.id, 'HARNESS_NATIVE_AGENT_SEED');
    assert(stream.includes('HARNESS_NATIVE_AGENT_SEED_OK'), stream.slice(-4000));
  }
  const session = await post('/api/coder/sessions', { ...sessionOptions, title: 'Native MCP agent reads' });
  setSession(session.id);
  const stream = await send(dashboard, session.id, 'HARNESS_NATIVE_AGENT_READS');
  assert(stream.includes('HARNESS_NATIVE_AGENT_READS_OK'), stream.slice(-7000));
  return { sessionId: session.id, seedId: fixture.seedId, projectId: fixture.projectId,
    foreignId: fixture.foreignId, passed: true, reads: 7, restored };
}
