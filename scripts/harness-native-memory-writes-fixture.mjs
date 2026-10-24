import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nativeMcpMemoryDelta, runNativeMcpMemoryFixture, recoverNativeMcpMemoryFixture } from './harness-native-mcp-memory-fixture.mjs';

const kept = 'bounded-memory-fixture', preference = 'memory-fixture-preference', temporary = 'temporary-memory-fixture';
const rich = 'rich-memory-fixture';
export function nativeMemoryWritesDelta(body) {
  const owned = nativeMcpMemoryDelta(body); if (owned) return owned;
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_MEMORY_WRITES_(CREATE|RECOVER)/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  for (const name of ['remember', 'forget_memory', 'recall_memory', 'mcp__save_memory']) assert(body.tools.some(t => t.function?.name === name), `missing ${name}`);
  const recover = JSON.stringify(body.messages[start].content).includes('_RECOVER');
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-memory-write-${recover}-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  if (!results.length && recover) return call([['recall_memory', { mode: 'list' }], ['forget_memory', { target: temporary }]]);
  if (!results.length) {
    const project = ['remember', { title: kept, content: 'Bound memory retrieval to twelve results per page.', type: 'convention' }];
    const user = ['remember', { title: preference, content: 'Always report durable memory writes accurately.', scope: 'user' }];
    const metadata = { title: rich, category: 'architecture', importance: 0.94, project_name: 'foreign', scope: 'user', projectId: 999 };
    return call([project, user, project, user, ['remember', { title: temporary, content: 'Archive this obsolete fixture after checking ownership.' }],
      ['mcp__save_memory', { ...metadata, content: 'Keep durable file references.', referenced_files: ['first.ts'] }],
      ['mcp__save_memory', { ...metadata, content: 'Keep durable file references. Preserve dependencies after merging.', referenced_files: ['second.ts'] }]]);
  }
  if (!recover && results.length === 7) {
    results.slice(0, 5).forEach(result => assert.match(result.content, /Remembered/));
    assert.match(results[2].content, /merged into existing/); assert.match(results[3].content, /merged into existing/);
    assert.match(results[5].content, /created=1/); assert.match(results[6].content, /merged=1/);
    return call([['recall_memory', { mode: 'list' }], ['forget_memory', { target: temporary }],
      ['forget_memory', { target: preference, scope: 'project' }], ['recall_memory', { mode: 'list' }]]);
  }
  if (recover) {
    assert.equal(results.length, 2); assert.match(results[0].content, new RegExp(kept));
    assert.match(results[0].content, new RegExp(rich));
    assert(!results[0].content.includes(temporary)); assert.match(results[1].content, /No project memory/);
  } else {
    assert.equal(results.length, 11); assert.match(results[7].content, new RegExp(temporary));
    assert.match(results[8].content, /archived from project/); assert.match(results[9].content, /No project memory/);
    assert.match(results[10].content, new RegExp(kept)); assert(!results[10].content.includes(temporary));
  }
  return { role: 'assistant', content: `HARNESS_NATIVE_MEMORY_WRITES_${recover ? 'RECOVER' : 'CREATE'}_OK` };
}
async function send(dashboard, id, stage) {
  const stream = await dashboard.evaluate(async ({ id, stage }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120000), body: JSON.stringify({ content: `HARNESS_NATIVE_MEMORY_WRITES_${stage}`, profile: 'full', max_turns: 5 }) });
    if (!response.ok) throw new Error('Memory write fixture ' + response.status + ': ' + (await response.text()).slice(0, 1000));
    return response.text();
  }, { id, stage });
  assert(stream.includes(`HARNESS_NATIVE_MEMORY_WRITES_${stage}_OK`), stream.slice(-7000));
}
export async function assertNativeMemories(app, evidence) {
  const rows = await app.evaluate(({ app }, evidence) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
    try {
      return db.raw().prepare('SELECT id, project_id, scope, name, content, type, importance, referenced_files, archived_at FROM agent_memory WHERE project_id IN (?, ?, 0) AND name LIKE ? ORDER BY id')
        .all(evidence.projectId, evidence.foreignProjectId, '%memory-fixture%');
    } finally { db.close(); }
  }, evidence);
  const owned = rows.filter(row => row.project_id === evidence.projectId);
  assert.equal(owned.filter(row => row.name === kept && !row.archived_at).length, 1, 'duplicate project memory');
  const detailed = owned.filter(row => row.name === rich && !row.archived_at);
  assert.equal(detailed.length, 1); assert.equal(detailed[0].type, 'architecture');
  assert(detailed[0].importance >= 0.94);
  assert.deepEqual(JSON.parse(detailed[0].referenced_files).map(file => file.path), ['first.ts', 'second.ts']);
  assert(!rows.some(row => row.name === rich && row.scope === 'user'), 'MCP scope injection escaped project');
  assert.equal(owned.filter(row => row.name === temporary && row.archived_at).length, 1, 'missing archive');
  const users = rows.filter(row => row.scope === 'user' && row.name === preference && !row.archived_at);
  assert.equal(users.length, 1, 'duplicate user preference');
  assert.equal(rows.filter(row => row.project_id === evidence.foreignProjectId && !row.archived_at).length, 1, 'foreign project changed');
  return rows.map(({ id, project_id, scope, name, archived_at }) => ({ id, project_id, scope, name, archived: !!archived_at }));
}
export async function runNativeMemoryWritesFixture({ app, dashboard, post, root, setSession }) {
  const caseRoot = join(dirname(root), 'memory-writes'); await mkdir(caseRoot);
  const project = await post('/api/projects', { name: 'Native memory writes', root_path: caseRoot });
  const foreignProjectId = await app.evaluate(({ app }, foreignRoot) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const { SemanticStore } = require(join(app.getAppPath(), 'dist/packages/store/src/semantic-store.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
    try {
      new SemanticStore(db.raw()).upsertProfile({ purpose: 'memory', embedding_target: { kind: 'disabled' }, reranker_target: { kind: 'disabled' } });
      const foreign = db.createProject('Foreign memory writes', foreignRoot);
      db.createAgentMemory({ projectId: foreign.id, scope: 'project', name: 'temporary-memory-fixture', type: 'note', content: 'Foreign fact must survive.', source: 'user' });
      return foreign.id;
    } finally { db.close(); }
  }, caseRoot + '-foreign');
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native memory writes', provider: 'harness-local', model: 'harness-model', max_turns: 5 });
  setSession(session.id); await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
  await send(dashboard, session.id, 'CREATE');
  const evidence = { sessionId: session.id, projectId: project.id, foreignProjectId, passed: true,
    projectWrite: true, userWrite: true, deduplicated: true, archiveScoped: true, mode: 'isolated profile; FTS only' };
  evidence.rows = await assertNativeMemories(app, evidence);
  evidence.mcp = await runNativeMcpMemoryFixture({ app, dashboard, post, root, setSession });
  return evidence;
}
export async function recoverNativeMemoryWritesFixture({ app, dashboard, evidence, setSession }) {
  assert.deepEqual(await assertNativeMemories(app, evidence), evidence.rows);
  setSession(evidence.sessionId); await send(dashboard, evidence.sessionId, 'RECOVER');
  assert.deepEqual(await assertNativeMemories(app, evidence), evidence.rows);
  const mcp = await recoverNativeMcpMemoryFixture({ app, dashboard, evidence: evidence.mcp, setSession });
  return { passed: true, durableRowsPreserved: true, archivedMemoryStayedArchived: true, mcp };
}
