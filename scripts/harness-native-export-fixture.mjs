import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertNativeHttpRecovery } from './harness-native-http-fixture.mjs';

export function nativeExportDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_EXPORT_/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  const stage = JSON.stringify(body.messages[start].content).match(/HARNESS_NATIVE_EXPORT_(COMPLETE|NESTED|FOLLOWUP|CANCEL|UNKNOWN)/)[1];
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  assert(body.tools.some(t => t.function?.name === 'mcp__export_docs'));
  if (!results.length) {
    const calls = stage === 'NESTED'
      ? [['code_exec', { code: 'const doc=await tools.mcp__export_docs({format:"json",sections:["symbols"]}); return {symbols:JSON.parse(doc).symbols.length};' }]]
      : [['mcp__export_docs', { format: 'markdown', sections: ['files'], project_name: 'foreign', outputPath: '../forbidden.md' }]];
    if (stage === 'UNKNOWN' || stage === 'CANCEL') calls.push(['create_file', { path: 'forbidden-after-export.txt', content: 'must not run' }]);
    return { role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index, id: `export-${stage}-${index}`, type: 'function',
      function: { name, arguments: JSON.stringify(args) } })) };
  }
  assert(!['CANCEL', 'UNKNOWN'].includes(stage), 'provider resumed after uncertain/cancelled export');
  assert.equal(results.length, 1);
  assert.match(results[0].content, stage === 'NESTED' ? /"symbols":\s*601/ : /fixture.ts/);
  assert(!/TOOL_OUTCOME_UNKNOWN|host_capability_executor_failed/.test(results[0].content));
  return { role: 'assistant', content: `HARNESS_NATIVE_EXPORT_${stage}_OK` };
}

async function send(dashboard, sessionId, stage) {
  return dashboard.evaluate(async ({ sessionId, stage }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${sessionId}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90000),
      body: JSON.stringify({ content: `HARNESS_NATIVE_EXPORT_${stage}`, profile: 'full', max_turns: 3 }) });
    if (!response.ok) throw new Error(`Export ${response.status}: ${(await response.text()).slice(0, 4000)}`);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let stream = '', buffer = '', approvals = 0, cancelled = false, cancelAckMs;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        const text = decoder.decode(next.value, { stream: true }); stream += text; buffer += text;
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (stage === 'CANCEL' && !cancelled && /^event: tool_call_start$/m.test(frame)) {
            await window.harnessExportEntered();
            const started = performance.now();
            const abort = await fetch(`mcp://app/api/coder/sessions/${sessionId}/abort`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            cancelAckMs = performance.now() - started;
            if (!abort.ok) throw new Error('Export cancel failed'); cancelled = true;
            await window.harnessExportRelease();
          }
          if (!/^event: tool_approval_request$/m.test(frame)) continue;
          const data = JSON.parse(frame.split(/\r?\n/).find(line => line.startsWith('data: ')).slice(6));
          if (stage !== 'NESTED' || ++approvals !== 1 || data.toolName !== 'mcp__export_docs') throw new Error('Unexpected export approval');
          await window.harnessExportBeforeApproval();
          const accepted = await fetch(`mcp://app/api/coder/sessions/${sessionId}/tool-approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool_use_id: data.toolUseId, approved: true }) });
          if (!accepted.ok) throw new Error('Export approval failed');
        }
      }
    } finally { reader.releaseLock(); }
    return { stream, approvals, cancelled, cancelAckMs };
  }, { sessionId, stage });
}

export async function runNativeExportFixture({ app, dashboard, post, root, isolated, setSession }) {
  const setup = async (name, suffix) => {
    const caseRoot = join(dirname(root), `export-${suffix}`); await mkdir(caseRoot);
    await writeFile(join(caseRoot, 'fixture.ts'), Array.from({ length: 601 }, (_, i) => `export function symbol${i}(){}`).join('\n'));
    const project = await post('/api/projects', { name, root_path: caseRoot });
    await app.evaluate(({ app }, projectId) => {
      const { join } = process.getBuiltinModule('node:path');
      const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
      const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
      const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
      try {
        const id = db.upsertFile(projectId, { path: 'fixture.ts', language: 'typescript', size: 24000, lineCount: 601, contentHash: 'fixture' });
        db.upsertSymbols(projectId, id, 'fixture.ts', Array.from({ length: 601 }, (_, i) => ({ name: 'symbol' + i,
          kind: 'function', signature: '()', parent: null, modifiers: [], return_type: null, parameters: null,
          line: i + 1, exported: true, comment: null, tags: [] })));
      } finally { db.close(); }
    }, project.id);
    const session = await post('/api/coder/sessions', { project_id: project.id, title: name, provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 3 });
    await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
    return { projectId: project.id, sessionId: session.id, root: caseRoot, name };
  };
  const healthy = await setup('Native export', 'healthy'); setSession(healthy.sessionId);
  const complete = await send(dashboard, healthy.sessionId, 'COMPLETE');
  assert(complete.stream.includes('HARNESS_NATIVE_EXPORT_COMPLETE_OK'), complete.stream.slice(-6000));
  const exportRoot = join(isolated, 'data', 'exports');
  assert.match(await readFile(join(exportRoot, 'Native export.md'), 'utf8'), /fixture.ts/);
  await post(`/api/coder/sessions/${healthy.sessionId}/tool-permission-mode`, { mode: 'ask' }, 'PATCH');
  await dashboard.exposeFunction('harnessExportBeforeApproval', async () => assert.rejects(readFile(join(exportRoot, 'Native export.json')), { code: 'ENOENT' }));
  const nested = await send(dashboard, healthy.sessionId, 'NESTED');
  assert(nested.stream.includes('HARNESS_NATIVE_EXPORT_NESTED_OK'), nested.stream.slice(-6000));
  assert.equal(nested.approvals, 1);
  assert.equal(JSON.parse(await readFile(join(exportRoot, 'Native export.json'), 'utf8')).symbols.length, 601);
  await post(`/api/coder/sessions/${healthy.sessionId}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
  const faults = [];
  await dashboard.exposeFunction('harnessExportEntered', async () => {
    for (let i = 0; i < 500; i++) { if (await app.evaluate(() => globalThis.harnessExportFault.entered)) return; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('Export did not reach owned service');
  });
  await dashboard.exposeFunction('harnessExportRelease', () => app.evaluate(() => { globalThis.harnessExportFault.release(); }));
  for (const stage of ['CANCEL', 'UNKNOWN']) {
    const fault = await setup('Native export ' + stage, stage.toLowerCase()); setSession(fault.sessionId);
    await app.evaluate(({ app }, { projectId, stage }) => {
      const { join } = process.getBuiltinModule('node:path');
      const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
      const { ExportService } = require(join(app.getAppPath(), 'dist/packages/services/src/services/exporter.js'));
      const original = ExportService.prototype.exportProject;
      let release; const gate = new Promise(r => { release = r; });
      const probe = globalThis.harnessExportFault = { entered: false, effects: 0, release, original, ExportService };
      ExportService.prototype.exportProject = async function(id, input, control) {
        if (id !== projectId) return original.call(this, id, input, control);
        probe.entered = true;
        if (stage === 'CANCEL') { await gate; control.signal.throwIfAborted(); }
        const result = await original.call(this, id, input, control); probe.effects++;
        if (stage === 'UNKNOWN') throw new Error('Injected export ACK lost after physical publication');
        return result;
      };
    }, { projectId: fault.projectId, stage });
    try {
      const result = await send(dashboard, fault.sessionId, stage);
      const effects = await app.evaluate(() => globalThis.harnessExportFault.effects);
      if (stage === 'CANCEL') { assert(result.cancelled); assert.equal(effects, 0); }
      else { assert(result.stream.includes('TOOL_OUTCOME_UNKNOWN'), result.stream.slice(-6000)); assert.equal(effects, 1); await assertNativeHttpRecovery(dashboard, fault.sessionId); }
      await assert.rejects(readFile(join(fault.root, 'forbidden-after-export.txt')), { code: 'ENOENT' });
      faults.push({ ...fault, stage, effects, cancelAckMs: result.cancelAckMs });
    } finally { await app.evaluate(() => { const p = globalThis.harnessExportFault; p.release(); p.ExportService.prototype.exportProject = p.original; }); }
  }
  return { ...healthy, passed: true, symbols: 601, nestedApprovalCount: nested.approvals, faults };
}

export async function recoverNativeExportFixture({ dashboard, evidence, setSession }) {
  setSession(evidence.sessionId);
  const result = await send(dashboard, evidence.sessionId, 'FOLLOWUP');
  assert(result.stream.includes('HARNESS_NATIVE_EXPORT_FOLLOWUP_OK'), result.stream.slice(-6000));
  await assertNativeHttpRecovery(dashboard, evidence.faults.find(f => f.stage === 'UNKNOWN').sessionId);
  return { passed: true, checkpointResumed: true, uncertainWriteNotReplayed: true };
}
