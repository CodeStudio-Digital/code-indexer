import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertNativeHttpRecovery } from './harness-native-http-fixture.mjs';

export function nativeMcpMemoryDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_MCP_MEMORY_/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  const stage = JSON.stringify(body.messages[start].content).match(/HARNESS_NATIVE_MCP_MEMORY_(NESTED|FOLLOWUP|CANCEL|UNKNOWN)/)[1];
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const input = { title: 'owned-memory-fault', content: 'Preserve a confirmed memory.', category: 'decision', importance: 0.91, referenced_files: ['fixture.ts'] };
  if (!results.length) {
    const calls = stage === 'NESTED'
      ? [['code_exec', { code: `return await tools.mcp__save_memory(${JSON.stringify(input)});` }]]
      : [['mcp__save_memory', input]];
    if (stage === 'CANCEL' || stage === 'UNKNOWN') calls.push(['create_file', { path: 'forbidden-after-memory.txt', content: 'must not run' }]);
    return { role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index, id: `mcp-memory-${stage}-${index}`,
      type: 'function', function: { name, arguments: JSON.stringify(args) } })) };
  }
  assert(!['CANCEL', 'UNKNOWN'].includes(stage), 'provider resumed after an uncertain memory effect');
  assert.equal(results.length, 1); assert.match(results[0].content, /created=1|merged=1/);
  return { role: 'assistant', content: `HARNESS_NATIVE_MCP_MEMORY_${stage}_OK` };
}

async function send(dashboard, id, stage) {
  return dashboard.evaluate(async ({ id, stage }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(90000), body: JSON.stringify({ content: `HARNESS_NATIVE_MCP_MEMORY_${stage}`, profile: 'full', max_turns: 3 }) });
    if (!response.ok) throw new Error('Memory fixture rejected: ' + response.status);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let stream = '', buffer = '', approvals = 0, cancelled = false, cancelAckMs;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        const text = decoder.decode(next.value, { stream: true }); stream += text; buffer += text;
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (stage === 'CANCEL' && !cancelled && /^event: tool_call_start$/m.test(frame)) {
            await window.harnessMemoryEntered(); const started = performance.now();
            const abort = await fetch(`mcp://app/api/coder/sessions/${id}/abort`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            cancelAckMs = performance.now() - started;
            if (!abort.ok) throw new Error('Memory cancellation rejected'); cancelled = true;
            await window.harnessMemoryRelease();
          }
          if (!/^event: tool_approval_request$/m.test(frame)) continue;
          const data = JSON.parse(frame.split(/\r?\n/).find(line => line.startsWith('data: ')).slice(6));
          if (stage !== 'NESTED' || ++approvals !== 1 || data.toolName !== 'mcp__save_memory') throw new Error('Unexpected memory approval');
          await window.harnessMemoryBeforeApproval();
          const accepted = await fetch(`mcp://app/api/coder/sessions/${id}/tool-approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool_use_id: data.toolUseId, approved: true }) });
          if (!accepted.ok) throw new Error('Memory approval rejected');
        }
      }
    } finally { reader.releaseLock(); }
    return { stream, approvals, cancelled, cancelAckMs };
  }, { id, stage });
}

async function memoryCount(app, projectId) {
  return app.evaluate(({ app }, id) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
    try { return db.raw().prepare('SELECT count(*) AS count FROM agent_memory WHERE project_id = ? AND archived_at IS NULL').get(id).count; }
    finally { db.close(); }
  }, projectId);
}

export async function runNativeMcpMemoryFixture({ app, dashboard, post, root, setSession }) {
  const setup = async stage => {
    const caseRoot = join(dirname(root), `mcp-memory-${stage.toLowerCase()}`); await mkdir(caseRoot);
    const project = await post('/api/projects', { name: `Native MCP memory ${stage}`, root_path: caseRoot });
    const session = await post('/api/coder/sessions', { project_id: project.id, title: project.name, provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 3 });
    await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: stage === 'NESTED' ? 'ask' : 'unrestricted' }, 'PATCH');
    setSession(session.id); return { projectId: project.id, sessionId: session.id, root: caseRoot };
  };
  const healthy = await setup('NESTED');
  await dashboard.exposeFunction('harnessMemoryBeforeApproval', async () => assert.equal(await memoryCount(app, healthy.projectId), 0));
  const nested = await send(dashboard, healthy.sessionId, 'NESTED');
  assert(nested.stream.includes('HARNESS_NATIVE_MCP_MEMORY_NESTED_OK'), nested.stream.slice(-6000));
  assert.equal(nested.approvals, 1); assert.equal(await memoryCount(app, healthy.projectId), 1);
  await post(`/api/coder/sessions/${healthy.sessionId}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
  await dashboard.exposeFunction('harnessMemoryEntered', async () => {
    for (let i = 0; i < 500; i++) { if (await app.evaluate(() => globalThis.harnessMemoryFault.entered)) return; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('Memory did not reach the owned writer');
  });
  await dashboard.exposeFunction('harnessMemoryRelease', () => app.evaluate(() => { globalThis.harnessMemoryFault.release(); }));
  const faults = [];
  for (const stage of ['CANCEL', 'UNKNOWN']) {
    const fault = await setup(stage);
    await app.evaluate(({ app }, { projectId, stage }) => {
      const { join } = process.getBuiltinModule('node:path');
      const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
      const { AgentMemoryWriter } = require(join(app.getAppPath(), 'dist/packages/services/src/memory/agent-memory-writer.js'));
      const original = AgentMemoryWriter.prototype.create;
      let release; const gate = new Promise(r => { release = r; });
      const probe = globalThis.harnessMemoryFault = { entered: false, effects: 0, release, original, AgentMemoryWriter };
      AgentMemoryWriter.prototype.create = async function(id, data) {
        if (id !== projectId) return original.call(this, id, data);
        probe.entered = true; if (stage === 'CANCEL') await gate;
        const result = await original.call(this, id, data); probe.effects++;
        if (stage === 'UNKNOWN') throw new Error('Injected memory ACK lost after persistence');
        return result;
      };
    }, { projectId: fault.projectId, stage });
    try {
      const result = await send(dashboard, fault.sessionId, stage);
      const effects = await app.evaluate(() => globalThis.harnessMemoryFault.effects);
      if (stage === 'CANCEL') { assert(result.cancelled); assert.equal(effects, 0); }
      else { assert(result.stream.includes('TOOL_OUTCOME_UNKNOWN'), result.stream.slice(-6000)); assert.equal(effects, 1); await assertNativeHttpRecovery(dashboard, fault.sessionId); }
      assert.equal(await memoryCount(app, fault.projectId), effects);
      await assert.rejects(readFile(join(fault.root, 'forbidden-after-memory.txt')), { code: 'ENOENT' });
      faults.push({ ...fault, stage, effects, cancelAckMs: result.cancelAckMs });
    } finally { await app.evaluate(() => { const p = globalThis.harnessMemoryFault; p.release(); p.AgentMemoryWriter.prototype.create = p.original; }); }
  }
  return { ...healthy, passed: true, nestedApprovalCount: nested.approvals, faults };
}

export async function recoverNativeMcpMemoryFixture({ app, dashboard, evidence, setSession }) {
  setSession(evidence.sessionId);
  const result = await send(dashboard, evidence.sessionId, 'FOLLOWUP');
  assert(result.stream.includes('HARNESS_NATIVE_MCP_MEMORY_FOLLOWUP_OK'), result.stream.slice(-6000));
  assert.equal(await memoryCount(app, evidence.projectId), 1);
  const unknown = evidence.faults.find(fault => fault.stage === 'UNKNOWN');
  await assertNativeHttpRecovery(dashboard, unknown.sessionId);
  assert.equal(await memoryCount(app, unknown.projectId), 1);
  return { passed: true, checkpointResumed: true, uncertainWriteNotReplayed: true };
}
