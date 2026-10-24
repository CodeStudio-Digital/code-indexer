import { expect, it, vi } from 'vitest';
import type { PreparedCoderExecution } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import { NativeTreeInteractions } from '../workers/native-tree-interactions.js';
import { NativeCoderInteractions } from '../sse/native-coder-interactions.js';

it('proves cancellation only for pending questions that never received a response', async () => {
  const controller = new AbortController(), interactions = new NativeCoderInteractions(controller.signal);
  const waiting = interactions.waitForInput('unanswered');
  const answered = interactions.waitForInput('answered');
  await interactions.provideInput('answered', 'yes');
  controller.abort();
  expect(await waiting).toBe(JSON.stringify({ aborted: true }));
  expect(await answered).toBe('yes');
  expect(interactions.wasCancelledWithoutResponse('unanswered')).toBe(true);
  expect(interactions.wasCancelledWithoutResponse('answered')).toBe(false);
  expect(interactions.wasCancelledWithoutResponse('foreign')).toBe(false);
});

function execution(id: string) {
  return { isWaitingForInput: () => true, isInteractionPending: (candidate: string) => candidate === id,
    resolveInteraction: vi.fn(async () => {}) } as unknown as PreparedCoderExecution;
}

it('routes budget ask_id to the same owned identity as its review', async () => {
  const emit = vi.fn(), tree = new NativeTreeInteractions(emit), child = tree.child('budget-attempt', 'budget-run');
  const target = execution('budget-local'); child.attach(target);
  child.forward({ event: 'budget_request', seq: 1, data: { id: 'budget-local', ask_id: 'budget-local', run_id: 'run' } });
  const review = emit.mock.lastCall![1];
  expect(review.ask_id).toBe(review.id); expect(tree.hasPending(review.ask_id)).toBe(true);
  await tree.resolve(review.ask_id, { idempotencyKey: 'budget-once', value: 'cancel_pending' });
  expect(target.resolveInteraction).toHaveBeenCalledWith('budget-local', { idempotencyKey: 'budget-once', value: 'cancel_pending' });
  child.close();
});

it('routes identical model tool IDs to separate child facades without resolving on the parent', async () => {
  const emit = vi.fn(); const tree = new NativeTreeInteractions(emit);
  const first = tree.child('attempt-one', 'run-one'), second = tree.child('attempt-two', 'run-two');
  const a = execution('tool_approval:write'), b = execution('tool_approval:write');
  first.attach(a); second.attach(b);
  const event = { seq: 1, event: 'tool_approval_request', data: { toolUseId: 'write', toolName: 'create_file' } };
  first.forward(event); second.forward(event);
  const [one, two] = emit.mock.calls.map(([, data]) => `tool_approval:${data.toolUseId}`);
  expect(one).not.toBe(two); expect(tree.hasPending(one)).toBe(true); expect(tree.isWaiting).toBe(true);
  const response = { idempotencyKey: 'approval-once', value: '{"approved":true}' };
  await tree.resolve(two, response); await tree.resolve(two, response);
  expect(a.resolveInteraction).not.toHaveBeenCalled();
  expect(b.resolveInteraction).toHaveBeenCalledTimes(2);
  expect(b.resolveInteraction).toHaveBeenCalledWith('tool_approval:write', response);
  second.forward({ ...event, event: 'tool_approval_resolved' });
  expect(emit.mock.lastCall?.[1].toolUseId).toBe(two.replace('tool_approval:', ''));
  second.close(); expect(tree.hasPending(two)).toBe(false);
  await expect(tree.resolve(two, response)).rejects.toThrow('not owned');
  first.close(); expect(tree.isWaiting).toBe(false);
});

it('routes a nested question through each owner and drops non-interaction events', async () => {
  const emit = vi.fn(), outer = new NativeTreeInteractions(emit);
  const branch = outer.child('branch', 'branch-run');
  const inner = new NativeTreeInteractions((event, data) => branch.forward({ event, data, seq: 1 }));
  const leaf = inner.child('leaf', 'leaf-run'), target = execution('question-1');
  leaf.attach(target);
  branch.attach({ isWaitingForInput: () => inner.isWaiting, isInteractionPending: id => inner.hasPending(id),
    resolveInteraction: (id, response) => inner.resolve(id, response) } as PreparedCoderExecution);
  leaf.forward({ event: 'message_complete', data: { private: 'child-history' }, seq: 1 });
  expect(emit).not.toHaveBeenCalled();
  leaf.forward({ event: 'question', data: { id: 'question-1', question: 'Continue?' }, seq: 2 });
  const id = emit.mock.lastCall?.[1].id;
  expect(outer.hasPending(id)).toBe(true);
  const response = { idempotencyKey: 'answer', value: 'yes' };
  await outer.resolve(id, response);
  expect(target.resolveInteraction).toHaveBeenCalledWith('question-1', response);
  leaf.close(); expect(outer.hasPending(id)).toBe(false);
  branch.close();
});

it('does not claim a published prompt is ready before the child facade attaches, and bounds receipts', async () => {
  const emit = vi.fn(), tree = new NativeTreeInteractions(emit), child = tree.child('attempt', 'run');
  child.forward({ event: 'question', data: { id: 'question' }, seq: 1 });
  const id = emit.mock.lastCall?.[1].id;
  expect(tree.owns(id)).toBe(true); expect(tree.hasPending(id)).toBe(false);
  await expect(tree.resolve(id, { idempotencyKey: 'early', value: 'yes' })).rejects.toThrow('not ready');
  for (let i = 1; i < 1024; i++) child.forward({ event: 'question', data: { id: `q-${i}` }, seq: i });
  expect(() => child.forward({ event: 'question', data: { id: 'overflow' }, seq: 1025 })).toThrow('bound');
  child.close(); expect(() => child.attach(execution('question'))).toThrow('closed');
});

it.each([false, true])('forwards nested progress with original ownership (workflow=%s)', workflow => {
  const emit = vi.fn(), outer = new NativeTreeInteractions(emit);
  const branch = outer.child('branch', 'branch-run');
  const inner = new NativeTreeInteractions((event, data) => branch.forward({ event, data, seq: 1 }));
  const leaf = inner.child('leaf', 'leaf-run');
  const events = workflow ? ['workflow_run_started', 'workflow_step_update', 'workflow_run_finished'] : ['agents_group_start', 'agent_progress', 'agents_group_end'];
  const identity = workflow ? { workflow_id: 'leaf-workflow' } : { groupId: 'leaf-group' };
  for (const event of events) {
    leaf.forward({ event, data: { ...identity, agentIndex: 0, event: 'tool_call' }, seq: 1 });
  }
  expect(emit.mock.calls.map(([event]) => event)).toEqual(events);
  for (const [, data] of emit.mock.calls) expect(data).toMatchObject({ ...identity,
    nativeTree: { agentRunId: 'leaf-run', attemptId: 'leaf' } });
  expect(outer.owns('leaf-group')).toBe(false);
  leaf.forward({ event: 'tool_call_result', data: { private: 'child-result' }, seq: 2 });
  expect(emit).toHaveBeenCalledTimes(3);
  expect(() => leaf.forward({ event: 'agent_progress', data: { groupId: '' }, seq: 3 })).toThrow('identity');
  branch.close(); leaf.forward({ event: 'agent_progress', data: { groupId: 'late' }, seq: 4 });
  expect(emit).toHaveBeenCalledTimes(3); leaf.close();
});
