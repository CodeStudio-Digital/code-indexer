import { describe, expect, it, vi } from 'vitest';
import { InteractivePriorityGate } from '../interactive-priority-gate.js';

describe('InteractivePriorityGate', () => {
  it('pauses only the busy project and releases every waiter on resume', async () => {
    const gate = new InteractivePriorityGate();
    gate.setBusy(1, true);

    const projectOneA = vi.fn();
    const projectOneB = vi.fn();
    const projectTwo = vi.fn();
    const waitA = gate.wait(1).then(projectOneA);
    const waitB = gate.wait(1).then(projectOneB);
    await gate.wait(2).then(projectTwo);

    expect(projectTwo).toHaveBeenCalledOnce();
    expect(projectOneA).not.toHaveBeenCalled();
    expect(projectOneB).not.toHaveBeenCalled();

    gate.setBusy(1, false);
    await Promise.all([waitA, waitB]);
    expect(projectOneA).toHaveBeenCalledOnce();
    expect(projectOneB).toHaveBeenCalledOnce();
  });
});
