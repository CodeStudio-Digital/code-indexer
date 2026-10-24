import { expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../core/registry.js';
import { ToolCallLedger } from '../../core/tool-call-ledger.js';
import { ok, unknownToolOutcome, type CoderTool, type ToolResult } from '../../core/tool.js';
import { buildCodeExecTool } from '../code-exec.js';

function deferred() {
  let resolve!: (value: ToolResult) => void;
  const promise = new Promise<ToolResult>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(mutates: boolean, handler: CoderTool['handler']) {
  const registry = new ToolRegistry(); const ledger = new ToolCallLedger();
  const invoked = vi.fn(handler);
  registry.register({ name: 'fixture_call', description: 'Fixture', source: 'native',
    parameters: { type: 'object', properties: {} }, mutates, parallelSafe: !mutates,
    riskLevel: mutates ? 'write' : 'read', timeoutMs: 25, handler: invoked });
  return { registry, ledger, invoked, tool: buildCodeExecTool(registry),
    context: { cwd: process.cwd(), projectName: 'fixture', toolCallLedger: ledger } };
}

it.each([true, false])('distinguishes a timed-out mutation (%s) from a read', async mutates => {
  const call = deferred(); const f = fixture(mutates, () => call.promise);
  try {
    const result = await f.tool.handler({ code: 'return await tools.fixture_call({});' }, f.context);
    expect(result.isError).toBe(true);
    expect(result.effectOutcome).toBe(mutates ? 'unknown' : undefined);
    expect(f.ledger.outcomeUnknownTool).toBe(mutates ? 'fixture_call' : undefined);
    if (mutates) expect(result.error?.retryable).toBe(false);
    expect(result.content).toContain('timed out');
  } finally { call.resolve(ok('late result')); }
});

it('keeps uncertainty after a script catches a timeout and the physical call later finishes', async () => {
  const call = deferred(); const f = fixture(true, () => call.promise);
  try {
    const result = await f.tool.handler({ code: 'try { await tools.fixture_call({}); } catch {} return "caught";' }, f.context);
    expect(result).toMatchObject({ isError: true, effectOutcome: 'unknown', error: { retryable: false } });
    call.resolve(ok('late write')); await call.promise;
    const again = await f.registry.invoke('fixture_call', {}, f.context);
    expect(again.effectOutcome).toBe('unknown'); expect(f.invoked).toHaveBeenCalledOnce();
  } finally { call.resolve(ok('late result')); }
});

it('does not invent an uncertain effect when a write times out while queued', async () => {
  const f = fixture(true, async () => ok('must not run'));
  const release = await f.ledger.reserveUnsafe();
  try {
    const result = await f.tool.handler({ code: 'return await tools.fixture_call({});' }, f.context);
    expect(result.isError).toBe(true); expect(result.effectOutcome).toBeUndefined();
    expect(f.ledger.outcomeUnknownTool).toBeUndefined(); expect(f.invoked).not.toHaveBeenCalled();
  } finally { release(); }
});

it('propagates an explicit unknown outcome even without a runner ledger', async () => {
  const f = fixture(true, async () => unknownToolOutcome('lost ACK'));
  const result = await f.tool.handler({ code: 'try { await tools.fixture_call({}); } catch {} return "caught";' },
    { cwd: process.cwd(), projectName: 'fixture' });
  expect(result).toMatchObject({ isError: true, effectOutcome: 'unknown', error: { retryable: false } });
});

it('retains uncertainty when cancellation races with an uncooperative mutation', async () => {
  const call = deferred(); const f = fixture(true, () => call.promise); const cancel = new AbortController();
  try {
    const pending = f.tool.handler({ code: 'return await tools.fixture_call({});' }, { ...f.context, signal: cancel.signal });
    await vi.waitFor(() => expect(f.invoked).toHaveBeenCalledOnce(), { interval: 1 });
    cancel.abort(new Error('fixture cancelled'));
    expect(await pending).toMatchObject({ isError: true, effectOutcome: 'unknown', error: { retryable: false } });
  } finally { call.resolve(ok('late result')); }
});
