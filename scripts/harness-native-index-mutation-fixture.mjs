import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertNativeHttpRecovery } from './harness-native-http-fixture.mjs';

export function nativeIndexMutationDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_INDEX_MUTATION_/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  const stage = JSON.stringify(body.messages[start].content).match(/HARNESS_NATIVE_INDEX_MUTATION_(NESTED|FOLLOWUP|CANCEL|UNKNOWN)/)[1];
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  assert(body.tools.some(t => t.function?.name === 'mcp__index_project'));
  if (!results.length) {
    const input = { project_path: '.', rebuild_semantic: false };
    const calls = stage === 'NESTED'
      ? [['code_exec', { code: `return await tools.mcp__index_project(${JSON.stringify(input)});` }]]
      : [['mcp__index_project', input]];
    if (stage === 'CANCEL' || stage === 'UNKNOWN') calls.push(['create_file', { path: 'forbidden-after-index.txt', content: 'must not run' }]);
    return { role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index, id: `index-mutation-${stage}-${index}`,
      type: 'function', function: { name, arguments: JSON.stringify(args) } })) };
  }
  assert(!['CANCEL', 'UNKNOWN'].includes(stage), 'provider resumed after uncertain indexing');
  assert.equal(results.length, 1); assert.match(results[0].content, /job #\d+ was accepted/);
  return { role: 'assistant', content: `HARNESS_NATIVE_INDEX_MUTATION_${stage}_OK` };
}

async function send(dashboard, id, stage) {
  return dashboard.evaluate(async ({ id, stage }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120000), body: JSON.stringify({ content: `HARNESS_NATIVE_INDEX_MUTATION_${stage}`, profile: 'full', max_turns: 3 }) });
    if (!response.ok) throw new Error(`Indexing fixture ${response.status}: ${(await response.text()).slice(0, 1000)}`);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let stream = '', buffer = '', approvals = 0, cancelled = false, cancelAckMs;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        const text = decoder.decode(next.value, { stream: true }); stream += text; buffer += text;
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (stage === 'CANCEL' && !cancelled && /^event: tool_call_start$/m.test(frame)) {
            await window.harnessIndexEntered(); const started = performance.now();
            const abort = await fetch(`mcp://app/api/coder/sessions/${id}/abort`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            cancelAckMs = performance.now() - started;
            if (!abort.ok) throw new Error('Indexing cancel failed'); cancelled = true; await window.harnessIndexRelease();
          }
          if (!/^event: tool_approval_request$/m.test(frame)) continue;
          const data = JSON.parse(frame.split(/\r?\n/).find(line => line.startsWith('data: ')).slice(6));
          if (stage !== 'NESTED' || ++approvals !== 1 || data.toolName !== 'mcp__index_project') throw new Error('Unexpected indexing approval');
          const accepted = await fetch(`mcp://app/api/coder/sessions/${id}/tool-approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool_use_id: data.toolUseId, approved: true }) });
          if (!accepted.ok) throw new Error('Indexing approval failed');
        }
      }
    } finally { reader.releaseLock(); }
    return { stream, approvals, cancelled, cancelAckMs };
  }, { id, stage });
}

export async function runNativeIndexMutationFixture({ app, dashboard, post, root, setSession }) {
  const setup = async stage => {
    const caseRoot = join(dirname(root), `index-mutation-${stage.toLowerCase()}`); await mkdir(caseRoot);
    await writeFile(join(caseRoot, 'fixture.ts'), 'export function indexedFixture() { return 42; }\n');
    const project = await post('/api/projects', { name: `Native index ${stage}`, root_path: caseRoot });
    const session = await post('/api/coder/sessions', { project_id: project.id, title: project.name,
      provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 3 });
    await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: stage === 'NESTED' ? 'ask' : 'unrestricted' }, 'PATCH');
    setSession(session.id); return { projectId: project.id, sessionId: session.id, root: caseRoot };
  };
  const healthy = await setup('NESTED');
  const nested = await send(dashboard, healthy.sessionId, 'NESTED');
  assert(nested.stream.includes('HARNESS_NATIVE_INDEX_MUTATION_NESTED_OK'), nested.stream.slice(-7000)); assert.equal(nested.approvals, 1);
  await post(`/api/coder/sessions/${healthy.sessionId}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
  const faults = [];
  await dashboard.exposeFunction('harnessIndexEntered', async () => {
    for (let i = 0; i < 500; i++) { if (await app.evaluate(() => globalThis.harnessIndexFault.entered)) return; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('Indexing did not reach the owning service');
  });
  await dashboard.exposeFunction('harnessIndexRelease', () => app.evaluate(() => { globalThis.harnessIndexFault.release(); }));
  for (const stage of ['CANCEL', 'UNKNOWN']) {
    const fault = await setup(stage);
    await app.evaluate(({ app }, { projectId, stage }) => {
      const { join } = process.getBuiltinModule('node:path');
      const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
      const { OwnedProjectIndex } = require(join(app.getAppPath(), 'dist/apps/http-api/server/owned-project-index.js'));
      const original = OwnedProjectIndex.prototype.reconcile;
      let release; const gate = new Promise(r => { release = r; });
      const probe = globalThis.harnessIndexFault = { entered: false, effects: 0, release, original, OwnedProjectIndex };
      OwnedProjectIndex.prototype.reconcile = async function(id, input, control) {
        if (id !== projectId) return original.call(this, id, input, control);
        probe.entered = true;
        if (stage === 'CANCEL') { await gate; control.signal.throwIfAborted(); }
        const result = await original.call(this, id, input, control); probe.effects++;
        if (stage === 'UNKNOWN') throw new Error('Injected indexing ACK lost after scheduling');
        return result;
      };
    }, { projectId: fault.projectId, stage });
    try {
      const result = await send(dashboard, fault.sessionId, stage);
      const effects = await app.evaluate(() => globalThis.harnessIndexFault.effects);
      if (stage === 'CANCEL') { assert(result.cancelled); assert.equal(effects, 0); }
      else { assert(result.stream.includes('TOOL_OUTCOME_UNKNOWN'), result.stream.slice(-7000)); assert.equal(effects, 1); await assertNativeHttpRecovery(dashboard, fault.sessionId); }
      await assert.rejects(readFile(join(fault.root, 'forbidden-after-index.txt')), { code: 'ENOENT' });
      faults.push({ ...fault, stage, effects, cancelAckMs: result.cancelAckMs });
    } finally { await app.evaluate(() => { const p = globalThis.harnessIndexFault; p.release(); p.OwnedProjectIndex.prototype.reconcile = p.original; }); }
  }
  return { ...healthy, passed: true, nestedApprovalCount: nested.approvals, faults };
}

export async function recoverNativeIndexMutationFixture({ dashboard, evidence, setSession }) {
  setSession(evidence.sessionId); const result = await send(dashboard, evidence.sessionId, 'FOLLOWUP');
  assert(result.stream.includes('HARNESS_NATIVE_INDEX_MUTATION_FOLLOWUP_OK'), result.stream.slice(-7000));
  await assertNativeHttpRecovery(dashboard, evidence.faults.find(f => f.stage === 'UNKNOWN').sessionId);
  return { passed: true, checkpointResumed: true, uncertainIndexNotReplayed: true };
}
