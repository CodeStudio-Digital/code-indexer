import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeIndexDelta(body, repoMap = false) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_INDEX/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const text = index => typeof results[index]?.content === 'string' ? results[index].content : JSON.stringify(results[index]?.content);
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-index-${results.length}-${index}`, type: 'function', function: { name: 'mcp__' + name, arguments: JSON.stringify(args) } })) });
  for (const name of ['get_project_overview', 'get_project_pulse', 'get_recently_modified_files', 'get_dependencies', 'get_dependents']) assert(body.tools.some(t => t.function?.name === 'mcp__' + name), 'missing native ' + name);
  if (repoMap) assert(body.tools.some(t => t.function?.name === 'mcp__get_repo_map'));
  if (!results.length) return call([
    ['get_project_pulse', { format: 'json' }], ['get_project_overview', { compact: true, max_files: 2 }],
    ['get_recently_modified_files', { limit: 2 }], ['get_dependents', { file_path: 'value.ts', limit: 2 }],
  ]);
  if (results.length === 4) {
    assert(text(0).includes('"file_count":554'), text(0));
    for (const index of [1, 2, 3]) assert(text(index).includes('"offset":2'), text(index));
    return call([['get_project_overview', { offset: 502 }], ['get_recently_modified_files', { offset: 502 }],
      ['get_dependents', { file_path: 'value.ts', offset: 502 }], ['get_dependencies', { file_path: 'src/consumer-0000.ts' }]]);
  }
  if (results.length === 8) {
  assert(text(4).includes('value.ts'), text(4));
  assert(text(5).includes('Showing 20 of 554'), text(5));
  assert(text(6).includes('consumer-0552.ts'), text(6)); assert(!text(6).includes('Continue:'), text(6));
  assert(text(7).includes('../value → value.ts'), text(7));
  if (repoMap) return call([
    ['get_repo_map', { limit: 2, format: 'json' }], ['get_repo_map', { offset: 550, format: 'json' }],
    ['get_repo_map', { limit: 1, max_tokens: 20 }], ['get_repo_map', { limit: 501 }],
  ]);
  } else {
    assert.equal(results.length, 12);
    const parse = n => JSON.parse(text(n).slice(text(n).indexOf('{'), text(n).lastIndexOf('}') + 1));
    assert.equal(parse(8).total, 554); assert.equal(parse(8).shown, 2); assert.equal(parse(8).next_offset, 2);
    assert.equal(parse(8).files[0].path, 'value.ts'); assert.equal(parse(8).files[0].dependent_count, 553);
    assert.equal(parse(9).shown, 4); assert.equal(parse(9).files.at(-1).path, 'src/consumer-0552.ts');
    assert.match(text(10), /rerun without max_tokens/); assert.match(text(11), /Invalid|501|500/);
  }
  return { role: 'assistant', content: 'HARNESS_NATIVE_INDEX_OK' };
}

export async function runNativeIndexFixture({ app, root, dashboard, post, setSession, repoMap = false }) {
  const caseRoot = join(dirname(root), 'index-navigation'); await mkdir(join(caseRoot, 'src'), { recursive: true });
  await writeFile(join(caseRoot, 'value.ts'), 'export const value = 42;\n');
  const paths = Array.from({ length: 553 }, (_, i) => `src/consumer-${String(i).padStart(4, '0')}.ts`);
  await Promise.all(paths.map(path => writeFile(join(caseRoot, path), 'import {value} from "../value"; export const count = value;\n')));
  const project = await post('/api/projects', { name: 'Native index navigation', root_path: caseRoot });
  await app.evaluate(({ app }, { projectId, paths }) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
    try {
      const row = path => ({ path, language: 'typescript', size: 62, lineCount: 1, contentHash: 'fixture' });
      db.upsertFile(projectId, row('value.ts'));
      for (const path of paths) { const id = db.upsertFile(projectId, row(path)); db.upsertFileDependencies(projectId, id, path, ['../value'], []); }
    } finally { db.close(); }
  }, { projectId: project.id, paths });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native index navigation',
    provider: 'harness-local', model: 'harness-model', agent: 'explore', max_turns: repoMap ? 5 : 4 });
  setSession(session.id);
  const stream = await dashboard.evaluate(async ({ id, maxTurns }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ content: 'HARNESS_NATIVE_INDEX', profile: 'full', max_turns: maxTurns }) });
    if (!response.ok) throw new Error('Index navigation ' + response.status); return response.text();
  }, { id: session.id, maxTurns: repoMap ? 5 : 4 });
  assert(stream.includes('HARNESS_NATIVE_INDEX_OK'), stream.slice(-7000));
  return { sessionId: session.id, passed: true, indexedFiles: 554, reverseDependencies: 553, pagedTailRecovered: true, repoMap };
}
