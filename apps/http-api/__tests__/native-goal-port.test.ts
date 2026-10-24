import { expect, it, vi } from 'vitest';
import { nativeToolUseId } from '@mcp/agent-runtime-host';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { goalTools } from '@mcp/code-agent/tools/goal.js';
import { NativeGoalPort } from '../workers/native-goal-port.js';

function harness() {
  let revoked = false;
  const context = { getGoalState: () => null } as unknown as ToolContext;
  const port = new NativeGoalPort(context, () => { if (revoked) throw new Error('revoked'); });
  let serial = 0;
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const request = { identity: { attemptId: 'attempt' }, providerOperationId: 'provider', toolUseId: `call-${++serial}` };
    context.currentToolUseId = nativeToolUseId(request.identity.attemptId, request.providerOperationId, request.toolUseId);
    const result = await goalTools.find(t => t.name === name)!.handler(args, context);
    return { request, toolName: name, result } as Parameters<NativeGoalPort['result']>[0];
  };
  return { context, port, invoke, revoke: () => { revoked = true; } };
}
it('defers invalid legacy state to explicit goal operations without blocking other results', () => {
  const getInitial = vi.fn(() => ({ text: 'x'.repeat(8193) }));
  const context = { getGoalState: getInitial } as unknown as ToolContext;
  const port = new NativeGoalPort(context, () => {});
  expect(getInitial).not.toHaveBeenCalled();
  expect(port.result({ toolName: 'read_file' } as Parameters<NativeGoalPort['result']>[0])).toBeUndefined();
  expect(() => context.getGoalState!()).toThrow('Invalid native goal state');
});
it('captures valid legacy fractional budgets once and preserves them through completion', async () => {
  const initial = { text: 'Existing goal', status: 'in_progress', budgetTokens: 0.5, completionNote: null,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
  const getInitial = vi.fn(() => initial);
  const context = { getGoalState: getInitial } as unknown as ToolContext;
  const port = new NativeGoalPort(context, () => {});
  const request = { identity: { attemptId: 'attempt' }, providerOperationId: 'provider', toolUseId: 'finish' };
  context.currentToolUseId = nativeToolUseId('attempt', 'provider', 'finish');
  expect(context.getGoalState!()?.budgetTokens).toBe(0.5);
  const result = await goalTools.find(t => t.name === 'update_goal')!.handler({ status: 'complete' }, context);
  const committed = port.result({ request, toolName: 'update_goal', result } as Parameters<NativeGoalPort['result']>[0]);
  expect(committed?.next).toMatchObject({ ...initial, status: 'complete', updatedAt: expect.any(String) });
  expect(getInitial).toHaveBeenCalledTimes(1);
});
it('pairs successful sequential goal results and exposes the same state to the next tool', async () => {
  const h = harness();
  const create = await h.invoke('create_goal', { goal: 'Keep settings', budget_tokens: 700 });
  expect(h.context.getGoalState!()).toBeNull();
  const first = h.port.result(create)!;
  expect(first.next.text).toBe('Keep settings');
  expect((await h.invoke('get_goal', {})).result.content).toContain('Keep settings');
  const redundant = h.port.result(await h.invoke('create_goal', { goal: 'Replace silently' }))!;
  expect(redundant.next).toEqual(first.next);
  expect(redundant.expected).toEqual(first.next);
  const complete = h.port.result(await h.invoke('update_goal', { status: 'complete', note: 'Verified' }))!;
  expect(complete.next.status).toBe('complete');
  expect(h.context.getGoalState!()?.completionNote).toBe('Verified');
});
it('does not publish abandoned state, accept foreign result IDs or accept revoked authority', async () => {
  const h = harness();
  const input = await h.invoke('create_goal', { goal: 'Pending' });
  expect(h.context.getGoalState!()).toBeNull();
  expect(() => h.port.result({ ...input, request: { ...input.request, toolUseId: 'foreign' } })).toThrow('attributed');
  const revoked = harness();
  const pending = await revoked.invoke('create_goal', { goal: 'Pending' });
  revoked.revoke();
  expect(() => revoked.port.result(pending)).toThrow('revoked');
  expect(() => revoked.context.getGoalState!()).toThrow('revoked');
});
it('keeps invalid input and cancelled tools free of staged changes', async () => {
  const h = harness();
  for (const args of [{ goal: {} }, { goal: 'x'.repeat(8193) }, { goal: 'test', budget_tokens: Infinity }]) {
    const failed = await h.invoke('create_goal', args);
    expect(failed.result.isError).toBe(true);
    expect(h.port.result(failed)).toBeUndefined();
  }
  h.context.signal = AbortSignal.abort();
  await expect(h.invoke('create_goal', { goal: 'No effect' })).rejects.toThrow();
  expect(h.context.getGoalState!()).toBeNull();
});
