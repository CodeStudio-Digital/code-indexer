import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeFileToolsDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_FILE_TOOLS/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  for (const name of ['mcp__read_file', 'mcp__get_file_skeleton']) assert(body.tools.some(t => t.function?.name === name));
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-filetools-${results.length}-${index}`, type: 'function', function: { name: 'mcp__' + name, arguments: JSON.stringify(args) } })) });
  const text = n => results[n].content;
  const parse = n => JSON.parse(text(n).slice(text(n).indexOf('{'), text(n).lastIndexOf('}') + 1));
  if (!results.length) return call([
    ['read_file', { file_path: 'plain.ts', max_lines: 2 }], ['read_file', { file_path: 'unicode.txt', byte_offset: 3, max_bytes: 4 }],
    ['get_file_skeleton', { file_path: 'src', max_symbols: 2, format: 'json' }],
    ['get_file_skeleton', { file_path: '.harness-unindexed/fallback.ts', max_symbols: 5, format: 'json' }],
  ]);
  if (results.length === 4) {
    assert.match(text(0), /"start_line":3/); assert(!text(0).includes('line-1201'));
    assert.equal(parse(1).content, '😀'); assert.equal(parse(1).byte_offset, 1);
    assert.equal(parse(2).next_offset, 2); assert.equal(parse(2).total_symbols, 553);
    assert.equal(parse(3).source, 'tree-sitter-fallback'); assert.equal(parse(3).next_offset, 5);
    return call([
      ['read_file', { file_path: 'plain.ts', force: true }], ['read_file', { file_path: 'plain.ts', start_line: 1200 }],
      ['get_file_skeleton', { file_path: 'src', offset: 500, max_symbols: 100, format: 'json' }],
      ['get_file_skeleton', { file_path: '.harness-unindexed/fallback.ts', offset: 20, max_symbols: 5, format: 'json' }],
    ]);
  }
  if (results.length === 8) {
    assert.match(text(4), /1201\tline-1201/); assert.match(text(5), /1201\tline-1201/);
    assert.equal(parse(6).shown_symbols, 53); assert.match(text(6), /symbol0552/);
    assert.equal(parse(7).shown_symbols, 5); assert.match(text(7), /fallback24/);
    return call([['read_file', { file_path: 'regex.txt', search_term: '(a+)+$' }], ['read_file', { file_path: '../escape' }]]);
  }
  assert.equal(results.length, 10); assert.match(text(8), /exceeded 50 ms/); assert.match(text(9), /outside the project root/);
  return { role: 'assistant', content: 'HARNESS_NATIVE_FILE_TOOLS_OK' };
}

export async function runNativeFileToolsFixture({ app, root, dashboard, post, setSession }) {
  const caseRoot = join(dirname(root), 'file-tools'); await mkdir(join(caseRoot, 'src'), { recursive: true });
  await mkdir(join(caseRoot, '.harness-unindexed'));
  await Promise.all([
    writeFile(join(caseRoot, 'plain.ts'), Array.from({ length: 1201 }, (_, i) => `line-${i + 1}`).join('\n')),
    writeFile(join(caseRoot, 'unicode.txt'), 'a😀é中tail'), writeFile(join(caseRoot, 'regex.txt'), 'a'.repeat(10000) + '!'),
    writeFile(join(caseRoot, 'src', 'outline.ts'), Array.from({ length: 553 }, (_, i) => `export function symbol${String(i).padStart(4, '0')}() {}`).join('\n')),
    writeFile(join(caseRoot, '.harness-unindexed', 'fallback.ts'), Array.from({ length: 25 }, (_, i) => `export function fallback${i}() {}`).join('\n')),
  ]);
  const project = await post('/api/projects', { name: 'Native file tools', root_path: caseRoot });
  await app.evaluate(({ app }, projectId) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
    try {
      const filePath = 'src/outline.ts', id = db.upsertFile(projectId, { path: filePath, language: 'typescript', size: 20000, lineCount: 553, contentHash: 'fixture' });
      db.upsertSymbols(projectId, id, filePath, Array.from({ length: 553 }, (_, i) => ({ name: 'symbol' + String(i).padStart(4, '0'),
        kind: 'function', signature: '()', parent: null, modifiers: [], return_type: null, parameters: null, line: i + 1,
        exported: true, comment: null, tags: [] })));
    } finally { db.close(); }
  }, project.id);
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native file readers',
    provider: 'harness-local', model: 'harness-model', agent: 'explore', max_turns: 5 }); setSession(session.id);
  const stream = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ content: 'HARNESS_NATIVE_FILE_TOOLS', profile: 'full', max_turns: 5 }) });
    if (!response.ok) throw new Error('File tools fixture ' + response.status); return response.text();
  }, session.id);
  assert(stream.includes('HARNESS_NATIVE_FILE_TOOLS_OK'), stream.slice(-7000));
  return { sessionId: session.id, passed: true, indexedSymbols: 553, fallbackSymbols: 25,
    utf8Pages: true, wholeFileAndTail: true, regexDeadline: true, traversalRejected: true };
}
