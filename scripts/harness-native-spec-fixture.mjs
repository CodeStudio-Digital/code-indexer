import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const first = '# Feature\n\n## Context\nNative specification fixture.\n\n## Implementation Plan\nWrite approved-spec.txt.';
const revised = first + '\n\n## Acceptance Criteria\nRead the committed file after restart.';
export function nativeSpecDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_SPEC_(COMPLETE|RECOVER)/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  const recover = JSON.stringify(body.messages[start].content).includes('HARNESS_NATIVE_SPEC_RECOVER');
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const call = (name, args) => ({ role: 'assistant', tool_calls: [{ index: 0,
    id: `harness-spec-${recover ? 'recover' : 'complete'}-${results.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  if (recover) {
    if (!results.length) return call('read_file', { path: 'approved-spec.txt' });
    assert.match(results[0].content, /SPEC_APPROVED_WRITE/);
    if (results.length === 1) return call('write_file', { path: 'resumed-spec.txt', content: 'SPEC_RESUMED_WRITE' });
    assert.equal(results.length, 2); assert.match(results[1].content, /Wrote resumed-spec/);
    return { role: 'assistant', content: 'HARNESS_NATIVE_SPEC_RECOVER_OK' };
  }
  if (!results.length) return call('write_file', { path: 'blocked-spec.txt', content: 'MUST_NOT_EXIST' });
  assert.match(results[0].content, /spec_mode|spec.mode|submit_spec/i);
  if (results.length === 1) return call('submit_spec', { name: 'Native fixture', body: first });
  assert.match(results[1].content, /restart verification/);
  if (results.length === 2) return call('submit_spec', { name: 'Native fixture', body: first });
  assert.match(results[2].content, /already rejected/);
  if (results.length === 3) return call('submit_spec', { name: 'Native fixture', body: revised });
  assert.match(results[3].content, /Spec approved/);
  assert(body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('<system-reminder>Mode transition: Spec')), 'provider lost its approved transition reminder');
  if (results.length === 4) return call('write_file', { path: 'approved-spec.txt', content: 'SPEC_APPROVED_WRITE' });
  assert.equal(results.length, 5);
  return { role: 'assistant', content: 'HARNESS_NATIVE_SPEC_COMPLETE_OK' };
}
async function send(dashboard, id, stage) {
  return dashboard.evaluate(async ({ id, stage }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ content: `HARNESS_NATIVE_SPEC_${stage}`, profile: 'full', max_turns: 8 }) });
    if (!response.ok) throw new Error(`Spec fixture ${response.status}: ${await response.text()}`);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', text = ''; const paths = [];
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        const chunk = decoder.decode(value, { stream: true }); buffer += chunk; text += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (!event.includes('event: spec\n')) continue;
          const spec = JSON.parse(event.split('\n').find(line => line.startsWith('data: ')).slice(6)); paths.push(spec.spec_path);
          const post = body => fetch(`mcp://app/api/coder/sessions/${id}/spec-response`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
          if ((await post({ approved: true })).status !== 400) throw new Error('Missing spec identity accepted');
          if ((await post({ approved: true, interaction_id: 'native-tool:foreign' })).status !== 409) throw new Error('Foreign spec identity accepted');
          const accepted = await post({ approved: paths.length === 2, interaction_id: spec.id,
            requested_changes: paths.length === 1 ? 'Add restart verification' : undefined });
          if (!accepted.ok) throw new Error(`Spec response ${accepted.status}: ${await accepted.text()}`);
        }
      }
    } finally { reader.releaseLock(); }
    if (!text.includes(`HARNESS_NATIVE_SPEC_${stage}_OK`)) throw new Error(text.slice(-8000));
    return { paths };
  }, { id, stage });
}
export async function runNativeSpecFixture({ dashboard, post, root, setSession }) {
  const projectRoot = join(dirname(root), 'spec-tools'); await mkdir(projectRoot, { recursive: true });
  const project = await post('/api/projects', { name: 'Native specification', root_path: projectRoot });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native specification',
    provider: 'harness-local', model: 'harness-model', agent: 'spec', max_turns: 8 });
  setSession(session.id); const result = await send(dashboard, session.id, 'COMPLETE');
  assert.equal(result.paths.length, 2); assert.notEqual(...result.paths);
  assert.equal(await readFile(join(projectRoot, result.paths[0]), 'utf8'), first);
  assert.equal(await readFile(join(projectRoot, result.paths[1]), 'utf8'), revised);
  assert.equal((await readdir(join(projectRoot, '.mcp/specs'))).length, 2);
  await assert.rejects(access(join(projectRoot, 'blocked-spec.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(projectRoot, 'approved-spec.txt'), 'utf8'), 'SPEC_APPROVED_WRITE');
  return { sessionId: session.id, root: projectRoot, ...result, keyedApproval: true, draftIsolation: true, policyGate: true };
}
export async function recoverNativeSpecFixture({ dashboard, evidence, setSession, beforeSend }) {
  await beforeSend();
  setSession(evidence.sessionId); await send(dashboard, evidence.sessionId, 'RECOVER');
  assert.equal(await readFile(join(evidence.root, 'resumed-spec.txt'), 'utf8'), 'SPEC_RESUMED_WRITE');
  return { passed: true, restartReadConfirmed: true, approvedModePreserved: true };
}
