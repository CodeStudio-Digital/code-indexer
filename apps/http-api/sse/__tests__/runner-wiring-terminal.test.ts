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

  it('preserves the legacy immediate terminal event by default', () => {
    const runner = fakeRunner();
    const bus = createBus(new AbortController());
    wireRunnerEventsToBus(runner, bus);

    runner.emit('done', 'completed');

    expect(bus.ended).toBe(true);
    expect(bus.buffer.at(-1)?.event).toBe('done');
  });
});
