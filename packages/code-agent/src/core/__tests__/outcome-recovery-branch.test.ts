import { expect, it, vi } from 'vitest';
import { ToolCallLedger } from '../tool-call-ledger.js';
import { ToolRegistry } from '../registry.js';
import { ok } from '../tool.js';

it('retains raw ownership and accounting while isolating late unknown callbacks', async () => {
  const old = new ToolCallLedger();
  const release = await old.reserveUnsafe();
  old.markOutcomeUnknown('effect');
  old.record({ name: 'effect', args: {}, content: 'lost ack', isError: true });
  const next = old.continueAfterOutcomeRegistration();
  expect(next.lastSeq).toBe(1);
  expect(next.snapshot()).toEqual(old.snapshot());
  let acquired = false;
  const nextLane = next.reserveUnsafe().then(unlock => { acquired = true; return unlock; });
  await Promise.resolve();
  expect(acquired).toBe(false);
  const registry = new ToolRegistry(); const read = vi.fn(async () => ok('read'));
  registry.register({ name: 'inspect', source: 'native', description: '', mutates: false,
    parallelSafe: true, riskLevel: 'read', parameters: { type: 'object', properties: {} }, handler: read });
  const ctx = { cwd: process.cwd(), projectName: 'fixture' };
  expect(await registry.invoke('inspect', {}, { ...ctx, toolCallLedger: next })).toMatchObject({ content: 'read' });
  expect(await registry.invoke('inspect', {}, { ...ctx, toolCallLedger: old })).toMatchObject({ effectOutcome: 'unknown' });
  old.markOutcomeUnknown('late-child');
  expect(next.outcomeUnknownTool).toBeUndefined();
  release(); (await nextLane)();
  expect(acquired).toBe(true); expect(read).toHaveBeenCalledOnce();
  next.record({ name: 'inspect', args: {}, content: 'receipt', isError: false });
  expect(old.lastSeq).toBe(2); expect(next.lastSeq).toBe(2);
});
