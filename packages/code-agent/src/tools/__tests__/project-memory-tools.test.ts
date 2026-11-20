import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../core/tool.js';
import { forgetMemoryTool, rememberTool, recallMemoryTool } from '../project-memory-tools.js';
import { suppressesMemoryRecall } from '@mcp/shared/memory-opt-out.js';

const context = (overrides: Partial<ToolContext>): ToolContext => ({
  cwd: 'D:\\project',
  projectName: 'project',
  ...overrides,
} as ToolContext);

describe('project memory write tools', () => {
  it('skips project and user recall and list on a turn that excludes memory', async () => {
    const recall = vi.fn(), list = vi.fn(), ports = { save: vi.fn(), recall, list };
    for (const scope of ['project', 'user']) {
      const ctx = context({ projectMemory: ports, userMemory: ports, memoryReadSuppressed: suppressesMemoryRecall('Não use a memória neste pedido.') });
      for (const mode of ['search', 'list']) expect((await recallMemoryTool.handler({ scope, mode, query: 'policy' }, ctx)).isError).toBe(true);
    }
    expect(recall).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(suppressesMemoryRecall('Ignore the memory leak in this trace')).toBe(false);
    expect(suppressesMemoryRecall('Ignore o consumo de memória por enquanto.')).toBe(false);
    expect(suppressesMemoryRecall('Do not use project memory for this task')).toBe(true);
  });
  it('reads and lists global preferences without enabling project memory', async () => {
    const recall = vi.fn().mockResolvedValue([{ id: '1', title: 'Language', content: 'Portuguese' }]);
    const list = vi.fn().mockResolvedValue([{ name: 'Language', description: 'Portuguese', type: 'preference' }]);
    const ctx = context({ userMemory: { save: vi.fn(), recall, list } });
    const result = await recallMemoryTool.handler({ scope: 'user', query: 'language' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Portuguese');
    expect(recall).toHaveBeenCalledWith('language', 5, undefined);
    const index = await recallMemoryTool.handler({ scope: 'user', mode: 'list' }, ctx);
    expect(index.content).toContain('Language');
    expect(list).toHaveBeenCalledOnce();
    expect((await recallMemoryTool.handler({ scope: 'wrong', query: 'x' }, ctx)).isError).toBe(true);
  });
  it('passes cancellation to explicit recall and never reports an aborted result as empty memory', async () => {
    const ctrl = new AbortController();
    const recall = vi.fn(async (_query, _limit, signal: AbortSignal) => { ctrl.abort(); signal.throwIfAborted(); return []; });
    const result = await recallMemoryTool.handler({ query: 'remember this' }, context({
      signal: ctrl.signal, projectMemory: { save: vi.fn(), recall },
    }));
    expect(recall).toHaveBeenCalledWith('remember this', 5, ctrl.signal);
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('No agent memory matches');
  });
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
      resource: 'memory:project',
    });
    expect(result.isError).toBeUndefined();
  });

  it('classifies forget_memory as a database mutation', () => {
    expect(forgetMemoryTool.mutates).toBe(true);
    expect(forgetMemoryTool.effectBoundary).toBe('database');
  });
  it.each([NaN, Infinity, 0, -1, 1.5, 13, '3'])('rejects an invalid recall window %s before host dispatch', async limit => {
    const recall = vi.fn();
    const result = await recallMemoryTool.handler({ query: 'x', limit }, context({ projectMemory: { recall, save: vi.fn() } }));
    expect(result.isError).toBe(true); expect(recall).not.toHaveBeenCalled();
  });
  it.each([rememberTool, forgetMemoryTool].map(tool => [tool.name, tool] as const))('reports an uncertain effect from %s when the write response is lost', async (_name, tool) => {
    const write = vi.fn().mockRejectedValue(new Error('ACK lost'));
    const result = await tool.handler({ title: 'Fact', content: 'Confirmed', target: 'Fact' }, context({
      projectMemory: { save: write, forget: write, recall: vi.fn() },
    }));
    expect(result).toMatchObject({ isError: true, effectOutcome: 'unknown' });
    expect(result.content).toContain('Reconcile memory before retrying'); expect(write).toHaveBeenCalledOnce();
  });
  it('dispatches native writes exclusively through the bound port', async () => {
    const save = vi.fn(); const invoke = vi.fn().mockResolvedValue({ created: 1, merged: 0, skipped: 0 });
    const result = await rememberTool.handler({ title: 'Fact', content: 'Confirmed', scope: 'user' }, context({
      currentToolUseId: 'tool-1', userMemory: { save } as any, ports: { memoryMutations: { invoke } } as any,
      mutationFence: { mode: 'enforce', resourceBinding: { bindingId: 'sealed' }, assertMutation: vi.fn() } as any,
    }));
    expect(result.isError).toBeUndefined(); expect(save).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'remember', toolUseId: 'tool-1', binding: { bindingId: 'sealed' } }));
  });
  it('does not describe skipped memories as saved', async () => {
    const result = await rememberTool.handler({ title: 'Fact', content: 'Confirmed' }, context({
      projectMemory: { save: vi.fn().mockResolvedValue({ created: 0, merged: 0, skipped: 1 }), recall: vi.fn() },
    }));
    expect(result.content).toContain('No new project memory was written');
  });
});
