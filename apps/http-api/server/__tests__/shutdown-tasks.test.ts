import { describe, expect, it, vi } from 'vitest';
import { registerShutdownTask, runShutdownTasks } from '../shutdown-tasks.js';

describe('shutdown task registry', () => {
  it('drains once, tolerates failures, and immediately closes late resources', async () => {
    const first = vi.fn();
    const second = vi.fn(() => {
      registerShutdownTask('nested', first);
      throw new Error('expected');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registerShutdownTask('second', second);

    await runShutdownTasks();
    await runShutdownTasks();

    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();

    const late = vi.fn();
    registerShutdownTask('late', late);
    await Promise.resolve();
    await Promise.resolve();
    expect(late).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
