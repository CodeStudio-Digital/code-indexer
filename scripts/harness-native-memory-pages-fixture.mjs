import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeMemoryPagesDelta(body, fixture) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_MEMORY_PAGES/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  assert(body.tools.some(t => t.function?.name === 'mcp__search_memory')); assert(fixture);
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const call = calls => ({ role: 'assistant', tool_calls: calls.map((args, index) => ({ index,
    id: `harness-memory-pages-${results.length}-${index}`, type: 'function',
    function: { name: 'mcp__search_memory', arguments: JSON.stringify({ ...args, format: 'json' }) } })) });
  const text = n => results[n].content;
  const parse = n => JSON.parse(text(n).slice(text(n).indexOf('{'), text(n).lastIndexOf('}') + 1));
  if (!results.length) return call([
    { query: 'longuniquefixture', limit: 1, content_limit: 1000 },
    { memory_id: fixture.longId, content_offset: 8000 },
    { memory_id: fixture.foreignId }, { query: 'longuniquefixture', limit: 51 },
  ]);
  if (results.length === 4) {
    assert.equal(parse(0).source, 'semantic_owner'); assert.equal(parse(0).total, 1);
    assert.equal(parse(0).results[0].content, '😀'.repeat(1000));
    assert.equal(parse(0).results[0].recovery.content_offset, 1000);
    assert.equal(parse(1).results[0].content, '😀'.repeat(1000));
    assert.match(text(2), /not found in this project/); assert.match(text(3), /Invalid|51|50/);
    return call([{ ...parse(0).results[0].recovery }, { query: 'zzznomemorymatchqqq' }]);
  }
  assert.equal(results.length, 6);
  assert.equal(parse(4).source, 'current_store'); assert.equal(parse(4).results[0].content_offset, 1000);
  assert.equal(parse(4).results[0].content, '😀'.repeat(1000)); assert.equal(parse(5).total, 0);
  return { role: 'assistant', content: 'HARNESS_NATIVE_MEMORY_PAGES_OK' };
}

export async function runNativeMemoryPagesFixture({ app, root, dashboard, post, setSession, setFixture }) {
  const caseRoot = join(dirname(root), 'memory-pages'); await mkdir(caseRoot);
  await writeFile(join(caseRoot, 'index.ts'), 'export const memoryFixture = true;');
  const project = await post('/api/projects', { name: 'Native memory pages', root_path: caseRoot });
  const ids = await app.evaluate(({ app }, { projectId, foreignRoot }) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const { SemanticStore } = require(join(app.getAppPath(), 'dist/packages/store/src/semantic-store.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
    try {
      new SemanticStore(db.raw()).upsertProfile({ purpose: 'memory', embedding_target: { kind: 'disabled' }, reranker_target: { kind: 'disabled' } });
      const foreign = db.createProject('Foreign memory fixture', foreignRoot);
      const long = db.createAgentMemory({ scope: 'project', projectId, name: 'longuniquefixture', type: 'convention', content: '😀'.repeat(9000), source: 'user' });
      const other = db.createAgentMemory({ scope: 'project', projectId: foreign.id, name: 'foreignfixture', type: 'convention', content: 'Never returned in another project.', source: 'user' });
      return { longId: long.id, foreignId: other.id };
    } finally { db.close(); }
  }, { projectId: project.id, foreignRoot: caseRoot + '-foreign' });
  setFixture(ids);
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native paged memory',
    provider: 'harness-local', model: 'harness-model', agent: 'explore', max_turns: 4 }); setSession(session.id);
  const stream = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120000), body: JSON.stringify({ content: 'HARNESS_NATIVE_MEMORY_PAGES', profile: 'full', max_turns: 4 }) });
    if (!response.ok) throw new Error('Memory pages fixture ' + response.status); return response.text();
  }, session.id);
  assert(stream.includes('HARNESS_NATIVE_MEMORY_PAGES_OK'), stream.slice(-7000));
  return { sessionId: session.id, passed: true, ownedSearch: true, unicodePagination: true, currentReadById: true,
    foreignProjectRejected: true, invalidLimitRejected: true, emptyJson: true, mode: 'isolated memory owner; FTS only' };
}
