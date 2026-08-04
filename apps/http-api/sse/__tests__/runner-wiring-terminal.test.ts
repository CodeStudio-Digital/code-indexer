import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { createBus } from '../../coder-bus.js';
import { wireRunnerEventsToBus } from '../runnerWiring.js';

function fakeRunner(): CoderRunner {
  return new EventEmitter() as unknown as CoderRunner;
}

describe('wireRunnerEventsToBus terminal ordering', () => {
  it('keeps the bus open when the worker defers done until transcript persistence', () => {
    const runner = fakeRunner();
    const bus = createBus(new AbortController());
    wireRunnerEventsToBus(runner, bus, { deferTerminalEvent: true });

    runner.emit('done', 'completed');

    expect(bus.ended).toBe(false);
    expect(bus.buffer.some((event) => event.event === 'done')).toBe(false);
  });

  it('marks goal-tool success provisional and publishes its durable ack after runner done', () => {
    const runner = fakeRunner();
    const bus = createBus(new AbortController());
    wireRunnerEventsToBus(runner, bus, { deferTerminalEvent: true });

    runner.emit('tool_call_start', 'goal-1', 'update_goal', { status: 'complete' });
    runner.emit(
      'tool_call_result',
      'goal-1',
      'update_goal',
      { content: 'Goal marked complete.' },
      4,
    );
    runner.emit('done', 'completed');
    runner.emit('goal_mutations_persisted', { toolUseIds: ['goal-1'] });

    expect(bus.buffer.find((event) => event.event === 'tool_call_result')).toMatchObject({
      data: {
        id: 'goal-1',
        name: 'update_goal',
        persistence: 'pending',
      },
    });
    expect(bus.buffer.at(-1)).toMatchObject({
      event: 'goal_mutations_persisted',
      data: { toolUseIds: ['goal-1'] },
    });
    expect(bus.ended).toBe(false);
  });

  it('publishes a compensating goal persistence failure during the deferred terminal window', () => {
    const runner = fakeRunner();
    const bus = createBus(new AbortController());
    wireRunnerEventsToBus(runner, bus, { deferTerminalEvent: true });

    runner.emit('tool_call_result', 'goal-2', 'create_goal', { content: 'Goal set.' }, 1);
    runner.emit('done', 'completed');
    runner.emit('goal_mutations_persistence_failed', {
      toolUseIds: ['goal-2'],
      message: 'database write failed',
    });

    expect(bus.buffer.at(-1)).toMatchObject({
      event: 'goal_mutations_persistence_failed',
      data: {
        toolUseIds: ['goal-2'],
        message: 'database write failed',
      },
    });
  });

  it('preserves the legacy immediate terminal event by default', () => {
    const runner = fakeRunner();
    const bus = createBus(new AbortController());
    wireRunnerEventsToBus(runner, bus);

    runner.emit('done', 'completed');

    expect(bus.ended).toBe(true);
    expect(bus.buffer.at(-1)?.event).toBe('done');
  });

  it('forwards adjacent text deltas immediately to the single downstream IPC coalescer', () => {
    const runner = fakeRunner();
    const bus = createBus(new AbortController());
    wireRunnerEventsToBus(runner, bus);

    runner.emit('text_delta', 'hel', { itemId: 'msg_1', phase: 'commentary' });
    runner.emit('text_delta', 'lo');

    expect(bus.buffer).toMatchObject([
      {
        event: 'text',
        data: { text: 'hel', item_id: 'msg_1', phase: 'commentary' },
      },
      { event: 'text', data: { text: 'lo' } },
    ]);
    runner.emit('done', 'completed');
  });

  it('publishes injected user-message boundaries without exposing message content', () => {
    const runner = fakeRunner();
    const bus = createBus(new AbortController());
    wireRunnerEventsToBus(runner, bus);

    runner.emit('user_message_boundary', { roundMessageIds: [1222] });

    expect(bus.buffer).toMatchObject([
      {
        event: 'user_message_boundary',
        data: { round_message_ids: [1222] },
      },
    ]);
    runner.emit('done', 'completed');
  });

  it('keeps text before a non-text ordering boundary without duplicating it', () => {
    const runner = fakeRunner();
    const bus = createBus(new AbortController());
    wireRunnerEventsToBus(runner, bus);

    runner.emit('text_delta', 'before ');
    runner.emit('text_delta', 'tool');
    runner.emit('tool_call_start', 'tool-1', 'read_file', {});

    expect(bus.buffer.map((event) => event.event)).toEqual([
      'text',
      'text',
      'tool_call_start',
    ]);
    expect(bus.buffer[0]?.data).toEqual({ text: 'before ' });
    expect(bus.buffer[1]?.data).toEqual({ text: 'tool' });
    runner.emit('done', 'completed');
  });

  it('forwards final text even when the worker defers the terminal event', () => {
    const runner = fakeRunner();
    const bus = createBus(new AbortController());
    wireRunnerEventsToBus(runner, bus, { deferTerminalEvent: true });

    runner.emit('text_delta', 'durable tail');
    runner.emit('done', 'completed');

    expect(bus.buffer).toMatchObject([
      { event: 'text', data: { text: 'durable tail' } },
    ]);
    expect(bus.ended).toBe(false);
  });

  it('seals every event kind after runner done, including deferred terminal runs', () => {
    const runner = fakeRunner();
    const bus = createBus(new AbortController());
    wireRunnerEventsToBus(runner, bus, { deferTerminalEvent: true });

    runner.emit('text_delta', 'tail');
    runner.emit('done', 'completed');
    runner.emit('thinking_delta', 'late thinking');
    runner.emit('tool_progress', {
      id: 'tool-1',
      name: 'run_command',
      elapsedMs: 10_000,
      kind: 'heartbeat',
    });
    runner.emit('text_delta', 'late text');

    expect(bus.buffer).toMatchObject([
      { event: 'text', data: { text: 'tail' } },
    ]);
  });

  it('forwards a budget gate after flushing prior text', () => {
    const runner = fakeRunner();
    const bus = createBus(new AbortController());
    wireRunnerEventsToBus(runner, bus);
    const payload = {
      ask_id: 'budget-run-1',
      run_id: '11111111-1111-4111-8111-111111111111',
      spent: 100,
      cap: 100,
      estimated: 50,
      options: ['continue+50%', 'stop_after_current', 'cancel_pending'],
    } as const;

    runner.emit('text_delta', 'before budget');
    runner.emit('budget_request', payload);

    expect(bus.buffer).toMatchObject([
      { event: 'text', data: { text: 'before budget' } },
      { event: 'budget_request', data: payload },
    ]);
    runner.emit('done', 'completed');
  });

  it('normalizes failure reasons to an error terminal with renderer-compatible data', () => {
    const runner = fakeRunner();
    const bus = createBus(new AbortController());
    wireRunnerEventsToBus(runner, bus);

    runner.emit('done', 'recovery_capped', new Error('provider never recovered'));

    expect(bus.endReason).toEqual({
      event: 'error',
      data: {
        reason: 'recovery_capped',
        error: 'provider never recovered',
        message: 'provider never recovered',
      },
    });
    expect(bus.buffer.at(-1)).toMatchObject({
      event: 'error',
      data: { reason: 'recovery_capped', message: 'provider never recovered' },
    });
  });

  it('keeps budget exhaustion as a clean interrupted transport terminal', () => {
    const runner = fakeRunner();
    const bus = createBus(new AbortController());
    wireRunnerEventsToBus(runner, bus);

    runner.emit('done', 'max_turns');

    expect(bus.endReason).toEqual({
      event: 'done',
      data: { reason: 'max_turns', error: undefined },
    });
  });
});
