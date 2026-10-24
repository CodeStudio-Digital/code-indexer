import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

export function nativeInspectionDelta(body, fixture) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_INSPECTION_/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  const scenario = JSON.stringify(body.messages[start].content).includes('HARNESS_NATIVE_INSPECTION_CANCEL') ? 'CANCEL' : 'COMPLETE';
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const text = r => typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-inspection-${scenario}-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  for (const name of ['get_diagnostics', 'mcp_list_resources', 'mcp_read_resource']) assert(body.tools.some(t => t.function?.name === name), 'missing native ' + name);
  if (scenario === 'CANCEL') {
    assert.equal(results.length, 0, 'provider resumed after cancelled checker');
    return call([['get_diagnostics', { file_path: 'consumer.ts' }]]);
  }
  if (!results.length) return call([['mcp_list_resources', {}]]);
  if (results.length === 1) {
    assert(text(results[0]).includes('mcp://project/{project_name}/overview'), text(results[0]));
    return call([['mcp_read_resource', { uri: 'mcp://project/' + encodeURIComponent(fixture.projectName) + '/overview' }],
      ['get_diagnostics', { file_path: 'consumer.ts' }]]);
  }
  if (results.length === 3) {
    assert(text(results[1]).includes('file_count'), text(results[1])); assert(text(results[1]).includes(fixture.projectName));
    assert(text(results[2]).includes('TS2322'), text(results[2]));
    return call([['write_file', { path: 'value.ts', content: 'export const value = 42;\n' }], ['get_diagnostics', { file_path: 'consumer.ts' }]]);
  }
  assert.equal(results.length, 5); assert(text(results[4]).includes('OK: TypeScript project check passed.'), text(results[4]));
  return { role: 'assistant', content: 'HARNESS_NATIVE_INSPECTION_OK' };
}

export async function runNativeInspectionFixture({ root, dashboard, post, setSession, fixture }) {
  const require = createRequire(import.meta.url), parent = dirname(root), cases = [];
  let activeRoot;
  await dashboard.exposeFunction('harnessWaitForCheckerProcess', async () => {
    for (let n = 0; n < 200; n++) {
      try { const pids = JSON.parse(await readFile(join(activeRoot, 'checker-pids.json'), 'utf8')); if (pids.parent > 0 && pids.child > 0) return; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Checker did not create parent/child evidence before cancellation');
  });
  const compiler = dirname(require.resolve('typescript/package.json'));
  await cp(compiler, join(parent, 'node_modules/typescript'), { recursive: true });
  for (const scenario of ['COMPLETE', 'CANCEL']) {
    const caseRoot = join(parent, 'inspection-' + scenario.toLowerCase()); await mkdir(caseRoot);
    activeRoot = caseRoot; console.log('Native inspection fixture: ' + scenario);
    await writeFile(join(caseRoot, 'consumer.ts'), 'import { value } from "./value";\nexport const count: number = value;\n');
    await writeFile(join(caseRoot, 'value.ts'), 'export const value = "wrong type";\n');
    await writeFile(join(caseRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ['*.ts'] }));
    if (scenario === 'CANCEL') {
      const bin = join(caseRoot, 'node_modules/typescript/bin'); await mkdir(bin, { recursive: true });
      await writeFile(join(bin, 'tsc'), `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});require('node:fs').writeFileSync('checker-pids.json',JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`);
    }
    fixture.projectName = 'Native inspection ' + scenario;
    const project = await post('/api/projects', { name: fixture.projectName, root_path: caseRoot });
    const session = await post('/api/coder/sessions', { project_id: project.id, title: fixture.projectName,
      provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 6 });
    await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
    setSession(session.id);
    const result = await dashboard.evaluate(async ({ id, scenario }) => {
      const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
        body: JSON.stringify({ content: 'HARNESS_NATIVE_INSPECTION_' + scenario, profile: 'full', max_turns: 6 }) });
      if (!response.ok || !response.body) throw new Error('Inspection fixture ' + response.status);
      const reader = response.body.getReader(), decoder = new TextDecoder(); let stream = '', buffer = '', aborted = false, cancelAckMs;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        const text = decoder.decode(part.value, { stream: true }); stream += text; buffer += text;
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (scenario !== 'CANCEL' || aborted || !/^event: tool_call_start$/m.test(frame)) continue;
          await window.harnessWaitForCheckerProcess(); const before = performance.now();
          const cancelled = await fetch(`mcp://app/api/coder/sessions/${id}/abort`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          cancelAckMs = performance.now() - before; if (!cancelled.ok) throw new Error('Checker cancellation failed'); aborted = true;
        }
      }
      return { stream, aborted, cancelAckMs };
    }, { id: session.id, scenario });
    let reapedCheckerPids;
    if (scenario === 'CANCEL') {
      assert(result.aborted, result.stream.slice(-5000)); const pids = JSON.parse(await readFile(join(caseRoot, 'checker-pids.json'), 'utf8'));
      const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
      assert(!alive(pids.parent), 'checker survived terminal'); assert(!alive(pids.child), 'checker descendant survived terminal');
      reapedCheckerPids = pids;
    } else assert(result.stream.includes('HARNESS_NATIVE_INSPECTION_OK'), result.stream.slice(-7000));
    cases.push({ scenario, sessionId: session.id, passed: true, cancelAckMs: result.cancelAckMs, reapedCheckerPids });
  }
  return { cases, realTypescriptVersion: require('typescript/package.json').version, dependencyChangeRechecked: true };
}
