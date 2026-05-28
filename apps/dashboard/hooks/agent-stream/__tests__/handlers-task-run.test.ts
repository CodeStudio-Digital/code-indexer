import { describe, expect, it, vi } from 'vitest';
import { createEventHandlers } from '../handlers.js';
import type { StreamBlock, UpdateSession } from '../types.js';

function setup() {
  const blocks: StreamBlock[] = [];
  const toolIndex = new Map<string, number>();
  const flush = vi.fn();
  const flushNow = vi.fn();
  const updateSession: UpdateSession = vi.fn();
  const handlers = createEventHandlers({
    sid: 1,
    blocks,
    toolIndex,
    flush,
    flushNow,
    updateSession,
  });
  return { handlers, blocks, toolIndex, flush, flushNow, updateSession };
}

describe('task_run handlers', () => {
  it('creates and updates a live execute_tasks timeline block', () => {
    const { handlers, blocks, flush } = setup();

    handlers.task_run_started(
      {
        run_id: 'taskrun_1',
        mode: 'auto',
        total_tasks: 1,
        waves: [
          {
            index: 1,
            tasks: [{ id: 'tsk_one', title: 'One', kind: 'implement', mode: 'subagent' }],
          },
        ],
      },
      'task_run_started',
    );

    expect(blocks[0]).toMatchObject({
      type: 'task_run',
      run: {
        runId: 'taskrun_1',
        status: 'running',
        tasks: [{ id: 'tsk_one', status: 'pending', toolCallCount: 0 }],
      },
    });

    handlers.task_run_task_started(
      {
        run_id: 'taskrun_1',
        task_id: 'tsk_one',
        title: 'One',
        kind: 'implement',
        wave: 1,
        mode: 'subagent',
        started_at: '2026-05-27T00:00:00.000Z',
      },
      'task_run_task_started',
    );
    handlers.task_run_task_progress(
      {
        run_id: 'taskrun_1',
        task_id: 'tsk_one',
        tool_call_count: 4,
        note: 'read_file completed',
        phase: 'tool_call',
        last_tool_name: 'read_file',
        turn: 2,
        limit: { maxToolCalls: 40, timeoutMs: 600000, stallMs: 120000 },
        elapsed_ms: 1234,
        stall_ms: 0,
      },
      'task_run_task_progress',
    );
    handlers.task_run_task_finished(
      {
        run_id: 'taskrun_1',
        task_id: 'tsk_one',
        status: 'done',
        summary: 'Finished',
        usage: { input_tokens: 10, output_tokens: 2 },
        tool_call_count: 4,
        finished_at: '2026-05-27T00:01:00.000Z',
      },
      'task_run_task_finished',
    );
    handlers.task_run_finished(
      {
        run_id: 'taskrun_1',
        status: 'completed',
        total_usage: { input_tokens: 10, output_tokens: 2 },
        finished_at: '2026-05-27T00:01:00.000Z',
      },
      'task_run_finished',
    );

    const block = blocks[0];
    expect(block.type).toBe('task_run');
    if (block.type !== 'task_run') throw new Error('expected task_run block');
    expect(block.run.status).toBe('completed');
    expect(block.run.totalUsage).toEqual({ input_tokens: 10, output_tokens: 2 });
    expect(block.run.tasks[0]).toMatchObject({
      status: 'done',
      toolCallCount: 4,
      summary: 'Finished',
      progressNote: 'read_file completed',
      phase: 'tool_call',
      lastToolName: 'read_file',
      turn: 2,
      elapsedMs: 1234,
    });
    expect(flush).toHaveBeenCalled();
  });

  it('marks running execute_tasks UI as failed when the stream emits error', () => {
    const { handlers, blocks, toolIndex, flushNow } = setup();

    handlers.tool_call_start(
      { id: 'tool_1', name: 'execute_tasks', input: {} },
      'tool_call_start',
    );
    toolIndex.set('tool_1', 0);
    handlers.task_run_started(
      {
        run_id: 'taskrun_1',
        mode: 'auto',
        total_tasks: 1,
        waves: [
          {
            index: 1,
            tasks: [{ id: 'tsk_one', title: 'One', kind: 'implement', mode: 'subagent' }],
          },
        ],
      },
      'task_run_started',
    );
    handlers.task_run_task_started(
      {
        run_id: 'taskrun_1',
        task_id: 'tsk_one',
        title: 'One',
        kind: 'implement',
        wave: 1,
        mode: 'subagent',
        started_at: '2026-05-27T00:00:00.000Z',
      },
      'task_run_task_started',
    );

    handlers.error({ message: 'worker crashed: boom' }, 'error');

    expect(blocks).toHaveLength(1);
    const taskRunBlock = blocks[0];
    expect(taskRunBlock.type).toBe('task_run');
    if (taskRunBlock.type !== 'task_run') throw new Error('expected task_run block');
    expect(taskRunBlock.run.status).toBe('failed');
    expect(taskRunBlock.run.tasks[0]).toMatchObject({
      status: 'interrupted',
      error: 'worker crashed: boom',
    });
    expect(flushNow).toHaveBeenCalled();
  });
});
