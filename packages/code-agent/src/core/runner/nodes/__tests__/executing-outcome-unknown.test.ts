import { expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../../registry.js';
import { ToolCallLedger } from '../../../tool-call-ledger.js';
import { ok, unknownToolOutcome, type CoderTool, type ToolResult } from '../../../tool.js';
import { buildCodeExecTool } from '../../../../tools/code-exec.js';
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
  const result = await dispatchTools({ registry, toolContext: context(), turn: 1,
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
  const result = await dispatchTools({ registry, toolContext: context(), turn: 1,
    toolUses: [{ id: 'a', name: external.name, input: {} }] });
  expect(result.outcomeUnknown).toBe(true);
  expect(result.results[0].effectOutcome).toBe('unknown');
});

it.each([
  { name: 'native_write', source: 'native' as const, mutates: true, riskLevel: 'write' as const, uncertain: true },
  { name: 'native_command', source: 'native' as const, mutates: false, riskLevel: 'execute' as const, uncertain: true },
  { name: 'native_read', source: 'native' as const, mutates: false, riskLevel: 'read' as const, uncertain: false },
  { name: 'external_read', source: 'mcp_external' as const, mutates: false, riskLevel: 'read' as const, uncertain: false },
])('classifies runner timeout by physical effects for $name', async ({ uncertain, ...metadata }) => {
  const registry = new ToolRegistry();
  registry.register({ ...external, ...metadata, timeoutMs: 10, handler: async (_args, ctx) => {
    await new Promise<void>(resolve => ctx.signal!.addEventListener('abort', () => resolve(), { once: true }));
    return ok('late terminal response');
  } });
  const result = await dispatchTools({ registry, toolContext: context(), turn: 1,
    toolUses: [{ id: 'a', name: metadata.name, input: {} }] });
  expect(result.outcomeUnknown === true).toBe(uncertain);
  expect(result.results[0].effectOutcome).toBe(uncertain ? 'unknown' : undefined);
});

it('does not claim an effect when a mutation expires waiting for its unsafe lane', async () => {
  const registry = new ToolRegistry();
  const handler = vi.fn(async () => ok('must not run'));
  registry.register({ ...external, source: 'native', timeoutMs: 10, handler });
  const toolContext = context();
  const release = await toolContext.toolCallLedger.reserveUnsafe();
  try {
    const result = await dispatchTools({ registry, toolContext, turn: 1,
      toolUses: [{ id: 'a', name: external.name, input: {} }] });
    expect(result.outcomeUnknown).not.toBe(true);
    expect(result.results[0].effectOutcome).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  } finally { release(); }
});

it('does not claim an effect when cancellation precedes Registry handler dispatch', async () => {
  const registry = new ToolRegistry();
  const handler = vi.fn(async () => ok('must not run'));
  registry.register({ ...external, source: 'native', handler });
  const result = await dispatchTools({ registry, toolContext: { ...context(), signal: AbortSignal.abort() },
    turn: 1, toolUses: [{ id: 'a', name: external.name, input: {} }] });
  expect(result.outcomeUnknown).not.toBe(true);
  expect(handler).not.toHaveBeenCalled();
});

it('keeps an outer wrapper timeout read-only when no physical child effect started', async () => {
  const registry = new ToolRegistry();
  let finish!: (result: ToolResult) => void;
  const pending = new Promise<ToolResult>(resolve => { finish = resolve; });
  registry.register({ ...buildCodeExecTool(registry), timeoutMs: 10,
    handler: async () => pending });
  try {
    const result = await dispatchTools({ registry, toolContext: context(), turn: 1,
      toolUses: [{ id: 'wrapper', name: 'code_exec', input: { code: 'no effects' } }] });
    expect(result.outcomeUnknown).not.toBe(true);
  } finally { finish(ok('cleanup')); }
});

it('detects a physical nested mutation when its wrapper wait expires first', async () => {
  const registry = new ToolRegistry();
  let finish!: (result: ToolResult) => void;
  const pending = new Promise<ToolResult>(resolve => { finish = resolve; });
  registry.register({ ...external, source: 'native', handler: async () => pending });
  registry.register({ ...buildCodeExecTool(registry), timeoutMs: 10, handler: async (_args, ctx) => {
    return registry.invoke(external.name, {}, { ...ctx, currentToolUseId: 'nested' });
  } });
  try {
    const result = await dispatchTools({ registry, toolContext: context(), turn: 1,
      toolUses: [{ id: 'wrapper', name: 'code_exec', input: { code: 'write' } }] });
    expect(result.outcomeUnknown).toBe(true);
    expect(result.results[0].effectOutcome).toBe('unknown');
  } finally { finish(ok('cleanup')); }
});

it('automatically continues with inspection after an unknown outcome without replaying it', async () => {
  const registry = new ToolRegistry();
  const effect = vi.fn(external.handler), inspect = vi.fn(async () => ok('existing receipt found'));
  registry.register({ ...external, handler: effect });
  registry.register({ ...external, name: 'inspect_receipt', source: 'native',
    mutates: false, parallelSafe: true, riskLevel: 'read', handler: inspect });
  let calls = 0;
  const { ctx } = makeTestContext({ registry, toolContext: context(), provider: {
    name: 'fixture', model: 'fixture', setModel() {}, async *chat(request) {
      calls++;
      if (calls > 1) expect(request.system).toContain('<tool-outcome-recovery>');
      if (calls === 4) {
        yield { type: 'text_delta' as const, text: 'Verified current state without repeating the effect.' };
        yield { type: 'done' as const, stop_reason: 'end_turn' }; return;
      }
      // Deliberately try an exact replay on turn two: the host must block it,
      // still return to the model, and allow the subsequent read-only check.
      const name = calls < 3 ? external.name : 'inspect_receipt';
      yield { type: 'tool_call_start' as const, id: `a-${calls}`, name };
      yield { type: 'tool_call_end' as const, id: `a-${calls}`, name, input: {} };
      yield { type: 'done' as const, stop_reason: 'tool_use' };
    },
  } });
  const nodes = buildDefaultNodes();
  nodes.Bootstrap = { state: 'Bootstrap', execute: async () => ({ kind: 'TurnSucceeded', hasToolCalls: false }) };
  nodes.Executing = new ExecutingNode();
  const result = await runBehaviorTree({ opts: ctx.opts, emit: ctx.emit, initialTiers: null }, nodes);
  expect(result.reason).not.toBe('error');
  expect(calls).toBe(4);
  expect(effect).toHaveBeenCalledOnce(); expect(inspect).toHaveBeenCalledOnce();
  expect(ctx.opts.toolContext.outcomeRecovery?.toolUseIds).toEqual(['a-1']);
  expect(ctx.opts.toolContext.toolCallLedger?.outcomeUnknownTool).toBeUndefined();
});

it('resumes the conversation with recovery restrictions instead of permanently rejecting its history', async () => {
  let calls = 0;
  const { ctx } = makeTestContext({ registry: new ToolRegistry(), toolContext: context(), provider: {
    name: 'fixture', model: 'fixture', setModel() {}, async *chat(request) {
      calls++;
      expect(request.system).toContain('<tool-outcome-recovery>');
      expect(request.system).toContain('old-call');
      yield { type: 'text_delta' as const, text: 'I can inspect the interrupted operation.' };
      yield { type: 'done' as const, stop_reason: 'end_turn' };
    },
  } });
  ctx.opts.initialMessages = [{ role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'old-call',
    content: 'lost response', is_error: true, effect_outcome: 'unknown' }] }];
  const result = await runBehaviorTree({ opts: ctx.opts, emit: ctx.emit, initialTiers: null });
  expect(result.reason).not.toBe('error');
  expect(calls).toBe(1);
  expect(ctx.opts.toolContext.outcomeRecovery?.toolUseIds).toEqual(['old-call']);
});
