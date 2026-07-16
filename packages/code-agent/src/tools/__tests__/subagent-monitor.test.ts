import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSubagentMonitor } from '../subagent-monitor.js';

describe('SubagentMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out an awaiting provider heartbeat that never emits a delta', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const failures: string[] = [];
    const monitor = createSubagentMonitor({
      limits: { timeoutMs: 600_000, stallMs: 300_000 },
      startedAt: Date.now(),
      getToolCallCount: () => 0,
      getTurn: () => 1,
      getLastToolName: () => undefined,
      onFail: (message) => failures.push(message),
    });
    monitor.promise.catch(() => undefined);

    monitor.recordProviderCall('zai', 'glm-5');
    vi.advanceTimersByTime(121_000);
    await Promise.resolve();

    expect(failures[0]).toContain('provider timeout');
    monitor.cleanup();
  });

  it('does not treat provider heartbeat tool_progress as semantic progress', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const failures: string[] = [];
    const monitor = createSubagentMonitor({
      limits: { timeoutMs: 600_000, stallMs: 1_000 },
      startedAt: Date.now(),
      getToolCallCount: () => 0,
      getTurn: () => 1,
      getLastToolName: () => 'provider.chat',
      onFail: (message) => failures.push(message),
    });
    monitor.promise.catch(() => undefined);

    monitor.recordToolProgress('provider.chat', 'awaiting zai:glm-5');
    vi.advanceTimersByTime(1_001);
    await Promise.resolve();

    expect(failures[0]).toContain('subagent stalled');
    monitor.cleanup();
  });

  it('does not schedule a hard wall-clock cutoff when timeoutMs is 0', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const failures: string[] = [];
    const monitor = createSubagentMonitor({
      limits: { timeoutMs: 0, stallMs: 300_000 },
      startedAt: Date.now(),
      getToolCallCount: () => 0,
      getTurn: () => 1,
      getLastToolName: () => undefined,
      onFail: (message) => failures.push(message),
    });
    monitor.promise.catch(() => undefined);

    for (let minute = 0; minute < 10; minute++) {
      vi.advanceTimersByTime(60_000);
      monitor.recordSemantic('test_progress', `minute ${minute + 1}`);
      await Promise.resolve();
    }

    // The semantic stall guard is independent and would fire at 5 minutes;
    // periodic progress keeps it alive while proving no 10-minute hard timer.
    expect(failures.some((message) => message.includes('hard timeout'))).toBe(false);
    expect(failures).toEqual([]);
    monitor.cleanup();
  });
});
