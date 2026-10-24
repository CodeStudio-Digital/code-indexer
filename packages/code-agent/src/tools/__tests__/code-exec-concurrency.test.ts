import { expect, it, vi } from 'vitest';
import { buildCodeExecTool } from '../code-exec.js';
import { NestedToolConcurrencyGate } from '../code-exec-concurrency.js';
import { ToolRegistry } from '../../core/registry.js';
import { ToolCallLedger } from '../../core/tool-call-ledger.js';
import { ok, type CoderTool } from '../../core/tool.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const base = { description: 'Fixture', source: 'native' as const,
  parameters: { type: 'object' as const, properties: {} } };

it('does not reuse a read result across an intervening queued mutation', async () => {
  const registry = new ToolRegistry(); const observed: string[] = []; let value = 'before';
  registry.register({ ...base, name: 'fixture_read', mutates: false, parallelSafe: true,
    handler: async () => { observed.push(value); return ok(value); } });
  registry.register({ ...base, name: 'fixture_write', mutates: true, parallelSafe: false,
    handler: async () => { value = 'after'; return ok('changed'); } });
  const result = await buildCodeExecTool(registry).handler({ code: `return await Promise.all([
    tools.fixture_read({}), tools.fixture_write({}), tools.fixture_read({})]);` },
    { cwd: process.cwd(), projectName: 'fixture' });
  expect(result.isError).not.toBe(true); expect(observed).toEqual(['before', 'after']);
  expect(result.content).toContain('before'); expect(result.content).toContain('after');
});

it.each([
  { name: 'fixture_write', mutates: true, parallelSafe: false, riskLevel: 'write' as const },
  { name: 'fixture_command', mutates: false, parallelSafe: true, riskLevel: 'execute' as const, executionClass: 'execute' as const },
  { name: 'fixture_unknown', mutates: false },
])('places $name between two read batches without physical overlap', async metadata => {
  const registry = new ToolRegistry(); const reads = deferred(); const barrier = deferred(); const started: string[] = [];
  registry.register({ ...base, name: 'fixture_read', mutates: false, parallelSafe: true, riskLevel: 'read',
    handler: async args => { started.push(`read${args.n}`); if (args.n !== 3) await reads.promise; return ok(`read${args.n}`); } });
  registry.register({ ...base, ...metadata, handler: async () => { started.push('barrier'); await barrier.promise; return ok('barrier'); } } as CoderTool);
  const pending = buildCodeExecTool(registry).handler({ code: `return await Promise.all([
    tools.fixture_read({n:1}), tools.fixture_read({n:2}), tools.${metadata.name}({}), tools.fixture_read({n:3})]);` },
    { cwd: process.cwd(), projectName: 'fixture' });
  await vi.waitFor(() => expect(started).toEqual(['read1', 'read2']));
  reads.resolve(); await vi.waitFor(() => expect(started).toEqual(['read1', 'read2', 'barrier']));
  barrier.resolve(); const result = await pending;
  expect(result.isError).not.toBe(true); expect(started).toEqual(['read1', 'read2', 'barrier', 'read3']);
});

it('shares a runner barrier across simultaneous scripts', async () => {
  const registry = new ToolRegistry(); const release = deferred(); const started: string[] = [];
  registry.register({ ...base, name: 'fixture_write', mutates: true, parallelSafe: false,
    handler: async () => { started.push('write'); await release.promise; return ok('written'); } });
  registry.register({ ...base, name: 'fixture_read', mutates: false, parallelSafe: true,
    handler: async () => { started.push('read'); return ok('read'); } });
  const tool = buildCodeExecTool(registry);
  const context = { cwd: process.cwd(), projectName: 'fixture', toolCallLedger: new ToolCallLedger() };
  const write = tool.handler({ code: 'return await tools.fixture_write({});' }, context);
  await vi.waitFor(() => expect(started).toEqual(['write']));
  const read = tool.handler({ code: 'return await tools.fixture_read({});' }, context);
  await new Promise(resolve => setImmediate(resolve)); expect(started).toEqual(['write']);
  release.resolve(); expect((await write).isError).not.toBe(true); expect((await read).isError).not.toBe(true);
  expect(started).toEqual(['write', 'read']);
});

it('removes a cancelled waiting barrier and wakes later reads without leaking capacity', async () => {
  const gate = new NestedToolConcurrencyGate(4); const first = await gate.reserve(true);
  const controller = new AbortController(); const waiting = gate.reserve(false, controller.signal);
  const cancelled = expect(waiting).rejects.toThrow('cancel fixture');
  let readStarted = false; const next = gate.reserve(true).then(release => { readStarted = true; return release; });
  expect(readStarted).toBe(false); controller.abort(new Error('cancel fixture')); await cancelled;
  const second = await next; expect(readStarted).toBe(true); first(); second();
  const final = await gate.reserve(false); final(); final();
  const all = await Promise.all(Array.from({ length: 4 }, () => gate.reserve(true))); all.forEach(release => release());
});
