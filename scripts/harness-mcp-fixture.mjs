import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function startMcpFixture(projectRoot) {
  const stats = { mutations: 0, discoveries: 0 };
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      let result = {};
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'harness-lost-ack', version: '1' } };
      if (message.method === 'tools/list') {
        stats.discoveries++;
        result = { tools: [{ name: 'mutate', description: 'HARNESS_MCP_CASE fixture mutation.', inputSchema: { type: 'object', properties: {} } }] };
      }
      if (message.method === 'tools/call') {
        stats.mutations++;
        await writeFile(join(projectRoot, 'mcp-effect.txt'), `effects:${stats.mutations}`);
        response.destroy(); return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch { response.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { stats, url: `http://127.0.0.1:${server.address().port}/mcp`, async close() {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }, async assertSingleEffect() { assert.equal(await readFile(join(projectRoot, 'mcp-effect.txt'), 'utf8'), 'effects:1'); } };
}

export async function runMcpFixture({ dashboard, post, projectId, fixture, setSession, requestCount, worktree = false }) {
  await post('/api/admin/mcp-servers', { id: 'harness-ext', name: 'Harness external MCP',
    ...(fixture.configuration ?? { transport: 'streamable_http', url: fixture.url }), enabled: true, auth_type: 'none', default_tier: 'bootstrap' });
  const session = await post('/api/coder/sessions', { project_id: projectId, title: 'MCP lost ACK fixture',
    provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 3 });
  setSession(session.id);
  await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'auto' }, 'PATCH');
  const before = requestCount();
  const readStream = path => dashboard.evaluate(async ({ path, sessionId, worktree }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${sessionId}/${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ content: 'Execute the fixture mutation. HARNESS_MCP_CASE', profile: 'full',
        client_msg_id: `harness-mcp-${path}`, max_turns: 3, max_auto_continues: 0,
        ...(worktree && path === 'messages' ? { worktree: { name: 'fixture-mcp', branch: 'codex/fixture-mcp' } } : {}) }) });
    return { status: response.status, text: await response.text() };
  }, { path, sessionId: session.id, worktree });
  const first = await readStream('messages');
  assert(first.text.includes('TOOL_OUTCOME_UNKNOWN'), `MCP did not stop on unknown: ${first.text.slice(-2000)}`);
  assert.equal(requestCount(), before + 2, 'MCP uncertainty entered another provider turn');
  await fixture.assertSingleEffect();
  const history = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}?full=1`); return response.json();
  }, session.id);
  assert(JSON.stringify(history.messages).includes('"effect_outcome":"unknown"'), 'history lost uncertain effect');
  if (worktree) assert(history.session.worktree_path?.replaceAll('\\', '/').endsWith('/.mcp-indexer/worktrees/fixture-mcp'),
    'MCP did not execute from the admitted managed worktree');
  const continuation = await readStream('continue');
  assert(continuation.text.includes('TOOL_OUTCOME_UNKNOWN'), 'continuation did not retain uncertain-effect stop');
  assert.equal(requestCount(), before + (native ? 1 : 2), 'continue retried an uncertain mutation');
  await fixture.assertSingleEffect();
  return { ...fixture.stats, sessionId: session.id, providerCalls: requestCount() - before,
    historyRetainedOutcome: true, continuationBlocked: true, worktreeRoot: worktree ? history.session.worktree_path : undefined };
}


export async function assertMcpRecovery({ dashboard, sessionId, fixture, requestCount }) {
  const before = requestCount();
  const result = await dashboard.evaluate(async id => {
    const history = await fetch('mcp://app/api/coder/sessions/' + id + '?full=1').then(response => response.json());
    const response = await fetch('mcp://app/api/coder/sessions/' + id + '/continue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ max_auto_continues: 0 }),
    });
    return { history, continuation: await response.text() };
  }, sessionId);
  assert(JSON.stringify(result.history.messages).includes('"effect_outcome":"unknown"'), 'restart lost MCP uncertainty');
  assert(result.continuation.includes('TOOL_OUTCOME_UNKNOWN'), 'restart bypassed uncertain MCP effect');
  assert.equal(requestCount(), before, 'restart continuation called the provider after uncertain effect');
  await fixture.assertSingleEffect();
  return { historyRetainedOutcome: true, continuationBlocked: true, replayedProviderCalls: 0 };
}
