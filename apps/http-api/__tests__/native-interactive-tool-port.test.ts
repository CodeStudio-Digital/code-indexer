import { expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { askUser, decisionGate } from '@mcp/code-agent/tools/interaction.js';
import { submitPlan } from '@mcp/code-agent/tools/plan.js';
import { NativeCoderInteractions } from '../sse/native-coder-interactions.js';
import { NativeInteractiveToolPort } from '../workers/native-interactive-tool-port.js';

function fixture(specMode = false) {
  const controller = new AbortController();
  const slots = new NativeCoderInteractions(controller.signal);
  const emit = vi.fn();
  const port = new NativeInteractiveToolPort('plan', specMode, slots, emit, () => controller.signal.throwIfAborted());
  const context: ToolContext = { cwd: 'D:\\fixture', projectName: 'fixture', currentToolUseId: 'native-tool:review',
    ports: { interactions: port }, recordPlan: vi.fn(), resolvePlan: vi.fn(), setSessionAgent: vi.fn() };
  Object.defineProperty(context, 'runner', { get() { throw new Error('Legacy runner access forbidden'); } });
  return { controller, slots, emit, port, context };
}

it('registers a question before publication and accepts a synchronous keyed response without a runner', async () => {
  const f = fixture();
  f.emit.mockImplementation((_event, data) => { expect(f.slots.isWaiting).toBe(true);
    void f.slots.provideInput(data.id, JSON.stringify({ answer: 'chosen' })); });
  expect(await askUser.handler({ question: 'Choose?' }, f.context)).toMatchObject({ content: 'User answered: chosen' });
  expect(f.emit).toHaveBeenCalledWith('question', expect.objectContaining({ id: 'native-tool:review' }));
  expect(f.slots.isWaiting).toBe(false); f.slots.close();
});

it('does not resolve another question and releases its waiter on cancellation', async () => {
  const f = fixture(); const result = askUser.handler({ question: 'Choose?' }, f.context);
  expect(await f.slots.provideInput('native-tool:old', '{"answer":"wrong"}')).toBe(false);
  expect(f.slots.isWaiting).toBe(true); f.controller.abort();
  expect(await result).toMatchObject({ isError: true, content: 'Question aborted by user.' });
  expect(f.slots.isWaiting).toBe(false);
});

it('keeps a revised plan blocked and unlocks only after a persisted approval', async () => {
  const f = fixture();
  const first = submitPlan.handler({ plan: 'Read, then change' }, f.context);
  await vi.waitFor(() => expect(f.slots.isWaiting).toBe(true));
  await f.slots.provideInput('native-tool:review', '{"approved":false,"feedback":"revise"}');
  expect((await first).content).toContain('revision requested'); expect(f.port.planApproved).toBe(false);
  expect((await submitPlan.handler({ plan: 'Read, then change' }, f.context)).isError).toBe(true);
  const next = submitPlan.handler({ plan: 'Read, test, then change' }, f.context);
  await vi.waitFor(() => expect(f.slots.isWaiting).toBe(true));
  f.context.resolvePlan = vi.fn(async () => { expect(f.port.planApproved).toBe(false); });
  await f.slots.provideInput('native-tool:review', '{"approved":true}');
  expect((await next).extraUserBlocks).toHaveLength(1);
  expect(f.port.planApproved).toBe(true); expect(f.context.setSessionAgent).toHaveBeenCalledWith('build');
  f.slots.close();
});

it('does not unlock a plan when its durable approval write fails', async () => {
  const f = fixture(); f.context.resolvePlan = vi.fn(async () => { throw new Error('disk full'); });
  const pending = submitPlan.handler({ plan: 'Change' }, f.context);
  const rejected = expect(pending).rejects.toThrow('disk full');
  await vi.waitFor(() => expect(f.slots.isWaiting).toBe(true));
  await f.slots.provideInput('native-tool:review', '{"approved":true}'); await rejected;
  expect(f.port.planApproved).toBe(false); f.slots.close();
});

it('does not let plan review bypass specification mode', async () => {
  const f = fixture(true);
  expect((await submitPlan.handler({ plan: 'Change' }, f.context)).isError).toBe(true);
  expect(f.emit).not.toHaveBeenCalled(); expect(() => f.port.approvePlan()).toThrow('specification gate'); f.slots.close();
});

it('uses the same owned port for structured decisions', async () => {
  const f = fixture(); f.emit.mockImplementation((_event, data) => {
    void f.slots.provideInput(data.id, '{"answers":{"scope":{"selected":["a"]}}}'); });
  const result = await decisionGate.handler({ questions: [{ id: 'scope', question: 'Scope?', options: [
    { label: 'A', value: 'a', summary: 'First' }, { label: 'B', value: 'b', summary: 'Second' },
  ] }] }, f.context);
  expect(result.isError).not.toBe(true); expect(result.content).toContain('scope: A');
  expect(f.emit).toHaveBeenCalledWith('decision', expect.objectContaining({ id: 'native-tool:review' })); f.slots.close();
});
