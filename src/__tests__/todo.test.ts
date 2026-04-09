import { describe, it, expect, vi, beforeEach } from 'vitest';
import { todoWrite, type TodoItem } from '../core/coder/tools/todo.js';
import type { ToolContext } from '../core/coder/core/tool.js';

// ── Helpers ─────────────────────────────────────────────────────────

const ctx = (): ToolContext => ({ cwd: '/fake', projectName: 'test' });

function makeRunnerSpy() {
  const todos: TodoItem[] = [];
  return {
    runner: {
      setTodos: vi.fn((t: TodoItem[]) => {
        todos.length = 0;
        todos.push(...t);
      }),
      currentTodos: todos,
    },
    getTodos: () => todos,
  };
}

// ── Validation tests ────────────────────────────────────────────────

describe('todo_write', () => {
  it('accepts a valid todo list and updates the runner', async () => {
    const { runner } = makeRunnerSpy();
    const result = await todoWrite.handler(
      {
        todos: [
          { content: 'Read code', activeForm: 'Reading code', status: 'pending' },
          { content: 'Write tests', activeForm: 'Writing tests', status: 'pending' },
        ],
      },
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('2 todos');
    expect(result.content).toContain('0 completed');
    expect(result.content).toContain('[ ] Read code');
    expect(result.content).toContain('[ ] Write tests');
    expect(runner.setTodos).toHaveBeenCalledTimes(1);
  });

  it('accepts an empty array to clear the list', async () => {
    const { runner } = makeRunnerSpy();
    const result = await todoWrite.handler(
      { todos: [] },
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('cleared');
    expect(runner.setTodos).toHaveBeenCalledWith([]);
  });

  it('rejects non-array todos', async () => {
    const { runner } = makeRunnerSpy();
    const result = await todoWrite.handler(
      { todos: 'not an array' } as any,
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('must be an array');
  });

  it('rejects todos with missing content', async () => {
    const { runner } = makeRunnerSpy();
    const result = await todoWrite.handler(
      {
        todos: [{ activeForm: 'Doing something', status: 'in_progress' }],
      },
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('content');
  });

  it('rejects todos with missing activeForm', async () => {
    const { runner } = makeRunnerSpy();
    const result = await todoWrite.handler(
      {
        todos: [{ content: 'Do thing', status: 'in_progress' }],
      },
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('activeForm');
  });

  it('rejects todos with invalid status', async () => {
    const { runner } = makeRunnerSpy();
    const result = await todoWrite.handler(
      {
        todos: [{ content: 'Do thing', activeForm: 'Doing', status: 'invalid' }],
      },
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('pending|in_progress|completed');
  });

  it('rejects duplicate content entries', async () => {
    const { runner } = makeRunnerSpy();
    const result = await todoWrite.handler(
      {
        todos: [
          { content: 'Read code', activeForm: 'Reading code', status: 'pending' },
          { content: 'Read code', activeForm: 'Reading code again', status: 'pending' },
        ],
      },
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('duplicated');
  });

  it('rejects more than 50 items', async () => {
    const { runner } = makeRunnerSpy();
    const todos = Array.from({ length: 51 }, (_, i) => ({
      content: `Item ${i}`,
      activeForm: `Doing item ${i}`,
      status: 'pending' as const,
    }));
    const result = await todoWrite.handler(
      { todos },
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('too many');
  });

  it('accepts exactly 50 items', async () => {
    const { runner } = makeRunnerSpy();
    const todos = Array.from({ length: 50 }, (_, i) => ({
      content: `Item ${i}`,
      activeForm: `Doing item ${i}`,
      status: 'pending' as const,
    }));
    const result = await todoWrite.handler(
      { todos },
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('50 todos');
  });

  it('rejects non-object items in the array', async () => {
    const { runner } = makeRunnerSpy();
    const result = await todoWrite.handler(
      { todos: ['string item'] } as any,
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('must be an object');
  });

  it('warns when more than one todo is in_progress', async () => {
    const { runner } = makeRunnerSpy();
    const result = await todoWrite.handler(
      {
        todos: [
          { content: 'Read code', activeForm: 'Reading code', status: 'in_progress' },
          { content: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' },
        ],
      },
      { ...ctx(), runner } as any,
    );
    // Should NOT be an error — just a warning
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('WARNING');
    expect(result.content).toContain('2 todos in_progress');
  });

  it('shows completed/in_progress/pending counts correctly', async () => {
    const { runner } = makeRunnerSpy();
    const result = await todoWrite.handler(
      {
        todos: [
          { content: 'Done', activeForm: 'Doing done', status: 'completed' },
          { content: 'Active', activeForm: 'Being active', status: 'in_progress' },
          { content: 'Wait', activeForm: 'Waiting', status: 'pending' },
          { content: 'Also done', activeForm: 'Also being done', status: 'completed' },
        ],
      },
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('4 todos');
    expect(result.content).toContain('2 completed');
    expect(result.content).toContain('1 in_progress');
    expect(result.content).toContain('1 pending');
  });

  it('uses activeForm for in_progress items in output', async () => {
    const { runner } = makeRunnerSpy();
    const result = await todoWrite.handler(
      {
        todos: [{ content: 'Run tests', activeForm: 'Running tests', status: 'in_progress' }],
      },
      { ...ctx(), runner } as any,
    );
    expect(result.content).toContain('[~] Running tests');
    expect(result.content).not.toContain('[~] Run tests');
  });

  it('uses content for pending and completed items in output', async () => {
    const { runner } = makeRunnerSpy();
    const result = await todoWrite.handler(
      {
        todos: [
          { content: 'Pending task', activeForm: 'Pending active', status: 'pending' },
          { content: 'Done task', activeForm: 'Done active', status: 'completed' },
        ],
      },
      { ...ctx(), runner } as any,
    );
    expect(result.content).toContain('[ ] Pending task');
    expect(result.content).toContain('[x] Done task');
  });

  it('returns error when runner does not support todo tracking', async () => {
    const result = await todoWrite.handler(
      {
        todos: [{ content: 'Test', activeForm: 'Testing', status: 'pending' }],
      },
      ctx(), // no runner
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('runner that supports todo tracking');
  });

  it('replaces the entire list on each call (no merge)', async () => {
    const { runner, getTodos } = makeRunnerSpy();

    // First call with 2 items
    await todoWrite.handler(
      {
        todos: [
          { content: 'A', activeForm: 'Doing A', status: 'completed' },
          { content: 'B', activeForm: 'Doing B', status: 'pending' },
        ],
      },
      { ...ctx(), runner } as any,
    );
    expect(getTodos()).toHaveLength(2);

    // Second call with 1 item — should replace, not merge
    await todoWrite.handler(
      {
        todos: [{ content: 'C', activeForm: 'Doing C', status: 'in_progress' }],
      },
      { ...ctx(), runner } as any,
    );
    expect(getTodos()).toHaveLength(1);
    expect(getTodos()[0].content).toBe('C');
  });
});
