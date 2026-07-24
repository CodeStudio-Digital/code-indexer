import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../core/tool.js';
import { forgetMemoryTool, rememberTool } from '../project-memory-tools.js';

const context = (overrides: Partial<ToolContext>): ToolContext => ({
  cwd: 'D:\\project',
  projectName: 'project',
  ...overrides,
} as ToolContext);

describe('project memory write tools', () => {
  it('never reports success when the persistence port returns null', async () => {
    const result = await rememberTool.handler({
      title: 'durable fact',
      content: 'must really land',
    }, context({
      projectMemory: {
        save: vi.fn().mockResolvedValue(null),
        recall: vi.fn(),
      },
    }));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('persistence is unavailable');
  });

  it('declares and checks the database effect boundary for writes', async () => {
    const assertMutation = vi.fn();
    const save = vi.fn().mockResolvedValue({ created: 1, merged: 0, skipped: 0 });
    const result = await rememberTool.handler({
      title: 'durable fact',
      content: 'landed',
    }, context({
      mutationFence: { mode: 'enforce', assertMutation } as never,
      projectMemory: { save, recall: vi.fn() },
    }));

    expect(rememberTool.mutates).toBe(true);
    expect(rememberTool.effectBoundary).toBe('database');
    expect(assertMutation).toHaveBeenCalledWith({
      kind: 'database',
      operation: 'remember.save',
      resource: 'memory:project:project',
    });
    expect(result.isError).toBeUndefined();
  });

  it('classifies forget_memory as a database mutation', () => {
    expect(forgetMemoryTool.mutates).toBe(true);
    expect(forgetMemoryTool.effectBoundary).toBe('database');
  });
});
