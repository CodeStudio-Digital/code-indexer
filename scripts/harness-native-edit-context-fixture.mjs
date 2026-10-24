import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeEditContextDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_EDIT_CONTEXT/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  for (const name of ['mcp__prepare_edit', 'mcp__trace_usage']) assert(body.tools.some(t => t.function?.name === name));
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-edit-context-${results.length}-${index}`, type: 'function',
    function: { name: 'mcp__' + name, arguments: JSON.stringify({ ...args, format: 'json' }) } })) });
  const text = n => results[n].content;
  const parse = n => JSON.parse(text(n).slice(text(n).indexOf('{'), text(n).lastIndexOf('}') + 1));
  if (!results.length) return call([
    ['prepare_edit', { symbol_name: 'target', file_path: 'target.ts', max_callers: 2, max_imports: 2, max_tests: 2, max_lines: 2 }],
    ['trace_usage', { symbol_name: 'target', depth: 3 }],
    ['prepare_edit', { symbol_name: 'target', file_path: 'wrong.ts' }],
    ['trace_usage', { symbol_name: 'target', depth: 6 }],
  ]);
  if (results.length === 4) {
    const first = parse(0), trace = parse(1);
    assert.equal(first.symbol.line, 104); assert.equal(first.body.start_line, 104);
    assert.equal(first.callers.total, 19); assert.equal(first.callers.shown, 2);
    assert.equal(first.callers.recovery.declaration_line, 104);
    assert.equal(first.imports_total, 103); assert.equal(first.imports.length, 2);
    assert.equal(first.tests_covering_total, 7); assert.equal(first.tests_covering.length, 2);
    assert.equal(trace.graph_kind, 'name_based'); assert.equal(trace.callers.length, 5);
    assert.deepEqual(trace.callers[0].symbols_in_file, ['caller0']);
    assert.equal(trace.callers[0].callers[0].stop, 'already_expanded');
    assert(trace.recoveries.some(r => r.symbol === 'target' && r.total === 12 && r.recovery.offset === 5));
    assert.match(text(2), /SYMBOL_NOT_FOUND/); assert.match(text(3), /depth|6|5/);
    return call([
      ['prepare_edit', { symbol_name: 'target', file_path: 'target.ts', callers_offset: 17, imports_offset: 100, tests_offset: 5, line_offset: 500 }],
      ['trace_usage', { symbol_name: 'target', depth: 1 }],
      ['prepare_edit', { symbol_name: 'target' }],
      ['prepare_edit', { symbol_name: 'target', file_path: '../outside.ts' }],
    ]);
  }
  assert.equal(results.length, 8);
  const tail = parse(4), shallow = parse(5);
  assert.equal(tail.symbol.line, 104); assert.equal(tail.body.start_line, 604);
  assert.equal(tail.body.end_line, 706); assert(!tail.body.body.includes('export function caller0'));
  assert.equal(tail.callers.items.length, 2); assert.equal(tail.imports.length, 3); assert.equal(tail.tests_covering.length, 2);
  assert.equal(shallow.callers.length, 5); assert(shallow.callers.every(c => c.stop === 'depth_limit' && c.callers.length === 0));
  assert.equal(parse(6).error, 'ambiguous'); assert.equal(parse(6).total, 2);
  assert.match(text(7), /outside the project root/);
  return { role: 'assistant', content: 'HARNESS_NATIVE_EDIT_CONTEXT_OK' };
}

export async function runNativeEditContextFixture({ app, root, dashboard, post, setSession }) {
  const caseRoot = join(dirname(root), 'edit-context'); await mkdir(caseRoot);
  const imports = Array.from({ length: 103 }, (_, i) => 'library' + String(i).padStart(3, '0'));
  await Promise.all([
    writeFile(join(caseRoot, 'target.ts'), [...imports.map((s, i) => `import x${i} from '${s}';`),
      'export function target() {', '  caller0();', ...Array.from({ length: 600 }, (_, i) => `  return ${i};`), '}',
      ...Array.from({ length: 12 }, (_, i) => `export function caller${i}() { target(); }`)].join('\n')),
    writeFile(join(caseRoot, 'other.ts'), 'export function target() {}'),
    writeFile(join(caseRoot, 'wrong.ts'), 'export function nope() {}'),
    ...Array.from({ length: 7 }, (_, i) => writeFile(join(caseRoot, `cover${i}.test.ts`), "import { target } from './target';\nexport const testValue = 1;")),
  ]);
  const project = await post('/api/projects', { name: 'Native edit context', root_path: caseRoot });
  await app.evaluate(({ app }, { projectId, imports }) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
    const file = (path, isTest = false) => db.upsertFile(projectId, { path, isTest, language: 'typescript', size: 1000, lineCount: 1000, contentHash: 'fixture' });
    const symbol = (name, line, end_line) => ({ name, kind: 'function', signature: '()', parent: null, line, end_line,
      modifiers: [], return_type: null, parameters: null, exported: true, comment: null, tags: [] });
    try {
      const id = file('target.ts');
      db.upsertSymbols(projectId, id, 'target.ts', [symbol('target', 104, 706), ...Array.from({ length: 12 }, (_, i) => symbol('caller' + i, 707 + i, 707 + i))]);
      db.upsertSymbolReferences(projectId, id, 'target.ts', [{ symbol_name: 'caller0', kind: 'call', line: 105 },
        ...Array.from({ length: 12 }, (_, i) => ({ symbol_name: 'target', kind: 'call', line: 707 + i }))]);
      db.upsertFileDependencies(projectId, id, 'target.ts', [], imports);
      const other = file('other.ts'); db.upsertSymbols(projectId, other, 'other.ts', [symbol('target', 1, 1)]);
      for (let i = 0; i < 7; i++) { const path = `cover${i}.test.ts`, testId = file(path, true); db.upsertFileDependencies(projectId, testId, path, ['./target'], []); db.upsertSymbolReferences(projectId, testId, path, [{ symbol_name: 'target', kind: 'import', line: 1 }]); }
    } finally { db.close(); }
  }, { projectId: project.id, imports });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native bounded edit context',
    provider: 'harness-local', model: 'harness-model', agent: 'explore', max_turns: 4 }); setSession(session.id);
  const stream = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120000), body: JSON.stringify({ content: 'HARNESS_NATIVE_EDIT_CONTEXT', profile: 'full', max_turns: 4 }) });
    if (!response.ok) throw new Error('Edit context fixture ' + response.status); return response.text();
  }, session.id);
  assert(stream.includes('HARNESS_NATIVE_EDIT_CONTEXT_OK'), stream.slice(-7000));
  return { sessionId: session.id, passed: true, boundedCallers: true, sameFileCallers: true, cycles: true,
    bodyPagination: true, declarationAnchor: true, importPagination: true, coveringTestsPagination: true, scopeRejection: true };
}
