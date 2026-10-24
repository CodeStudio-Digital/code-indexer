import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativePathDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_PATH/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  assert(body.tools.some(t => t.function?.name === 'manage_path'));
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const call = calls => ({ role: 'assistant', tool_calls: calls.map((args, index) => ({ index,
    id: `harness-path-${results.length}-${index}`, type: 'function', function: { name: 'manage_path', arguments: JSON.stringify(args) } })) });
  if (!results.length) return call([
    { operation: 'mkdir', path: 'empty/nested' },
    { operation: 'move', from_path: 'source.txt', to_path: 'moved/result.txt' },
    { operation: 'move', from_path: 'tree', to_path: 'moved/tree' },
    { operation: 'move', from_path: 'collision.txt', to_path: 'occupied.txt' },
    { operation: 'delete', path: '.git' },
    { operation: 'delete', path: 'empty/nested' },
  ]);
  if (results.length === 6) {
    assert.match(results[0].content, /Created directory/); assert.match(results[1].content, /Moved source.txt/);
    assert.match(results[2].content, /Moved tree/); assert.match(results[3].content, /already exists/);
    assert.match(results[4].content, /protected/); assert.match(results[5].content, /to trash/);
    return call([
      { operation: 'delete', path: 'moved/result.txt' },
      { operation: 'delete', path: 'moved/tree', recursive: true, confirm: 'DELETE moved/tree' },
      { operation: 'delete', path: 'permanent.txt', delete_mode: 'permanent', confirm: 'PERMANENT DELETE permanent.txt' },
    ]);
  }
  assert.equal(results.length, 9); assert.match(results[6].content, /to trash/);
  assert.match(results[7].content, /to trash/); assert.match(results[8].content, /Deleted permanently/);
  return { role: 'assistant', content: 'HARNESS_NATIVE_PATH_OK' };
}

export async function assertNativePathFiles(evidence) {
  const root = evidence.root;
  assert.equal(await readFile(join(root, 'occupied.txt'), 'utf8'), 'occupied stays');
  assert.equal(await readFile(join(root, 'collision.txt'), 'utf8'), 'collision stays');
  for (const name of ['source.txt', 'tree', 'moved/result.txt', 'moved/tree', 'permanent.txt', 'empty/nested']) {
    await assert.rejects(stat(join(root, name)), { code: 'ENOENT' });
  }
  const trash = join(root, '.mcp-indexer/trash');
  const entries = await readdir(trash, { recursive: true });
  const file = entries.find(p => p.replaceAll('\\', '/').endsWith('/moved/result.txt'));
  const tree = entries.find(p => p.replaceAll('\\', '/').endsWith('/moved/tree/child.txt'));
  assert(file && tree); assert.equal(await readFile(join(trash, file), 'utf8'), 'exact file content');
  assert.equal(await readFile(join(trash, tree), 'utf8'), 'nested content');
  assert.equal((await readdir(trash)).length, 3);
}

export async function runNativePathFixture({ dashboard, post, root, setSession }) {
  const caseRoot = join(dirname(root), 'path-management'); await mkdir(join(caseRoot, 'tree'), { recursive: true });
  await Promise.all(Object.entries({ 'source.txt': 'exact file content', 'tree/child.txt': 'nested content',
    'collision.txt': 'collision stays', 'occupied.txt': 'occupied stays', 'permanent.txt': 'remove with confirmation' })
    .map(([name, value]) => writeFile(join(caseRoot, name), value)));
  const project = await post('/api/projects', { name: 'Native path management', root_path: caseRoot });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native path operations',
    provider: 'harness-local', model: 'harness-model', max_turns: 5 }); setSession(session.id);
  await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
  const stream = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ content: 'HARNESS_NATIVE_PATH', profile: 'full', max_turns: 5 }) });
    if (!response.ok) throw new Error('Path fixture ' + response.status); return response.text();
  }, session.id);
  assert(stream.includes('HARNESS_NATIVE_PATH_OK'), stream.slice(-7000));
  const evidence = { sessionId: session.id, root: caseRoot, passed: true, existingDestinationPreserved: true,
    trashPreservedFileAndDirectory: true, explicitPermanentDelete: true, protectedPathRejected: true };
  await assertNativePathFiles(evidence); return evidence;
}
