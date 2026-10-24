import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeDocsDelta(body, fixture) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_DOCS/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  if (fixture.mcp) return mcpDocsDelta(body, fixture, results);
  const text = result => typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-docs-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  for (const name of ['rag_search_docs', 'rag_read_doc', 'rag_doc_outline']) assert(body.tools.some(t => t.function?.name === name), 'missing native ' + name);
  for (const result of results) assert(!/not configured|not available|failed:|No doc chunk|No source with/i.test(text(result)), text(result).slice(0, 1000));
  if (!results.length) return call([['rag_search_docs', { query: 'HARNESSRAGUNIQUE' }],
    ['rag_doc_outline', { collection: 'Native fixture docs' }], ['rag_doc_outline', { source_id: fixture.source, limit: 2 }],
    ['rag_read_doc', { chunk_id: fixture.chunk, max_chars: 1000, window: 0 }]]);
  if (results.length === 4) {
    assert(text(results[0]).includes(`chunk_id: ${fixture.chunk}`)); assert(text(results[0]).includes('scope=project'));
    assert(text(results[1]).includes('source_id ' + fixture.source)); assert(text(results[2]).includes('"offset":2'));
    assert(text(results[3]).includes('char_offset:1000'));
    return call([['rag_read_doc', { chunk_id: fixture.chunk, char_offset: 65000, max_chars: 2000, window: 0 }],
      ['rag_read_doc', { chunk_id: fixture.chunk + 1, mode: 'section', limit: 2 }],
      ['rag_read_doc', { chunk_id: fixture.chunk + 1, mode: 'section', offset: 68, limit: 2 }],
      ['rag_doc_outline', { source_id: fixture.source, offset: 70, limit: 2 }]]);
  }
  assert.equal(results.length, 8); assert(text(results[4]).includes('RAGTAIL'));
  assert(text(results[5]).includes('offset:2')); assert(text(results[6]).includes('part-70')); assert(text(results[7]).includes('Last heading'));
  return { role: 'assistant', content: 'HARNESS_NATIVE_DOCS_OK' };
}

export async function runNativeDocsFixture({ app, dashboard, post, root, setSession, fixture }) {
  const caseRoot = join(dirname(root), 'docs'); await mkdir(caseRoot);
  const project = await post('/api/projects', { name: 'Native docs', root_path: caseRoot });
  const ids = await app.evaluate(({ app }, projectId) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const { DocStore } = require(join(app.getAppPath(), 'dist/packages/store/src/doc-store.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
    try {
      const docs = new DocStore(db.raw()), collection = docs.createCollection({ name: 'Native fixture docs' });
      const source = docs.createSource({ collection_id: collection.id, type: 'url', uri: 'https://docs.example/native' });
      docs.linkProjectCollection(projectId, collection.id);
      const chunks = docs.insertChunks(Array.from({ length: 72 }, (_, n) => ({ collection_id: collection.id, source_id: source.id,
        ord: n, heading_path: n === 0 ? 'Introduction' : n === 71 ? 'Last heading' : 'Guide', content_hash: 'fixture-' + n,
        token_count: 5, source_uri: source.uri, content: n === 0 ? 'HARNESSRAGUNIQUE ' + 'x'.repeat(66000) + ' RAGTAIL' : 'part-' + n })));
      return { source: source.id, chunk: chunks[0] };
    } finally { db.close(); }
  }, project.id);
  Object.assign(fixture, ids);
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native indexed docs',
    provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 5 });
  setSession(session.id);
  const stream = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ content: 'HARNESS_NATIVE_DOCS', profile: 'full', max_turns: 5 }) });
    const body = await response.text();
    if (!response.ok) throw new Error(`Docs fixture ${response.status} session=${id}: ${body.slice(0, 4000)}`);
    return body;
  }, session.id);
  assert(stream.includes('HARNESS_NATIVE_DOCS_OK'), stream.slice(-6000));
  return { sessionId: session.id, ...ids, passed: true, paginatedTailRecovered: true, projectScopedSearch: true, standaloneMcp: !!fixture.mcp };
}

function mcpDocsDelta(body, fixture, results) {
  for (const name of ['mcp__rag_search_docs', 'mcp__rag_read_doc', 'mcp__rag_doc_outline']) {
    assert(body.tools.some(t => t.function?.name === name), 'missing ' + name);
  }
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-mcpdocs-${results.length}-${index}`, type: 'function', function: { name: 'mcp__' + name, arguments: JSON.stringify(args) } })) });
  const parse = result => {
    assert.equal(typeof result.content, 'string');
    // MCP results can carry the harness's omission footer after the JSON body.
    const text = result.content, first = text.indexOf('{'), last = text.lastIndexOf('}');
    return JSON.parse(text.slice(first, last + 1));
  };
  if (!results.length) return call([['rag_search_docs', { query: 'HARNESSRAGUNIQUE' }],
    ['rag_doc_outline', { collection: 'Native fixture docs', limit: 1 }],
    ['rag_doc_outline', { source_id: fixture.source, limit: 2 }],
    ['rag_read_doc', { chunk_id: fixture.chunk, max_chars: 1000, window: 0 }]]);
  if (results.length === 4) {
    const values = results.map(parse);
    assert.equal(values[0].diag.mode, 'fts'); assert.equal(values[0].diag.scope, 'project');
    assert.equal(values[0].results[0].chunk_id, fixture.chunk); assert(values[0].results[0].snippet_truncated);
    assert.equal(values[1].sources[0].source_id, fixture.source);
    assert.equal(values[2].next_offset, 2); assert.equal(values[3].chunk.next_char_offset, 1000);
    return call([['rag_read_doc', { chunk_id: fixture.chunk, char_offset: 65000, max_chars: 2000, window: 0 }],
      ['rag_read_doc', { chunk_id: fixture.chunk + 1, mode: 'section', limit: 2 }],
      ['rag_read_doc', { chunk_id: fixture.chunk + 1, mode: 'section', offset: 68, limit: 2 }],
      ['rag_doc_outline', { source_id: fixture.source, offset: 70, limit: 2 }]]);
  }
  assert.equal(results.length, 8); const tail = results.slice(4).map(parse);
  assert(tail[0].chunk.content.includes('RAGTAIL')); assert.equal(tail[1].next_offset, 2);
  assert.equal(tail[2].chunks.at(-1).content, 'part-70'); assert.equal(tail[3].headings.at(-1).heading_path, 'Last heading');
  return { role: 'assistant', content: 'HARNESS_NATIVE_DOCS_OK' };
}
