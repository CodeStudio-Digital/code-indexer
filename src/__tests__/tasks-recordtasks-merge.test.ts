import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import type { CoderTask, TasksState } from '@mcp/code-agent/sessions/types.js';

function makeTask(partial: Partial<CoderTask> & { id: string; title: string }): CoderTask {
  return {
    description: '',
    files: [],
    references: [],
    depends_on: [],
    suggested_mode: 'inline',
    estimated_complexity: 'small',
    status: 'pending',
    ...partial,
  } as CoderTask;
}

describe('SessionStore.recordTasks — preserve runtime fields on re-submission', () => {
  let workDir: string;
  let db: CodeIndexDB;
  let store: SessionStore;
  let projectId: number;
  let sessionId: number;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'tasks-merge-'));
    const dbPath = join(workDir, 'index.sqlite');
    db = new CodeIndexDB(dbPath);
    store = new SessionStore(dbPath);
    projectId = db.createProject('test-proj', workDir).id;
  });

  afterAll(() => {
    store.close();
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    sessionId = store.createSession({
      project_id: projectId,
      title: 'tasks merge test',
      provider: 'anthropic',
      model: 'sonnet',
    }).id;
  });

  it('keeps status/result/started_at when the same id is re-submitted', () => {
    const initial: TasksState = {
      summary: 'first',
      execution_mode: null,
      approved: false,
      current_task_id: null,
      tasks: [
        makeTask({ id: 'task_1', title: 'A' }),
        makeTask({ id: 'task_2', title: 'B' }),
      ],
    };
    store.recordTasks({ session_id: sessionId, tool_use_id: 'first', state: initial });
    // Mark task_1 as done with a result.
    store.updateTaskStatus(sessionId, 'task_1', {
      status: 'done',
      started_at: '2026-01-01T00:00:00.000Z',
      finished_at: '2026-01-01T00:01:00.000Z',
      result: { summary: 'finished A', files_modified: ['a.ts'] },
    });

    // Re-submit with the same ids but a refined plan (different title/files).
    const resubmit: TasksState = {
      summary: 'second',
      execution_mode: null,
      approved: false,
      current_task_id: null,
      tasks: [
        makeTask({ id: 'task_1', title: 'A — refined', files: ['a.ts', 'a-extra.ts'] }),
        makeTask({ id: 'task_2', title: 'B' }),
      ],
    };
    store.recordTasks({ session_id: sessionId, tool_use_id: 'second', state: resubmit });

    const after = store.getTasksState(sessionId)!;
    const merged1 = after.tasks.find((t) => t.id === 'task_1')!;
    expect(merged1.status).toBe('done'); // preserved!
    expect(merged1.result?.summary).toBe('finished A'); // preserved!
    expect(merged1.started_at).toBe('2026-01-01T00:00:00.000Z'); // preserved!
    expect(merged1.title).toBe('A — refined'); // taken from new submission
    expect(merged1.files).toEqual(['a.ts', 'a-extra.ts']); // taken from new submission
  });

  it('drops tasks that disappear from the new submission', () => {
    store.recordTasks({
      session_id: sessionId,
      tool_use_id: 'first',
      state: {
        summary: 'x',
        execution_mode: null,
        approved: false,
        current_task_id: null,
        tasks: [makeTask({ id: 'task_1', title: 'A' }), makeTask({ id: 'task_2', title: 'B' })],
      },
    });
    store.recordTasks({
      session_id: sessionId,
      tool_use_id: 'second',
      state: {
        summary: 'x',
        execution_mode: null,
        approved: false,
        current_task_id: null,
        tasks: [makeTask({ id: 'task_1', title: 'A' })], // task_2 removed
      },
    });
    const after = store.getTasksState(sessionId)!;
    expect(after.tasks.map((t) => t.id)).toEqual(['task_1']);
  });

  it('treats a totally new id set as a fresh decomposition (nothing preserved)', () => {
    store.recordTasks({
      session_id: sessionId,
      tool_use_id: 'first',
      state: {
        summary: 'x',
        execution_mode: null,
        approved: false,
        current_task_id: null,
        tasks: [makeTask({ id: 'task_1', title: 'A', status: 'done' })],
      },
    });
    store.recordTasks({
      session_id: sessionId,
      tool_use_id: 'second',
      state: {
        summary: 'x',
        execution_mode: null,
        approved: false,
        current_task_id: null,
        tasks: [makeTask({ id: 'task_a', title: 'fresh' })],
      },
    });
    const after = store.getTasksState(sessionId)!;
    expect(after.tasks).toHaveLength(1);
    expect(after.tasks[0].id).toBe('task_a');
    expect(after.tasks[0].status).toBe('pending');
  });

  it('clears current_task_id when the running task disappears from the new submission', () => {
    store.recordTasks({
      session_id: sessionId,
      tool_use_id: 'first',
      state: {
        summary: 'x',
        execution_mode: null,
        approved: false,
        current_task_id: null,
        tasks: [makeTask({ id: 'task_1', title: 'A' }), makeTask({ id: 'task_2', title: 'B' })],
      },
    });
    store.updateTaskStatus(sessionId, 'task_1', { status: 'running' });
    expect(store.getTasksState(sessionId)?.current_task_id).toBe('task_1');
    store.recordTasks({
      session_id: sessionId,
      tool_use_id: 'second',
      state: {
        summary: 'x',
        execution_mode: null,
        approved: false,
        current_task_id: null,
        tasks: [makeTask({ id: 'task_2', title: 'B' })], // task_1 removed
      },
    });
    expect(store.getTasksState(sessionId)?.current_task_id).toBeNull();
  });
});
