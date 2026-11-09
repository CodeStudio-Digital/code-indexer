import { expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../core/registry.js';
import { ToolCallLedger } from '../../core/tool-call-ledger.js';
import { ok, err, unknownToolOutcome, type ToolResult } from '../../core/tool.js';
import type { ToolOutcomeTerminalReceipt } from '../../core/tool-outcome-observer.js';
import { buildCodeExecTool } from '../code-exec.js';

function fixture() {
  const registry = new ToolRegistry();
  const receipts: ToolOutcomeTerminalReceipt[] = [];
  let resolve!: (result: ToolResult) => void;
  const raw = new Promise<ToolResult>(done => { resolve = done; });
  const handler = vi.fn(() => raw);
  registry.register({ name: 'write_fixture', description: '', source: 'native', mutates: true,
    riskLevel: 'write', timeoutMs: 25, parameters: { type: 'object', properties: {} }, handler });
  registry.register(buildCodeExecTool(registry));
  const ledger = new ToolCallLedger();
  const context = { cwd: process.cwd(), projectName: 'fixture', currentToolUseId: 'batch',
    toolCallLedger: ledger, onToolOutcomeTerminal: (r: ToolOutcomeTerminalReceipt) => { receipts.push(r); } };
  return { registry, receipts, resolve, handler, ledger, context };
}

it('keeps a timed-out code_exec unresolved until its RAW mutation returns terminal evidence', async () => {
  const f = fixture();
  try {
    const result = await f.registry.invoke('code_exec', {
      code: 'try { await tools.write_fixture({}); } catch {} return "caught";',
    }, f.context);
    expect(result.effectOutcome).toBe('unknown');
    expect(f.receipts).toEqual([]);
    f.resolve(ok('physical write completed'));
    await vi.waitFor(() => expect(f.receipts).toHaveLength(2), { interval: 1 });
    expect(f.receipts[0]).toMatchObject({ toolName: 'write_fixture', parentToolUseId: 'batch', outcome: 'confirmed' });
    expect(f.receipts[1]).toMatchObject({ toolUseId: 'batch', toolName: 'code_exec',
      source: 'code_exec_aggregate', outcome: 'confirmed' });
    expect(f.ledger.outcomeUnknownTool).toBe('write_fixture');
    expect(f.handler).toHaveBeenCalledOnce();
  } finally { f.resolve(ok('cleanup')); }
});

it.each([err('finished maybe'), unknownToolOutcome('transport ACK lost')])(
  'does not emit an aggregate for an opaque late child result', async childResult => {
    const f = fixture();
    try {
      expect((await f.registry.invoke('code_exec', { code: 'await tools.write_fixture({});' }, f.context)).effectOutcome).toBe('unknown');
      f.resolve(childResult);
      await new Promise(resolve => setImmediate(resolve));
      expect(f.receipts).toEqual([]);
    } finally { f.resolve(ok('cleanup')); }
  },
);

it('records a terminated evaluator with no dispatched effects as not applied', async () => {
  const f = fixture();
  const result = await f.registry.invoke('code_exec', { code: 'throw new Error("script failure");' }, f.context);
  expect(result.isError).toBe(true);
  expect(f.handler).not.toHaveBeenCalled();
  expect(f.receipts).toEqual([expect.objectContaining({ toolUseId: 'batch', outcome: 'not_applied', source: 'code_exec_aggregate' })]);
});

it('does not confuse two concurrent batch owners when a late raw result arrives', async () => {
  const f = fixture();
  try {
    await f.registry.invoke('code_exec', { code: 'await tools.write_fixture({});' }, f.context);
    const other = await f.registry.invoke('code_exec', { code: 'return 42;' }, {
      ...f.context, currentToolUseId: 'other-batch', toolCallLedger: new ToolCallLedger(),
    });
    expect(other.isError).not.toBe(true);
    expect(f.receipts.map(r => r.toolUseId)).toEqual(['other-batch']);
    f.resolve(ok('late original write'));
    await vi.waitFor(() => expect(f.receipts).toHaveLength(3), { interval: 1 });
    expect(f.receipts[2]).toMatchObject({ toolUseId: 'batch', outcome: 'confirmed' });
  } finally { f.resolve(ok('cleanup')); }
});
