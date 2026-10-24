import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { loadNativeHostBridge, parseRuntimePackageAnchor, verifyRuntimePackage } from '@mcp/agent-runtime-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import { ok, err, unknownToolOutcome, type ToolContext, type CoderTool } from '@mcp/code-agent/core/tool.js';
import { buildCodeExecTool } from '@mcp/code-agent/tools/code-exec.js';
import { createCodeExecStash } from '@mcp/code-agent/tools/code-exec-stash.js';
import { NativeCodeExecutionPort } from '../workers/native-code-execution-port.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(tools: CoderTool[] = []) {
  const pkg = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
    parseRuntimePackageAnchor(await readFile('dist/apps/electron/native-agent-runtime-integrity.json')));
  const binding = loadNativeHostBridge(pkg), pids: number[] = [], controller = new AbortController(), unknown = vi.fn();
  const port = new NativeCodeExecutionPort({ root: process.cwd(), deadline: Date.now() + 60000, signal: controller.signal,
    workerPath: resolve('dist/apps/http-api/workers/native-code-exec-worker.js'), assertOwner() {}, outcomeUnknown: unknown,
    spawn: options => { const owner = binding.startNativeHostDuplexProcess!(options); pids.push(owner.processId); return owner; } });
  const registry = new ToolRegistry(); for (const tool of tools) registry.register(tool);
  const tool = buildCodeExecTool(registry);
  const ctx: ToolContext = { cwd: process.cwd(), projectName: 'isolated-evaluator', runtimeGeneration: 'rust_v1', signal: controller.signal,
    codeExecStash: createCodeExecStash(), toolCallLedger: new ToolCallLedger(), ports: { codeExecution: port } };
  return { ctx, controller, unknown, pids, run: (code: string, timeout_ms = 2000) => tool.handler({ code, timeout_ms }, ctx),
    assertReaped: () => { expect(pids.length).toBeGreaterThan(0); for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(); expect(unknown).not.toHaveBeenCalled(); } };
}
function tool(name: string, handler: CoderTool['handler'], mutates = false): CoderTool {
  return { name, description: 'physical evaluator fixture', source: 'native', mutates, parallelSafe: !mutates,
    riskLevel: mutates ? 'write' : 'read', repeatPolicy: 'volatile', parameters: { type: 'object', properties: {} }, handler };
}

physicalIt('executes concurrent reads through Host barriers, persists stash, and serializes structured returns off the Host', async () => {
  let active = 0, maxActive = 0; const order: string[] = [];
  const f = await fixture([
    tool('read_file', async args => { active++; maxActive = Math.max(maxActive, active); await sleep(40); order.push('read' + args.id); active--; return ok('ação ' + args.id); }),
    tool('write_file', async () => { expect(active).toBe(0); order.push('write'); return ok('written'); }, true),
  ]);
  const result = await f.run('const r=await Promise.all([0,1,2,3,4].map(id=>tools.read_file({id}))); await write_file({}); stash.set("r",r); log("kept"); return {n:r.length,text:r[0]};');
  expect(result.isError, result.content).toBeFalsy(); expect(maxActive).toBe(4); expect(order.at(-1)).toBe('write');
  expect(result.content).toContain('"n": 5'); expect(result.content).toContain('ação 0');
  const followup = await f.run('return stash.get("r").length + ":" + tool_schema("read_file").invokeAs;');
  expect(followup.content).toContain('5:code_exec'); f.assertReaped();
}, 30000);

physicalIt('reaps an infinite microtask continuation without freezing the Host timer', async () => {
  const f = await fixture([tool('read_file', async () => ok('read'))]);
  let ticks = 0; const timer = setInterval(() => ticks++, 20);
  try {
    const result = await f.run('await tools.read_file({}); while(true) {}', 500);
    expect(result.error?.code, result.content).toBe('CODE_EXEC_JS_TIMEOUT'); expect(ticks).toBeGreaterThan(5); f.assertReaped();
    expect((await f.run('return "still usable";')).content).toContain('still usable'); f.assertReaped();
  } finally { clearInterval(timer); f.controller.abort(); }
}, 30000);

physicalIt('does not charge a slow nested capability against the JavaScript time budget', async () => {
  const f = await fixture([tool('read_file', async () => { await sleep(850); return ok('slow success'); })]);
  const result = await f.run('return await tools.read_file({});', 500);
  expect(result.isError, result.content).toBeFalsy(); expect(result.content).toContain('slow success'); f.assertReaped();
}, 30000);

physicalIt('cancels an evaluator and drains its physically started nested operation', async () => {
  let entered!: () => void, drained = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture([tool('read_file', async (_args, ctx) => {
    entered(); await new Promise<void>(resolve => ctx.signal!.addEventListener('abort', () => { drained = true; resolve(); }, { once: true }));
    return err('cancelled');
  })]);
  const pending = f.run('await tools.read_file({}); return "must not finish";');
  await started; f.controller.abort(new Error('physical cancellation'));
  const result = await pending; expect(result.isError).toBe(true); expect(drained).toBe(true); f.assertReaped();
}, 30000);

physicalIt('preserves probe errors and permission errors, and drains detached started work', async () => {
  let completed = 0;
  const f = await fixture([
    tool('optional_read', async () => err('missing', { code: 'MISSING', kind: 'not_found', retryable: false })),
    tool('denied_read', async () => err('denied', { code: 'DENIED', kind: 'permission', retryable: false })),
    tool('read_file', async () => { await sleep(40); completed++; return ok('done'); }),
  ]);
  expect((await f.run('return await attempt(tools.optional_read({}));')).content).toContain('"ok": false');
  expect((await f.run('return await attempt(tools.denied_read({}));')).error?.kind).toBe('permission');
  const detached = await f.run('tools.read_file({}); return "detached";');
  expect(detached.isError, detached.content).toBeFalsy(); expect(completed).toBe(1); f.assertReaped();
}, 30000);

physicalIt('keeps mutation uncertainty sticky even when the script catches its error', async () => {
  let writes = 0, after = 0;
  const f = await fixture([
    tool('write_file', async () => { writes++; return unknownToolOutcome('effect applied but ACK lost'); }, true),
    tool('create_file', async () => { after++; return ok('forbidden'); }, true),
  ]);
  const result = await f.run('try { await tools.write_file({}); } catch {} try { await tools.create_file({}); } catch {} return "caught";');
  expect(result.error?.code).toBe('TOOL_OUTCOME_UNKNOWN'); expect(writes).toBe(1); expect(after).toBe(0); f.assertReaped();
}, 30000);

physicalIt('caps console traffic, retains late errors and applies stash changes even when the script throws', async () => {
  const f = await fixture();
  const result = await f.run('stash.set("kept",42); for(let i=0;i<50000;i++) log("verbose output"); console.error("LAST_DIAGNOSTIC"); throw Error("fixture failure");');
  expect(result.isError).toBe(true); expect(result.content).toContain('logs truncated');
  expect(result.content).toContain('LAST_DIAGNOSTIC'); expect(result.content.length).toBeLessThan(100000);
  expect(f.ctx.codeExecStash!.get('kept')).toBe(42); f.assertReaped();
}, 30000);

physicalIt('rejects lexical shadowing before effect dispatch and supports change queries', async () => {
  let calls = 0;
  const f = await fixture([tool('read_file', async () => { calls++; return ok('read'); })]);
  const invalid = await f.run('const [first, tools] = [read_file({}), tools.read_file({})];');
  expect(invalid.isError).toBe(true); expect(calls).toBe(0);
  f.ctx.sessionChanges = { getDiffs: async () => [], getBeforeContent: async () => null } as NonNullable<ToolContext['sessionChanges']>;
  const changes = await f.run('return await change.files();');
  expect(changes.isError, changes.content).toBeFalsy(); expect(changes.content).toContain('[]'); f.assertReaped();
}, 30000);
