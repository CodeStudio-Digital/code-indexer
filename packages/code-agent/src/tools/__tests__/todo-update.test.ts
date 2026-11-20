/**
 * update_todo — single-patch (legacy) and atomic batch forms.
 *
 * The batch form exists because telemetry showed the dominant pattern —
 * complete the current item + start the next — burned a full LLM round-trip
 * per transition (830 consecutive update_todo→update_todo turn pairs). One
 * call now applies both patches atomically, and the "exactly ONE in_progress"
 * warning evaluates the FINAL state instead of a transient intermediate.
 */
import { describe, it, expect } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { updateTodo, type TodoItem } from '../todo.js';

const item = (id: string, status: TodoItem['status'], content = `task ${id}`): TodoItem => ({
  id,
  content,
  activeForm: `doing ${id}`,
  status,
});

function makeCtx(initial: TodoItem[]) {
  const runner = {
    currentTodos: initial,
    setCalls: 0,
    setTodos(t: TodoItem[]) {
      this.currentTodos = t;
      this.setCalls++;
    },
  };
  return { ctx: { runner } as unknown as ToolContext, runner };
}

describe('update_todo — legacy single form (unchanged behavior)', () => {
  it('patches one item by top-level id', async () => {
    const { ctx, runner } = makeCtx([item('aaaa1111', 'in_progress'), item('bbbb2222', 'pending')]);
    const res = await updateTodo.handler({ id: 'aaaa1111', status: 'completed' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(runner.currentTodos.find((t) => t.id === 'aaaa1111')?.status).toBe('completed');
    expect(runner.setCalls).toBe(1);
  });

  it('still rejects a missing id and an explicitly bad status', async () => {
    const { ctx } = makeCtx([item('aaaa1111', 'pending')]);
    expect((await updateTodo.handler({}, ctx)).content).toContain('id is required');
    const bad = await updateTodo.handler({ id: 'aaaa1111', status: 'done' }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("must be pending|in_progress|completed, got 'done'");
  });

  it('still rejects a patch with no fields', async () => {
    const { ctx } = makeCtx([item('aaaa1111', 'pending')]);
    const res = await updateTodo.handler({ id: 'aaaa1111' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('at least one of {status, content, activeForm}');
  });
});

describe('update_todo — batch form', () => {
  it('completes the current item and starts the next in ONE call', async () => {
    const { ctx, runner } = makeCtx([item('aaaa1111', 'in_progress'), item('bbbb2222', 'pending')]);
    const res = await updateTodo.handler(
      {
        updates: [
          { id: 'aaaa1111', status: 'completed' },
          { id: 'bbbb2222', status: 'in_progress' },
        ],
      },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(runner.setCalls).toBe(1); // one application, one dashboard event
    expect(runner.currentTodos.map((t) => t.status)).toEqual(['completed', 'in_progress']);
    // Final state has exactly one in_progress → no transient-invariant warning.
    expect(res.content).not.toContain('WARNING');
    expect(res.content).toContain('1 completed, 1 in_progress, 0 pending');
  });

  it('is atomic: one unknown id rejects the whole call and nothing changes', async () => {
    const { ctx, runner } = makeCtx([item('aaaa1111', 'in_progress'), item('bbbb2222', 'pending')]);
    const res = await updateTodo.handler(
      {
        updates: [
          { id: 'aaaa1111', status: 'completed' },
          { id: 'nope9999', status: 'in_progress' },
        ],
      },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("id 'nope9999' not found — nothing was applied");
    expect(res.content).toContain('Known ids: aaaa1111, bbbb2222');
    expect(runner.setCalls).toBe(0);
    expect(runner.currentTodos.map((t) => t.status)).toEqual(['in_progress', 'pending']);
  });

  it('rejects a bad status naming the offending entry, before applying anything', async () => {
    const { ctx, runner } = makeCtx([item('aaaa1111', 'pending')]);
    const res = await updateTodo.handler(
      { updates: [{ id: 'aaaa1111', status: 'finished' }] },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain('updates[0].status must be');
    expect(runner.setCalls).toBe(0);
  });

  it('rejects duplicate ids within one batch', async () => {
    const { ctx } = makeCtx([item('aaaa1111', 'pending')]);
    const res = await updateTodo.handler(
      {
        updates: [
          { id: 'aaaa1111', status: 'in_progress' },
          { id: 'aaaa1111', status: 'completed' },
        ],
      },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("repeats id 'aaaa1111'");
  });

  it('rejects mixing the single form with updates[]', async () => {
    const { ctx } = makeCtx([item('aaaa1111', 'pending')]);
    const res = await updateTodo.handler(
      { id: 'aaaa1111', updates: [{ id: 'aaaa1111', status: 'completed' }] },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain('not both');
  });

  it('rejects an empty batch and an oversized batch', async () => {
    const { ctx } = makeCtx([item('aaaa1111', 'pending')]);
    expect((await updateTodo.handler({ updates: [] }, ctx)).isError).toBe(true);
    const oversized = Array.from({ length: 11 }, (_, i) => ({
      id: `id${i.toString().padStart(6, '0')}`,
      status: 'completed',
    }));
    const res = await updateTodo.handler({ updates: oversized }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('too many patches (11, max 10)');
  });

  it('still warns when the FINAL state has 2+ in_progress', async () => {
    const { ctx } = makeCtx([item('aaaa1111', 'pending'), item('bbbb2222', 'pending')]);
    const res = await updateTodo.handler(
      {
        updates: [
          { id: 'aaaa1111', status: 'in_progress' },
          { id: 'bbbb2222', status: 'in_progress' },
        ],
      },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('WARNING: 2 todos in_progress');
  });

  it('can rename content/activeForm alongside status in the same batch', async () => {
    const { ctx, runner } = makeCtx([item('aaaa1111', 'in_progress'), item('bbbb2222', 'pending')]);
    const res = await updateTodo.handler(
      {
        updates: [
          { id: 'aaaa1111', status: 'completed' },
          { id: 'bbbb2222', status: 'in_progress', activeForm: 'Compiling the backend' },
        ],
      },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(runner.currentTodos[1].activeForm).toBe('Compiling the backend');
    expect(res.content).toContain('Compiling the backend');
  });
});

describe('update_todo — shared guards', () => {
  it('errors when there is no active list', async () => {
    const { ctx } = makeCtx([]);
    const res = await updateTodo.handler({ updates: [{ id: 'aaaa1111', status: 'completed' }] }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('no active checklist');
  });
});
