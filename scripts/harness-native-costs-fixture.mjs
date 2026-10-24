import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeCostsDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_COSTS/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  assert(body.tools.some(t => t.function?.name === 'mcp__get_costs'));
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  if (!results.length) return { role: 'assistant', tool_calls: [
    { since: '2026-10-07T09:00:00-03:00' }, { since: '2026-10-07T12:00:00.001Z' },
    { project_name: 'Native cost other', since: '2026-10-07' }, { since: '2026-02-30' },
  ].map((args, index) => ({ index, id: `harness-costs-${index}`, type: 'function',
    function: { name: 'mcp__get_costs', arguments: JSON.stringify(args) } })) };
  assert.equal(results.length, 4);
  const parse = result => JSON.parse(result.content.slice(result.content.indexOf('{'), result.content.lastIndexOf('}') + 1));
  assert.equal(parse(results[0]).total_cost_usd, 0.5);
  assert.equal(parse(results[1]).total_cost_usd, 0);
  // The coder bridge pins project_name to the admitted project, even if the
  // model supplies another name. Standalone MCP/global behavior has unit proof.
  assert.equal(parse(results[2]).total_cost_usd, 0.5);
  assert.match(results[3].content, /valid ISO/);
  return { role: 'assistant', content: 'HARNESS_NATIVE_COSTS_OK' };
}

export async function runNativeCostsFixture({ app, root, dashboard, post, setSession }) {
  const caseRoot = join(dirname(root), 'costs'); await mkdir(caseRoot);
  const project = await post('/api/projects', { name: 'Native costs', root_path: caseRoot });
  await app.evaluate(({ app }, { projectId, caseRoot }) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
    try {
      const other = db.createProject('Native cost other', caseRoot + '-other');
      const row = { projectId, provider: 'fixture', model: 'test', operation: 'embedding', inputTokens: 20, outputTokens: 0, costUsd: 0.5 };
      db.insertCost(row); db.insertCost({ ...row, projectId: other.id, costUsd: 3 });
      db.raw().prepare('UPDATE costs SET created_at=? WHERE provider=?').run('2026-10-07 12:00:00', 'fixture');
    } finally { db.close(); }
  }, { projectId: project.id, caseRoot });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native costs',
    provider: 'harness-local', model: 'harness-model', agent: 'explore', max_turns: 3 });
  setSession(session.id);
  const stream = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ content: 'HARNESS_NATIVE_COSTS', profile: 'full', max_turns: 3 }) });
    if (!response.ok) throw new Error('Cost fixture ' + response.status); return response.text();
  }, session.id);
  assert(stream.includes('HARNESS_NATIVE_COSTS_OK'), stream.slice(-7000));
  return { sessionId: session.id, passed: true, projectScope: true, crossProjectOverridePrevented: true,
    timezoneBoundary: true, invalidDateRejected: true };
}
