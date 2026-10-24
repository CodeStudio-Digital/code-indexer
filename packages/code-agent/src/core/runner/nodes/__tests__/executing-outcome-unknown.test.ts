import { expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../../registry.js';
import { ToolCallLedger } from '../../../tool-call-ledger.js';
import { unknownToolOutcome, type CoderTool } from '../../../tool.js';
import { dispatchTools } from '../executing-dispatch.js';
import { ExecutingNode } from '../executing.js';
import { makeTestContext } from './test-helpers.js';
import { runBehaviorTree, buildDefaultNodes } from '../../orchestrator.js';

const external: CoderTool = { name: 'ext_fixture__write', description: 'external mutation',
  source: 'mcp_external', mutates: true, parallelSafe: false, riskLevel: 'write',
  parameters: { type: 'object', properties: {} }, handler: async () => unknownToolOutcome('lost ACK') };
const context = () => ({ cwd: process.cwd(), projectName: 'unknown', toolCallLedger: new ToolCallLedger() });

it('stops the batch after an uncertain effect and pairs every requested tool result', async () => {
  const registry = new ToolRegistry();
  const next = vi.fn(async () => ({ content: 'should not run' }));
  registry.register(external);
  registry.register({ ...external, name: 'next_write', handler: next });
  const result = await dispatchTools({ registry, toolContext: context(), turn: 1, dupCalls: new Map(),
    toolUses: [{ id: 'a', name: external.name, input: {} }, { id: 'b', name: 'next_write', input: {} }] });
  expect(result.outcomeUnknown).toBe(true);
  expect(result.results.map(r => r.toolUseId)).toEqual(['a', 'b']);
  expect(result.results[0].effectOutcome).toBe('unknown');
  expect(result.results[1]).toMatchObject({ isError: true, refusalKind: 'gate' });
  expect(next).not.toHaveBeenCalled();
});

it('catches an uncertain nested call even when its caller swallows the result', async () => {
  const registry = new ToolRegistry();
  const next = vi.fn(async () => ({ content: 'no' }));
  registry.register(external);
  registry.register({ ...external, name: 'next', handler: next });
  registry.register({ ...external, name: 'nested', source: 'native', handler: async (_args, ctx) => {
    await registry.invoke(external.name, {}, ctx);
    await registry.invoke('next', {}, ctx);
    return { content: 'claimed success' };
  } });
  expect(await registry.invoke('nested', {}, context())).toMatchObject({ effectOutcome: 'unknown', isError: true });
  expect(next).not.toHaveBeenCalled();
});

it('treats the runner timeout after external dispatch as uncertain', async () => {
  const registry = new ToolRegistry();
  registry.register({ ...external, timeoutMs: 10, handler: async (_args, ctx) => {
    await new Promise<void>(resolve => ctx.signal!.addEventListener('abort', () => resolve(), { once: true }));
    return { content: 'late success' };
  } });
  const result = await dispatchTools({ registry, toolContext: context(), turn: 1, dupCalls: new Map(),
    toolUses: [{ id: 'a', name: external.name, input: {} }] });
  expect(result.outcomeUnknown).toBe(true);
  expect(result.results[0].effectOutcome).toBe('unknown');
});

it('terminates the runner without another provider call or queued-message revival', async () => {
  const registry = new ToolRegistry(); registry.register(external);
  let calls = 0;
  const { ctx } = makeTestContext({ registry, toolContext: context(), provider: {
    name: 'fixture', model: 'fixture', setModel() {}, async *chat() {
      calls++;
      yield { type: 'tool_call_start' as const, id: 'a', name: external.name };
      yield { type: 'tool_call_end' as const, id: 'a', name: external.name, input: {} };
      yield { type: 'done' as const, stop_reason: 'tool_use' };
    },
  } });
  const nodes = buildDefaultNodes();
  nodes.Bootstrap = { state: 'Bootstrap', execute: async () => ({ kind: 'TurnSucceeded', hasToolCalls: false }) };
  nodes.Executing = new ExecutingNode();
  const result = await runBehaviorTree({ opts: ctx.opts, emit: ctx.emit, initialTiers: null,
    bridge: { hasPendingMessages: () => true } }, nodes);
  expect(result.reason).toBe('error');
  expect(calls).toBe(1);
});

it('does not ask the provider to resume an uncertain operation recovered from history', async () => {
  const { ctx } = makeTestContext({ registry: new ToolRegistry(), toolContext: context() });
  ctx.opts.initialMessages = [{ role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'old-call',
    content: 'lost response', is_error: true, effect_outcome: 'unknown' }] }];
  expect(await runBehaviorTree({ opts: ctx.opts, emit: ctx.emit, initialTiers: null })).toMatchObject({ reason: 'error' });
});
