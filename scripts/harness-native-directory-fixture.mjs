import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeDirectoryDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_DIRECTORY/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  assert(body.tools.some(t => t.function?.name === 'mcp__list_directory'));
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  if (!results.length) return { role: 'assistant', tool_calls: [
    { path: 'src', limit: 2, depth: 0 }, { path: 'src', offset: 500, depth: 0 },
    { path: '.harness-unindexed', limit: 2, depth: 0 }, { path: '.harness-unindexed', offset: 500, depth: 0 },
    { path: '../outside' },
  ].map((args, index) => ({ index, id: `harness-directory-${index}`, type: 'function',
    function: { name: 'mcp__list_directory', arguments: JSON.stringify(args) } })) };
  assert.equal(results.length, 5);
  for (const n of [0, 2]) assert.match(results[n].content, /"offset":2/);
  assert.match(results[1].content, /file-0552.ts/); assert.match(results[1].content, /of 553 indexed files/);
  assert.match(results[3].content, /disk fallback/); assert.match(results[3].content, /total 553/);
  assert.equal((results[3].content.match(/\(1B\)/g) ?? []).length, 53);
  assert.match(results[4].content, /outside the project root/);
  return { role: 'assistant', content: 'HARNESS_NATIVE_DIRECTORY_OK' };
}

export async function runNativeDirectoryFixture({ app, root, dashboard, post, setSession }) {
  const caseRoot = join(dirname(root), 'directories');
  await mkdir(join(caseRoot, 'src'), { recursive: true }); await mkdir(join(caseRoot, '.harness-unindexed'));
  const paths = Array.from({ length: 553 }, (_, i) => `file-${String(i).padStart(4, '0')}.ts`);
  await Promise.all(paths.flatMap(path => [writeFile(join(caseRoot, 'src', path), 'x'), writeFile(join(caseRoot, '.harness-unindexed', path), 'x')]));
  const project = await post('/api/projects', { name: 'Native directory pages', root_path: caseRoot });
  await app.evaluate(({ app }, { projectId, paths }) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
    try { for (const path of paths) db.upsertFile(projectId, { path: 'src/' + path, language: 'typescript', size: 1, lineCount: 1, contentHash: 'x' }); }
    finally { db.close(); }
  }, { projectId: project.id, paths });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native directories',
    provider: 'harness-local', model: 'harness-model', agent: 'explore', max_turns: 3 }); setSession(session.id);
  const stream = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ content: 'HARNESS_NATIVE_DIRECTORY', profile: 'full', max_turns: 3 }) });
    if (!response.ok) throw new Error('Directory fixture ' + response.status); return response.text();
  }, session.id);
  assert(stream.includes('HARNESS_NATIVE_DIRECTORY_OK'), stream.slice(-7000));
  return { sessionId: session.id, passed: true, indexedFiles: 553, diskFiles: 553, bothTailsRecovered: true, traversalRejected: true };
}
