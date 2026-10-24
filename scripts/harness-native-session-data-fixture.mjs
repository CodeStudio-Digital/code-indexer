import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeSessionDataDelta(body, fixture) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_SESSION_DATA_(CREATE|RECOVER)/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  assert(fixture);
  for (const name of ['read_plan', 'save_note', 'list_notes', 'recall_investigations', 'recall_conversation']) assert(body.tools.some(t => t.function?.name === name));
  const recover = JSON.stringify(body.messages[start].content).includes('_RECOVER');
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const calls = list => ({ role: 'assistant', tool_calls: list.map(([name, args], index) => ({ index,
    id: `harness-session-data-${recover}-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  if (recover) {
    if (!results.length) return calls([['list_notes', { limit: 10 }], ['read_plan', {}],
      ['recall_conversation', { mode: 'source', chapter_id: fixture.chapterId, limit: 2 }]]);
    assert.equal(results.length, 3); assert.match(results[0].content, /FINAL_NOTE_ALPHA/);
    assert.match(results[0].content, /NOTE_BETA/); assert.match(results[1].content, /approved/);
    assert.match(results[2].content, /LEGACY_SOURCE_ONE/); assert.match(results[2].content, /LEGACY_SOURCE_TWO/);
    return { role: 'assistant', content: 'HARNESS_NATIVE_SESSION_DATA_RECOVERED_OK' };
  }
  if (!results.length) return calls([
    ['save_note', { title: 'alpha', body: 'INITIAL_NOTE_ALPHA', kind: 'decision', pinned: true }],
    ['save_note', { title: 'beta', body: 'NOTE_BETA', kind: 'procedure' }],
    ['save_note', { title: 'alpha', body: 'FINAL_NOTE_ALPHA', kind: 'decision', pinned: true }],
    ['read_plan', {}], ['list_notes', { limit: 1 }], ['recall_investigations', { query: 'ownedfixture' }],
    ['recall_conversation', { mode: 'search', query: 'ownedfixture' }],
  ]);
  if (results.length === 7) {
    for (const r of results.slice(0, 3)) assert.match(r.content, /Saved note/);
    assert.match(results[3].content, /approved/); assert.match(results[3].content, /PRESERVED_PLAN/);
    assert.match(results[4].content, /FINAL_NOTE_ALPHA/); assert.match(results[4].content, /offset=1/);
    assert(!results[4].content.includes('NOTE_BETA'));
    assert.match(results[5].content, /INVESTIGATION_DIGEST/); assert.match(results[6].content, /ownedfixture/);
    return calls([['list_notes', { limit: 1, offset: 1 }], ['recall_conversation', { mode: 'get', chapter_id: fixture.chapterId }],
      ['recall_conversation', { mode: 'source', chapter_id: fixture.chapterId, limit: 1 }]]);
  }
  if (results.length === 10) {
    assert.match(results[7].content, /NOTE_BETA/); assert.match(results[8].content, /PRESERVED_RESUME/);
    assert.match(results[9].content, /LEGACY_SOURCE_ONE/); assert(!results[9].content.includes('LEGACY_SOURCE_TWO'));
    const cursor = JSON.parse(results[9].content.match(/cursor=("[^\n]+?")\./)[1]);
    return calls([['recall_conversation', { mode: 'source', chapter_id: fixture.chapterId, limit: 1, cursor }]]);
  }
  assert.equal(results.length, 11); assert.match(results[10].content, /LEGACY_SOURCE_TWO/);
  return { role: 'assistant', content: 'HARNESS_NATIVE_SESSION_DATA_CREATED_OK' };
}

async function send(dashboard, evidence, stage) {
  const stream = await dashboard.evaluate(async ({ id, stage }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(90000), body: JSON.stringify({ content: `HARNESS_NATIVE_SESSION_DATA_${stage}`, profile: 'full', max_turns: 5 }) });
    if (!response.ok) throw new Error('Session data fixture ' + response.status + ': ' + (await response.text()).slice(0, 1000)); return response.text();
  }, { id: evidence.sessionId, stage });
  assert(stream.includes(`HARNESS_NATIVE_SESSION_DATA_${stage === 'CREATE' ? 'CREATED' : 'RECOVERED'}_OK`), stream.slice(-7000));
  if (stage === 'CREATE') assert.equal((stream.match(/event: session_drive_changed/g) ?? []).length, 3);
}
export async function assertNativeSessionNotes(dashboard, evidence) {
  const state = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/drive`);
    if (!response.ok) throw new Error('Drive state ' + response.status); return response.json();
  }, evidence.sessionId);
  assert.equal(state.memory.length, 2);
  assert.equal(state.memory.find(n => n.title === 'alpha').body, 'FINAL_NOTE_ALPHA');
  assert.equal(state.memory.find(n => n.title === 'alpha').revision, 2);
  assert.equal(state.memory.find(n => n.title === 'beta').kind, 'procedure');
}
export async function runNativeSessionDataFixture({ app, dashboard, post, root, setSession, setFixture, reopenApplication }) {
  const caseRoot = join(dirname(root), 'session-data'); await mkdir(caseRoot, { recursive: true });
  const project = await post('/api/projects', { name: 'Native session data', root_path: caseRoot });
  // Seed and close a legacy bundle before the first native attempt. All data
  // belong to this isolated test profile; no active writer is shared.
  const evidence = await app.evaluate(async ({ app }, { projectId, caseRoot }) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { FsSessionStore } = require(join(app.getAppPath(), 'dist/packages/session-storage/src/fs-store/fs-session-store.js'));
    const store = FsSessionStore.fromRoots({ dataDir: process.env.MCP_DATA_DIR,
      projectRootResolver: { resolveProjectRoot: id => id === projectId ? caseRoot : null,
        listProjectRoots: () => [{ project_id: projectId, root_path: caseRoot }] } });
    try {
      const session = await store.createSession({ project_id: projectId, title: 'Legacy data in native attempts', provider: 'harness-local', model: 'harness-model' });
      for (const [role, text] of [['user', 'LEGACY_SOURCE_ONE'], ['assistant', 'LEGACY_SOURCE_TWO']]) {
        await store.appendMessage({ session_id: session.id, operation_id: text, message: { role, content: [{ type: 'text', text }] } });
      }
      await store.recordPlan({ session_id: session.id, tool_use_id: 'legacy-plan', plan_text: 'PRESERVED_PLAN', operation_id: 'plan-fixture' });
      await store.resolvePlan(session.id, 'legacy-plan', 'approved');
      await store.recordInvestigation({ session_id: session.id, topic: 'ownedfixture', summary: 'INVESTIGATION_DIGEST', operation_id: 'investigation-fixture' });
      const chapters = await store.insertRebuiltConversationChapters(session.id, [{ startMessageSeq: 1, endMessageSeq: 2,
        trigger: 'user_rebuild:fixture', title: 'ownedfixture', chapterJson: '{}', chapterText: 'ownedfixture chapter',
        resumeJson: '{}', resumeText: 'PRESERVED_RESUME', version: 3, chapterKind: 'rebuild', advancesContextBoundary: false }]);
      return { sessionId: session.id, chapterId: chapters.items[0].id };
    } finally { await store.close(); }
  }, { projectId: project.id, caseRoot });
  // The host catalog is a startup snapshot. Reopen normally so the closed
  // legacy bundle is discovered exactly as a pre-existing user's session is.
  ({ dashboard } = await reopenApplication());
  setFixture(evidence); setSession(evidence.sessionId);
  await post(`/api/coder/sessions/${evidence.sessionId}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
  await send(dashboard, evidence, 'CREATE'); await assertNativeSessionNotes(dashboard, evidence);
  return { ...evidence, passed: true, importedOnStartup: true, upsert: true, paginatedNotes: true, legacyPlan: true, legacyChapters: true, investigations: true };
}
export async function recoverNativeSessionDataFixture({ dashboard, evidence, setSession }) {
  setSession(evidence.sessionId); await send(dashboard, evidence, 'RECOVER');
  await assertNativeSessionNotes(dashboard, evidence);
  return { passed: true, notesPreserved: true, legacySourcePreserved: true };
}
