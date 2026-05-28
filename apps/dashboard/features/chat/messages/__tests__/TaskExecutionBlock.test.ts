import { describe, expect, it } from 'vitest';
import { parseExecuteTasksResult } from '../TaskExecutionBlock.js';

describe('parseExecuteTasksResult', () => {
  it('builds a persisted task run summary from execute_tasks output', () => {
    const parsed = parseExecuteTasksResult(
      [
        '[execute_tasks: 2 wave(s), 2 task(s), input=100 output=25]',
        '',
        '### tsk_one — First task [wave=1, kind=implement, status=done, tools=3, tokens=40]',
        'First summary',
        '',
        '---',
        '',
        '### tsk_two — Verify task [wave=2, kind=verify, status=failed, tools=1, tokens=20]',
        'Verification failed',
      ].join('\n'),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.status).toBe('failed');
    expect(parsed?.totalUsage).toEqual({ input_tokens: 100, output_tokens: 25 });
    expect(parsed?.waves).toEqual([
      { index: 1, taskIds: ['tsk_one'] },
      { index: 2, taskIds: ['tsk_two'] },
    ]);
    expect(parsed?.tasks[0]).toMatchObject({
      id: 'tsk_one',
      kind: 'implement',
      status: 'done',
      toolCallCount: 3,
      summary: 'First summary',
    });
    expect(parsed?.tasks[1]).toMatchObject({
      id: 'tsk_two',
      kind: 'verify',
      status: 'failed',
      error: 'Verification failed',
    });
  });
});
