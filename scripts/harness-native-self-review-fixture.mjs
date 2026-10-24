import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function createSelfReviewFixture() {
  let started;
  return { calls: [], cancelledConnectionClosed: false,
    cancelStarted: new Promise(resolve => { started = resolve; }), markCancelStarted: () => started() };
}
export function respondSelfReview(body, response, fixture) {
  const system = String(body.messages.find(m => m.role === 'system')?.content ?? '');
  if (!system.startsWith('You are a meticulous senior software engineer doing a pre-commit code review.')) return false;
  const text = JSON.stringify(body.messages);
  assert.match(text, /review-target\.ts/); assert.match(text, /return 2/);
  const cancelled = text.includes('HARNESS_SELF_REVIEW_CANCEL');
  assert(cancelled || text.includes('HARNESS_SELF_REVIEW_COMPLETE'));
  fixture.calls.push(cancelled ? 'CANCEL' : 'COMPLETE');
  if (cancelled) {
    response.once('close', () => { fixture.cancelledConnectionClosed = true; });
    fixture.markCancelStarted(); return true;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: 'local-self-review', object: 'chat.completion', model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ findings: [{ severity: 'high',
      filePath: 'review-target.ts', newLine: 1, body: 'HARNESS_REVIEW_FINDING: changed return value.', suggestedFix: 'Verify the intended value.' }] }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  return true;
}
export function nativeSelfReviewDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_SELF_REVIEW_ROOT_/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  const stage = JSON.stringify(body.messages[start].content).match(/HARNESS_SELF_REVIEW_ROOT_(UNCONFIGURED|COMPLETE|CANCEL)/)[1];
  assert(body.tools.some(t => t.function?.name === 'self_review'));
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const call = (name, args) => ({ role: 'assistant', tool_calls: [{ index: 0, id: `self-review-${stage}-${results.length}`,
    type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  if (!results.length) return call('write_file', { path: 'review-target.ts', content: 'export function reviewTarget() { return 2; }\n' });
  if (results.length === 1) return call('self_review', { focus: `HARNESS_SELF_REVIEW_${stage}: review the changed return value.` });
  assert.notEqual(stage, 'CANCEL', 'Provider resumed after cancelled review'); assert.equal(results.length, 2);
  assert.match(results[1].content, stage === 'UNCONFIGURED' ? /Configure snapshot_review\/reviewer/ : /HARNESS_REVIEW_FINDING/);
  return { role: 'assistant', content: `HARNESS_SELF_REVIEW_${stage}_OK` };
}
async function reviewState(dashboard, id) {
  return dashboard.evaluate(async id => {
    const r = await fetch(`mcp://app/api/coder/sessions/${id}/snapshot/reviews`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('Review state HTTP ' + r.status + ': ' + await r.text()); return r.json();
  }, id);
}
export async function runNativeSelfReviewFixture({ app, dashboard, post, root, setSession, fixture }) {
  const cases = [];
  for (const stage of ['UNCONFIGURED', 'COMPLETE', 'CANCEL']) {
    if (stage === 'COMPLETE') await app.evaluate(({ app }) => {
      const { join } = process.getBuiltinModule('node:path');
      const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
      const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
      const { PipelineProviderBindingsStore } = require(join(app.getAppPath(), 'dist/packages/store/src/pipeline-provider-bindings-store.js'));
      const db = new CodeIndexDB(process.env.MCP_INDEX_DB, { busyTimeoutMs: 500 });
      try { new PipelineProviderBindingsStore(db.raw()).upsert({ pipeline_name: 'snapshot_review', binding_role: 'reviewer',
        provider_id: 'harness-local', model_id: 'harness-model', scope_type: 'global', enabled: true }); }
      finally { db.close(); }
    });
    const caseRoot = join(dirname(root), 'self-review-' + stage.toLowerCase()); await mkdir(caseRoot);
    await writeFile(join(caseRoot, 'review-target.ts'), 'export function reviewTarget() { return 1; }\n');
    const project = await post('/api/projects', { name: 'Self-review ' + stage, root_path: caseRoot });
    const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Self-review ' + stage,
      provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 5 });
    setSession(session.id); await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
    const pending = dashboard.evaluate(async ({ id, stage }) => {
      const r = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(90000), body: JSON.stringify({ content: 'HARNESS_SELF_REVIEW_ROOT_' + stage, profile: 'full', max_turns: 5 }) });
      if (!r.ok) throw new Error('Self-review HTTP ' + r.status + ': ' + await r.text()); return r.text();
    }, { id: session.id, stage });
    void pending.catch(() => {});
    let cancelAckMs;
    if (stage === 'CANCEL') {
      let timer;
      try { await Promise.race([fixture.cancelStarted, pending.then(text => { throw new Error('Review ended before cancellation: ' + text.slice(-5000)); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Review provider did not start')), 45000); })]); }
      finally { clearTimeout(timer); }
      const before = performance.now(); await post(`/api/coder/sessions/${session.id}/abort`, {}); cancelAckMs = performance.now() - before;
    }
    const stream = await pending;
    if (stage === 'CANCEL') { assert.match(stream, /"interrupted":true/); assert(fixture.cancelledConnectionClosed); }
    else assert(stream.includes(`HARNESS_SELF_REVIEW_${stage}_OK`), stream.slice(-8000));
    const state = await reviewState(dashboard, session.id);
    assert.equal(state.runs.length, 1); assert.equal(state.runs[0].status, stage === 'COMPLETE' ? 'completed' : 'error');
    assert.equal(state.comments.length, stage === 'COMPLETE' ? 1 : 0);
    if (stage === 'COMPLETE') assert.match(state.comments[0].body, /HARNESS_REVIEW_FINDING/);
    assert.match(await readFile(join(caseRoot, 'review-target.ts'), 'utf8'), /return 2/);
    cases.push({ stage, sessionId: session.id, passed: true, runId: state.runs[0].id, commentIds: state.comments.map(c => c.id), cancelAckMs });
  }
  assert.deepEqual(fixture.calls, ['COMPLETE', 'CANCEL']);
  return { cases, actualSnapshotReviewed: true, cancelledConnectionClosed: fixture.cancelledConnectionClosed };
}
export async function recoverNativeSelfReviewFixture({ dashboard, evidence }) {
  for (const item of evidence.cases) {
    const state = await reviewState(dashboard, item.sessionId);
    assert.equal(state.runs.length, 1); assert.equal(state.runs[0].id, item.runId);
    assert.equal(state.runs[0].status, item.stage === 'COMPLETE' ? 'completed' : 'error');
    assert.deepEqual(state.comments.map(c => c.id), item.commentIds);
  }
  return { passed: true, runs: evidence.cases.length, duplicateReviews: 0 };
}
