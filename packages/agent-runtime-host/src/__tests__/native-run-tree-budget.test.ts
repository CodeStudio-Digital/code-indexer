import { create } from '@bufbuild/protobuf';
import { agentV1Common } from '@mcp/agent-runtime-contracts';
import { expect, it } from 'vitest';
import { NativeRunTreeBudget } from '../runtime-policy/NativeRunTreeBudget.js';

const identity = (agentRunId = 'root', attemptId = 'root-attempt') => create(agentV1Common.AttemptIdentitySchema,
  { agentRunId, attemptId, rootAgentRunId: 'root' });
const child = (index: number, parent = 'root', depth = 1) => ({ kind: 'reserved' as const,
  context: { agentRunId: `child-${index}`, attemptId: `child-attempt-${index}` }, rootAgentRunId: 'root', parentAgentRunId: parent, spawnDepth: depth });
function fixture() {
  let now = 100; const abort = new AbortController();
  const budget = new NativeRunTreeBudget({ agentRunId: 'root', attemptId: 'root-attempt' },
    { maxTurns: 3, maxToolCalls: 5, maxAgents: 3, maxDepth: 2, deadlineAtUnixMs: 200 }, abort.signal, () => now);
  return { budget, abort, expire: () => { now = 200; } };
}

it('shares monotonic provider and tool consumption across root, siblings and nested calls', async () => {
  const f = fixture(); const root = f.budget.rootPort(), a = f.budget.childPort(child(1)), b = f.budget.childPort(child(2));
  root.admitProviderOperation(identity(), f.abort.signal);
  a.admitProviderOperation(identity('child-1', 'child-attempt-1'), f.abort.signal);
  b.admitProviderOperation(identity('child-2', 'child-attempt-2'), f.abort.signal);
  expect(() => root.admitProviderOperation(identity(), f.abort.signal)).toThrow(expect.objectContaining({ code: 'provider_run_tree_budget_exhausted' }));
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => [root, a, b][i % 3]!.take())));
  expect(results.filter(Boolean)).toHaveLength(5);
  a.close(); expect(a.take()).toBe(false); expect(root.take()).toBe(false);
  expect(f.budget.usage).toEqual({ turns: 3, toolCalls: 5, agents: 3 });
});

it('does not relaunch existing admission, refund closed agents, accept foreign identity or overrun depth', () => {
  const f = fixture(); const one = child(1); const a = f.budget.childPort(one);
  expect(() => f.budget.childPort(one)).toThrow('reservation');
  expect(() => f.budget.childPort({ ...child(2), kind: 'existing' })).toThrow('reservation');
  expect(() => a.admitProviderOperation(identity(), f.abort.signal)).toThrow(expect.objectContaining({ code: 'provider_run_tree_fenced' }));
  const grandchild = f.budget.childPort(child(2, 'child-1', 2));
  expect(() => f.budget.childPort(child(3, 'child-2', 3))).toThrow('reservation');
  a.close(); expect(grandchild.take()).toBe(false);
  expect(() => f.budget.childPort(child(3))).toThrow('reservation');
  expect(f.budget.usage).toEqual({ turns: 0, toolCalls: 0, agents: 3 });
});

it('fences every descendant on root close, cancellation and absolute deadline', () => {
  for (const mode of ['close', 'abort', 'expiry']) {
    const f = fixture(); const root = f.budget.rootPort(), a = f.budget.childPort(child(1));
    if (mode === 'close') root.close(); else if (mode === 'abort') f.abort.abort(); else f.expire();
    expect(a.take()).toBe(false);
    expect(() => f.budget.childPort(child(2, 'child-1', 2))).toThrow();
    expect(() => a.admitProviderOperation(identity('child-1', 'child-attempt-1'), f.abort.signal)).toThrow();
    expect(f.budget.usage.turns).toBe(0);
  }
});

it('copies authority inputs and rejects invalid finite bounds', () => {
  const root = { agentRunId: 'root', attemptId: 'root-attempt' };
  const limits = { maxTurns: 1, maxAgents: 1, maxDepth: 0, deadlineAtUnixMs: 200 };
  const signal = new AbortController().signal;
  const budget = new NativeRunTreeBudget(root, limits, signal, () => 100);
  root.agentRunId = 'other'; limits.maxTurns = 100;
  budget.rootPort().admitProviderOperation(identity(), signal);
  expect(() => budget.rootPort().admitProviderOperation(identity(), signal)).toThrow('exhausted');
  for (const invalid of [0, -1, NaN, Infinity, 1.1]) {
    expect(() => new NativeRunTreeBudget(root, { ...limits, maxTurns: invalid }, signal, () => 100)).toThrow('limit');
  }
});
