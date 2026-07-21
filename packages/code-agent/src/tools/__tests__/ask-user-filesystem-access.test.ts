import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { askUser } from '../interaction.js';

function ctx(answer: string, authorize = vi.fn(async (path: string, access: 'read' | 'write') => ({
  rootPath: path,
  access,
}))) {
  const emit = vi.fn();
  return {
    authorize,
    emit,
    context: {
      cwd: 'D:\\project',
      projectName: 'test',
      authorizeFilesystemRoot: authorize,
      runner: {
        emit,
        waitForUserInput: vi.fn(async () => JSON.stringify({ answer })),
      },
    } as unknown as ToolContext,
  };
}

const input = {
  question: 'Authorize this external folder for inspection?',
  header: 'External folder',
  options: [
    { label: 'Authorize', value: 'authorize' },
    { label: 'Deny', value: 'deny' },
  ],
  filesystem_access: { path: 'C:\\reference', access: 'read' },
};

describe('ask_user filesystem access', () => {
  it('activates the exact root only after the user authorizes it', async () => {
    const fixture = ctx('authorize');
    const result = await askUser.handler(input, fixture.context);

    expect(result.isError).toBeFalsy();
    expect(fixture.authorize).toHaveBeenCalledWith('C:\\reference', 'read');
    expect(fixture.emit).toHaveBeenCalledWith('question_posted', expect.objectContaining({
      question: expect.stringContaining('C:\\reference'),
    }));
    expect(result.content).toContain('Filesystem root authorized');
  });

  it('does not grant access when the user denies it', async () => {
    const fixture = ctx('deny');
    const result = await askUser.handler(input, fixture.context);

    expect(result.isError).toBeFalsy();
    expect(fixture.authorize).not.toHaveBeenCalled();
    expect(result.content).toContain('User answered: deny');
  });

  it('rejects ambiguous grant cards', async () => {
    const fixture = ctx('yes');
    const result = await askUser.handler({
      ...input,
      options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }],
    }, fixture.context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("'authorize' and 'deny'");
    expect(fixture.authorize).not.toHaveBeenCalled();
  });
});
