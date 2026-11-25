import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { askUser } from '../interaction.js';

const projectRoot = resolve(tmpdir(), 'permission-test-project');
const externalRoot = resolve(tmpdir(), 'permission-test-reference');

function ctx(answer: string, authorize = vi.fn(async (path: string, access: 'read' | 'write') => ({
  rootPath: path,
  access,
}))) {
  const emit = vi.fn();
  return {
    authorize,
    emit,
    context: {
      cwd: projectRoot,
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
  filesystem_access: { path: externalRoot, access: 'read' },
};

describe('ask_user filesystem access', () => {
  it('activates the exact root only after the user authorizes it', async () => {
    const fixture = ctx('authorize');
    const result = await askUser.handler(input, fixture.context);

    expect(result.isError).toBeFalsy();
    expect(fixture.authorize).toHaveBeenCalledWith(externalRoot, 'read');
    expect(fixture.emit).toHaveBeenCalledWith('question_posted', expect.objectContaining({
      question: expect.stringContaining(externalRoot),
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

  it('returns an immediate result for a folder already covered by the session', async () => {
    const fixture = ctx('deny');
    const current = { ...fixture.context, unrestrictedFilesystemAccess: () => true };
    const result = await askUser.handler(input, current);
    expect(result.content).toContain('already allows read access');
    expect(fixture.emit).not.toHaveBeenCalled();
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  it('requires a new decision for write access on a folder granted only for read', async () => {
    const fixture = ctx('deny');
    const current = { ...fixture.context, externalRoots: [{ id: '1', rootPath: tmpdir(), access: 'read' as const }] };
    const path = join(tmpdir());
    expect((await askUser.handler({ ...input, filesystem_access: { path, access: 'read' } }, current)).content)
      .toContain('already allows read access');
    expect((await askUser.handler({ ...input, filesystem_access: { path, access: 'write' } }, current)).content)
      .toContain('User answered: deny');
    expect(fixture.emit).toHaveBeenCalledTimes(1);
  });
});
