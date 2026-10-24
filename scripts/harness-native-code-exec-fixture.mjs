import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { startNativeHttpFixture, assertNativeHttpRecovery } from './harness-native-http-fixture.mjs';

export function nativeCodeExecDelta(body, fixture) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_SCRIPT_(MIXED|APPROVAL|FOLLOWUP|CANCEL|UNKNOWN)/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  const stage = JSON.stringify(body.messages[start].content).match(/HARNESS_NATIVE_SCRIPT_(MIXED|APPROVAL|FOLLOWUP|CANCEL|UNKNOWN)/)[1];
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  assert(body.tools.some(t => t.function?.name === 'code_exec'), 'native script tool missing');
  if (!results.length) {
    const code = ['UNKNOWN', 'CANCEL'].includes(stage)
      ? `try { await tools.http_request(${JSON.stringify({ url: fixture.url + (stage === 'UNKNOWN' ? '/lost-ack' : '/stall'), method: stage === 'UNKNOWN' ? 'POST' : 'GET' })}); } catch {} await tools.create_file({path:"forbidden-after-script.txt",content:"must not run"}); return "caught";`
      : stage === 'MIXED'
      ? 'const before=await Promise.all([0,1,2,3,4].map(i=>tools.read_file({path:"seed-"+i+".txt"}))); if(!before.every(s=>s.includes("NESTED_SEED"))) throw Error("missing reads"); await tools.create_file({path:"nested.txt",content:"NESTED_AFTER"}); const after=await tools.read_file({path:"nested.txt"}); return {reads:before.length,after};'
      : stage === 'APPROVAL' ? 'await tools.create_file({path:"approved-nested.txt",content:"NESTED_APPROVED"}); return await tools.read_file({path:"approved-nested.txt"});'
        : 'return await tools.read_file({path:"nested.txt"});';
    return { role: 'assistant', tool_calls: [{ index: 0, id: `nested-${stage}`, type: 'function', function: { name: 'code_exec', arguments: JSON.stringify({ code }) } }] };
  }
  assert(!['UNKNOWN', 'CANCEL'].includes(stage), 'provider resumed after an uncertain/cancelled script');
  assert.equal(results.length, 1);
  assert.match(results[0].content, stage === 'APPROVAL' ? /NESTED_APPROVED/ : /NESTED_AFTER/);
  assert(!/TOOL_OUTCOME_UNKNOWN|code_exec error|host_capability_executor_failed/.test(results[0].content), results[0].content);
  return { role: 'assistant', content: `HARNESS_NATIVE_SCRIPT_${stage}_OK` };
}

async function send(dashboard, sessionId, stage) {
  return dashboard.evaluate(async ({ sessionId, stage }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${sessionId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90000),
      body: JSON.stringify({ content: `HARNESS_NATIVE_SCRIPT_${stage}`, profile: 'full', max_turns: 3 }) });
    if (!response.ok) throw new Error(`Native script ${response.status}: ${(await response.text()).slice(0, 4000)}`);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let stream = '', buffer = '', approvals = 0, aborted = false, cancelAckMs;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        const chunk = decoder.decode(next.value, { stream: true }); stream += chunk; buffer += chunk;
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (stage === 'CANCEL' && !aborted && /^event: tool_call_start$/m.test(frame)) {
            await window.harnessAwaitNestedStall();
            const start = performance.now();
            const cancelled = await fetch(`mcp://app/api/coder/sessions/${sessionId}/abort`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            cancelAckMs = performance.now() - start;
            if (!cancelled.ok) throw new Error('Nested cancellation failed'); aborted = true;
          }
          if (!/^event: tool_approval_request$/m.test(frame)) continue;
          const data = JSON.parse(frame.split(/\r?\n/).find(line => line.startsWith('data: ')).slice(6));
          if (stage !== 'APPROVAL' || ++approvals !== 1 || data.toolName !== 'create_file'
            || !/^native-tool:[a-f0-9]{64}$/.test(data.toolUseId)) throw new Error('Unexpected nested approval: ' + JSON.stringify(data));
          await window.harnessBeforeNestedApproval();
          const accepted = await fetch(`mcp://app/api/coder/sessions/${sessionId}/tool-approval`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool_use_id: data.toolUseId, approved: true }) });
          if (!accepted.ok) throw new Error('Nested approval failed ' + accepted.status + ': ' + await accepted.text());
        }
      }
    } finally { reader.releaseLock(); }
    return { stream, approvals, aborted, cancelAckMs };
  }, { sessionId, stage });
}

export async function runNativeCodeExecFixture({ dashboard, post, root, setSession, fixture }) {
  const caseRoot = join(dirname(root), 'native-scripts'); await mkdir(caseRoot);
  await Promise.all(Array.from({ length: 5 }, (_, i) => writeFile(join(caseRoot, `seed-${i}.txt`), `NESTED_SEED_${i}`)));
  const project = await post('/api/projects', { name: 'Native scripts', root_path: caseRoot });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native script calls',
    provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 3 });
  setSession(session.id);
  const mixed = await send(dashboard, session.id, 'MIXED');
  assert(mixed.stream.includes('HARNESS_NATIVE_SCRIPT_MIXED_OK'), mixed.stream.slice(-7000));
  assert.equal(await readFile(join(caseRoot, 'nested.txt'), 'utf8'), 'NESTED_AFTER');
  await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'ask' }, 'PATCH');
  await dashboard.exposeFunction('harnessBeforeNestedApproval', async () => {
    await assert.rejects(readFile(join(caseRoot, 'approved-nested.txt')), { code: 'ENOENT' });
  });
  const approved = await send(dashboard, session.id, 'APPROVAL');
  assert(approved.stream.includes('HARNESS_NATIVE_SCRIPT_APPROVAL_OK'), approved.stream.slice(-7000));
  assert.equal(approved.approvals, 1);
  assert.equal(await readFile(join(caseRoot, 'approved-nested.txt'), 'utf8'), 'NESTED_APPROVED');
  const http = await startNativeHttpFixture(); Object.assign(fixture, { url: http.url });
  const faultCases = [];
  try {
    await dashboard.exposeFunction('harnessAwaitNestedStall', async () => {
      for (let n = 0; n < 500 && !http.stalled(); n++) await new Promise(r => setTimeout(r, 10));
      assert.equal(http.stalled(), 1, 'nested HTTP request was not physically dispatched');
    });
    for (const stage of ['CANCEL', 'UNKNOWN']) {
      // An uncertain remote mutation intentionally retains its workspace lease.
      // Give each injected failure its own root; never discard that authority
      // just to let the successful session's restart test advance.
      const faultRoot = join(dirname(root), `native-scripts-${stage.toLowerCase()}`); await mkdir(faultRoot);
      const faultProject = await post('/api/projects', { name: `Native script ${stage}`, root_path: faultRoot });
      const fault = await post('/api/coder/sessions', { project_id: faultProject.id, title: `Native script ${stage}`,
        provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 3 });
      await post(`/api/coder/sessions/${fault.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
      setSession(fault.id);
      const result = await send(dashboard, fault.id, stage);
      if (stage === 'CANCEL') assert(result.aborted, result.stream.slice(-5000));
      else {
        assert(result.stream.includes('TOOL_OUTCOME_UNKNOWN'), result.stream.slice(-5000));
        assert.equal(http.effects(), 1); await assertNativeHttpRecovery(dashboard, fault.id); assert.equal(http.effects(), 1);
      }
      await assert.rejects(readFile(join(faultRoot, 'forbidden-after-script.txt')), { code: 'ENOENT' });
      await http.assertDrained();
      faultCases.push({ stage, sessionId: fault.id, root: faultRoot, cancelAckMs: result.cancelAckMs, remainingSockets: http.sockets() });
    }
  } finally { await http.close(); }
  return { sessionId: session.id, root: caseRoot, passed: true, nestedApprovalCount: approved.approvals, mixedReads: 5,
    faultCases, effects: http.effects() };
}

export async function recoverNativeCodeExecFixture({ dashboard, evidence, setSession, beforeSend }) {
  await beforeSend?.(); setSession(evidence.sessionId);
  const followup = await send(dashboard, evidence.sessionId, 'FOLLOWUP');
  assert(followup.stream.includes('HARNESS_NATIVE_SCRIPT_FOLLOWUP_OK'), followup.stream.slice(-7000));
  assert.equal(await readFile(join(evidence.root, 'nested.txt'), 'utf8'), 'NESTED_AFTER');
  const unknown = evidence.faultCases.find(c => c.stage === 'UNKNOWN');
  await assertNativeHttpRecovery(dashboard, unknown.sessionId);
  return { passed: true, checkpointResumed: true };
}
