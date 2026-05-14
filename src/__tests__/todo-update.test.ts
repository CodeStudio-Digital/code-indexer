import { describe, it, expect, vi } from 'vitest';
import {
  todoWrite,
  updateTodo,
  generateTodoId,
  _resetWriteBurstForKey,
  type TodoItem,
} from '../core/coder/tools/todo.js';
import type { ToolContext } from '../core/coder/core/tool.js';

const ctx = (): ToolContext => ({ cwd: '/fake', projectName: 'test' });

function makeRunner() {
  const todos: TodoItem[] = [];
  const runner = {
    setTodos: vi.fn((t: TodoItem[]) => {
      todos.length = 0;
      todos.push(...t);
    }),
    get currentTodos() {
      return todos;
    },
    set currentTodos(v: TodoItem[]) {
      todos.length = 0;
      todos.push(...v);
    },
  };
  return { runner, getTodos: () => todos };
}

describe('todo_write — id assignment', () => {
  it('mints an id when the caller does not supply one', async () => {
    const { runner, getTodos } = makeRunner();
    await todoWrite.handler(
      { todos: [{ content: 'A', activeForm: 'Doing A', status: 'pending' }] },
      { ...ctx(), runner } as unknown as ToolContext,
    );
    expect(getTodos()).toHaveLength(1);
    expect(getTodos()[0].id).toMatch(/^[a-f0-9]{6,}$/);
  });

  it('preserves a caller-supplied id when valid', async () => {
    const { runner, getTodos } = makeRunner();
    await todoWrite.handler(
      { todos: [{ id: 'abc12345', content: 'A', activeForm: 'Doing A', status: 'pending' }] },
      { ...ctx(), runner } as unknown as ToolContext,
    );
    expect(getTodos()[0].id).toBe('abc12345');
  });

  it('regenerates an id when two items share the same id', async () => {
    const { runner, getTodos } = makeRunner();
    await todoWrite.handler(
      {
        todos: [
          { id: 'abc12345', content: 'A', activeForm: 'Doing A', status: 'pending' },
          { id: 'abc12345', content: 'B', activeForm: 'Doing B', status: 'pending' },
        ],
      },
      { ...ctx(), runner } as unknown as ToolContext,
    );
    const ids = getTodos().map((t) => t.id);
    expect(ids[0]).toBe('abc12345');
    expect(ids[1]).not.toBe('abc12345');
    expect(new Set(ids).size).toBe(2);
  });

  it('shows the id in the result text so the agent can patch it later', async () => {
    const { runner } = makeRunner();
    const result = await todoWrite.handler(
      { todos: [{ id: 'abc12345', content: 'Run tests', activeForm: 'Running tests', status: 'pending' }] },
      { ...ctx(), runner } as unknown as ToolContext,
    );
    expect(result.content).toContain('(id=abc12345)');
  });
});

describe('todo_write — burst guard', () => {
  it('refuses on the 4th identical call inside the window', async () => {
    const { runner } = makeRunner();
    _resetWriteBurstForKey(runner);
    const list = [{ content: 'A', activeForm: 'Doing A', status: 'pending' as const }];
    for (let i = 0; i < 3; i++) {
      const r = await todoWrite.handler({ todos: list }, { ...ctx(), runner } as unknown as ToolContext);
      expect(r.isError).toBeFalsy();
    }
    const fourth = await todoWrite.handler({ todos: list }, { ...ctx(), runner } as unknown as ToolContext);
    expect(fourth.isError).toBe(true);
    expect(fourth.content).toContain('Refused');
    expect(fourth.content).toContain('update_todo');
  });

  it('resets the counter when the list signature changes', async () => {
    const { runner } = makeRunner();
    _resetWriteBurstForKey(runner);
    for (let i = 0; i < 3; i++) {
      await todoWrite.handler(
        { todos: [{ content: 'A', activeForm: 'Doing A', status: 'pending' }] },
        { ...ctx(), runner } as unknown as ToolContext,
      );
    }
    // Signature change (new content) → counter resets, no refusal.
    const changed = await todoWrite.handler(
      { todos: [{ content: 'B', activeForm: 'Doing B', status: 'pending' }] },
      { ...ctx(), runner } as unknown as ToolContext,
    );
    expect(changed.isError).toBeFalsy();
  });

  it('does not trip on empty-list (clear) calls', async () => {
    const { runner } = makeRunner();
    _resetWriteBurstForKey(runner);
    for (let i = 0; i < 5; i++) {
      const r = await todoWrite.handler({ todos: [] }, { ...ctx(), runner } as unknown as ToolContext);
      expect(r.isError).toBeFalsy();
    }
  });
});

describe('update_todo', () => {
  async function seed(runner: ReturnType<typeof makeRunner>['runner']) {
    await todoWrite.handler(
      {
        todos: [
          { id: 'aaaaaa01', content: 'First', activeForm: 'Doing first', status: 'pending' },
          { id: 'bbbbbb02', content: 'Second', activeForm: 'Doing second', status: 'pending' },
          { id: 'cccccc03', content: 'Third', activeForm: 'Doing third', status: 'pending' },
        ],
      },
      { ...ctx(), runner } as unknown as ToolContext,
    );
  }

  it('patches a single status without disturbing other items', async () => {
    const { runner, getTodos } = makeRunner();
    _resetWriteBurstForKey(runner);
    await seed(runner);
    const r = await updateTodo.handler(
      { id: 'bbbbbb02', status: 'in_progress' },
      { ...ctx(), runner } as unknown as ToolContext,
    );
    expect(r.isError).toBeFalsy();
    const todos = getTodos();
    expect(todos[0].status).toBe('pending');
    expect(todos[1].status).toBe('in_progress');
    expect(todos[2].status).toBe('pending');
  });

  it('returns a recoverable error listing known ids when id is unknown', async () => {
    const { runner } = makeRunner();
    _resetWriteBurstForKey(runner);
    await seed(runner);
    const r = await updateTodo.handler(
      { id: 'doesnotexist', status: 'completed' },
      { ...ctx(), runner } as unknown as ToolContext,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not found');
    expect(r.content).toContain('aaaaaa01');
    expect(r.content).toContain('bbbbbb02');
    expect(r.content).toContain('cccccc03');
  });

  it('errors when there is no active list', async () => {
    const { runner } = makeRunner();
    const r = await updateTodo.handler(
      { id: 'aaaaaa01', status: 'completed' },
      { ...ctx(), runner } as unknown as ToolContext,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('todo_write first');
  });

  it('requires at least one of {status, content, activeForm}', async () => {
    const { runner } = makeRunner();
    _resetWriteBurstForKey(runner);
    await seed(runner);
    const r = await updateTodo.handler(
      { id: 'aaaaaa01' },
      { ...ctx(), runner } as unknown as ToolContext,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('at least one of');
  });

  it('renames content and activeForm when supplied', async () => {
    const { runner, getTodos } = makeRunner();
    _resetWriteBurstForKey(runner);
    await seed(runner);
    await updateTodo.handler(
      { id: 'aaaaaa01', content: 'First (renamed)', activeForm: 'Doing first (renamed)' },
      { ...ctx(), runner } as unknown as ToolContext,
    );
    expect(getTodos()[0].content).toBe('First (renamed)');
    expect(getTodos()[0].activeForm).toBe('Doing first (renamed)');
  });

  it('rejects an invalid status', async () => {
    const { runner } = makeRunner();
    _resetWriteBurstForKey(runner);
    await seed(runner);
    const r = await updateTodo.handler(
      { id: 'aaaaaa01', status: 'bogus' },
      { ...ctx(), runner } as unknown as ToolContext,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('pending|in_progress|completed');
  });
});

describe('generateTodoId', () => {
  it('returns 8 lower-case hex chars and is unique across calls', () => {
    const a = generateTodoId();
    const b = generateTodoId();
    expect(a).toMatch(/^[a-f0-9]{8}$/);
    expect(b).toMatch(/^[a-f0-9]{8}$/);
    expect(a).not.toBe(b);
  });
});
