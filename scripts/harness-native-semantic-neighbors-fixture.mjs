import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeSemanticNeighborsDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_SEMANTIC_NEIGHBORS/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  assert(body.tools.some(t => t.function?.name === 'mcp__semantic_neighbors'));
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const call = args => ({ role: 'assistant', tool_calls: args.map((arg, index) => ({ index, id: `harness-neighbors-${results.length}-${index}`,
    type: 'function', function: { name: 'mcp__semantic_neighbors', arguments: JSON.stringify({ ...arg, format: 'json' }) } })) });
  const text = n => results[n].content;
  const parse = n => JSON.parse(text(n).slice(text(n).indexOf('{'), text(n).lastIndexOf('}') + 1));
  if (!results.length) return call([{ symbol_name: 'alpha', limit: 2 }, { symbol_name: 'duplicate' },
    { symbol_name: 'alpha', limit: 51 }, { symbol_name: 'alpha', file_path: 'wrong.ts' }]);
  if (results.length === 4) {
    assert.equal(parse(0).source, 'lexical_fallback'); assert.equal(parse(0).query_basis, 'current_body_excerpt'); assert(parse(0).shown <= 2);
    assert.equal(parse(1).error, 'ambiguous'); assert.equal(parse(1).total, 2);
    assert.match(text(2), /50|51|Invalid/); assert.match(text(3), /not found/);
    return call([{ symbol_id: parse(1).candidates[1].id, limit: 1 }]);
  }
  assert.equal(results.length, 5); assert.equal(parse(4).seed.name, 'duplicate'); assert.equal(parse(4).source, 'lexical_fallback');
  return { role: 'assistant', content: 'HARNESS_NATIVE_SEMANTIC_NEIGHBORS_OK' };
}

export async function runNativeSemanticNeighborsFixture({ app, root, dashboard, post, setSession }) {
  const caseRoot = join(dirname(root), 'semantic-neighbors'); await mkdir(caseRoot);
  const files = [['seed.ts', 'alpha'], ['neighbor.ts', 'beta'], ['first.ts', 'duplicate'], ['second.ts', 'duplicate'], ['wrong.ts', 'unrelated']];
  await Promise.all(files.map(([path, name]) => writeFile(join(caseRoot, path), '// shared arithmetic helper\nexport function ' + name + '() { return 42; }')));
  const project = await post('/api/projects', { name: 'Native semantic neighbors', root_path: caseRoot });
  await app.evaluate(({ app }, { projectId, files }) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const { SemanticStore } = require(join(app.getAppPath(), 'dist/packages/store/src/semantic-store.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
    try {
      new SemanticStore(db.raw()).upsertProfile({ purpose: 'code', embedding_target: { kind: 'disabled' }, reranker_target: { kind: 'disabled' } });
      for (const [path, name] of files) {
        const id = db.upsertFile(projectId, { path, language: 'typescript', size: 100, lineCount: 2, contentHash: 'fixture' });
        db.upsertSymbols(projectId, id, path, [{ name, kind: 'function', signature: '()', parent: null, modifiers: [],
          return_type: null, parameters: null, line: 2, end_line: 2, exported: true, comment: 'shared arithmetic helper', tags: [] }]);
      }
    } finally { db.close(); }
  }, { projectId: project.id, files });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native semantic neighbors',
    provider: 'harness-local', model: 'harness-model', agent: 'explore', max_turns: 4 }); setSession(session.id);
  const stream = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120000), body: JSON.stringify({ content: 'HARNESS_NATIVE_SEMANTIC_NEIGHBORS', profile: 'full', max_turns: 4 }) });
    if (!response.ok) throw new Error('Semantic neighbors fixture ' + response.status); return response.text();
  }, session.id);
  assert(stream.includes('HARNESS_NATIVE_SEMANTIC_NEIGHBORS_OK'), stream.slice(-7000));
  return { sessionId: session.id, passed: true, nameBasedEntry: true, ambiguity: true, legacyId: true,
    invalidLimit: true, wrongFile: true, mode: 'isolated owner with embeddings/reranker disabled; lexical fallback only' };
}
