import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function reservePublicMcpPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function runPublicMcpFixture({ port, setSession, requests, cancelObserved }) {
  const client = new Client({ name: 'harness-public-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  try {
    const tools = await client.listTools();
    for (const name of ['start_agent_run', 'get_agent_run', 'get_agent_result', 'list_agent_runs', 'cancel_agent_run']) {
      assert(tools.tools.some(tool => tool.name === name), `public MCP omitted ${name}`);
    }
    const call = async (name, args = {}) => {
      const response = await client.callTool({ name, arguments: args });
      assert(!response.isError, `MCP ${name}: ${JSON.stringify(response.content)}`);
      return response.structuredContent;
    };
    const evidence = [];
    for (const scenario of ['COMPLETE', 'CANCEL', 'FAILURE']) {
      setSession(undefined);
      const before = requests.length;
      const started = await call('start_agent_run', { project_name: 'Harness fixture',
        task: `Read fixture.txt, then finish. HARNESS_PUBLIC_MCP_${scenario}`, agent_id: 'explore',
        provider: 'harness-local', model: 'harness-model' });
      setSession(started.sessionId);
      const deadline = Date.now() + 60_000;
      if (scenario === 'CANCEL') {
        while (!cancelObserved() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        assert(cancelObserved(), 'public MCP cancel did not reach the provider');
        assert.equal((await call('cancel_agent_run', { run_id: started.id })).status, 'cancelled');
      }
      let result;
      do {
        result = await call('get_agent_result', { run_id: started.id });
        if (!['starting', 'running'].includes(result.status)) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      const expected = { COMPLETE: 'completed', CANCEL: 'cancelled', FAILURE: 'failed' }[scenario];
      assert.equal(result.status, expected, `public MCP terminal ${scenario}: ${JSON.stringify(result)}`);
      if (scenario === 'COMPLETE') assert(result.result.includes('HARNESS_RESULT_OK'));
      if (scenario === 'FAILURE') assert(result.error, 'public MCP hid the provider failure');
      const status = await call('get_agent_run', { run_id: started.id });
      assert.equal(status.status, expected);
      const listed = await call('list_agent_runs', { limit: 50 });
      assert(listed.runs.some(run => run.id === started.id && run.status === expected));
      const attempts = requests.slice(before);
      assert(attempts.length >= 1, 'public MCP never reached the native provider');
      assert(attempts.every(request => request.admission.sessionId === started.sessionId
        && request.admission.runtimeRoute.runtimeGeneration === 'rust_v1'));
      evidence.push({ scenario, sessionId: started.sessionId, status: expected, providerRequests: attempts.length });
    }
    return evidence;
  } finally { await client.close(); }
}

export async function assertPublicMcpAfterRestart(port, expectedRuns) {
  const client = new Client({ name: 'harness-public-agent-restart', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  try {
    const restored = [];
    for (const expected of expectedRuns) {
      const response = await client.callTool({ name: 'get_agent_result', arguments: { run_id: expected.sessionId } });
      assert(!response.isError, JSON.stringify(response.content));
      const actual = response.structuredContent;
      assert.equal(actual.status, expected.status, `restart changed public MCP terminal ${expected.scenario}`);
      if (expected.scenario === 'COMPLETE') assert(actual.result.includes('HARNESS_RESULT_OK'));
      restored.push({ sessionId: expected.sessionId, status: actual.status });
    }
    const listed = await client.callTool({ name: 'list_agent_runs', arguments: { limit: 50 } });
    assert(!listed.isError, JSON.stringify(listed.content));
    for (const expected of expectedRuns) assert(listed.structuredContent.runs.some(run => run.id === expected.sessionId
      && run.status === expected.status), `restart list lost terminal ${expected.scenario}`);
    return restored;
  } finally { await client.close(); }
}
