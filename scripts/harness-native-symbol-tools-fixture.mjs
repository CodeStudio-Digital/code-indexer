import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeSymbolToolsDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_SYMBOL_TOOLS/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  for (const name of ['mcp__find_implementations', 'mcp__get_hierarchy', 'mcp__get_symbol_body', 'mcp__find_references']) assert(body.tools.some(t => t.function?.name === name));
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-symboltools-${results.length}-${index}`, type: 'function', function: { name: 'mcp__' + name, arguments: JSON.stringify({ ...args, format: 'json' }) } })) });
  const text = n => results[n].content;
  const parse = n => JSON.parse(text(n).slice(text(n).indexOf('{'), text(n).lastIndexOf('}') + 1));
  if (!results.length) return call([
    ['find_implementations', { interface_name: 'Port', limit: 2 }], ['get_hierarchy', { symbol_name: 'Port', limit: 2 }],
    ['get_symbol_body', { symbol_name: 'target', max_lines: 2 }], ['get_hierarchy', { symbol_name: 'Same', limit: 1 }],
  ]);
  if (results.length === 4) {
    assert.equal(parse(0).total, 553); assert.equal(parse(0).next_offset, 2);
    assert.equal(parse(1).total, 553); assert.equal(parse(1).relations.length, 2);
    assert.equal(parse(2).start_line, 3); assert.equal(parse(2).range_kind, 'parsed'); assert.equal(parse(2).next_line_offset, 2);
    assert.equal(parse(3).error, 'ambiguous'); assert.equal(parse(3).total, 2);
    return call([
      ['find_implementations', { interface_name: 'Port', offset: 500 }], ['get_hierarchy', { symbol_name: 'Port', offset: 500 }],
      ['get_symbol_body', { symbol_name: 'target', line_offset: 500 }], ['get_hierarchy', { symbol_name: 'Same', file_path: 'second.ts' }],
    ]);
  }
  if (results.length === 8) {
    assert.equal(parse(4).shown, 53); assert.equal(parse(4).implementations.at(-1).name, 'Type0552'); assert.equal(parse(5).shown, 53);
    assert.equal(parse(6).end_line, 904); assert.match(parse(6).body, /console.log\(899\)/); assert(!parse(6).body.includes('unrelated'));
    assert.equal(parse(7).extends_chain[0], 'BaseB');
    return call([
      ['get_symbol_body', { symbol_name: 'target', file_path: 'other.ts' }],
      ['get_symbol_body', { symbol_name: 'target', file_path: '../outside.ts' }],
      ['get_hierarchy', { symbol_name: 'T0' }], ['find_implementations', { interface_name: 'Port', limit: 501 }],
    ]);
  }
  if (results.length === 12) {
    assert.match(text(8), /SYMBOL_NOT_FOUND/); assert.match(text(9), /outside the project root/);
    assert.equal(parse(10).chain_stop, 'depth_limit'); assert.equal(parse(10).extends_chain.length, 5); assert.match(text(11), /Invalid type page|501|500/);
    return call([
      ['find_references', { symbol_name: 'refTarget', limit: 2, source: 'index' }],
      ['find_references', { symbol_name: 'refTarget', offset: 550, source: 'index' }],
      ['find_references', { symbol_name: 'diskTarget', source: 'disk', search_path: '.harness-unindexed/calls.ts', limit: 50 }],
      ['find_references', { symbol_name: 'diskTarget', source: 'disk', search_path: '.harness-unindexed/calls.ts', scan_file_offset: 0, scan_line_offset: 50 }],
    ]);
  }
  assert.equal(results.length, 16); assert.equal(parse(12).total, 553); assert.equal(parse(12).references.length, 2);
  assert.equal(parse(13).references.length, 3); assert.equal(parse(13).next_offset, undefined);
  assert.equal(parse(14).total_at_least, 51); assert.equal(parse(14).recovery.scan_line_offset, 50);
  assert.equal(parse(15).references.length, 10); assert.equal(parse(15).total_exact, false);
  return { role: 'assistant', content: 'HARNESS_NATIVE_SYMBOL_TOOLS_OK' };
}

export async function runNativeSymbolToolsFixture({ app, root, dashboard, post, setSession }) {
  const caseRoot = join(dirname(root), 'symbol-tools'); await mkdir(caseRoot);
  await mkdir(join(caseRoot, '.harness-unindexed'));
  await Promise.all([
    writeFile(join(caseRoot, 'body.ts'), ['// shifted', '// shifted again', 'export function target() {', ...Array.from({ length: 900 }, (_, i) => `  console.log(${i});`), '}', 'export function unrelated() {}'].join('\n')),
    writeFile(join(caseRoot, 'other.ts'), 'export function another() { target(); }'),
    writeFile(join(caseRoot, 'types.ts'), 'export interface Port {}\n' + Array.from({ length: 553 }, (_, i) => `export class Type${String(i).padStart(4, '0')} implements Port {}`).join('\n')),
    writeFile(join(caseRoot, 'first.ts'), 'class Same extends BaseA {}'), writeFile(join(caseRoot, 'second.ts'), 'class Same extends BaseB {}'),
    writeFile(join(caseRoot, 'chain.ts'), Array.from({ length: 8 }, (_, i) => `class T${i}${i < 7 ? ` extends T${i + 1}` : ''} {}`).join('\n')),
    writeFile(join(caseRoot, 'refs.ts'), 'export function refTarget() {}\n' + Array.from({ length: 300 }, () => 'refTarget();').join('\n')),
    writeFile(join(caseRoot, 'refs-tail.ts'), 'export function refTarget() {}\n' + Array.from({ length: 253 }, () => 'refTarget();').join('\n')),
    writeFile(join(caseRoot, '.harness-unindexed', 'calls.ts'), Array.from({ length: 60 }, () => 'diskTarget();').join('\n')),
  ]);
  const project = await post('/api/projects', { name: 'Native symbol tools', root_path: caseRoot });
  await app.evaluate(({ app }, projectId) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
    const add = (path, symbols) => {
      const id = db.upsertFile(projectId, { path, language: 'typescript', size: 20000, lineCount: symbols.length, contentHash: 'fixture' });
      db.upsertSymbols(projectId, id, path, symbols.map((s, i) => ({ kind: 'class', signature: '', parent: null,
        modifiers: [], return_type: null, parameters: null, line: i + 1, exported: true, comment: null, tags: [], ...s })));
    };
    try {
      add('types.ts', [{ name: 'Port', kind: 'interface' }, ...Array.from({ length: 553 }, (_, i) => ({ name: 'Type' + String(i).padStart(4, '0'), implements_list: ['Port', 'Port'] }))]);
      add('body.ts', [{ name: 'target', kind: 'function', line: 1, end_line: 2 }]);
      add('first.ts', [{ name: 'Same', extends_from: 'BaseA' }]); add('second.ts', [{ name: 'Same', extends_from: 'BaseB' }]);
      add('chain.ts', Array.from({ length: 8 }, (_, i) => ({ name: 'T' + i, ...(i < 7 ? { extends_from: 'T' + (i + 1) } : {}) })));
      for (const [path, count] of [['refs.ts', 300], ['refs-tail.ts', 253]]) {
        const refId = db.upsertFile(projectId, { path, language: 'typescript', size: 10000, lineCount: count + 1, contentHash: 'fixture' });
        db.upsertSymbolReferences(projectId, refId, path, Array.from({ length: count }, (_, i) => ({ symbol_name: 'refTarget', kind: 'call', line: i + 2, snippet: 'refTarget();' })));
      }
    } finally { db.close(); }
  }, project.id);
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native symbol navigation',
    provider: 'harness-local', model: 'harness-model', agent: 'explore', max_turns: 6 }); setSession(session.id);
  const stream = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ content: 'HARNESS_NATIVE_SYMBOL_TOOLS', profile: 'full', max_turns: 6 }) });
    if (!response.ok) throw new Error('Symbol tools fixture ' + response.status); return response.text();
  }, session.id);
  assert(stream.includes('HARNESS_NATIVE_SYMBOL_TOOLS_OK'), stream.slice(-7000));
  return { sessionId: session.id, passed: true, implementations: 553, hierarchyTail: true, currentBody: true,
    ambiguity: true, boundedChain: true, wrongScopeRejected: true, traversalRejected: true, indexReferencePage: true, diskReferenceRecovery: true };
}
