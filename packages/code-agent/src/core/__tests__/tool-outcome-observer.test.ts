import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { ToolCallLedger } from '../tool-call-ledger.js';
import { ok, err, unknownToolOutcome, type CoderTool, type ToolContext, type ToolResult } from '../tool.js';
import { ToolOutcomeScope, toolOutcomeInputHash, type ToolOutcomeTerminalReceipt } from '../tool-outcome-observer.js';
import { withTimeout } from '../runner/nodes/executing-abort.js';

function deferred() {
  let resolve!: (result: ToolResult) => void;
  const promise = new Promise<ToolResult>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(handler: CoderTool['handler'], extra: Partial<CoderTool> = {}) {
  const registry = new ToolRegistry();
  const receipts: ToolOutcomeTerminalReceipt[] = [];
  const ledger = new ToolCallLedger();
  const ctx: ToolContext = { cwd: process.cwd(), projectName: 'test', currentToolUseId: 'call-1',
    toolCallLedger: ledger, onToolOutcomeTerminal: receipt => { receipts.push(receipt); } };
  registry.register({ name: 'write_fixture', description: '', source: 'native', mutates: true,
    riskLevel: 'write', parameters: { type: 'object', properties: { path: { type: 'string' } } },
    handler, ...extra });
  return { registry, receipts, ledger, ctx };
}

describe('physical tool outcome receipts', () => {
  it('captures a late success after a lost wait without clearing the attempt guard', async () => {
    const operation = deferred();
    const f = fixture(() => operation.promise);
    const raw = f.registry.invoke('write_fixture', { path: 'example.txt' }, f.ctx);
    await expect(withTimeout(raw, 5)).rejects.toMatchObject({ code: 'TIMEOUT' });
    f.ledger.markOutcomeUnknown('write_fixture');
    expect(f.receipts).toEqual([]);
    operation.resolve(ok('terminal result'));
    expect((await raw).effectOutcome).toBe('unknown');
    expect(f.receipts).toEqual([expect.objectContaining({ version: 1, toolUseId: 'call-1',
      toolName: 'write_fixture', outcome: 'confirmed', source: 'registry',
      inputHash: toolOutcomeInputHash({ path: 'example.txt' }) })]);
    expect(f.ledger.outcomeUnknownTool).toBe('write_fixture');
    expect(f.receipts[0].invocationId).toMatch(/^[\da-f-]{36}$/);
  });

  it('binds normalized arguments before the handler mutates its input', async () => {
    const f = fixture(async args => { args.path = 'changed-after-dispatch'; return ok('secret output'); });
    await f.registry.invoke('write_fixture', { file_path: 'secret-original-path' }, f.ctx);
    expect(f.receipts[0].inputHash).toBe(toolOutcomeInputHash({ path: 'secret-original-path' }));
    expect(JSON.stringify(f.receipts)).not.toMatch(/secret|changed-after/);
  });

  it.each([
    ['explicit unknown', unknownToolOutcome('completed successfully')],
    ['opaque error', err('completed successfully')],
    ['unknown evidence', { ...ok('completed successfully'), evidence: {
      version: 2, invocationId: 'opaque', state: 'succeeded', effect: 'unknown', completeness: 'complete', timings: { totalMs: 1 },
    } } as ToolResult],
  ])('does not trust text for %s', async (_label, result) => {
    const f = fixture(async () => result);
    await f.registry.invoke('write_fixture', {}, f.ctx);
    expect(f.receipts).toEqual([]);
  });

  it('does not invent a receipt when the physical handler throws', async () => {
    const f = fixture(async () => { throw new Error('opaque transport failure'); });
    await f.registry.invoke('write_fixture', {}, f.ctx);
    expect(f.receipts).toEqual([]);
  });

  it.each(['none', 'confirmed'] as const)('accepts explicit %s evidence even for a failed result', async effect => {
    const f = fixture(async () => ({ ...err('partial domain failure'), evidence: {
      version: 2, invocationId: 'domain', state: 'failed', effect, completeness: 'complete', timings: { totalMs: 1 },
    } }));
    await f.registry.invoke('write_fixture', {}, f.ctx);
    expect(f.receipts[0].outcome).toBe(effect === 'none' ? 'not_applied' : 'confirmed');
  });

  it('records cancellation before handler dispatch as not applied', async () => {
    const handler = vi.fn(async () => ok('must not run'));
    const f = fixture(handler);
    await f.registry.invoke('write_fixture', {}, { ...f.ctx, signal: AbortSignal.abort() });
    expect(handler).not.toHaveBeenCalled();
    expect(f.receipts[0].outcome).toBe('not_applied');
  });

  it('does not let a failed async observer reject an otherwise completed invocation', async () => {
    const f = fixture(async () => ok('done'));
    const result = await f.registry.invoke('write_fixture', {}, { ...f.ctx,
      onToolOutcomeTerminal: async () => { throw new Error('disk unavailable'); } });
    expect(result.isError).not.toBe(true);
    await new Promise(resolve => setImmediate(resolve));
  });

  it('delays a wrapper receipt until its raw descendant settles', async () => {
    const operation = deferred();
    const f = fixture(() => operation.promise);
    let child!: Promise<ToolResult>;
    f.registry.register({ name: 'wrapper', description: '', source: 'native', mutates: false,
      riskLevel: 'read', parameters: { type: 'object', properties: {} }, handler: async (_args, ctx) => {
        child = f.registry.invoke('write_fixture', {}, { ...ctx, currentToolUseId: 'child', parentToolUseId: 'parent' });
        return ok('wrapper has returned');
      } });
    await f.registry.invoke('wrapper', {}, { ...f.ctx, currentToolUseId: 'parent' });
    expect(f.receipts).toEqual([]);
    operation.resolve(ok('write is now terminal'));
    await child;
    expect(f.receipts.map(r => [r.toolUseId, r.outcome])).toEqual([
      ['child', 'confirmed'], ['parent', 'confirmed'],
    ]);
  });

  it('never promotes an unknown descendant into a successful wrapper', async () => {
    const f = fixture(async () => unknownToolOutcome('lost acknowledgement'));
    f.registry.register({ name: 'wrapper', description: '', source: 'native', mutates: false,
      riskLevel: 'read', parameters: { type: 'object', properties: {} }, handler: async (_args, ctx) => {
        await f.registry.invoke('write_fixture', {}, { ...ctx, currentToolUseId: 'child' });
        return ok('the model says done');
      } });
    await f.registry.invoke('wrapper', {}, f.ctx);
    expect(f.receipts).toEqual([]);
  });

  it('does not emit an aggregate before evaluator termination, even if its wrapper settled first', () => {
    const receipts: ToolOutcomeTerminalReceipt[] = [];
    const scope = new ToolOutcomeScope({ onToolOutcomeTerminal: r => { receipts.push(r); } }, {
      version: 1, toolUseId: 'batch', invocationId: 'invocation', toolName: 'code_exec',
      inputHash: toolOutcomeInputHash({}), source: 'code_exec_aggregate',
    }, undefined, true);
    scope.settle(unknownToolOutcome('wait lost'), true, true);
    expect(receipts).toEqual([]);
    scope.markEvaluatorClosed();
    scope.markEvaluatorClosed();
    expect(receipts.map(r => r.outcome)).toEqual(['not_applied']);
  });
});
