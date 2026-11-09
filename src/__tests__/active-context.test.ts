import { describe, it, expect } from 'vitest';
import { buildActiveContextBlock } from '@mcp/code-agent/core/active-context.js';

describe('buildActiveContextBlock', () => {
  it('returns null when nothing is set', () => {
    const block = buildActiveContextBlock({});
    expect(block).toBeNull();
  });

  it('returns null with empty todos and no goal/active task', () => {
    const block = buildActiveContextBlock({ todos: [] });
    expect(block).toBeNull();
  });

  it('renders todos with status markers and uses activeForm for in_progress', () => {
    const block = buildActiveContextBlock({
      todos: [
        { id: 'a1b2c3d4', content: 'Refactor parser', activeForm: 'Refactoring parser', status: 'in_progress' },
        { id: 'e5f6a7b8', content: 'Add tests', activeForm: 'Adding tests', status: 'pending' },
        { id: 'c9d0e1f2', content: 'Wire DB', activeForm: 'Wiring DB', status: 'completed' },
      ],
    });
    expect(block).toContain('todos:');
    expect(block).toMatch(/\[in_progress\] \(id=a1b2c3d4\) Refactoring parser/);
    expect(block).toMatch(/\[pending\] \(id=e5f6a7b8\) Add tests/);
    expect(block).toMatch(/\[completed\] \(id=c9d0e1f2\) Wire DB/);
  });

  it('renders active task from tasks state when one is running', () => {
    const block = buildActiveContextBlock({
      tasksState: {
        approved: true,
        execution_mode: 'inline',
        tasks: [
          {
            id: 'task_1',
            title: 'Refactor parser',
            description: '',
            files: ['src/parse.ts', 'src/lex.ts'],
            references: [],
            depends_on: [],
            suggested_mode: 'inline',
            estimated_complexity: 'small',
            status: 'running',
          },
        ],
      } as unknown as Parameters<typeof buildActiveContextBlock>[0]['tasksState'],
    });
    expect(block).toContain('active_task: task_1 "Refactor parser"');
    expect(block).toContain('files: [src/parse.ts, src/lex.ts]');
  });

  it('truncates the todo body when over the cap and counts dropped items', () => {
    const todos = Array.from({ length: 50 }, (_, i) => ({
      id: `id${i.toString().padStart(6, '0')}`,
      content: `Item ${i} that is reasonably long to force truncation behaviour`,
      activeForm: `Doing item ${i} which keeps going for several more characters`,
      status: 'pending' as const,
    }));
    const block = buildActiveContextBlock({ todos, maxChars: 400 });
    expect(block).toBeTruthy();
    expect(block!.length).toBeLessThanOrEqual(400 + 100); // some header slack
    expect(block).toMatch(/\d+ more truncated/);
  });
});
