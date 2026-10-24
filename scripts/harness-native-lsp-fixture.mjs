import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeLspDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_LSP_/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  const cancel = JSON.stringify(body.messages[start].content).includes('HARNESS_NATIVE_LSP_CANCEL');
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const text = index => typeof results[index]?.content === 'string' ? results[index].content : JSON.stringify(results[index]?.content);
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-lsp-${cancel}-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  const position = { file_path: 'value.ts', line: 1, column: 14 };
  for (const name of ['lsp_definition', 'lsp_references', 'lsp_hover', 'lsp_diagnostics']) assert(body.tools.some(t => t.function?.name === name), 'missing native ' + name);
  if (cancel) { assert.equal(results.length, 0, 'provider resumed after cancellation'); return call([['lsp_references', position]]); }
  if (!results.length) return call([
    ['lsp_diagnostics', { file_path: 'consumer.ts' }], ['lsp_references', { ...position, limit: 2 }],
    ['lsp_definition', { file_path: 'consumer.ts', line: 1, column: 10 }], ['lsp_hover', position],
  ]);
  if (results.length === 4) {
    assert(text(0).includes('TS2322'), text(0)); assert(text(1).includes('"offset":2'), text(1));
    assert(text(2).includes('value.ts:1:14'), text(2)); assert(text(3).includes('wrong type'), text(3));
    return call([['lsp_references', { ...position, offset: 2, limit: 500 }], ['lsp_references', { ...position, offset: 502, limit: 500 }],
      ['write_file', { path: 'value.ts', content: 'export const value = 42;\n' }], ['lsp_diagnostics', { file_path: 'outside.ts' }]]);
  }
  if (results.length === 8) {
    assert(text(4).includes('"offset":502'), text(4)); assert(text(5).includes('usage.ts:551:'), text(5));
    assert(!text(5).includes('Continue:'), text(5)); assert(text(7).includes('TS2322'), text(7));
    return call([['lsp_diagnostics', { file_path: 'consumer.ts' }], ['lsp_hover', position],
      ['write_file', { path: 'outside.ts', content: 'export const outside: number = 42;\n' }], ['lsp_diagnostics', { file_path: 'outside.ts' }]]);
  }
  assert.equal(results.length, 12); assert(text(8).includes('No diagnostics'), text(8));
  assert(text(9).includes('42'), text(9)); assert(text(11).includes('No diagnostics'), text(11));
  return { role: 'assistant', content: 'HARNESS_NATIVE_LSP_OK' };
}

export async function runNativeLspFixture({ root, dashboard, post, setSession }) {
  const cases = [];
  for (const scenario of ['COMPLETE', 'CANCEL']) {
    const caseRoot = join(dirname(root), 'lsp-' + scenario.toLowerCase()); await mkdir(caseRoot);
    await writeFile(join(caseRoot, 'consumer.ts'), 'import { value } from "./value";\nexport const count: number = value;\n');
    await writeFile(join(caseRoot, 'value.ts'), 'export const value = "wrong type";\n');
    await writeFile(join(caseRoot, 'outside.ts'), 'export const outside: number = "wrong type";\n');
    await writeFile(join(caseRoot, 'usage.ts'), 'import { value } from "./value";\n' + Array.from({ length: scenario === 'CANCEL' ? 25000 : 550 }, (_, i) => `export const count${i} = value;`).join('\n'));
    await writeFile(join(caseRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] }, files: ['consumer.ts', 'value.ts', 'usage.ts'] }));
    const project = await post('/api/projects', { name: 'Native LSP ' + scenario, root_path: caseRoot });
    const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native LSP ' + scenario,
      provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 6 });
    await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH'); setSession(session.id);
    const result = await dashboard.evaluate(async ({ id, scenario }) => {
      const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
        body: JSON.stringify({ content: 'HARNESS_NATIVE_LSP_' + scenario, profile: 'full', max_turns: 6 }) });
      if (!response.ok || !response.body) throw new Error('LSP fixture ' + response.status);
      const reader = response.body.getReader(), decoder = new TextDecoder(); let stream = '', buffer = '', aborted = false, cancelAckMs;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        const text = decoder.decode(part.value, { stream: true }); stream += text; buffer += text;
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (scenario !== 'CANCEL' || aborted || !/^event: tool_call_start$/m.test(frame)) continue;
          await new Promise(resolve => setTimeout(resolve, 100)); const before = performance.now();
          const cancelled = await fetch(`mcp://app/api/coder/sessions/${id}/abort`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          cancelAckMs = performance.now() - before; if (!cancelled.ok) throw new Error('LSP cancellation failed'); aborted = true;
        }
      }
      return { stream, aborted, cancelAckMs };
    }, { id: session.id, scenario });
    if (scenario === 'CANCEL') assert(result.aborted, result.stream.slice(-5000));
    else assert(result.stream.includes('HARNESS_NATIVE_LSP_OK'), result.stream.slice(-7000));
    cases.push({ scenario, sessionId: session.id, passed: true, cancelAckMs: result.cancelAckMs });
  }
  return { cases, pagedReferences: true, dependencyAndExcludedFileChangesRechecked: true };
}
